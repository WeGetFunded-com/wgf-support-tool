import mysql from "mysql2/promise";
import { type Config, type Environment, getEnvConfig } from "./config.js";
import { openTunnel, type Tunnel } from "./tunnel.js";
import * as ui from "./ui.js";

export interface DatabaseSession {
  connection: mysql.Connection;
  env: Environment;
  operator: string;
  config: Config;
  close(): Promise<void>;
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

const AFFILIATION_SETTLEMENT_DDL = `
CREATE TABLE IF NOT EXISTS affiliation_settlement (
  settlement_uuid BINARY(16) PRIMARY KEY,
  owner_uuid BINARY(16) NOT NULL,
  amount DECIMAL(14, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  settled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operator VARCHAR(128) NOT NULL,
  environment VARCHAR(16) NOT NULL,
  note TEXT NULL,
  INDEX idx_owner_uuid (owner_uuid),
  INDEX idx_settled_at (settled_at)
)`;

export async function createSession(
  config: Config,
  env: Environment,
  operator: string
): Promise<DatabaseSession> {
  const envConfig = getEnvConfig(config, env);
  const label = env === "staging" ? "Staging" : "Production";

  let tunnel: Tunnel | null = null;
  let connection: mysql.Connection | null = null;

  try {
    tunnel = await openTunnel(config, env);

    ui.info(`Connexion MySQL a ${label}...`);

    connection = await mysql.createConnection({
      host: "127.0.0.1",
      port: tunnel.localPort,
      user: envConfig.user,
      password: envConfig.password,
      database: envConfig.database,
      connectTimeout: 10000,
      ssl: { rejectUnauthorized: false },
    });

    await connection.execute("SELECT 1");
    ui.success(`Connecte a ${label} !`);

    // Auto-create audit log table
    await connection.execute(AUDIT_LOG_DDL);

    // Auto-create affiliation settlement table
    await connection.execute(AFFILIATION_SETTLEMENT_DDL);

    const tunnelRef = tunnel;
    const connRef = connection;

    return {
      connection: connRef,
      env,
      operator,
      config,
      async close() {
        await connRef.end().catch(() => {});
        tunnelRef.close();
        ui.info("Session fermee.");
      },
    };
  } catch (err: unknown) {
    if (connection) await connection.end().catch(() => {});
    if (tunnel) tunnel.close();

    const error = err as { code?: string; message?: string };
    switch (error.code) {
      case "ECONNREFUSED":
        ui.error("Impossible de joindre le serveur via le tunnel.");
        break;
      case "ETIMEDOUT":
      case "ECONNRESET":
        ui.error("Le serveur ne repond pas (timeout).");
        break;
      case "ER_ACCESS_DENIED_ERROR":
        ui.error("Identifiants incorrects. Verifiez le fichier .env.");
        break;
      case "ER_BAD_DB_ERROR":
        ui.error(`La base "${envConfig.database}" n'existe pas.`);
        break;
      default:
        ui.error(error.message || "Erreur inconnue");
    }
    throw err;
  }
}
