import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import dotenv from "dotenv";
import * as ui from "./ui.js";

/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore — __dirname existe en CJS (bundle), pas en ESM (dev tsx)
const SCRIPT_DIR: string = typeof __dirname !== "undefined" ? __dirname : process.cwd();
const ENV_FILE = join(SCRIPT_DIR, ".env");

export interface Config {
  kubeServer: string;
  kubeToken: string;
  staging: {
    namespace: string;
    podName: string;
    podPort: number;
    database: string;
    user: string;
    password: string;
  };
  production: {
    namespace: string;
    podName: string;
    podPort: number;
    database: string;
    user: string;
    password: string;
  };
}

export type Environment = "staging" | "production";

const REQUIRED_KEYS = [
  "KUBE_SERVER", "KUBE_TOKEN",
  "STAGING_NAMESPACE", "STAGING_POD_NAME", "STAGING_POD_PORT", "STAGING_DB_NAME",
  "STAGING_DB_USER", "STAGING_DB_PASSWORD",
  "PRODUCTION_NAMESPACE", "PRODUCTION_POD_NAME", "PRODUCTION_POD_PORT", "PRODUCTION_DB_NAME",
  "PRODUCTION_DB_USER", "PRODUCTION_DB_PASSWORD",
];

export function loadConfig(): Config {
  if (!existsSync(ENV_FILE)) {
    console.log("");
    ui.error("Fichier .env introuvable.");
    console.log("");
    ui.info("Placez le fichier .env fourni par votre administrateur");
    ui.info(`dans le dossier de l'outil : ${ENV_FILE}`);
    console.log("");
    process.exit(1);
  }

  const envContent = readFileSync(ENV_FILE, "utf-8");
  const parsed = dotenv.parse(envContent);

  const missing = REQUIRED_KEYS.filter((key) => !parsed[key]);
  if (missing.length > 0) {
    console.log("");
    ui.error("Le fichier .env est incomplet. Clés manquantes :");
    for (const key of missing) {
      ui.warn(`  - ${key}`);
    }
    console.log("");
    ui.info("Demandez un fichier .env complet à votre administrateur.");
    console.log("");
    process.exit(1);
  }

  return {
    kubeServer: parsed["KUBE_SERVER"],
    kubeToken: parsed["KUBE_TOKEN"],
    staging: {
      namespace: parsed["STAGING_NAMESPACE"],
      podName: parsed["STAGING_POD_NAME"],
      podPort: parseInt(parsed["STAGING_POD_PORT"], 10),
      database: parsed["STAGING_DB_NAME"],
      user: parsed["STAGING_DB_USER"],
      password: parsed["STAGING_DB_PASSWORD"],
    },
    production: {
      namespace: parsed["PRODUCTION_NAMESPACE"],
      podName: parsed["PRODUCTION_POD_NAME"],
      podPort: parseInt(parsed["PRODUCTION_POD_PORT"], 10),
      database: parsed["PRODUCTION_DB_NAME"],
      user: parsed["PRODUCTION_DB_USER"],
      password: parsed["PRODUCTION_DB_PASSWORD"],
    },
  };
}

export function getEnvConfig(config: Config, env: Environment) {
  return config[env];
}
