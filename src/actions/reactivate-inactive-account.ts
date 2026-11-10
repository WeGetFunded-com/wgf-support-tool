import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as baQ from "../queries/broker-account.queries.js";
import * as btfQ from "../queries/back-to-funded.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import { REASONS } from "../types.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatPhase, formatDate } from "../utils/format.js";
import { enableMT5Login } from "../mt5-login-client.js";

/**
 * Reactivates an account the watcher failed for INACTIVITY (30 days without
 * opening a position). Nothing was deleted: the account goes back to active,
 * the inactivity count restarts now, a pending Back to Funded offer is closed
 * and the MT5 login the watcher cut is reopened.
 */
export async function reactivateInactiveAccount(session: DatabaseSession, config: Config): Promise<void> {
  const { connection: conn, env, operator } = session;

  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  if (account.success !== 0 || account.reason !== REASONS.INACTIVITY) {
    ui.warn(
      `Ce compte n'est pas desactive pour inactivite (statut ${account.success ?? "actif"}, reason ${account.reason || "-"}). ` +
        'Utilisez "Reactiver un compte" pour les autres cas.'
    );
    return;
  }

  const accountDisplay = await baQ.getAccountDisplayId(conn, account);
  const pendingOffer = await btfQ.getPendingBackToFundedByAccount(conn, account.trading_account_uuid);

  ui.sectionHeader("Compte inactif a reactiver");
  renderKeyValue({
    "Compte": accountDisplay.label,
    "Phase": formatPhase(account.challenge_phase),
    "Debut de phase": formatDate(account.challenge_phase_begin),
    "Desactive le": formatDate(account.latest_update),
    "Offre Back to Funded": pendingOffer
      ? `en attente (${pendingOffer.amount} ${pendingOffer.currency}), sera fermee`
      : "aucune en attente",
    "Compteur d'inactivite": "repart de zero a la reactivation",
  });

  const confirmed = await confirmProductionAction(env, `Reactiver le compte inactif ${accountDisplay.label}`);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  await conn.beginTransaction();
  let expiredOffers = 0;
  try {
    await taQ.reactivateAccount(conn, account.trading_account_uuid, "");
    expiredOffers = await btfQ.expirePendingBackToFunded(conn, account.trading_account_uuid);
    await auditLogQ.insertAuditLog(conn, "REACTIVATE_INACTIVE_ACCOUNT", "trading_account", account.trading_account_uuid, {
      broker_name: accountDisplay.brokerName,
      account_login: accountDisplay.login,
      previous_reason: account.reason,
      back_to_funded_offers_expired: expiredOffers,
    }, operator, env);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  }
  ui.success(`Compte ${accountDisplay.label} reactive, compteur d'inactivite remis a zero.`);
  if (expiredOffers > 0) {
    ui.info("L'offre Back to Funded en attente a ete fermee.");
  }

  if (accountDisplay.brokerName !== "mt5") {
    ui.warn("Compte hors MT5 : rouvrir l'acces cote broker a la main.");
    return;
  }
  try {
    const status = await enableMT5Login(config, env, account.trading_account_uuid);
    ui.success(`Connexion MT5 ${status.login} rouverte.`);
  } catch (err) {
    ui.error(
      `Le compte est actif mais la connexion MT5 n'a pas pu etre rouverte : ${(err as Error).message}. ` +
        'Relancez via "Connexion MT5".'
    );
  }
}
