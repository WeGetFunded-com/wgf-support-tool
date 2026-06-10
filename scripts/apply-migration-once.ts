#!/usr/bin/env tsx
/**
 * One-off migration applier (staging only). Reuses the db-query tunnel
 * mechanics. Usage: npx tsx scripts/apply-migration-once.ts <sql-file>
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Cannot find free port")));
      }
    });
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = createConnection({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error("Tunnel timeout"));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

async function main() {
  const sqlFile = process.argv[2];
  if (!sqlFile || !existsSync(sqlFile)) {
    console.error("Usage: apply-migration-once.ts <sql-file>");
    process.exit(1);
  }

  const envFile = join(dirname(new URL(import.meta.url).pathname), "..", ".env");
  const parsed = dotenv.parse(readFileSync(envFile, "utf-8"));
  const prefix = "STAGING"; // hard-coded: this tool never touches production

  const kubeServer = parsed["KUBE_SERVER"];
  const kubeToken = parsed["KUBE_TOKEN"];
  const namespace = parsed[`${prefix}_NAMESPACE`];
  const podName = parsed[`${prefix}_POD_NAME`];
  const podPort = parsed[`${prefix}_POD_PORT`];
  const dbName = parsed[`${prefix}_DB_NAME`];
  const dbUser = parsed[`${prefix}_DB_USER`];
  const dbPassword = parsed[`${prefix}_DB_PASSWORD`];

  const raw = readFileSync(sqlFile, "utf-8");
  const statements = raw
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.error(`[apply] ${statements.length} statements from ${sqlFile}`);

  const localPort = await findFreePort();
  const child: ChildProcess = spawn(
    "kubectl",
    [
      `--server=${kubeServer}`,
      `--token=${kubeToken}`,
      "--insecure-skip-tls-verify",
      "port-forward",
      `pod/${podName}`,
      `${localPort}:${podPort}`,
      "-n",
      namespace,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );

  await waitForPort(localPort, 15000);
  console.error("[apply] Tunnel open. Connecting...");

  const connection = await mysql.createConnection({
    host: "127.0.0.1",
    port: localPort,
    user: dbUser,
    password: dbPassword,
    database: dbName,
    connectTimeout: 10000,
    ssl: { rejectUnauthorized: false },
  });

  try {
    for (const [i, stmt] of statements.entries()) {
      const head = stmt.replace(/\s+/g, " ").slice(0, 80);
      console.error(`[apply] (${i + 1}/${statements.length}) ${head}...`);
      const [res] = await connection.execute(stmt);
      const info = res as { affectedRows?: number };
      if (info.affectedRows !== undefined) {
        console.error(`[apply]   -> ${info.affectedRows} rows affected`);
      }
    }
    console.log("OK");
  } finally {
    await connection.end();
    child.kill();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
