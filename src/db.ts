import mysql from "mysql2/promise";
import { type Config, type Environment, getEnvConfig } from "./config.js";
import { openTunnel } from "./tunnel.js";
import * as ui from "./ui.js";

export async function testConnection(
  config: Config,
  env: Environment
): Promise<boolean> {
  const envConfig = getEnvConfig(config, env);
  const label = env === "staging" ? "Staging" : "Production";

  let tunnel: { localPort: number; close: () => void } | null = null;
  let connection: mysql.Connection | null = null;

  try {
    tunnel = await openTunnel(config, env);

    ui.info(`Connexion MySQL à ${label}...`);
    ui.info(`  User : ${envConfig.user}`);
    ui.info(`  Base : ${envConfig.database}`);
    console.log("");

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

    const [rows] = await connection.execute(
      "SELECT COUNT(*) as total FROM information_schema.tables WHERE table_schema = ?",
      [envConfig.database]
    );
    const tableCount = (rows as Array<{ total: number }>)[0].total;

    ui.success(`Connecté à ${label} avec succès !`);
    ui.info(`${tableCount} tables trouvées dans la base "${envConfig.database}".`);

    return true;
  } catch (err: unknown) {
    const error = err as { code?: string; message?: string };

    switch (error.code) {
      case "ECONNREFUSED":
        ui.error(
          "Impossible de joindre le serveur via le tunnel."
        );
        break;
      case "ETIMEDOUT":
      case "ECONNRESET":
        ui.error(
          "Le serveur ne répond pas (timeout). Réessayez."
        );
        break;
      case "ER_ACCESS_DENIED_ERROR":
        ui.error(
          "Identifiants incorrects. Verifiez le fichier .env."
        );
        break;
      case "ER_BAD_DB_ERROR":
        ui.error(`La base "${envConfig.database}" n'existe pas sur ce serveur.`);
        break;
      default:
        ui.error(error.message || "Erreur inconnue");
    }

    return false;
  } finally {
    if (connection) {
      await connection.end().catch(() => {});
    }
    if (tunnel) {
      tunnel.close();
    }
  }
}
