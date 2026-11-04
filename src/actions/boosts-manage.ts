import { select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as boostQ from "../queries/challenge-boost.queries.js";
import type { BoostRow } from "../queries/challenge-boost.queries.js";
import * as ui from "../ui.js";
import { BoostRefusedError, refundBoost } from "../challenge-boost-client.js";
import { confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatCurrency, formatSqlDateTime } from "../utils/format.js";
import {
  boostLabel,
  debitedCoinCents,
  paymentLabel,
  pendingReasonLabel,
  renderPendingBoosts,
  renderRefundToDo,
} from "../utils/challenge-boost.js";
import { boostConfigManage } from "./boost-config-manage.js";

/** Marks refunded a paid boost left pending, or edits the price grid of the boosts. */
export async function boostsManage(session: DatabaseSession, config: Config): Promise<void> {
  const action = await select<"refund" | "grid" | "back">({
    message: "Boosts :",
    choices: [
      { name: "Marquer rembourse un boost paye reste pending", value: "refund" },
      { name: "Grille des prix (modifier, ajouter, supprimer, couper un boost)", value: "grid" },
      { name: "Retour", value: "back" },
    ],
  });
  if (action === "refund") await markRefunded(session, config);
  if (action === "grid") await boostConfigManage(session);
}

function refusal(err: Error): string {
  if (err instanceof BoostRefusedError) {
    switch (err.code) {
      case "boost_not_pending":
        return "le boost a ete applique entre-temps : un boost applique n'est jamais rembourse";
      case "boost_being_applied":
        return "le boost est en cours d'application, reessayez dans 5 minutes";
      case "boost_not_found":
        return "boost introuvable";
    }
  }
  return err.message;
}

async function markRefunded(session: DatabaseSession, config: Config): Promise<void> {
  const { connection: conn, env, operator } = session;
  ui.sectionHeader("Boosts payes restes pending");
  const pending = await boostQ.getPendingBoosts(conn);
  renderPendingBoosts(pending);
  if (pending.length === 0) return;

  const boostUuid = await select<string>({
    message: "Boost a marquer rembourse :",
    choices: [
      ...pending.map((boost) => ({
        name: `${boost.email ?? "?"} · ${boostLabel(boost)} · ${formatCurrency(boost.price_cents / 100)} · ${formatSqlDateTime(boost.created_at)}`,
        value: boost.boost_uuid,
      })),
      { name: "Retour", value: "" },
    ],
  });
  const boost = pending.find((b) => b.boost_uuid === boostUuid);
  if (!boost) return;

  ui.sectionHeader("Recapitulatif");
  renderKeyValue({
    "Client": boost.email ?? "?",
    "Compte": boost.login ?? "?",
    "Boost": boostLabel(boost),
    "Prix": formatCurrency(boost.price_cents / 100),
    "Paiement": paymentLabel(boost),
    "Raison du pending": pendingReasonLabel(boost.pending_reason),
    "Auteur": operator,
  });
  ui.warn("Le boost passe en refunded et ne sera plus applique. Aucun argent ne bouge : le remboursement se fait a part.");
  const confirmed = await confirmProductionAction(env, `Marquer rembourse le boost ${boost.boost_uuid}`);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  let refunded: boolean;
  try {
    ({ refunded } = await refundBoost(config, env, boost.boost_uuid, operator));
  } catch (err) {
    ui.error(`Refuse : ${refusal(err instanceof Error ? err : new Error(String(err)))}`);
    return;
  }
  await auditRefund(session, boost, refunded);
  if (refunded) ui.success("Boost marque rembourse, boost_refunded emis.");
  else ui.info("Ce boost etait deja marque rembourse : rien n'a change.");
  ui.sectionHeader("A faire maintenant");
  renderRefundToDo(boost);
}

async function auditRefund(session: DatabaseSession, boost: BoostRow, refunded: boolean): Promise<void> {
  const { connection: conn, env, operator } = session;
  await auditLogQ.insertAuditLog(conn, "BOOST_REFUND", "challenge_boost", boost.boost_uuid, {
    email: boost.email,
    login: boost.login,
    trading_account_uuid: boost.trading_account_uuid,
    boost_type: boost.boost_type,
    reduction_pct: boost.reduction_pct,
    position_id: boost.position_id,
    price_cents: boost.price_cents,
    money_cents: boost.money_cents,
    wegetcoin_debited_cents: debitedCoinCents(boost),
    provider: boost.provider,
    provider_payment_id: boost.provider_payment_id,
    merchant_reference_id: boost.merchant_reference_id,
    pending_reason: boost.pending_reason,
    already_refunded: !refunded,
  }, operator, env);
}
