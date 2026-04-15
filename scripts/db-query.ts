#!/usr/bin/env tsx
/**
 * Standalone read-only database query script for Claude Code skill.
 *
 * Usage:  tsx scripts/db-query.ts <production|staging> "<SQL>"
 * Output: JSON array of rows to stdout. Errors go to stderr.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

// ── Helpers ──────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Cannot find free port")));
      }
    });
    srv.on("error", reject);
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function tryConnect() {
      if (Date.now() > deadline) return reject(new Error("Tunnel timeout"));
      const sock = createConnection({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => setTimeout(tryConnect, 300));
    }
    tryConnect();
  });
}

// ── Read-only validation ─────────────────────────

const ALLOWED_PREFIXES = ["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"];

function isReadOnly(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  return ALLOWED_PREFIXES.some((p) => trimmed.startsWith(p));
}

// ── Main ─────────────────────────────────────────

async function main() {
  const [, , env, ...queryParts] = process.argv;
  const query = queryParts.join(" ");

  if (!env || !query) {
    console.error("Usage: tsx scripts/db-query.ts <production|staging> <SQL>");
    process.exit(1);
  }

  if (env !== "production" && env !== "staging") {
    console.error('Environment must be "production" or "staging"');
    process.exit(1);
  }

  if (!isReadOnly(query)) {
    console.error("ERROR: Only read-only queries are allowed (SELECT, SHOW, DESCRIBE, EXPLAIN)");
    process.exit(1);
  }

  // Load .env from the project root (same dir as package.json)
  const projectRoot = join(dirname(new URL(import.meta.url).pathname), "..");
  const envFile = join(projectRoot, ".env");

  if (!existsSync(envFile)) {
    console.error(`ERROR: .env file not found at ${envFile}`);
    process.exit(1);
  }

  const parsed = dotenv.parse(readFileSync(envFile, "utf-8"));
  const prefix = env === "production" ? "PRODUCTION" : "STAGING";

  const kubeServer = parsed["KUBE_SERVER"];
  const kubeToken = parsed["KUBE_TOKEN"];
  const namespace = parsed[`${prefix}_NAMESPACE`];
  const podName = parsed[`${prefix}_POD_NAME`];
  const podPort = parsed[`${prefix}_POD_PORT`];
  const dbName = parsed[`${prefix}_DB_NAME`];
  const dbUser = parsed[`${prefix}_DB_USER`];
  const dbPassword = parsed[`${prefix}_DB_PASSWORD`];

  // Open tunnel
  const localPort = await findFreePort();
  console.error(`[db-query] Opening tunnel to ${env} on local port ${localPort}...`);

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

  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

  const exitPromise = new Promise<never>((_, reject) => {
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error(`Tunnel failed: ${stderr.trim()}`));
    });
  });

  try {
    await Promise.race([waitForPort(localPort, 15000), exitPromise]);
  } catch (err) {
    child.kill();
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  }

  console.error(`[db-query] Tunnel open. Connecting to MySQL...`);

  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection({
      host: "127.0.0.1",
      port: localPort,
      user: dbUser,
      password: dbPassword,
      database: dbName,
      connectTimeout: 10000,
      ssl: { rejectUnauthorized: false },
    });

    console.error(`[db-query] Connected. Executing query...`);
    const [rows] = await connection.execute(query);
    // Output rows as JSON to stdout
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    if (connection) await connection.end().catch(() => {});
    child.kill();
    console.error(`[db-query] Done.`);
  }
}

main();
