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
  const label = env === "staging" ? "Staging" : "Production";

  return forward(config, env, `pod/${envConfig.podName}`, envConfig.podPort, `tunnel vers ${label}`);
}

// The MT5 API only answers calls coming from the cluster, so a balance operation
// has to go through the manager service rather than from this machine.
export async function openManagerTunnel(
  config: Config,
  env: Environment
): Promise<Tunnel> {
  const envConfig = getEnvConfig(config, env);

  return forward(
    config,
    env,
    `svc/${envConfig.managerService}`,
    envConfig.managerPort,
    "tunnel vers le service manager"
  );
}

async function forward(
  config: Config,
  env: Environment,
  target: string,
  remotePort: number,
  label: string
): Promise<Tunnel> {
  const envConfig = getEnvConfig(config, env);
  const localPort = await findFreePort();

  ui.info(`Ouverture du ${label}...`);

  const args = [
    `--server=${config.kubeServer}`,
    `--token=${config.kubeToken}`,
    "--insecure-skip-tls-verify",
    "port-forward",
    target,
    `${localPort}:${remotePort}`,
    "-n",
    envConfig.namespace,
  ];

  const child: ChildProcess = spawn("kubectl", args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
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
