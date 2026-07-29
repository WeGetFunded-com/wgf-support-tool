#!/usr/bin/env tsx
/**
 * Rollback du backfill effectué par scripts/backfill-zombie-reason.ts.
 *
 * Lit le fichier de sauvegarde JSON produit lors du backfill (qui contient
 * l'environnement, le motif écrit et la liste exacte des UUID) et remet le
 * `reason` à '' (vide) UNIQUEMENT sur les comptes qui portent encore le motif
 * écrit par le backfill. Cela évite d'écraser un compte qui aurait été
 * (re)désactivé proprement depuis, avec un autre motif.
 *
 * Sûretés :
 *   - DRY-RUN par défaut (aucune écriture) ; --apply pour exécuter.
 *   - Environnement lu DANS le fichier de sauvegarde (pas d'argument à risque).
 *   - Confirmation "PRODUCTION" au clavier quand env = production.
 *   - Ne remet à '' que les lignes dont reason = <motif du backfill> (garde-fou
 *     anti-écrasement).
 *   - UPDATE en batches, dans une transaction unique.
 *   - Une entrée récapitulative dans admin_audit_log.
 *   - Idempotent : relancé, il ne trouve plus rien à annuler.
 *
 * Usage :
 *   Dry-run  : npx tsx scripts/rollback-zombie-reason.ts scripts/backfill-zombie-production-<date>.json
 *   Exécuter : npx tsx scripts/rollback-zombie-reason.ts scripts/backfill-zombie-production-<date>.json --apply --operator=Nael
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { createInterface } from "node:readline";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

const BATCH_SIZE = 500;
const SAMPLE_SIZE = 20;

interface BackupFile {
  env: "production" | "staging";
  reason: string;
  count: number;
  generated_at: string;
  accounts: Array<{ ta_uuid: string; login: number; phase: number }>;
}

// ── Helpers tunnel (repris de db-query.ts) ───────

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

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const AUDIT_LOG_DDL = `
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  action_type VARCHAR(64) NOT NULL,
  target_table VARCHAR(64) NOT NULL,
  target_uuid BINARY(16) NULL,
  details JSON NULL,
  operator VARCHAR(128) NOT NULL,
  environment VARCHAR(16) NOT NULL,
  executed_at DATETIME DEFAULT NOW()
)`;

// ── Main ─────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const backupPath = args[0];
  const apply = args.includes("--apply");
  const operatorArg = args.find((a) => a.startsWith("--operator="))?.split("=")[1];

  if (!backupPath || !existsSync(backupPath)) {
    console.error("Usage: tsx scripts/rollback-zombie-reason.ts <backup.json> [--apply] [--operator=NAME]");
    console.error("       (le <backup.json> est le fichier généré par backfill-zombie-reason.ts)");
    process.exit(1);
  }

  let backup: BackupFile;
  try {
    backup = JSON.parse(readFileSync(backupPath, "utf-8")) as BackupFile;
  } catch (err) {
    console.error(`ERROR: fichier de sauvegarde illisible : ${(err as Error).message}`);
    process.exit(1);
  }

  const env = backup.env;
  const reasonToUndo = backup.reason;
  const uuids = (backup.accounts ?? []).map((a) => a.ta_uuid).filter(Boolean);

  if (env !== "production" && env !== "staging") {
    console.error(`ERROR: env invalide dans la sauvegarde : ${env}`);
    process.exit(1);
  }
  if (!reasonToUndo) {
    console.error("ERROR: motif (reason) manquant dans la sauvegarde.");
    process.exit(1);
  }
  if (uuids.length === 0) {
    console.error("ERROR: aucun UUID dans la sauvegarde.");
    process.exit(1);
  }

  // Charge le .env (même racine que package.json)
  const projectRoot = join(dirname(new URL(import.meta.url).pathname), "..");
  const envFile = join(projectRoot, ".env");
  if (!existsSync(envFile)) {
    console.error(`ERROR: .env introuvable à ${envFile}`);
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

  // Ouvre le tunnel
  const localPort = await findFreePort();
  console.error(`[rollback] Sauvegarde : ${backupPath}`);
  console.error(`[rollback] Env=${env}  motif à annuler='${reasonToUndo}'  UUID=${uuids.length}`);
  console.error(`[rollback] Ouverture du tunnel vers ${env} (port local ${localPort})...`);

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

  console.error(`[rollback] Tunnel ouvert. Connexion MySQL...`);

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
      multipleStatements: false,
    });

    // 1) Combien de comptes portent encore EXACTEMENT le motif du backfill ?
    //    (Ceux dont le reason a changé depuis sont volontairement ignorés.)
    const batches = chunk(uuids, BATCH_SIZE);
    let stillMatching = 0;
    const sample: Array<{ ta_uuid: string; login: number }> = [];
    for (const b of batches) {
      const placeholders = b.map(() => "UUID_TO_BIN(?)").join(", ");
      const [rows] = await connection.execute(
        `SELECT BIN_TO_UUID(trading_account_uuid) AS ta_uuid, ctrader_trading_account AS login
         FROM trading_account
         WHERE reason = ? AND trading_account_uuid IN (${placeholders})`,
        [reasonToUndo, ...b]
      );
      const r = rows as Array<{ ta_uuid: string; login: number }>;
      stillMatching += r.length;
      for (const row of r) if (sample.length < SAMPLE_SIZE) sample.push(row);
    }

    const skipped = uuids.length - stillMatching;
    console.error("");
    console.error(`[rollback] À annuler (reason='${reasonToUndo}' toujours présent) : ${stillMatching}`);
    console.error(`[rollback] Ignorés (reason modifié depuis le backfill)          : ${skipped}`);
    console.error(`[rollback] Action : reason -> '' (vide), success NON modifié.`);
    console.error(`[rollback] Échantillon (${Math.min(SAMPLE_SIZE, sample.length)}) :`);
    for (const s of sample) console.error(`             - login ${s.login}  ${s.ta_uuid}`);
    console.error("");

    if (stillMatching === 0) {
      console.error("[rollback] Rien à annuler.");
      return;
    }

    // ── DRY-RUN ──
    if (!apply) {
      console.error("[rollback] DRY-RUN : aucune écriture effectuée.");
      console.error("[rollback] Pour exécuter réellement :");
      console.error(`             npx tsx scripts/rollback-zombie-reason.ts ${backupPath} --apply --operator=<TonNom>`);
      return;
    }

    // ── APPLY ──
    const operator = operatorArg || (await ask("Votre nom/identifiant (pour le log d'audit) : "));
    if (!operator) {
      console.error("ERROR: opérateur requis pour --apply.");
      process.exit(1);
    }

    if (env === "production") {
      console.error("");
      console.error("  /!\\  ATTENTION — PRODUCTION  /!\\");
      console.error(`  Vous allez revenir en arrière sur ${stillMatching} comptes RÉELS (reason -> '').`);
      const confirm = await ask('  Tapez "PRODUCTION" pour confirmer (ou Entrée pour annuler) : ');
      if (confirm !== "PRODUCTION") {
        console.error("[rollback] Action annulée.");
        return;
      }
    }

    await connection.execute(AUDIT_LOG_DDL);
    await connection.beginTransaction();
    try {
      let affected = 0;
      for (const b of batches) {
        const placeholders = b.map(() => "UUID_TO_BIN(?)").join(", ");
        const [res] = await connection.execute(
          `UPDATE trading_account
           SET reason = ''
           WHERE reason = ? AND trading_account_uuid IN (${placeholders})`,
          [reasonToUndo, ...b]
        );
        affected += (res as { affectedRows?: number }).affectedRows ?? 0;
      }

      await connection.execute(
        `INSERT INTO admin_audit_log (action_type, target_table, target_uuid, details, operator, environment)
         VALUES (?, ?, NULL, ?, ?, ?)`,
        [
          "ROLLBACK_ZOMBIE_REASON",
          "trading_account",
          JSON.stringify({
            undone_reason: reasonToUndo,
            restored_to: "",
            backup_file: backupPath,
            in_backup: uuids.length,
            still_matching: stillMatching,
            skipped_changed_since: skipped,
            affected,
          }),
          operator,
          env,
        ]
      );

      await connection.commit();
      console.error("");
      console.error(`[rollback] OK — ${affected} comptes remis à reason='' (backfill annulé).`);
      console.error(`[rollback] Entrée admin_audit_log écrite (operator=${operator}).`);
      console.log(JSON.stringify({ env, in_backup: uuids.length, affected, skipped }));
    } catch (err) {
      await connection.rollback();
      console.error("[rollback] ROLLBACK — aucune modification appliquée.");
      throw err;
    }
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    if (connection) await connection.end().catch(() => {});
    child.kill();
    console.error("[rollback] Terminé.");
  }
}

main();
