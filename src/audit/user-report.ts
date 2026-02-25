import { select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import type { DbUser } from "../types.js";
import type { OrderWithDetails } from "../queries/order.queries.js";
import type { DbTradingAccount, DbChallenge, DbTradingAccountBalance, DbPayoutRequest } from "../types.js";
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
import { interactiveChat, WGF_SYSTEM_PROMPT } from "../ai.js";

export async function userReport(session: DatabaseSession, config: Config): Promise<void> {
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
      ["Order UUID", "Challenge", "Type", "Balance", "Paiement", "Prix", "Ref", "Date"],
      orders.map((o) => [
        o.order_uuid.slice(0, 8) + "...",
        o.challenge_name ? formatChallengeName(o.challenge_name) : "N/A",
        o.challenge_type ?? "N/A",
        o.challenge_initial_coins_amount != null ? formatCurrency(o.challenge_initial_coins_amount) : "N/A",
        o.payment_method ?? "N/A",
        o.payment_price != null ? formatCurrency(o.payment_price / 100, o.payment_currency) : "N/A",
        o.payment_proof ? o.payment_proof.slice(0, 12) + "..." : "N/A",
        formatDate(o.payment_date),
      ])
    );
  }

  // ── Paiements ──
  ui.sectionHeader("Paiements");

  const ordersWithPayment = orders.filter((o) => o.payment_uuid);
  if (ordersWithPayment.length === 0) {
    ui.info("Aucun paiement.");
  } else {
    renderTable(
      ["Payment UUID", "Methode", "Prix", "Devise", "Reference", "Date"],
      ordersWithPayment.map((o) => [
        o.payment_uuid!.slice(0, 8) + "...",
        o.payment_method ?? "N/A",
        o.payment_price != null ? formatCurrency(o.payment_price / 100, o.payment_currency) : "N/A",
        (o.payment_currency ?? "N/A").toUpperCase(),
        o.payment_proof ?? "N/A",
        formatDate(o.payment_date),
      ])
    );
  }

  // ── Comptes de trading ──
  ui.sectionHeader("Comptes de trading");

  const accounts = await taQ.getAllTradingAccountsByUser(conn, user.user_uuid);

  const accountDetails: Array<{
    ta: DbTradingAccount;
    challenge: DbChallenge | null;
    balance: DbTradingAccountBalance | null;
  }> = [];

  if (accounts.length === 0) {
    ui.info("Aucun compte de trading.");
  } else {
    const rows: string[][] = [];
    for (const ta of accounts) {
      const challenge = await challengeQ.getChallengeByUuid(conn, ta.challenge_uuid);
      const balance = await taQ.getLastBalanceAndEquity(conn, ta.trading_account_uuid);
      accountDetails.push({ ta, challenge, balance });
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

  // ── Analyse AI optionnelle ──
  if (!config.openRouterApiKey) {
    return;
  }

  console.log("");
  const aiChoice = await select({
    message: "Souhaitez-vous lancer une analyse AI ?",
    choices: [
      { name: "Lancer l'analyse AI (chat interactif MiniMax)", value: "ai" },
      { name: "Terminer", value: "done" },
    ],
  });

  if (aiChoice === "done") return;

  const rawData = buildUserReportRawData(user, orders, accountDetails, payouts);

  await interactiveChat(
    config.openRouterApiKey,
    USER_REPORT_SYSTEM_PROMPT,
    `Voici les donnees completes d'un utilisateur WeGetFunded. Analyse l'ensemble et signale toute anomalie :\n\n${rawData}`
  );
}

// ── System prompt for user report AI analysis ──

const USER_REPORT_SYSTEM_PROMPT = `${WGF_SYSTEM_PROMPT}

=== CONTEXTE SUPPLEMENTAIRE : RAPPORT UTILISATEUR ===

Tu recois les donnees completes d'un utilisateur : commandes, paiements, comptes de trading, payouts.

En plus de ton expertise sur les regles de challenges, tu dois aussi :
1. Analyser l'ensemble des donnees pour detecter des anomalies dans le processus
2. Verifier la coherence entre commandes, paiements et comptes de trading
3. Repondre aux questions de l'operateur support

Anomalies a detecter :
- Incoherences entre le prix paye et le challenge (ex: prix incorrect pour le type de challenge)
- Paiements dupliques ou manquants
- Comptes de trading dans un etat anormal (phase incorrecte, balance suspecte)
- Commandes sans compte de trading associe (echec TAM possible)
- Payouts suspects (montant, statut)
- Comptes actifs en phase funded sans paiement d'activation
- Comptes avec des raisons de desactivation inattendues`;

// ── Build raw data string for AI context ──

function buildUserReportRawData(
  user: DbUser,
  orders: OrderWithDetails[],
  accountDetails: Array<{
    ta: DbTradingAccount;
    challenge: DbChallenge | null;
    balance: DbTradingAccountBalance | null;
  }>,
  payouts: DbPayoutRequest[]
): string {
  const sections: string[] = [];

  sections.push(`=== UTILISATEUR ===
UUID: ${user.user_uuid}
Email: ${user.email}
Nom: ${user.firstname} ${user.lastname}
CTID: ${user.CTID}
Pays: ${user.country_id ?? "N/A"}
Langue: ${user.language ?? "N/A"}
Compte actif: ${user.valid ? "Oui" : "Non"}`);

  if (orders.length > 0) {
    sections.push(`=== COMMANDES (${orders.length}) ===
${orders.map((o) =>
      `Order ${o.order_uuid} | challenge=${o.challenge_name ?? "N/A"} (${o.challenge_type ?? "N/A"}) | balance_initiale=${o.challenge_initial_coins_amount ?? "N/A"} | paiement=${o.payment_method ?? "N/A"} | prix=${o.payment_price != null ? (o.payment_price / 100).toFixed(2) : "N/A"} ${(o.payment_currency ?? "EUR").toUpperCase()} | ref=${o.payment_proof ?? "N/A"} | date=${formatDate(o.payment_date)}`
    ).join("\n")}`);
  } else {
    sections.push("=== COMMANDES ===\nAucune commande.");
  }

  if (accountDetails.length > 0) {
    sections.push(`=== COMPTES DE TRADING (${accountDetails.length}) ===
${accountDetails.map(({ ta, challenge, balance }) =>
      `cTrader ${ta.ctrader_trading_account} | challenge=${challenge?.name ?? "N/A"} (${challenge?.type ?? "N/A"}) | phase=${ta.challenge_phase} | success=${ta.success} | serveur=${ta.ctrader_server} | target=${ta.current_profit_target_percent} | balance=${balance?.balance ?? "N/A"} | equity=${balance?.equity ?? "N/A"} | reason=${ta.reason || "-"} | debut=${formatDate(ta.challenge_phase_begin)} | jours_trading=${ta.max_trading_day}`
    ).join("\n")}`);
  } else {
    sections.push("=== COMPTES DE TRADING ===\nAucun compte.");
  }

  if (payouts.length > 0) {
    sections.push(`=== DEMANDES DE PAYOUT (${payouts.length}) ===
${payouts.map((p) =>
      `methode=${p.payout_method} | montant=${p.payout_amount} | profit=${p.total_profit} | split=${p.profit_split} | statut=${p.status} | date=${formatDate(p.created_at)}`
    ).join("\n")}`);
  } else {
    sections.push("=== DEMANDES DE PAYOUT ===\nAucune demande.");
  }

  return sections.join("\n\n");
}
