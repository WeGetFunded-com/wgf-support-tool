import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as tradeHistoryQ from "../queries/trade-history.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as userQ from "../queries/user.queries.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt } from "../utils/prompts.js";
import { renderKeyValue, renderTable } from "../utils/table.js";
import {
  formatDate, formatPhase, formatPercent, formatSuccess,
  formatServer, formatCurrency, formatDuration, formatChallengeName,
} from "../utils/format.js";
import { interactiveChat, WGF_SYSTEM_PROMPT } from "../ai.js";

export async function deactivationAnalysis(
  session: DatabaseSession,
  config: Config
): Promise<void> {
  const { connection: conn } = session;

  // 1. Search for trading account
  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  // 2. Check if deactivated
  if (account.success !== 0) {
    ui.warn("Ce compte n'est pas desactive (success != 0).");
    return;
  }

  // 3. Collect all raw data
  const challenge = await challengeQ.getChallengeByUuid(conn, account.challenge_uuid);
  const rules = challenge
    ? await challengeQ.getChallengeRules(conn, account.challenge_uuid, account.challenge_phase)
    : null;
  const balance = await taQ.getLastBalanceAndEquity(conn, account.trading_account_uuid);
  const options = await taQ.getTradingAccountOptions(conn, account.trading_account_uuid);
  const tradeHistory = await tradeHistoryQ.getTradeHistory(conn, account.trading_account_uuid, 30);
  const firstHistory = await tradeHistoryQ.getFirstTradeHistory(conn, account.trading_account_uuid);
  const positions = await tradeHistoryQ.getPositions(conn, account.trading_account_uuid, 20);
  const positionsSummary = await tradeHistoryQ.getPositionsSummary(conn, account.trading_account_uuid);
  const phaseHistory = await taQ.getAllTradingAccountsByOrder(conn, account.order_uuid);
  const user = await userQ.getUserByOrderUuid(conn, account.order_uuid);
  const auditLogs = await auditLogQ.getAuditLogsForTarget(conn, account.trading_account_uuid);

  // Deactivation day history
  let deactivationDayHistory: Awaited<ReturnType<typeof tradeHistoryQ.getTradeHistoryForDate>> = [];
  if (account.latest_update) {
    const deactivationDate = formatDate(account.latest_update).slice(0, 10);
    deactivationDayHistory = await tradeHistoryQ.getTradeHistoryForDate(
      conn, account.trading_account_uuid, deactivationDate
    );
  }

  // 4. Display formatted raw data
  ui.sectionHeader(`Analyse de desactivation : cTrader ${account.ctrader_trading_account}`);

  // Account info
  ui.sectionHeader("Informations du compte");
  renderKeyValue({
    "UUID": account.trading_account_uuid,
    "cTrader ID": String(account.ctrader_trading_account),
    "Serveur": formatServer(account.ctrader_server),
    "Phase": formatPhase(account.challenge_phase, challenge?.type),
    "Statut": formatSuccess(account.success),
    "Raison desactivation": account.reason || "-",
    "Profit Target": formatPercent(account.current_profit_target_percent),
    "Debut phase": formatDate(account.challenge_phase_begin),
    "Fin phase": formatDate(account.challenge_phase_end),
    "Trades gagnes": String(account.number_of_won_trades),
    "Trades perdus": String(account.number_of_lost_trades),
    "Gains": formatCurrency(account.win_sum),
    "Pertes": formatCurrency(account.loss_sum),
    "Jours de trading": String(account.max_trading_day),
    "Derniere MAJ": formatDate(account.latest_update),
  });

  // User info
  if (user) {
    ui.sectionHeader("Utilisateur");
    renderKeyValue({
      "Email": user.email,
      "Nom": `${user.firstname} ${user.lastname}`,
      "CTID": String(user.CTID),
    });
  }

  // Challenge info
  if (challenge) {
    ui.sectionHeader("Challenge");
    renderKeyValue({
      "Nom": formatChallengeName(challenge.name),
      "Type": challenge.type,
      "Prix": formatCurrency(challenge.price),
      "Balance initiale": formatCurrency(challenge.initial_coins_amount),
    });
  }

  // Rules
  if (rules) {
    ui.sectionHeader("Regles de la phase");
    renderKeyValue({
      "Profit Target": formatPercent(rules.profit_target_percent),
      "Max Daily Drawdown": formatPercent(rules.max_daily_drawdown_percent),
      "Max Total Drawdown": rules.max_total_drawdown_percent != null
        ? formatPercent(rules.max_total_drawdown_percent) : "Illimite",
      "Min Trading Days": String(rules.min_trading_days),
      "Duree phase": formatDuration(rules.phase_duration),
    });
  }

  // Balance/Equity
  if (balance) {
    ui.sectionHeader("Balance / Equity");
    renderKeyValue({
      "Balance": formatCurrency(balance.balance),
      "Equity": formatCurrency(balance.equity),
      "Derniere MAJ": formatDate(balance.last_update),
    });
  }

  // Initial equity
  if (firstHistory) {
    ui.sectionHeader("Premiere entree historique");
    renderKeyValue({
      "Date": formatDate(firstHistory.pull_date),
      "Balance": formatCurrency(firstHistory.balance),
      "Equity": formatCurrency(firstHistory.equity),
    });
  }

  // Options
  if (options.length > 0) {
    ui.sectionHeader("Options actives");
    renderTable(
      ["Nom", "Majoration"],
      options.map((o) => [o.name, formatPercent(o.majoration_percent)])
    );
  }

  // Phase history
  if (phaseHistory.length > 1) {
    ui.sectionHeader("Historique des phases");
    renderTable(
      ["Phase", "Statut", "cTrader", "Serveur", "Target", "Debut", "Reason"],
      phaseHistory.map((ta) => [
        formatPhase(ta.challenge_phase),
        formatSuccess(ta.success),
        String(ta.ctrader_trading_account),
        formatServer(ta.ctrader_server),
        formatPercent(ta.current_profit_target_percent),
        formatDate(ta.challenge_phase_begin),
        ta.reason || "-",
      ])
    );
  }

  // Trade history (last 30)
  ui.sectionHeader("Historique de trading (30 derniers)");
  if (tradeHistory.length === 0) {
    ui.info("Aucun historique de trading.");
  } else {
    renderTable(
      ["Date", "Balance", "Equity", "PNL", "Volume", "Open", "Closed"],
      tradeHistory.map((h) => [
        formatDate(h.pull_date),
        formatCurrency(h.balance),
        formatCurrency(h.equity),
        formatCurrency(h.pnl),
        String(h.volume),
        String(h.number_of_trade_open),
        String(h.number_of_trade_closed),
      ])
    );
  }

  // Deactivation day entries
  if (deactivationDayHistory.length > 0) {
    ui.sectionHeader("Entrees du jour de desactivation");
    renderTable(
      ["Date", "Balance", "Equity", "PNL", "Volume", "Open", "Closed"],
      deactivationDayHistory.map((h) => [
        formatDate(h.pull_date),
        formatCurrency(h.balance),
        formatCurrency(h.equity),
        formatCurrency(h.pnl),
        String(h.volume),
        String(h.number_of_trade_open),
        String(h.number_of_trade_closed),
      ])
    );
  }

  // Positions summary
  ui.sectionHeader("Positions");
  renderKeyValue({
    "Total positions": String(positionsSummary.total),
    "Ouvertes": String(positionsSummary.open),
    "Fermees": String(positionsSummary.closed),
    "PNL total": formatCurrency(positionsSummary.totalPnl),
    "Positions invalides": String(positionsSummary.invalidCount),
  });

  if (positions.length > 0) {
    console.log("");
    renderTable(
      ["Symbol", "Direction", "Volume", "PNL", "Ouvert", "Ferme", "Invalide"],
      positions.map((p) => [
        p.symbol,
        p.direction,
        String(p.volume),
        p.pnl != null ? formatCurrency(p.pnl) : "N/A",
        formatDate(p.open_timestamp),
        formatDate(p.close_timestamp),
        p.invalid ? "OUI" : "-",
      ])
    );
  }

  // Audit logs
  if (auditLogs.length > 0) {
    ui.sectionHeader("Logs d'audit");
    renderTable(
      ["Date", "Action", "Operateur", "Env", "Details"],
      auditLogs.map((log) => [
        formatDate(log.executed_at),
        log.action_type,
        log.operator,
        log.environment,
        log.details ? String(log.details).slice(0, 60) : "-",
      ])
    );
  }

  // 5. Launch interactive chat with AI
  if (!config.openRouterApiKey) {
    console.log("");
    ui.warn("Cle OpenRouter non configuree (OPENROUTER_API_KEY dans .env).");
    ui.info("Les donnees brutes ont ete affichees ci-dessus. L'analyse AI n'est pas disponible.");
    return;
  }

  // Build raw data string for AI
  const rawData = buildRawDataString(
    account, challenge, rules, balance, firstHistory, options,
    tradeHistory, deactivationDayHistory, positions, positionsSummary,
    phaseHistory, user, auditLogs
  );

  await interactiveChat(
    config.openRouterApiKey,
    WGF_SYSTEM_PROMPT,
    `Voici les donnees brutes d'un compte de trading desactive. Analyse la desactivation et donne ton diagnostic :\n\n${rawData}`
  );
}

// ── Build raw data string for AI context ──

function buildRawDataString(
  account: any,
  challenge: any,
  rules: any,
  balance: any,
  firstHistory: any,
  options: any[],
  tradeHistory: any[],
  deactivationDayHistory: any[],
  positions: any[],
  positionsSummary: any,
  phaseHistory: any[],
  user: any,
  auditLogs: any[]
): string {
  const sections: string[] = [];

  sections.push(`=== COMPTE ===
UUID: ${account.trading_account_uuid}
cTrader ID: ${account.ctrader_trading_account}
Serveur: ${account.ctrader_server}
Phase: ${account.challenge_phase}
Statut: success=${account.success}
Raison: ${account.reason || "aucune"}
Profit Target actuel: ${account.current_profit_target_percent}
Debut phase: ${formatDate(account.challenge_phase_begin)}
Fin phase: ${formatDate(account.challenge_phase_end)}
Trades gagnes: ${account.number_of_won_trades}
Trades perdus: ${account.number_of_lost_trades}
Gains: ${account.win_sum}
Pertes: ${account.loss_sum}
Jours de trading: ${account.max_trading_day}
Derniere MAJ: ${formatDate(account.latest_update)}`);

  if (user) {
    sections.push(`=== UTILISATEUR ===
Email: ${user.email}
Nom: ${user.firstname} ${user.lastname}
CTID: ${user.CTID}`);
  }

  if (challenge) {
    sections.push(`=== CHALLENGE ===
Nom: ${challenge.name}
Type: ${challenge.type}
Prix: ${challenge.price}
Balance initiale: ${challenge.initial_coins_amount}`);
  }

  if (rules) {
    sections.push(`=== REGLES DE LA PHASE ===
Profit Target: ${rules.profit_target_percent}
Max Daily Drawdown: ${rules.max_daily_drawdown_percent}
Max Total Drawdown: ${rules.max_total_drawdown_percent ?? "Illimite"}
Min Trading Days: ${rules.min_trading_days}
Duree: ${rules.phase_duration}`);
  }

  if (balance) {
    sections.push(`=== BALANCE/EQUITY ACTUELLES ===
Balance: ${balance.balance}
Equity: ${balance.equity}
MAJ: ${formatDate(balance.last_update)}`);
  }

  if (firstHistory) {
    sections.push(`=== PREMIERE ENTREE HISTORIQUE ===
Date: ${formatDate(firstHistory.pull_date)}
Balance: ${firstHistory.balance}
Equity: ${firstHistory.equity}`);
  }

  if (options.length > 0) {
    sections.push(`=== OPTIONS ACTIVES ===
${options.map((o) => `- ${o.name} (majoration: ${o.majoration_percent})`).join("\n")}`);
  }

  if (phaseHistory.length > 0) {
    sections.push(`=== HISTORIQUE DES PHASES ===
${phaseHistory.map((ta) =>
      `Phase ${ta.challenge_phase} | success=${ta.success} | cTrader=${ta.ctrader_trading_account} | target=${ta.current_profit_target_percent} | debut=${formatDate(ta.challenge_phase_begin)} | reason=${ta.reason || "-"}`
    ).join("\n")}`);
  }

  if (tradeHistory.length > 0) {
    sections.push(`=== HISTORIQUE DE TRADING (30 derniers) ===
${tradeHistory.map((h) =>
      `${formatDate(h.pull_date)} | balance=${h.balance} | equity=${h.equity} | pnl=${h.pnl} | volume=${h.volume} | open=${h.number_of_trade_open} | closed=${h.number_of_trade_closed}`
    ).join("\n")}`);
  }

  if (deactivationDayHistory.length > 0) {
    sections.push(`=== ENTREES DU JOUR DE DESACTIVATION ===
${deactivationDayHistory.map((h) =>
      `${formatDate(h.pull_date)} | balance=${h.balance} | equity=${h.equity} | pnl=${h.pnl} | volume=${h.volume} | open=${h.number_of_trade_open} | closed=${h.number_of_trade_closed}`
    ).join("\n")}`);
  }

  sections.push(`=== RESUME POSITIONS ===
Total: ${positionsSummary.total}
Ouvertes: ${positionsSummary.open}
Fermees: ${positionsSummary.closed}
PNL total: ${positionsSummary.totalPnl}
Invalides: ${positionsSummary.invalidCount}`);

  if (positions.length > 0) {
    sections.push(`=== POSITIONS (20 dernieres) ===
${positions.map((p) =>
      `${p.symbol} ${p.direction} vol=${p.volume} pnl=${p.pnl ?? "N/A"} open=${formatDate(p.open_timestamp)} close=${formatDate(p.close_timestamp)} invalid=${p.invalid ? "OUI" : "NON"}`
    ).join("\n")}`);
  }

  if (auditLogs.length > 0) {
    sections.push(`=== LOGS D'AUDIT ===
${auditLogs.map((log) =>
      `${formatDate(log.executed_at)} | ${log.action_type} | ${log.operator} | ${log.environment} | ${log.details || "-"}`
    ).join("\n")}`);
  }

  return sections.join("\n\n");
}
