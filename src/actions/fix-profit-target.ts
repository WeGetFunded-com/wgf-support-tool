import { input } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import { REASONS } from "../types.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatPercent } from "../utils/format.js";

export async function fixProfitTarget(session: DatabaseSession): Promise<void> {
  const { connection: conn, env, operator } = session;

  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  // Show current state
  const rules = await challengeQ.getChallengeRules(conn, account.challenge_uuid, account.challenge_phase);

  ui.sectionHeader("Etat actuel");
  renderKeyValue({
    "cTrader ID": String(account.ctrader_trading_account),
    "Phase": String(account.challenge_phase),
    "Profit Target actuel": formatPercent(account.current_profit_target_percent),
    "Valeur de reference (rules)": rules ? formatPercent(rules.profit_target_percent) : "N/A",
  });

  const newValueStr = await input({
    message: "Nouveau profit target (decimal, ex: 0.08 pour 8%) :",
    validate: (v) => {
      const n = parseFloat(v);
      if (isNaN(n) || n < 0 || n > 1) return "Doit etre un decimal entre 0 et 1";
      return true;
    },
  });

  const newValue = parseFloat(newValueStr);

  const description =
    `Modifier profit target du compte cTrader ${account.ctrader_trading_account} : ` +
    `${formatPercent(account.current_profit_target_percent)} → ${formatPercent(newValue)}`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  await conn.beginTransaction();
  try {
    await taQ.updateProfitTarget(
      conn,
      account.trading_account_uuid,
      newValue,
      REASONS.PROFIT_TARGET_RECALCULATED
    );

    await auditLogQ.insertAuditLog(conn, "FIX_PROFIT_TARGET", "trading_account", account.trading_account_uuid, {
      ctrader_id: account.ctrader_trading_account,
      old_value: account.current_profit_target_percent,
      new_value: newValue,
    }, operator, env);

    await conn.commit();
    ui.success(`Profit target mis a jour : ${formatPercent(newValue)}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}
