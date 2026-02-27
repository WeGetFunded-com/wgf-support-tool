import { input } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as promoQ from "../queries/promo.queries.js";
import * as ui from "../ui.js";
import { renderTable, renderKeyValue } from "../utils/table.js";
import { formatDate, formatCurrency, formatPercent, formatBoolean, formatSuccess } from "../utils/format.js";

export async function promoUsageAnalysis(session: DatabaseSession): Promise<void> {
  const { connection: conn } = session;

  const code = await input({ message: "Code promo a analyser :" });
  if (!code.trim()) return;

  const rows = await promoQ.getOrdersByPromoCode(conn, code.trim());

  if (rows.length === 0) {
    ui.warn("Code promo non trouve ou jamais utilise.");
    return;
  }

  const promo = rows[0];

  ui.sectionHeader(`Code promo : ${promo.code}`);
  renderKeyValue({
    "Code": promo.code,
    "Reduction": formatPercent(promo.percent_promo),
    "Statut": promo.is_valid ? "Actif" : "Invalide",
    "Global": formatBoolean(promo.global),
    "Illimite": formatBoolean(promo.is_unlimited),
    "Expiration": formatDate(promo.expires_at),
    "Description": promo.descriptionFr ?? "N/A",
    "Nb utilisations": String(rows.length),
  });

  ui.sectionHeader("Clients ayant utilise ce code promo");

  const withAccount = rows.filter((r) => r.ctrader_trading_account != null).length;
  const withoutAccount = rows.length - withAccount;

  renderTable(
    ["Email", "Nom", "CTID", "Challenge", "Balance", "Compte", "Statut", "Prix", "Methode", "Date"],
    rows.map((r) => [
      r.email,
      `${r.firstname} ${r.lastname}`,
      String(r.CTID),
      r.challenge_name ?? "N/A",
      r.initial_coins_amount != null ? `${r.initial_coins_amount}$` : "N/A",
      r.ctrader_trading_account != null ? String(r.ctrader_trading_account) : "Non cree",
      r.ctrader_trading_account != null ? formatSuccess(r.ta_success) : "-",
      formatCurrency(r.payment_price, r.payment_currency ?? "EUR"),
      r.payment_method ?? "N/A",
      formatDate(r.payment_date),
    ])
  );

  ui.info(`${withAccount} compte(s) cree(s) / ${withoutAccount} sans compte de trading`);
}
