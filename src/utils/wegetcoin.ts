import type mysql from "mysql2/promise";
import type { DbUser } from "../types.js";
import * as wgcQ from "../queries/wegetcoin.queries.js";
import * as ui from "../ui.js";
import { renderKeyValue, renderTable } from "./table.js";
import { formatCurrency, formatSqlDateTime, truncate } from "./format.js";

/** 10 WeGetCoins = 1 EUR, stored in euro cents. */
export const CENTS_PER_COIN = 10;

const KIND_LABELS: Record<string, string> = {
  payout_conversion: "Payout converti",
  payout_bonus: "Bonus payout +10 %",
  level_reward: "Recompense de niveau",
  box_reward: "Lot de box",
  support_correction: "Correction support",
  support_gesture: "Geste commercial",
  order_payment: "Paiement de commande",
};

export function formatCoins(cents: number): string {
  return `${Math.trunc(cents / CENTS_PER_COIN)} WGC (${formatCurrency(cents / 100)})`;
}

function signedCoins(cents: number): string {
  const coins = Math.trunc(cents / CENTS_PER_COIN);
  return coins > 0 ? `+${coins}` : String(coins);
}

/**
 * Shows a trader's WeGetCoin balance and latest movements. Read-only, shared by
 * the consultation screens and the support action.
 */
export async function renderWeGetCoins(
  conn: mysql.Connection,
  user: DbUser,
  historyLimit: number
): Promise<wgcQ.WeGetCoinWallet> {
  ui.sectionHeader("WeGetCoins");

  const wallet = (await wgcQ.getWallet(conn, user.user_uuid)) ?? { balance_cents: 0, reserved_cents: 0 };
  renderKeyValue({
    "Solde": formatCoins(wallet.balance_cents),
    "Reserve (paiement en cours)": formatCoins(wallet.reserved_cents),
    "Disponible": formatCoins(wallet.balance_cents - wallet.reserved_cents),
  });

  const total = await wgcQ.countLines(conn, user.user_uuid);
  if (total === 0) {
    ui.info("Aucun mouvement de WeGetCoins.");
    return wallet;
  }

  const lines = await wgcQ.getLines(conn, user.user_uuid, historyLimit);
  console.log("");
  renderTable(
    ["Date", "Type", "WGC", "Solde apres", "Auteur", "Motif / reference"],
    lines.map((line) => [
      formatSqlDateTime(line.created_at),
      KIND_LABELS[line.kind] ?? line.kind,
      signedCoins(line.amount_cents),
      String(Math.trunc(line.balance_after_cents / CENTS_PER_COIN)),
      truncate(line.author, 24),
      truncate(line.reason ?? `${line.reference_type} ${line.reference_id}`, 40),
    ])
  );
  if (total > lines.length) {
    ui.info(`${lines.length} derniers mouvements sur ${total}.`);
  }

  return wallet;
}
