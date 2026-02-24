import { input, select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import { REASONS } from "../types.js";
import * as ui from "../ui.js";
import { confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatPhase, formatPercent, formatSuccess, formatServer } from "../utils/format.js";

export async function reactivateAccount(session: DatabaseSession): Promise<void> {
  const { connection: conn, env, operator } = session;

  // Search by cTrader Account ID
  const ctraderIdStr = await input({
    message: "cTrader Account ID du compte a reactiver :",
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n <= 0) return "Doit etre un entier positif";
      return true;
    },
  });

  const ctraderId = parseInt(ctraderIdStr, 10);
  const account = await taQ.getTradingAccountByCtrader(conn, ctraderId);

  if (!account) {
    ui.warn("Aucun compte trouve avec ce cTrader ID.");
    return;
  }

  if (account.success === null) {
    ui.warn("Ce compte est deja actif.");
    return;
  }

  if (account.success !== 0 && account.success !== 1) {
    ui.warn(`Ce compte a le statut success=${account.success}. Seuls les comptes avec success=0 ou success=1 peuvent etre reactives.`);
    return;
  }

  // Show current state
  const rules = await challengeQ.getChallengeRules(conn, account.challenge_uuid, account.challenge_phase);

  ui.sectionHeader("Compte a reactiver");
  renderKeyValue({
    "cTrader ID": String(account.ctrader_trading_account),
    "Phase": formatPhase(account.challenge_phase),
    "Serveur": formatServer(account.ctrader_server),
    "Statut": formatSuccess(account.success),
    "Reason": account.reason || "-",
    "Profit Target actuel": formatPercent(account.current_profit_target_percent),
    "Profit Target reference (rules)": rules ? formatPercent(rules.profit_target_percent) : "N/A",
  });

  // Ask if profit target adjustment is needed
  const adjustTarget = await select({
    message: "Souhaitez-vous reajuster le profit target ?",
    choices: [
      { name: "Non — garder la valeur actuelle", value: "no" },
      { name: "Oui — saisir une nouvelle valeur", value: "yes" },
    ],
  });

  let newProfitTarget: number | undefined;
  let reason = "";

  if (adjustTarget === "yes") {
    const newValueStr = await input({
      message: `Nouveau profit target (decimal, ex: 0.08 pour 8%) [actuel: ${formatPercent(account.current_profit_target_percent)}] :`,
      validate: (v) => {
        const n = parseFloat(v);
        if (isNaN(n) || n < 0 || n > 1) return "Doit etre un decimal entre 0 et 1";
        return true;
      },
    });
    newProfitTarget = parseFloat(newValueStr);
    reason = REASONS.PROFIT_TARGET_RECALCULATED;
  }

  const description =
    `Reactiver le compte cTrader ${account.ctrader_trading_account}` +
    (newProfitTarget !== undefined
      ? ` avec profit target ${formatPercent(newProfitTarget)}`
      : "");

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  await conn.beginTransaction();
  try {
    await taQ.reactivateAccount(conn, account.trading_account_uuid, reason, newProfitTarget);

    await auditLogQ.insertAuditLog(conn, "REACTIVATE_ACCOUNT", "trading_account", account.trading_account_uuid, {
      ctrader_id: account.ctrader_trading_account,
      previous_reason: account.reason,
      previous_success: account.success,
      new_profit_target: newProfitTarget ?? account.current_profit_target_percent,
      profit_target_adjusted: adjustTarget === "yes",
    }, operator, env);

    await conn.commit();
    ui.success(`Compte cTrader ${account.ctrader_trading_account} reactive !`);
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}
