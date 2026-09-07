import { select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as payoutQ from "../queries/payout.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatCurrency, formatDate } from "../utils/format.js";

/**
 * Removes a payout request this tool created itself, so a simulation run on a
 * real account does not stay behind.
 *
 * Only requests carrying a PAYOUT_SIMULATED audit entry are listed: a genuine
 * trader request has none and can therefore never be deleted from here.
 */
export async function deleteSimulatedPayout(session: DatabaseSession): Promise<void> {
  const { connection: conn, env, operator } = session;

  const payouts = await payoutQ.getSimulatedPayouts(conn, env);

  if (payouts.length === 0) {
    ui.info("Aucune demande de payout simulee sur cet environnement.");
    return;
  }

  const selected = await select({
    message: "Demande simulee a supprimer :",
    choices: [
      ...payouts.map((p, i) => ({
        name: `${p.email} — ${formatCurrency(p.payout_amount)} (${p.status}) — ${formatDate(p.created_at)}`,
        value: i,
      })),
      { name: "Retour", value: -1 },
    ],
  });

  if (selected < 0) return;

  const payout = payouts[selected];

  ui.sectionHeader("Demande simulee");
  renderKeyValue({
    "UUID": payout.payout_request_uuid,
    "Email": payout.email,
    "Compte": payoutQ.payoutAccountLabel(payout),
    "Montant": formatCurrency(payout.payout_amount),
    "Profit split": payout.profit_split,
    "Statut": payout.status,
    "Creee le": formatDate(payout.created_at),
  });

  // Paid means the amount was already withdrawn from the trader's MT5 account.
  // This row is the only record of that withdrawal in the database, so deleting
  // it would leave a debited account and nothing explaining why.
  if (payout.status === "paid") {
    ui.error("Cette demande a ete payee : le montant a deja ete retire du compte MT5.");
    ui.info(
      "Supprimer la ligne effacerait la seule trace de ce retrait en base. " +
        "Si c'etait une erreur, il faut recrediter le compte MT5, pas supprimer la demande."
    );
    return;
  }

  if (payout.status === "approved") {
    ui.warn(
      "Cette demande a ete approuvee : elle a donc pose une ancre de reset, et les " +
        "compteurs d'eligibilite du trader repartent de cette date."
    );
    ui.info(
      "La supprimer restaure l'ancre precedente. En revanche l'evenement " +
        "payout_approved est deja parti et ne peut pas etre repris."
    );
  }

  const description =
    `Supprimer definitivement la demande de payout simulee ${payout.payout_request_uuid.slice(0, 8)}... ` +
    `(${payout.email}, ${formatCurrency(payout.payout_amount)}, statut "${payout.status}")`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  await conn.beginTransaction();
  try {
    const deleted = await payoutQ.deleteSimulatedPayout(conn, payout.payout_request_uuid);
    if (deleted === 0) {
      // The status guard in the DELETE held: the request reached 'paid' between
      // the moment the list was drawn and this confirmation.
      await conn.rollback();
      ui.error("Suppression refusee : la demande a ete payee entre-temps.");
      return;
    }

    await auditLogQ.insertAuditLog(
      conn,
      "PAYOUT_SIMULATION_DELETED",
      "payout_request",
      // The row is gone, but the uuid is kept as the target so this deletion
      // still lines up with the PAYOUT_SIMULATED entry that created it.
      payout.payout_request_uuid,
      {
        email: payout.email,
        amount: payout.payout_amount,
        status_at_deletion: payout.status,
      },
      operator,
      env
    );

    await conn.commit();

    ui.success("Demande de payout simulee supprimee.");
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}
