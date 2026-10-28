import { select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import * as baQ from "../queries/broker-account.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatSuccess } from "../utils/format.js";
import {
  getMT5LoginStatus,
  enableMT5Login,
  resetMT5Password,
  type MT5LoginStatus,
} from "../mt5-login-client.js";

type Mt5LoginChoice = "enable_login" | "reset_password" | "back";

/**
 * "Invalid account" on MT5 has two causes: the login was cut (guard breach the
 * watcher rejected) or the trader changed his password. The diagnosis tells
 * which one, so support never has to create a new account.
 */
export async function mt5Login(session: DatabaseSession, config: Config): Promise<void> {
  const { connection: conn, env, operator } = session;

  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  const brokerAccount = await baQ.getActiveBrokerAccountByTradingAccount(conn, account.trading_account_uuid);
  if (!brokerAccount || brokerAccount.broker_name !== "mt5") {
    ui.warn("Ce compte n'a pas de compte MT5 actif.");
    return;
  }

  let status = await getMT5LoginStatus(config, env, account.trading_account_uuid);
  renderStatus(status, formatSuccess(account.success));

  const isActive = account.success === null;
  const choices: { name: string; value: Mt5LoginChoice }[] = [];
  if (!status.login_enabled && isActive) {
    choices.push({ name: "Rouvrir la connexion MT5", value: "enable_login" });
  }
  choices.push({ name: "Reinitialiser le mot de passe MT5", value: "reset_password" });
  choices.push({ name: "Retour", value: "back" });

  if (!status.login_enabled && !isActive) {
    ui.info("Connexion coupee normalement : le challenge est termine.");
  }

  const choice = await select<Mt5LoginChoice>({ message: "Action ?", choices });
  if (choice === "back") return;

  if (choice === "enable_login") {
    const confirmed = await confirmProductionAction(env, `Rouvrir la connexion MT5 du login ${status.login}`);
    if (!confirmed) {
      ui.info("Action annulee.");
      return;
    }
    status = await enableMT5Login(config, env, account.trading_account_uuid);
    await auditLogQ.insertAuditLog(conn, "MT5_ENABLE_LOGIN", "trading_account", account.trading_account_uuid, {
      login: status.login,
      login_enabled: status.login_enabled,
    }, operator, env);
    if (!status.login_enabled) {
      ui.error("MT5 indique toujours la connexion coupee.");
      return;
    }
    ui.success(`Connexion MT5 ${status.login} rouverte : le client peut se reconnecter avec les identifiants du dashboard.`);
    return;
  }

  const confirmed = await confirmProductionAction(
    env,
    `Reinitialiser le mot de passe MT5 du login ${status.login} (l'ancien ne fonctionnera plus)`
  );
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  const reset = await resetMT5Password(config, env, account.trading_account_uuid);
  try {
    await conn.beginTransaction();
    await baQ.updateBrokerAccountPassword(conn, brokerAccount.id, reset.password);
    await auditLogQ.insertAuditLog(conn, "MT5_RESET_PASSWORD", "broker_accounts", brokerAccount.id, {
      login: reset.login,
      trading_account_uuid: account.trading_account_uuid,
    }, operator, env);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    ui.error(
      `Mot de passe change sur MT5 mais NON enregistre en base. Nouveau mot de passe a reporter dans broker_accounts : ${reset.password}`
    );
    throw err;
  }

  status = await getMT5LoginStatus(config, env, account.trading_account_uuid);
  if (!status.dashboard_password_valid) {
    ui.error(`Le mot de passe enregistre est refuse par MT5 : ${status.dashboard_password_check}`);
    return;
  }
  ui.success(`Nouveau mot de passe MT5 ${reset.login} enregistre : le client le voit dans "Voir les identifiants".`);
  if (!status.login_enabled) {
    ui.warn("La connexion est encore coupee : utilisez aussi \"Rouvrir la connexion MT5\".");
  }
}

function renderStatus(status: MT5LoginStatus, accountStatus: string): void {
  ui.sectionHeader(`Connexion MT5 ${status.login}`);
  renderKeyValue({
    "Statut du compte": accountStatus,
    "Connexion MT5": status.login_enabled ? "ouverte" : "COUPEE",
    "Mot de passe du dashboard": status.dashboard_password_valid
      ? "valide"
      : `REFUSE par MT5 (${status.dashboard_password_check})`,
    "Creation (heure serveur MT5)": status.registered_at || "-",
    "Dernier changement de mot de passe": status.password_changed_at || "-",
    "Derniere connexion": status.last_access_at || "-",
    "Le client peut changer son mot de passe": status.trader_can_change_password ? "oui" : "non",
  });
}
