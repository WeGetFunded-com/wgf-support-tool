import { input, select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as payoutQ from "../queries/payout.queries.js";
import * as tradingAccountQ from "../queries/trading-account.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatDate, formatCurrency } from "../utils/format.js";
import { extendedDrawdownPoints } from "../utils/extended-drawdown.js";
import { previewWeGetCoinPayout, settlePayout, type WeGetCoinPayoutCredit } from "../manager-client.js";
import { decidePayout } from "../model-command-client.js";

/**
 * `--force-sql` keeps the legacy direct UPDATE as an escape hatch when
 * model-command is unreachable. It skips the tracking emission: the event
 * will only come back through the reconciliation cron.
 */
const FORCE_SQL = process.argv.includes("--force-sql");

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
    "Compte": payoutQ.payoutAccountLabel(payout),
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

  const isWeGetCoin = payout.payout_method === "wegetcoin";

  const action = await select({
    message: "Action :",
    choices: [
      {
        name: isWeGetCoin ? "Approuver (debit MT5 + credit WeGetCoins + paye)" : "Approuver",
        value: "approved",
      },
      { name: "Rejeter", value: "rejected" },
      { name: "Marquer comme paye", value: "paid" },
      { name: "Annuler", value: "cancel" },
    ],
  });

  if (action === "cancel") return;

  let rejectionReason = "";
  if (action === "rejected") {
    rejectionReason = (
      await input({ message: "Motif du rejet (transmis au tracking, garde en audit) :" })
    ).trim();
  }

  // A WeGetCoin payout has no Rise step: approving it pays it at once, at the
  // rate of the day. The operator sees what will be credited before confirming.
  const settleNow = action === "paid" || (isWeGetCoin && action === "approved");
  let preview: WeGetCoinPayoutCredit | null = null;
  if (isWeGetCoin && settleNow) {
    try {
      preview = await previewWeGetCoinPayout(
        session.config,
        env,
        payout.trading_account_uuid,
        payout.payout_request_uuid
      );
    } catch (err) {
      ui.error(`Apercu WeGetCoins impossible : ${err instanceof Error ? err.message : String(err)}`);
      ui.info("Le payout n'a pas ete modifie.");
      return;
    }
    renderWeGetCoinCredit(preview, "Credit WeGetCoins prevu");
    if (preview.rateFallback) {
      ui.warn("La BCE ne repond pas : c'est le dernier taux connu qui sera fige.");
    }
  }

  const description = isWeGetCoin && settleNow && preview
    ? `Payer le payout ${payout.payout_request_uuid.slice(0, 8)}... en WeGetCoins : ` +
      `debit MT5 de ${formatCurrency(payout.payout_amount, "USD")} puis credit de ` +
      `${preview.totalCoins} WeGetCoins a ${payout.email}`
    : `Changer le statut du payout ${payout.payout_request_uuid.slice(0, 8)}... ` +
      `de "${payout.status}" a "${action}" (${payout.email}, ${formatCurrency(payout.payout_amount)})`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  // Approve / reject go through model-command, which owns the status flip and
  // emits payout_approved / payout_rejected. A direct UPDATE would silently
  // skip the event (it used to).
  let via: "model-command" | "sql" | "manager" = "manager";
  if (action === "approved" || action === "rejected") {
    if (FORCE_SQL) {
      ui.warn("--force-sql : mise a jour directe en base, aucun evenement de tracking emis.");
      via = "sql";
    } else {
      try {
        await decidePayout(session.config, env, payout.payout_request_uuid, action, rejectionReason);
        via = "model-command";
      } catch (err) {
        ui.error(`model-command injoignable : ${err instanceof Error ? err.message : String(err)}`);
        ui.info("Le payout n'a pas ete modifie. Relancez avec --force-sql pour ecrire directement en base (sans tracking).");
        return;
      }
    }
  }

  // Paying is not a status change: the money has to leave the trader's MT5 account
  // in the same operation. The manager does both, and refuses the status change if
  // MT5 rejects the withdrawal — so a payout can never be marked paid while the
  // balance still shows the money. For a WeGetCoin payout it also credits the
  // wallet between the MT5 debit and the status change.
  let settlement: Awaited<ReturnType<typeof settlePayout>> | null = null;
  let settleError: string | null = null;
  if (settleNow) {
    try {
      settlement = await settlePayout(
        session.config,
        env,
        payout.trading_account_uuid,
        payout.payout_request_uuid,
        operator
      );
    } catch (err) {
      settleError = err instanceof Error ? err.message : String(err);
    }
  }

  if (settleError !== null) {
    ui.error(`Paiement refuse : ${settleError}`);
    if (settleError.includes("do NOT settle again")) {
      ui.warn("Le compte MT5 a deja ete debite : NE PAS relancer le paiement. Finir a la main avec un developpeur.");
    } else if (action === "approved") {
      ui.info('Le payout est approuve mais pas paye, rien n\'a ete credite. Corrigez puis relancez "Marquer comme paye".');
    } else {
      ui.info("Le payout n'a pas ete modifie. Verifiez le compte MT5 puis reessayez.");
    }
    // The decision already went through model-command: it is audited even though the payment failed.
    if (action !== "approved") return;
  } else if (settlement) {
    if (settlement.alreadySettled) {
      ui.warn("Ce payout etait deja regle : aucune operation MT5 n'a ete rejouee.");
    } else {
      ui.success(
        `Retrait MT5 effectue : ${formatCurrency(settlement.debitedAmount ?? 0, "USD")} ` +
          `sur le compte ${settlement.mt5Login} (ticket ${settlement.mt5Ticket}).`
      );
      if (settlement.weGetCoins) {
        renderWeGetCoinCredit(settlement.weGetCoins, "WeGetCoins credites");
      }
    }
  }

  const paid = settlement !== null && !settlement.alreadySettled;
  const changes: { from: string; to: string }[] = [];
  if (action === "approved" || action === "rejected") {
    changes.push({ from: payout.status, to: action });
  }
  if (paid) {
    changes.push({ from: action === "approved" ? "approved" : payout.status, to: "paid" });
  }

  await conn.beginTransaction();
  try {
    if (via === "sql") {
      await payoutQ.updatePayoutStatus(conn, payout.payout_request_uuid, action);
    }

    for (const change of changes) {
      const credit = change.to === "paid" ? settlement?.weGetCoins : undefined;
      await auditLogQ.insertAuditLog(conn, "PAYOUT_STATUS_CHANGE", "payout_request", payout.payout_request_uuid, {
        email: payout.email,
        amount: payout.payout_amount,
        payout_method: payout.payout_method,
        old_status: change.from,
        new_status: change.to,
        mt5_ticket: change.to === "paid" ? settlement?.mt5Ticket ?? null : null,
        mt5_login: change.to === "paid" ? settlement?.mt5Login ?? null : null,
        rejection_reason: change.to === "rejected" ? rejectionReason : null,
        wegetcoins_credited: credit?.totalCoins ?? null,
        wegetcoin_conversion: credit?.conversionCoins ?? null,
        wegetcoin_bonus: credit?.bonusCoins ?? null,
        fx_rate_usd_eur: credit?.fxRateUsdEur ?? null,
        via: change.to === "paid" ? "manager" : via,
      }, operator, env);
    }

    if (paid) {
      await tradingAccountQ.lockDrawdown(conn, payout.trading_account_uuid);
      await auditLogQ.insertAuditLog(conn, "PAYOUT_DRAWDOWN_RESET", "trading_account", payout.trading_account_uuid, {
        email: payout.email,
        payout_request_uuid: payout.payout_request_uuid,
        payout_amount: payout.payout_amount,
      }, operator, env);
    }

    await conn.commit();
    ui.success(`Payout mis a jour : ${changes.map((c) => c.to).join(" puis ") || action}`);
    if (paid) {
      ui.info("Drawdown floor verrouille a l'initial_amount pour ce compte.");
      const accountOptions = await tradingAccountQ.getTradingAccountOptions(conn, payout.trading_account_uuid);
      const extendedPoints = extendedDrawdownPoints(accountOptions);
      if (extendedPoints > 0) {
        ui.info(`Option Extended Drawdown ${extendedPoints}% : l'extension prend fin avec ce premier payout, le compte revient au drawdown par defaut.`);
      }
    }
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

function renderWeGetCoinCredit(credit: WeGetCoinPayoutCredit, title: string): void {
  ui.sectionHeader(title);
  renderKeyValue({
    "Taux": `1 USD = ${credit.fxRateUsdEur} EUR (${credit.rateSource.toUpperCase()} du ${credit.rateDate})`,
    "Profit split": credit.profitSplit,
    "Montant apres split": formatCurrency(credit.usdAfterSplit, "USD"),
    "Conversion": `${credit.conversionCoins} WeGetCoins`,
    "Bonus +10 %": `${credit.bonusCoins} WeGetCoins`,
    "Total": `${credit.totalCoins} WeGetCoins (${formatCurrency(credit.totalCoins / 10)})`,
  });
}
