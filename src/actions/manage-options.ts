import { select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as optionsQ from "../queries/options.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderTable } from "../utils/table.js";
import { formatPercent } from "../utils/format.js";

export async function manageOptions(session: DatabaseSession): Promise<void> {
  const { connection: conn, env, operator } = session;

  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  // Get current options on the account
  const currentOptions = await taQ.getTradingAccountOptions(conn, account.trading_account_uuid);
  const allOptions = await optionsQ.getAllOptions(conn);

  ui.sectionHeader(`Options du compte cTrader ${account.ctrader_trading_account}`);

  if (currentOptions.length > 0) {
    renderTable(
      ["Nom", "Majoration"],
      currentOptions.map((o) => [o.name, formatPercent(o.majoration_percent)])
    );
  } else {
    ui.info("Aucune option sur ce compte.");
  }

  const action = await select({
    message: "Que souhaitez-vous faire ?",
    choices: [
      { name: "Ajouter une option", value: "add" },
      { name: "Retirer une option", value: "remove" },
      { name: "Retour", value: "back" },
    ],
  });

  if (action === "back") return;

  if (action === "add") {
    const currentUuids = new Set(currentOptions.map((o) => o.option_uuid));
    const available = allOptions.filter((o) => !currentUuids.has(o.option_uuid));

    if (available.length === 0) {
      ui.info("Toutes les options sont deja actives sur ce compte.");
      return;
    }

    const optionIdx = await select({
      message: "Option a ajouter :",
      choices: available.map((o, i) => ({
        name: `${o.name} (majoration: ${formatPercent(o.majoration_percent)})`,
        value: i,
      })),
    });

    const option = available[optionIdx];

    const description = `Ajouter l'option "${option.name}" au compte cTrader ${account.ctrader_trading_account}`;
    const confirmed = await confirmProductionAction(env, description);
    if (!confirmed) {
      ui.info("Action annulee.");
      return;
    }

    await conn.beginTransaction();
    try {
      await taQ.addTradingAccountOption(conn, account.trading_account_uuid, option.option_uuid);

      await auditLogQ.insertAuditLog(conn, "ADD_OPTION", "trading_account_options", account.trading_account_uuid, {
        ctrader_id: account.ctrader_trading_account,
        option_name: option.name,
        option_uuid: option.option_uuid,
      }, operator, env);

      await conn.commit();
      ui.success(`Option "${option.name}" ajoutee.`);
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  if (action === "remove") {
    if (currentOptions.length === 0) {
      ui.info("Aucune option a retirer.");
      return;
    }

    const optionIdx = await select({
      message: "Option a retirer :",
      choices: currentOptions.map((o, i) => ({
        name: `${o.name} (majoration: ${formatPercent(o.majoration_percent)})`,
        value: i,
      })),
    });

    const option = currentOptions[optionIdx];

    const description = `Retirer l'option "${option.name}" du compte cTrader ${account.ctrader_trading_account}`;
    const confirmed = await confirmProductionAction(env, description);
    if (!confirmed) {
      ui.info("Action annulee.");
      return;
    }

    await conn.beginTransaction();
    try {
      await taQ.removeTradingAccountOption(conn, account.trading_account_uuid, option.option_uuid);

      await auditLogQ.insertAuditLog(conn, "REMOVE_OPTION", "trading_account_options", account.trading_account_uuid, {
        ctrader_id: account.ctrader_trading_account,
        option_name: option.name,
        option_uuid: option.option_uuid,
      }, operator, env);

      await conn.commit();
      ui.success(`Option "${option.name}" retiree.`);
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }
}
