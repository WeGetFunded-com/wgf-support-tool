import { input } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatPhase, formatServer } from "../utils/format.js";

export async function updateCtraderId(session: DatabaseSession): Promise<void> {
  const { connection: conn, env, operator } = session;

  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  ui.sectionHeader("Compte a mettre a jour");
  renderKeyValue({
    "UUID": account.trading_account_uuid,
    "cTrader ID actuel": String(account.ctrader_trading_account),
    "Phase": formatPhase(account.challenge_phase),
    "Serveur": formatServer(account.ctrader_server),
  });

  const newIdStr = await input({
    message: "Nouveau cTrader Account ID :",
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n <= 0) return "Doit etre un entier positif";
      return true;
    },
  });

  const newId = parseInt(newIdStr, 10);

  const description =
    `Modifier cTrader ID du compte ${account.trading_account_uuid.slice(0, 8)}... : ` +
    `${account.ctrader_trading_account} → ${newId}`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  await conn.beginTransaction();
  try {
    await taQ.updateCtraderAccountId(conn, account.trading_account_uuid, newId);

    await auditLogQ.insertAuditLog(conn, "UPDATE_CTRADER_ID", "trading_account", account.trading_account_uuid, {
      old_ctrader_id: account.ctrader_trading_account,
      new_ctrader_id: newId,
    }, operator, env);

    await conn.commit();
    ui.success(`cTrader ID mis a jour : ${newId}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}
