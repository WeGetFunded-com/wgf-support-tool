import { select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import { DEACTIVATION_REASONS } from "../types.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatPhase, formatPercent, formatSuccess, formatServer } from "../utils/format.js";

export async function deactivateAccount(session: DatabaseSession): Promise<void> {
  const { connection: conn, env, operator } = session;

  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  if (account.success !== null) {
    ui.warn(`Ce compte n'est pas actif (statut: ${formatSuccess(account.success)}, reason: ${account.reason || "-"}).`);
    return;
  }

  ui.sectionHeader("Compte a desactiver");
  renderKeyValue({
    "cTrader ID": String(account.ctrader_trading_account),
    "Phase": formatPhase(account.challenge_phase),
    "Serveur": formatServer(account.ctrader_server),
    "Profit Target": formatPercent(account.current_profit_target_percent),
    "Statut": formatSuccess(account.success),
  });

  const reason = await select({
    message: "Motif de desactivation :",
    choices: DEACTIVATION_REASONS.map((r) => ({
      name: `${r.value} — ${r.label}`,
      value: r.value,
    })),
  });

  const description =
    `Desactiver le compte cTrader ${account.ctrader_trading_account} ` +
    `(reason: ${reason})`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  await conn.beginTransaction();
  try {
    await taQ.deactivateAccount(conn, account.trading_account_uuid, reason);

    await auditLogQ.insertAuditLog(conn, "DEACTIVATE_ACCOUNT", "trading_account", account.trading_account_uuid, {
      ctrader_id: account.ctrader_trading_account,
      phase: account.challenge_phase,
      reason,
    }, operator, env);

    await conn.commit();
    ui.success(`Compte cTrader ${account.ctrader_trading_account} desactive (${reason}).`);
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}
