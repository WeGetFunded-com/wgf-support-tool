import { input } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as baQ from "../queries/broker-account.queries.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatPhase, formatServer } from "../utils/format.js";

export async function updateCtraderId(session: DatabaseSession): Promise<void> {
  const { connection: conn, env, operator } = session;

  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  const accountDisplay = await baQ.getAccountDisplayId(conn, account);

  ui.sectionHeader("Compte a mettre a jour");
  renderKeyValue({
    "UUID": account.trading_account_uuid,
    "Compte": accountDisplay.label,
    "Phase": formatPhase(account.challenge_phase),
    "Serveur": formatServer(account.ctrader_server),
  });

  const loginLabel = accountDisplay.brokerName === "mt5" ? "Login MT5" : "cTrader Account ID";

  const newIdStr = await input({
    message: `Nouveau ${loginLabel} :`,
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n <= 0) return "Doit etre un entier positif";
      return true;
    },
  });

  const newId = parseInt(newIdStr, 10);

  const description =
    `Modifier ${loginLabel} du compte ${account.trading_account_uuid.slice(0, 8)}... : ` +
    `${accountDisplay.login} → ${newId}`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  await conn.beginTransaction();
  try {
    if (accountDisplay.brokerName === "mt5") {
      // MT5: update broker_accounts table
      const brokerAccount = await baQ.getActiveBrokerAccountByTradingAccount(conn, account.trading_account_uuid);
      if (!brokerAccount) {
        ui.error("Broker account introuvable pour ce compte MT5.");
        await conn.rollback();
        return;
      }
      await baQ.updateBrokerAccountLogin(conn, brokerAccount.id, newId);
    } else {
      // cTrader: update trading_account table (legacy)
      await taQ.updateCtraderAccountId(conn, account.trading_account_uuid, newId);
    }

    await auditLogQ.insertAuditLog(conn, "UPDATE_BROKER_LOGIN", "trading_account", account.trading_account_uuid, {
      broker_name: accountDisplay.brokerName,
      old_login: accountDisplay.login,
      new_login: newId,
    }, operator, env);

    await conn.commit();
    ui.success(`${loginLabel} mis a jour : ${newId}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}
