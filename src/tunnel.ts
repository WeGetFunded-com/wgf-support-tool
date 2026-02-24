import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { type Config, type Environment, getEnvConfig } from "./config.js";
import * as ui from "./ui.js";

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Impossible de trouver un port libre")));
      }
    });
    srv.on("error", reject);
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function tryConnect() {
      if (Date.now() > deadline) {
        return reject(new Error("Timeout en attendant le tunnel kubectl"));
      }
      const sock = createConnection({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => {
        setTimeout(tryConnect, 300);
      });
    }

    tryConnect();
  });
}

export interface Tunnel {
  localPort: number;
  close: () => void;
}

export async function openTunnel(
  config: Config,
  env: Environment
): Promise<Tunnel> {
  const envConfig = getEnvConfig(config, env);
  const localPort = await findFreePort();
  const label = env === "staging" ? "Staging" : "Production";

  ui.info(`Ouverture du tunnel vers ${label}...`);

  const args = [
    `--server=${config.kubeServer}`,
    `--token=${config.kubeToken}`,
    "--insecure-skip-tls-verify",
    "port-forward",
    `pod/${envConfig.podName}`,
    `${localPort}:${envConfig.podPort}`,
    "-n",
    envConfig.namespace,
  ];

  const isWindows = process.platform === "win32";
  const child: ChildProcess = spawn("kubectl", args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
  });

  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  const exitPromise = new Promise<never>((_, reject) => {
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "kubectl n'est pas installé. Demandez à votre administrateur de l'installer."
          )
        );
      } else {
        reject(err);
      }
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`Le tunnel a échoué : ${stderr.trim() || `code ${code}`}`));
      }
    });
  });

  try {
    await Promise.race([
      waitForPort(localPort, 15000),
      exitPromise,
    ]);
  } catch (err) {
    child.kill();
    throw err;
  }

  ui.success(`Tunnel ouvert sur le port local ${localPort}`);

  return {
    localPort,
    close: () => {
      child.kill();
    },
  };
}
