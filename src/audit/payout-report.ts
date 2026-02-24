import { select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as payoutQ from "../queries/payout.queries.js";
import * as ui from "../ui.js";
import { renderTable, renderKeyValue } from "../utils/table.js";
import { formatDate, formatCurrency } from "../utils/format.js";

export async function payoutReport(session: DatabaseSession): Promise<void> {
  const { connection: conn } = session;

  const statusFilter = await select({
    message: "Filtrer par statut :",
    choices: [
      { name: "Tous", value: "" },
      { name: "Pending", value: "pending" },
      { name: "Approved", value: "approved" },
      { name: "Paid", value: "paid" },
      { name: "Rejected", value: "rejected" },
    ],
  });

  const payouts = await payoutQ.getPayoutsByStatus(
    conn,
    statusFilter || undefined
  );

  if (payouts.length === 0) {
    ui.info("Aucune demande de payout trouvee.");
    return;
  }

  ui.sectionHeader(`Demandes de payout${statusFilter ? ` (${statusFilter})` : ""}`);

  renderTable(
    ["Email", "cTrader", "Methode", "Montant", "Profit", "Split", "Statut", "Date"],
    payouts.map((p) => [
      p.email,
      String(p.ctrader_trading_account ?? "N/A"),
      p.payout_method,
      formatCurrency(p.payout_amount),
      formatCurrency(p.total_profit),
      p.profit_split,
      p.status,
      formatDate(p.created_at),
    ])
  );

  // Allow viewing detail of a specific payout
  if (payouts.length > 0) {
    const viewDetail = await select({
      message: "Voir le detail d'une demande ?",
      choices: [
        ...payouts.slice(0, 10).map((p, i) => ({
          name: `${p.email} - ${formatCurrency(p.payout_amount)} (${p.status})`,
          value: i,
        })),
        { name: "Non, retour", value: -1 },
      ],
    });

    if (viewDetail >= 0) {
      const payout = payouts[viewDetail];
      ui.sectionHeader("Detail payout");
      renderKeyValue({
        "UUID": payout.payout_request_uuid,
        "Email": payout.email,
        "cTrader": String(payout.ctrader_trading_account ?? "N/A"),
        "Methode": payout.payout_method,
        "IBAN": payout.iban ?? "N/A",
        "Wallet": payout.wallet_address ?? "N/A",
        "Protocole": payout.wallet_protocol ?? "N/A",
        "Prenom": payout.first_name ?? "N/A",
        "Nom": payout.last_name ?? "N/A",
        "Adresse": payout.postal_address ?? "N/A",
        "Balance avant": formatCurrency(payout.balance_before_request),
        "Profit total": formatCurrency(payout.total_profit),
        "Montant payout": formatCurrency(payout.payout_amount),
        "Profit split": payout.profit_split,
        "Statut": payout.status,
        "Cree le": formatDate(payout.created_at),
        "MAJ le": formatDate(payout.updated_at),
      });
    }
  }
}
