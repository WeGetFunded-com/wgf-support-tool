import type mysql from "mysql2/promise";
import * as boostQ from "../queries/challenge-boost.queries.js";
import type { BoostRow, PositionSummary } from "../queries/challenge-boost.queries.js";
import * as ui from "../ui.js";
import { formatCurrency, formatSqlDateTime, truncate } from "./format.js";
import { renderKeyValue, renderTable } from "./table.js";
import { CENTS_PER_COIN } from "./wegetcoin.js";

const STATUS_LABELS: Record<BoostRow["status"], string> = {
  pending: "pending",
  applied: "applique",
  refunded: "rembourse",
};

const PHASE_LABELS: Record<number, string> = { 0: "Unlimited", 1: "P1", 2: "P2" };

const PENDING_REASONS: Record<string, string> = {
  account_ended: "compte termine entre paiement et application",
  already_used: "reduction deja prise sur la phase",
  would_validate: "aurait valide la phase",
  position_gone: "position plus effacable",
  nothing_to_give: "plus rien a rendre",
  application_error: "erreur d'application (MT5 ou base)",
};

export function pendingReasonLabel(reason: string | null): string {
  if (!reason) return "en attente d'application";
  return PENDING_REASONS[reason] ?? reason;
}

function euros(cents: number): string {
  return formatCurrency(cents / 100, "EUR");
}

function dollars(amount: number): string {
  return formatCurrency(amount, "USD");
}

/** The coins debited for the boost, its WeGetCoin share and the rounding taken with it. */
export function debitedCoinCents(boost: BoostRow): number {
  return boost.wegetcoin_cents + boost.wegetcoin_rounding_cents;
}

function coins(cents: number): string {
  return `${Math.trunc(cents / CENTS_PER_COIN)} WGC`;
}

export function boostLabel(boost: BoostRow): string {
  return boost.boost_type === "reduction" ? `Reduction -${boost.reduction_pct} %` : `Effacement #${boost.position_id}`;
}

export function paymentLabel(boost: BoostRow): string {
  const parts = [];
  if (boost.money_cents > 0) parts.push(`carte ${euros(boost.money_cents)}`);
  if (debitedCoinCents(boost) > 0) parts.push(coins(debitedCoinCents(boost)));
  if (boost.payment_method === "voucher") parts.push("bon");
  return parts.join(" + ") || boost.payment_method;
}

function positionLabel(position: PositionSummary): string {
  return `${position.symbol} ${position.direction} vol. ${position.volume}`;
}

/** The opposite positions of every erasure of the list, by boost. */
async function hedgesOf(conn: mysql.Connection, userUuid: string, boosts: BoostRow[]) {
  const hedges = new Map<string, { erased: PositionSummary; opposite: PositionSummary[] }>();
  for (const boost of boosts) {
    if (boost.boost_type !== "erasure") continue;
    const erased = await boostQ.getErasedPosition(conn, boost.trading_account_uuid, boost.position_id);
    if (!erased) continue;
    hedges.set(boost.boost_uuid, { erased, opposite: await boostQ.getOppositePositions(conn, userUuid, erased) });
  }
  return hedges;
}

/** A trader's boosts with the possible hedge of each erased position; returns the boosts listed. */
export async function renderUserBoosts(conn: mysql.Connection, userUuid: string): Promise<BoostRow[]> {
  ui.sectionHeader("Boosts");
  const boosts = await boostQ.getUserBoosts(conn, userUuid);
  if (boosts.length === 0) {
    ui.info("Aucun boost.");
    return boosts;
  }

  const hedges = await hedgesOf(conn, userUuid, boosts);
  renderTable(
    ["Date (UTC)", "Compte", "Phase", "Boost", "Trade efface", "Rendu", "Prix", "Paiement", "Statut", "Couverture"],
    boosts.map((boost) => {
      const hedge = hedges.get(boost.boost_uuid);
      return [
        formatSqlDateTime(boost.created_at).slice(0, 16),
        boost.login ?? "?",
        PHASE_LABELS[boost.phase] ?? `Phase ${boost.phase}`,
        boostLabel(boost),
        hedge ? positionLabel(hedge.erased) : "",
        boost.credited_cents ? `+${dollars(boost.credited_cents / 100)}` : "",
        euros(boost.price_cents),
        paymentLabel(boost),
        STATUS_LABELS[boost.status],
        boost.boost_type !== "erasure" ? "" : hedge && hedge.opposite.length > 0 ? `possible (${hedge.opposite.length})` : "-",
      ];
    })
  );

  for (const [boostUuid, hedge] of hedges) {
    if (hedge.opposite.length > 0) renderHedge(boosts.find((b) => b.boost_uuid === boostUuid), hedge.erased, hedge.opposite);
  }
  return boosts;
}

function renderHedge(boost: BoostRow | undefined, erased: PositionSummary, opposite: PositionSummary[]): void {
  console.log("");
  ui.warn(
    `Couverture possible : compte ${boost?.login ?? "?"}, ${positionLabel(erased)}, ` +
      `${formatSqlDateTime(erased.opened_at)} -> ${formatSqlDateTime(erased.closed_at)} UTC, ${dollars(erased.pnl)}`
  );
  renderTable(
    ["Compte", "Position", "Sens et volume", "Ouverture (UTC)", "Cloture (UTC)", "P&L"],
    opposite.map((p) => [
      p.login ?? "?",
      `#${p.position_id} ${p.symbol}`,
      `${p.direction} vol. ${p.volume}`,
      formatSqlDateTime(p.opened_at),
      formatSqlDateTime(p.closed_at),
      dollars(p.pnl),
    ])
  );
}

export function renderPendingBoosts(boosts: BoostRow[]): void {
  renderTable(
    ["Paye le (UTC)", "Client", "Compte", "Boost", "Prix", "Paiement", "Raison", "Boost uuid"],
    boosts.map((boost) => [
      formatSqlDateTime(boost.created_at).slice(0, 16),
      truncate(boost.email ?? "?", 30),
      boost.login ?? "?",
      boostLabel(boost),
      euros(boost.price_cents),
      paymentLabel(boost),
      truncate(pendingReasonLabel(boost.pending_reason), 40),
      boost.boost_uuid,
    ])
  );
}

/** What the support gives back by hand once a boost is marked refunded. */
export function renderRefundToDo(boost: BoostRow): void {
  const todo: Record<string, string> = {};
  if (debitedCoinCents(boost) > 0) {
    todo["WeGetCoins a recrediter"] = `${coins(debitedCoinCents(boost))} (${euros(debitedCoinCents(boost))}) via Actions > WeGetCoins`;
  }
  if (boost.money_cents > 0) {
    todo["Carte a rembourser"] = `${euros(boost.money_cents)} chez ${boost.provider}, paiement ${boost.provider_payment_id || "?"}`;
  }
  todo["Reference du paiement"] = boost.merchant_reference_id ?? "?";
  renderKeyValue(todo);
}
