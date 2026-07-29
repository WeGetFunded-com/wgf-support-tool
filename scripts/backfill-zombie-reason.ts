#!/usr/bin/env tsx
/**
 * Backfill du `reason` manquant sur les comptes cTrader "fantômes".
 *
 * Contexte : le back-office classe un compte en "actif" / "désactivé" à partir
 * de `trading_account.reason` (et NON de `success`). Des comptes cTrader legacy
 * ont `success = 0` (échoués) mais un `reason` vide, ce qui les fait remonter à
 * tort dans l'onglet "Comptes actifs". Ce script remplit leur `reason` avec
 * NO_TRADE_HISTORY_ZOMBIE ("Compte zombie sans historique") SANS toucher à
 * `success`. Une fois `reason` non-vide, le front les bascule en "Désactivés".
 *
 * Cible (identique au comptage des 1 377) :
 *   - compte cTrader  = PAS de ligne broker_accounts mt5 active
 *   - success = 0     = déjà échoué
 *   - reason IS NULL OR reason = ''  = motif manquant
 *
 * Sûretés :
 *   - DRY-RUN par défaut (aucune écriture) ; --apply pour exécuter.
 *   - Confirmation "PRODUCTION" au clavier quand env = production.
 *   - UPDATE dans une transaction.
 *   - Sauvegarde des UUID affectés dans un fichier JSON (pour rollback).
 *   - Une entrée récapitulative dans admin_audit_log.
 *   - Idempotent : relancé, il ne trouve plus rien (reason désormais rempli).
 *
 * Usage :
 *   Dry-run  : npx tsx scripts/backfill-zombie-reason.ts <production|staging>
 *   Exécuter : npx tsx scripts/backfill-zombie-reason.ts <production|staging> --apply --operator=Nael
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { createInterface } from "node:readline";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

// ── Paramètres métier ────────────────────────────
const ZOMBIE_REASON = "NO_TRADE_HISTORY_ZOMBIE";
const SAMPLE_SIZE = 20;

// WHERE partagé par le SELECT (dry-run) et l'UPDATE (apply) — doit rester
// strictement identique pour que le compte affiché = le compte modifié.
const TARGET_WHERE = `
      ta.success = 0
  AND (ta.reason IS NULL OR ta.reason = '')
  AND NOT EXISTS (
    SELECT 1 FROM broker_accounts ba
    WHERE ba.trading_account_id = ta.trading_account_uuid
      AND ba.broker_name = 'mt5'
      AND ba.active = 1
  )`;

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
  const env = args[0];
  const apply = args.includes("--apply");
  const operatorArg = args.find((a) => a.startsWith("--operator="))?.split("=")[1];

  if (env !== "production" && env !== "staging") {
    console.error("Usage: tsx scripts/backfill-zombie-reason.ts <production|staging> [--apply] [--operator=NAME]");
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
  console.error(`[backfill] Ouverture du tunnel vers ${env} (port local ${localPort})...`);

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

  console.error(`[backfill] Tunnel ouvert. Connexion MySQL...`);

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

    // 1) Récupère la cible exacte (UUID + login) — sert au comptage,
    //    à l'échantillon, à la sauvegarde et (plus tard) au rollback.
    const [targetRows] = await connection.execute(
      `SELECT BIN_TO_UUID(ta.trading_account_uuid) AS ta_uuid,
              ta.ctrader_trading_account            AS login,
              ta.challenge_phase                    AS phase
       FROM trading_account ta
       WHERE ${TARGET_WHERE}`
    );
    const targets = targetRows as Array<{ ta_uuid: string; login: number; phase: number }>;
    const total = targets.length;

    console.error("");
    console.error(`[backfill] Comptes cTrader ciblés (success=0, reason vide) : ${total}`);
    console.error(`[backfill] Motif à écrire : reason = '${ZOMBIE_REASON}'  (success NON modifié)`);
    console.error(`[backfill] Échantillon (${Math.min(SAMPLE_SIZE, total)} premiers) :`);
    for (const t of targets.slice(0, SAMPLE_SIZE)) {
      console.error(`             - login ${t.login}  phase ${t.phase}  ${t.ta_uuid}`);
    }
    console.error("");

    if (total === 0) {
      console.error("[backfill] Rien à faire. (Déjà propre ou aucun compte ne correspond.)");
      return;
    }

    // ── DRY-RUN ──
    if (!apply) {
      console.error("[backfill] DRY-RUN : aucune écriture effectuée.");
      console.error("[backfill] Pour exécuter réellement :");
      console.error(`             npx tsx scripts/backfill-zombie-reason.ts ${env} --apply --operator=<TonNom>`);
      return;
    }

    // ── APPLY ──
    const operator =
      operatorArg || (await ask("Votre nom/identifiant (pour le log d'audit) : "));
    if (!operator) {
      console.error("ERROR: opérateur requis pour --apply.");
      process.exit(1);
    }

    if (env === "production") {
      console.error("");
      console.error("  /!\\  ATTENTION — PRODUCTION  /!\\");
      console.error(`  Vous allez remplir le reason de ${total} comptes RÉELS.`);
      const confirm = await ask('  Tapez "PRODUCTION" pour confirmer (ou Entrée pour annuler) : ');
      if (confirm !== "PRODUCTION") {
        console.error("[backfill] Action annulée.");
        return;
      }
    }

    // Sauvegarde des UUID affectés (pour rollback éventuel)
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = join(projectRoot, "scripts", `backfill-zombie-${env}-${stamp}.json`);
    writeFileSync(
      backupFile,
      JSON.stringify(
        { env, reason: ZOMBIE_REASON, count: total, generated_at: new Date().toISOString(), accounts: targets },
        null,
        2
      )
    );
    console.error(`[backfill] Sauvegarde des UUID ciblés : ${backupFile}`);

    await connection.execute(AUDIT_LOG_DDL);
    await connection.beginTransaction();
    try {
      const [res] = await connection.execute(
        `UPDATE trading_account ta
         SET ta.reason = ?
         WHERE ${TARGET_WHERE}`,
        [ZOMBIE_REASON]
      );
      const affected = (res as { affectedRows?: number }).affectedRows ?? 0;

      await connection.execute(
        `INSERT INTO admin_audit_log (action_type, target_table, target_uuid, details, operator, environment)
         VALUES (?, ?, NULL, ?, ?, ?)`,
        [
          "BACKFILL_ZOMBIE_REASON",
          "trading_account",
          JSON.stringify({
            reason: ZOMBIE_REASON,
            criteria: "ctrader (no active mt5 broker) AND success=0 AND reason empty",
            matched: total,
            affected,
            backup_file: backupFile,
          }),
          operator,
          env,
        ]
      );

      await connection.commit();
      console.error("");
      console.error(`[backfill] OK — ${affected} comptes mis à jour (reason = '${ZOMBIE_REASON}').`);
      console.error(`[backfill] Entrée admin_audit_log écrite (operator=${operator}).`);
      console.log(JSON.stringify({ env, matched: total, affected, backup_file: backupFile }));
    } catch (err) {
      await connection.rollback();
      console.error("[backfill] ROLLBACK — aucune modification appliquée.");
      throw err;
    }
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    if (connection) await connection.end().catch(() => {});
    child.kill();
    console.error("[backfill] Terminé.");
  }
}

main();
