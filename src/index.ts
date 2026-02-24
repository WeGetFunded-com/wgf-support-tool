import { input, select } from "@inquirer/prompts";
import * as ui from "./ui.js";
import { loadConfig, type Config } from "./config.js";
import { createSession, type DatabaseSession } from "./db.js";
import { auditMenu } from "./audit/index.js";
import { actionsMenu } from "./actions/index.js";

type EnvChoice = "staging" | "production" | "quit";
type HubChoice = "audit" | "actions" | "disconnect";

async function hubMenu(session: DatabaseSession, config: Config): Promise<void> {
  const label = session.env === "staging" ? "Staging" : "Production";

  while (true) {
    console.log("");
    ui.separator();
    console.log("");

    const choice = await select<HubChoice>({
      message: `[${label}] — ${session.operator} — Que souhaitez-vous faire ?`,
      choices: [
        { name: "Audit (consultation)", value: "audit" },
        { name: "Actions (modifications)", value: "actions" },
        { name: "Deconnexion", value: "disconnect" },
      ],
    });

    switch (choice) {
      case "audit":
        await auditMenu(session, config);
        break;
      case "actions":
        await actionsMenu(session, config);
        break;
      case "disconnect":
        await session.close();
        return;
    }
  }
}

async function mainMenu(): Promise<void> {
  const config = loadConfig();

  while (true) {
    console.log("");
    ui.separator();
    console.log("");

    const envChoice = await select<EnvChoice>({
      message: "Que souhaitez-vous faire ?",
      choices: [
        { name: "Se connecter a la BDD Staging", value: "staging" },
        { name: "Se connecter a la BDD Production", value: "production" },
        { name: "Quitter", value: "quit" },
      ],
    });

    if (envChoice === "quit") {
      console.log("");
      ui.info("A bientot !");
      console.log("");
      process.exit(0);
    }

    // Production confirmation
    if (envChoice === "production") {
      ui.productionWarning();
      const confirm = await input({
        message: 'Tapez "PRODUCTION" pour confirmer (ou Entree pour annuler) :',
      });
      if (confirm.trim() !== "PRODUCTION") {
        ui.info("Connexion annulee.");
        continue;
      }
    }

    // Ask for operator name
    const operator = await input({
      message: "Votre nom/identifiant (pour le log d'audit) :",
      validate: (v) => {
        if (v.trim().length < 2) return "Minimum 2 caracteres";
        return true;
      },
    });

    // Create session
    try {
      const session = await createSession(config, envChoice, operator.trim());
      await hubMenu(session, config);
    } catch {
      // Error already displayed by createSession
      ui.info("Retour au menu principal...");
    }
  }
}

async function main(): Promise<void> {
  ui.banner();
  await mainMenu();
}

main().catch((err) => {
  if (err?.name === "ExitPromptError") {
    console.log("");
    ui.info("A bientot !");
    console.log("");
    process.exit(0);
  }
  ui.error(`Erreur inattendue : ${err?.message || err}`);
  process.exit(1);
});
