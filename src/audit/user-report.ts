import type { DatabaseSession } from "../db.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as orderQ from "../queries/order.queries.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as payoutQ from "../queries/payout.queries.js";
import * as tradeHistoryQ from "../queries/trade-history.queries.js";
import * as ui from "../ui.js";
import { searchUserPrompt } from "../utils/prompts.js";
import { renderKeyValue, renderTable } from "../utils/table.js";
import {
  formatDate, formatPhase, formatPercent, formatSuccess,
  formatServer, formatCurrency, formatBoolean, formatChallengeName,
} from "../utils/format.js";

export async function userReport(session: DatabaseSession): Promise<void> {
  const { connection: conn } = session;

  const user = await searchUserPrompt(conn);
  if (!user) return;

  // ── Infos utilisateur ──
  ui.sectionHeader(`Rapport utilisateur : ${user.firstname} ${user.lastname}`);

  renderKeyValue({
    "UUID": user.user_uuid,
    "Email": user.email,
    "CTID": String(user.CTID),
    "Nom": `${user.firstname} ${user.lastname}`,
    "Pays": String(user.country_id ?? "N/A"),
    "Langue": user.language ?? "N/A",
    "Telephone": user.phone_number ?? "N/A",
    "Date de naissance": user.birthday ?? "N/A",
    "Compte actif": formatBoolean(user.valid),
    "Provider": user.provider_id ?? "N/A",
  });

  // ── Commandes ──
  ui.sectionHeader("Commandes");

  const orders = await orderQ.getOrdersByUser(conn, user.user_uuid);

  if (orders.length === 0) {
    ui.info("Aucune commande.");
  } else {
    renderTable(
      ["Order UUID", "Challenge", "Type", "Paiement", "Prix", "Date"],
      orders.map((o) => [
        o.order_uuid.slice(0, 8) + "...",
        o.challenge_name ? formatChallengeName(o.challenge_name) : "N/A",
        o.challenge_type ?? "N/A",
        o.payment_method ?? "N/A",
        o.payment_price != null ? formatCurrency(o.payment_price, o.payment_currency) : "N/A",
        formatDate(o.payment_date),
      ])
    );
  }

  // ── Comptes de trading ──
  ui.sectionHeader("Comptes de trading");

  const accounts = await taQ.getAllTradingAccountsByUser(conn, user.user_uuid);

  if (accounts.length === 0) {
    ui.info("Aucun compte de trading.");
  } else {
    const rows: string[][] = [];
    for (const ta of accounts) {
      const challenge = await challengeQ.getChallengeByUuid(conn, ta.challenge_uuid);
      const balance = await taQ.getLastBalanceAndEquity(conn, ta.trading_account_uuid);
      rows.push([
        String(ta.ctrader_trading_account),
        challenge ? formatChallengeName(challenge.name) : "N/A",
        formatPhase(ta.challenge_phase, challenge?.type),
        formatSuccess(ta.success),
        formatServer(ta.ctrader_server),
        formatPercent(ta.current_profit_target_percent),
        balance ? formatCurrency(balance.balance) : "N/A",
        ta.reason || "-",
      ]);
    }

    renderTable(
      ["cTrader", "Challenge", "Phase", "Statut", "Serveur", "Target", "Balance", "Reason"],
      rows
    );
  }

  // ── Resume positions par compte actif ──
  const activeAccounts = accounts.filter((a) => a.success === null);
  if (activeAccounts.length > 0) {
    ui.sectionHeader("Resume positions (comptes actifs)");

    for (const ta of activeAccounts) {
      const summary = await tradeHistoryQ.getPositionsSummary(conn, ta.trading_account_uuid);
      console.log(
        `    cTrader ${ta.ctrader_trading_account} : ` +
        `${summary.total} positions (${summary.open} ouvertes, ${summary.closed} fermees), ` +
        `PNL total: ${formatCurrency(summary.totalPnl)}` +
        (summary.invalidCount > 0 ? `, ${summary.invalidCount} invalide(s)` : "")
      );
    }
  }

  // ── Demandes de payout ──
  ui.sectionHeader("Demandes de payout");

  const payouts = await payoutQ.getPayoutsByUser(conn, user.user_uuid);

  if (payouts.length === 0) {
    ui.info("Aucune demande de payout.");
  } else {
    renderTable(
      ["Methode", "Montant", "Profit", "Split", "Statut", "Date"],
      payouts.map((p) => [
        p.payout_method,
        formatCurrency(p.payout_amount),
        formatCurrency(p.total_profit),
        p.profit_split,
        p.status,
        formatDate(p.created_at),
      ])
    );
  }
}
