import type { DatabaseSession } from "../db.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as btfQ from "../queries/back-to-funded.queries.js";
import * as tradeHistoryQ from "../queries/trade-history.queries.js";
import * as baQ from "../queries/broker-account.queries.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt } from "../utils/prompts.js";
import { renderKeyValue, renderTable } from "../utils/table.js";
import {
  formatDate, formatPhase, formatPercent, formatSuccess,
  formatServer, formatCurrency, formatDuration, formatBoolean, formatChallengeName,
} from "../utils/format.js";

export async function tradingAccountReport(session: DatabaseSession): Promise<void> {
  const { connection: conn } = session;

  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  const challenge = await challengeQ.getChallengeByUuid(conn, account.challenge_uuid);
  const balance = await taQ.getLastBalanceAndEquity(conn, account.trading_account_uuid);
  const options = await taQ.getTradingAccountOptions(conn, account.trading_account_uuid);
  const accountDisplay = await baQ.getAccountDisplayId(conn, account);

  // ── Infos du compte ──
  ui.sectionHeader(`Compte de trading : ${accountDisplay.label}`);

  renderKeyValue({
    "UUID": account.trading_account_uuid,
    "Broker": accountDisplay.brokerName.toUpperCase(),
    "Login": String(accountDisplay.login),
    "Serveur": formatServer(account.ctrader_server),
    "Challenge": challenge ? `${formatChallengeName(challenge.name)} (${challenge.type})` : "N/A",
    "Phase": formatPhase(account.challenge_phase, challenge?.type),
    "Statut": formatSuccess(account.success),
    "Reason": account.reason || "-",
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

  // ── Balance/Equity ──
  if (balance) {
    ui.sectionHeader("Balance / Equity");
    renderKeyValue({
      "Balance": formatCurrency(balance.balance),
      "Equity": formatCurrency(balance.equity),
      "Derniere MAJ": formatDate(balance.last_update),
    });
  }

  // ── Options ──
  if (options.length > 0) {
    ui.sectionHeader("Options");
    renderTable(
      ["Nom", "Majoration"],
      options.map((o) => [o.name, formatPercent(o.majoration_percent)])
    );
  }

  // ── Offre Back to Funded ──
  const backToFunded = await btfQ.getBackToFundedByAccount(conn, account.trading_account_uuid);
  if (backToFunded) {
    const profitSplitOption = options.find(
      (o) => o.name === "90/10 Split" || o.name === "100/0 Split"
    );
    ui.sectionHeader("Offre Back to Funded");
    renderKeyValue({
      "Offer UUID": backToFunded.offer_uuid,
      "Statut": backToFunded.status,
      "Prix challenge de base (catalogue)": formatCurrency(backToFunded.base_challenge_price, backToFunded.currency),
      "Majoration option": profitSplitOption
        ? `${formatPercent(profitSplitOption.majoration_percent)} (${profitSplitOption.name})`
        : "Aucune",
      "Montant": formatCurrency(backToFunded.amount, backToFunded.currency),
      "Creee le": formatDate(backToFunded.created_at),
      "Expire le": formatDate(backToFunded.expires_at),
      "Payee le": backToFunded.paid_at ? formatDate(backToFunded.paid_at) : "-",
      "Lien de paiement": backToFunded.payment_link || "-",
    });
  }

  // ── Regles du challenge pour cette phase ──
  if (challenge) {
    const rules = await challengeQ.getChallengeRules(
      conn,
      challenge.challenge_uuid,
      account.challenge_phase
    );
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
  }

  // ── Historique des phases (tous les comptes du meme order) ──
  ui.sectionHeader("Historique des phases");

  const phaseHistory = await taQ.getAllTradingAccountsByOrder(conn, account.order_uuid);
  const phaseDisplayMap = await baQ.getAccountsDisplayMap(conn, phaseHistory);

  if (phaseHistory.length > 1) {
    renderTable(
      ["Phase", "Statut", "Broker", "Login", "Serveur", "Target", "Debut", "Reason"],
      phaseHistory.map((ta) => {
        const d = phaseDisplayMap.get(ta.trading_account_uuid)!;
        return [
          formatPhase(ta.challenge_phase),
          formatSuccess(ta.success),
          d.brokerName.toUpperCase(),
          String(d.login),
          formatServer(ta.ctrader_server),
          formatPercent(ta.current_profit_target_percent),
          formatDate(ta.challenge_phase_begin),
          ta.reason || "-",
        ];
      })
    );
  } else {
    ui.info("Pas de progression de phase (une seule phase).");
  }

  // ── Derniers trade history ──
  ui.sectionHeader("Historique de trading (10 derniers)");

  const history = await tradeHistoryQ.getTradeHistory(conn, account.trading_account_uuid, 10);

  if (history.length === 0) {
    ui.info("Aucun historique de trading.");
  } else {
    renderTable(
      ["Date", "Balance", "Equity", "PNL", "Volume", "Open", "Closed"],
      history.map((h) => [
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

  // ── Positions resume ──
  ui.sectionHeader("Positions");

  const summary = await tradeHistoryQ.getPositionsSummary(conn, account.trading_account_uuid);
  renderKeyValue({
    "Total positions": String(summary.total),
    "Ouvertes": String(summary.open),
    "Fermees": String(summary.closed),
    "PNL total": formatCurrency(summary.totalPnl),
    "Positions invalides": String(summary.invalidCount),
  });

  // Show recent positions
  if (summary.total > 0) {
    const positions = await tradeHistoryQ.getPositions(conn, account.trading_account_uuid, 10);
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
}
