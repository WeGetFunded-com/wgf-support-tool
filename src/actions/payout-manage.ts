import { select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as payoutQ from "../queries/payout.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatDate, formatCurrency } from "../utils/format.js";

export async function payoutManage(session: DatabaseSession): Promise<void> {
  const { connection: conn, env, operator } = session;

  // List pending payouts
  const payouts = await payoutQ.getPayoutsByStatus(conn, "pending");

  if (payouts.length === 0) {
    ui.info("Aucune demande de payout en attente.");

    const viewAll = await select({
      message: "Voir les payouts d'un autre statut ?",
      choices: [
        { name: "Approved", value: "approved" },
        { name: "Tous", value: "" },
        { name: "Non, retour", value: "back" },
      ],
    });

    if (viewAll === "back") return;

    const allPayouts = await payoutQ.getPayoutsByStatus(conn, viewAll || undefined);
    if (allPayouts.length === 0) {
      ui.info("Aucun payout trouve.");
      return;
    }
    return handlePayoutSelection(allPayouts, session);
  }

  return handlePayoutSelection(payouts, session);
}

async function handlePayoutSelection(
  payouts: payoutQ.PayoutWithEmail[],
  session: DatabaseSession
): Promise<void> {
  const { connection: conn, env, operator } = session;

  const selected = await select({
    message: "Selectionner une demande de payout :",
    choices: [
      ...payouts.slice(0, 15).map((p, i) => ({
        name: `${p.email} — ${formatCurrency(p.payout_amount)} (${p.status})`,
        value: i,
      })),
      { name: "Retour", value: -1 },
    ],
  });

  if (selected < 0) return;

  const payout = payouts[selected];

  ui.sectionHeader("Detail payout");
  renderKeyValue({
    "UUID": payout.payout_request_uuid,
    "Email": payout.email,
    "cTrader": String(payout.ctrader_trading_account ?? "N/A"),
    "Methode": payout.payout_method,
    "IBAN": payout.iban ?? "N/A",
    "Wallet": payout.wallet_address ?? "N/A",
    "Balance avant": formatCurrency(payout.balance_before_request),
    "Profit total": formatCurrency(payout.total_profit),
    "Montant payout": formatCurrency(payout.payout_amount),
    "Profit split": payout.profit_split,
    "Statut actuel": payout.status,
    "Date": formatDate(payout.created_at),
  });

  const action = await select({
    message: "Action :",
    choices: [
      { name: "Approuver", value: "approved" },
      { name: "Rejeter", value: "rejected" },
      { name: "Marquer comme paye", value: "paid" },
      { name: "Annuler", value: "cancel" },
    ],
  });

  if (action === "cancel") return;

  const description =
    `Changer le statut du payout ${payout.payout_request_uuid.slice(0, 8)}... ` +
    `de "${payout.status}" a "${action}" (${payout.email}, ${formatCurrency(payout.payout_amount)})`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  await conn.beginTransaction();
  try {
    await payoutQ.updatePayoutStatus(conn, payout.payout_request_uuid, action);

    await auditLogQ.insertAuditLog(conn, "PAYOUT_STATUS_CHANGE", "payout_request", payout.payout_request_uuid, {
      email: payout.email,
      amount: payout.payout_amount,
      old_status: payout.status,
      new_status: action,
    }, operator, env);

    await conn.commit();
    ui.success(`Payout mis a jour : ${action}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}
