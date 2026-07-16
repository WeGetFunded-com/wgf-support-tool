import { input } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as affQ from "../queries/affiliation.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { searchUserPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatCurrency } from "../utils/format.js";
import { generateUuid } from "../utils/uuid.js";
import { computeAffiliationBalance } from "../utils/commission.js";

export async function resetAffiliationBalance(session: DatabaseSession): Promise<void> {
  const { connection: conn, env, operator } = session;

  const user = await searchUserPrompt(conn);
  if (!user) return;

  // Verify the user is actually an affiliator
  const codes = await affQ.getAffiliationCodesByOwner(conn, user.user_uuid);
  if (codes.length === 0) {
    ui.warn("Cet utilisateur n'a pas de code d'affiliation.");
    return;
  }

  // Compute current balance
  const sales = await affQ.getSalesByOwner(conn, user.user_uuid);
  const settlements = await affQ.getSettlementsByOwner(conn, user.user_uuid);

  const { totalCommission, totalSettled, currentBalance } =
    await computeAffiliationBalance(sales, settlements);

  // Balances mix fiat and crypto sales, so everything is normalised to EUR.
  const currency = "EUR";

  ui.sectionHeader(`Solde d'affiliation : ${user.email}`);
  renderKeyValue({
    "Affilie": `${user.firstname} ${user.lastname}`,
    "Email": user.email,
    "Code": codes.map((c) => c.code).join(", "),
    "Commission totale generee": formatCurrency(totalCommission, currency),
    "Deja regle": formatCurrency(totalSettled, currency),
    "Solde actuel a payer": formatCurrency(currentBalance, currency),
  });

  if (currentBalance <= 0) {
    ui.warn(
      currentBalance < 0
        ? `Solde negatif (${formatCurrency(currentBalance, currency)}). Aucun reglement a enregistrer.`
        : "Le solde est deja a zero. Aucun reglement a enregistrer."
    );
    return;
  }

  const note = await input({
    message: "Note sur ce reglement (optionnel) :",
  });

  const description =
    `Enregistrer un reglement de ${formatCurrency(currentBalance, currency)} pour ${user.email} ` +
    `(remet le solde d'affiliation a 0)`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  const settlementUuid = generateUuid();

  await conn.beginTransaction();
  try {
    await affQ.insertSettlement(
      conn,
      settlementUuid,
      user.user_uuid,
      currentBalance,
      currency,
      operator,
      env,
      note.trim() || null
    );

    await auditLogQ.insertAuditLog(
      conn,
      "RESET_AFFILIATION_BALANCE",
      "affiliation_settlement",
      settlementUuid,
      {
        owner_uuid: user.user_uuid,
        owner_email: user.email,
        amount: currentBalance,
        currency,
        total_commission_generated: totalCommission,
        previously_settled: totalSettled,
        note: note.trim() || null,
      },
      operator,
      env
    );

    await conn.commit();
    ui.success(
      `Reglement de ${formatCurrency(currentBalance, currency)} enregistre. ` +
      `Nouveau solde : ${formatCurrency(0, currency)}.`
    );
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}
