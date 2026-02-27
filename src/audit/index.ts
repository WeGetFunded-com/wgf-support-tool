import { select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import { userReport } from "./user-report.js";
import { tradingAccountReport } from "./trading-account-report.js";
import { activeAccounts } from "./active-accounts.js";
import { searchUsers } from "./search-users.js";
import { payoutReport } from "./payout-report.js";
import { deactivationAnalysis } from "./deactivation-analysis.js";
import { promoUsageAnalysis } from "./promo-usage-analysis.js";
import * as ui from "../ui.js";

type AuditChoice =
  | "user_report"
  | "ta_report"
  | "active_accounts"
  | "search_users"
  | "payout_report"
  | "deactivation_analysis"
  | "promo_usage"
  | "back";

export async function auditMenu(session: DatabaseSession, config: Config): Promise<void> {
  while (true) {
    console.log("");
    ui.sectionHeader("AUDIT");

    const choice = await select<AuditChoice>({
      message: "Que souhaitez-vous consulter ?",
      choices: [
        { name: "Rapport complet d'un utilisateur", value: "user_report" },
        { name: "Rapport complet d'un compte de trading", value: "ta_report" },
        { name: "Comptes de trading actifs d'un utilisateur", value: "active_accounts" },
        { name: "Rechercher des utilisateurs", value: "search_users" },
        { name: "Rapport des demandes de payout", value: "payout_report" },
        { name: "Verification de la desactivation d'un compte", value: "deactivation_analysis" },
        { name: "Analyse de l'utilisation d'un code promo", value: "promo_usage" },
        { name: "Retour", value: "back" },
      ],
    });

    if (choice === "back") return;

    try {
      switch (choice) {
        case "user_report":
          await userReport(session, config);
          break;
        case "ta_report":
          await tradingAccountReport(session);
          break;
        case "active_accounts":
          await activeAccounts(session);
          break;
        case "search_users":
          await searchUsers(session);
          break;
        case "payout_report":
          await payoutReport(session);
          break;
        case "deactivation_analysis":
          await deactivationAnalysis(session, config);
          break;
        case "promo_usage":
          await promoUsageAnalysis(session);
          break;
      }
    } catch (err: unknown) {
      const e = err as { message?: string };
      ui.error(`Erreur : ${e.message || "Erreur inconnue"}`);
    }
  }
}
