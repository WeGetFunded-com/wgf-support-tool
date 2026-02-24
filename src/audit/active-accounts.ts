import type { DatabaseSession } from "../db.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as ui from "../ui.js";
import { searchUserPrompt } from "../utils/prompts.js";
import { renderTable } from "../utils/table.js";
import { formatPhase, formatPercent, formatDate, formatServer } from "../utils/format.js";

export async function activeAccounts(session: DatabaseSession): Promise<void> {
  const { connection: conn } = session;

  const user = await searchUserPrompt(conn);
  if (!user) return;

  ui.sectionHeader(`Comptes actifs de ${user.firstname} ${user.lastname} (${user.email})`);

  const accounts = await taQ.getActiveTradingAccountsByUser(conn, user.user_uuid);

  if (accounts.length === 0) {
    ui.info("Aucun compte actif.");
    return;
  }

  const rows: string[][] = [];
  for (const ta of accounts) {
    const challenge = await challengeQ.getChallengeByUuid(conn, ta.challenge_uuid);
    rows.push([
      String(ta.ctrader_trading_account),
      challenge?.name ?? "N/A",
      formatPhase(ta.challenge_phase, challenge?.type),
      formatServer(ta.ctrader_server),
      formatPercent(ta.current_profit_target_percent),
      formatDate(ta.challenge_phase_begin),
      formatDate(ta.challenge_phase_end),
    ]);
  }

  renderTable(
    ["cTrader ID", "Challenge", "Phase", "Serveur", "Profit Target", "Debut", "Fin"],
    rows
  );
}
