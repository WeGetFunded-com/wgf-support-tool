import { select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import { createTradingAccount } from "./create-trading-account.js";
import { fixProfitTarget } from "./fix-profit-target.js";
import { activateFunded } from "./activate-funded.js";
import { bypassActivationFees } from "./bypass-activation-fees.js";
import { processBackToFunded } from "./process-back-to-funded.js";
import { deactivateAccount } from "./deactivate-account.js";
import { payoutManage } from "./payout-manage.js";
import { reactivateAccount } from "./reactivate-account.js";
import { createPromo } from "./create-promo.js";
import { manageOptions } from "./manage-options.js";
import { updateCtraderId } from "./update-ctrader-id.js";
import { verifyDeactivation } from "./verify-deactivation.js";
import { forcePhaseTransition } from "./force-phase-transition.js";
import { resetAffiliationBalance } from "./reset-affiliation-balance.js";
import { gdprErase } from "./gdpr-erase.js";
import * as ui from "../ui.js";

type ActionChoice =
  | "create_trading_account"
  | "fix_profit_target"
  | "activate_funded"
  | "bypass_activation_fees"
  | "process_back_to_funded"
  | "force_phase_transition"
  | "deactivate_account"
  | "payout_manage"
  | "reactivate_account"
  | "create_promo"
  | "manage_options"
  | "update_ctrader_id"
  | "verify_deactivation"
  | "reset_affiliation_balance"
  | "gdpr_erase"
  | "back";

export async function actionsMenu(session: DatabaseSession, config: Config): Promise<void> {
  while (true) {
    console.log("");
    ui.sectionHeader("ACTIONS");

    const choice = await select<ActionChoice>({
      message: "Que souhaitez-vous faire ?",
      choices: [
        { name: "Creer un compte de trading", value: "create_trading_account" },
        { name: "Corriger le profit target d'un compte", value: "fix_profit_target" },
        { name: "Activation d'un Funded depuis un compte existant", value: "activate_funded" },
        { name: "Bypass des frais d'activation", value: "bypass_activation_fees" },
        { name: "Traiter une offre Back to Funded (bypass paiement)", value: "process_back_to_funded" },
        { name: "Forcer le passage de phase", value: "force_phase_transition" },
        { name: "Desactiver un compte de trading", value: "deactivate_account" },
        { name: "Gerer une demande de payout", value: "payout_manage" },
        { name: "Reactiver un compte", value: "reactivate_account" },
        { name: "Creer un code promo", value: "create_promo" },
        { name: "Gerer les options d'un compte", value: "manage_options" },
        { name: "Mettre a jour l'identifiant broker (cTrader/MT5)", value: "update_ctrader_id" },
        { name: "Verification de la desactivation d'un compte", value: "verify_deactivation" },
        { name: "Remettre a 0 le solde d'affiliation d'un affilie", value: "reset_affiliation_balance" },
        { name: "Suppression totale RGPD (droit a l'effacement)", value: "gdpr_erase" },
        { name: "Retour", value: "back" },
      ],
    });

    if (choice === "back") return;

    try {
      switch (choice) {
        case "create_trading_account":
          await createTradingAccount(session, config);
          break;
        case "fix_profit_target":
          await fixProfitTarget(session);
          break;
        case "activate_funded":
          await activateFunded(session, config);
          break;
        case "bypass_activation_fees":
          await bypassActivationFees(session, config);
          break;
        case "process_back_to_funded":
          await processBackToFunded(session, config);
          break;
        case "force_phase_transition":
          await forcePhaseTransition(session, config);
          break;
        case "deactivate_account":
          await deactivateAccount(session);
          break;
        case "payout_manage":
          await payoutManage(session);
          break;
        case "reactivate_account":
          await reactivateAccount(session);
          break;
        case "create_promo":
          await createPromo(session);
          break;
        case "manage_options":
          await manageOptions(session);
          break;
        case "update_ctrader_id":
          await updateCtraderId(session);
          break;
        case "verify_deactivation":
          await verifyDeactivation(session, config);
          break;
        case "reset_affiliation_balance":
          await resetAffiliationBalance(session);
          break;
        case "gdpr_erase":
          await gdprErase(session);
          break;
      }
    } catch (err: unknown) {
      const e = err as { message?: string };
      ui.error(`Erreur : ${e.message || "Erreur inconnue"}`);
    }
  }
}
