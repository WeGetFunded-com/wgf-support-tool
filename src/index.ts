import { input, select } from "@inquirer/prompts";
import * as ui from "./ui.js";
import { loadConfig } from "./config.js";
import { testConnection } from "./db.js";

type MenuChoice = "staging" | "production" | "quit";

async function mainMenu(): Promise<void> {
  const config = loadConfig();

  while (true) {
    console.log("");
    ui.separator();
    console.log("");

    const choice = await select<MenuChoice>({
      message: "Que souhaitez-vous faire ?",
      choices: [
        {
          name: "Se connecter à la BDD Staging",
          value: "staging" as const,
        },
        {
          name: "Se connecter à la BDD Production",
          value: "production" as const,
        },
        {
          name: "Quitter",
          value: "quit" as const,
        },
      ],
    });

    switch (choice) {
      case "staging":
        await testConnection(config, "staging");
        break;

      case "production": {
        ui.productionWarning();
        const confirm = await input({
          message: 'Tapez "PRODUCTION" pour confirmer (ou Entree pour annuler) :',
        });
        if (confirm.trim() === "PRODUCTION") {
          await testConnection(config, "production");
        } else {
          ui.info("Connexion annulee.");
        }
        break;
      }

      case "quit":
        console.log("");
        ui.info("À bientôt !");
        console.log("");
        process.exit(0);
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
    ui.info("À bientôt !");
    console.log("");
    process.exit(0);
  }
  ui.error(`Erreur inattendue : ${err?.message || err}`);
  process.exit(1);
});
