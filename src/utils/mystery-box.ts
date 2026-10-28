import type mysql from "mysql2/promise";
import type { DbUser } from "../types.js";
import * as boxQ from "../queries/mystery-box.queries.js";
import * as ui from "../ui.js";
import { renderKeyValue, renderTable } from "./table.js";
import { formatDate, formatSqlDateTime, truncate } from "./format.js";

export const BOX_TYPE_LABELS: Record<string, string> = {
  classic: "Classique",
  premium: "Premium",
  challenge: "Challenge",
};

export const BOX_ORIGIN_LABELS: Record<string, string> = {
  purchase: "Achat",
  level: "Palier",
  box_reward: "Lot de box",
  marketing: "Campagne",
  support: "Geste support",
};

const OPENINGS_SHOWN = 10;

export function boxLabel(row: boxQ.BoxRow): string {
  return `${BOX_TYPE_LABELS[row.box_type] ?? row.box_type} (${BOX_ORIGIN_LABELS[row.origin] ?? row.origin})`;
}

export function euros(cents: number): string {
  return `${(cents / 100).toFixed(2)} EUR`;
}

function discountLabel(row: boxQ.VoucherRow): string {
  if (row.discount_percent !== null) {
    return row.discount_percent >= 1 ? "offert" : `-${Math.round(row.discount_percent * 100)} %`;
  }
  return row.discount_amount !== null ? `-${row.discount_amount.toFixed(2)} EUR` : "option offerte";
}

function usageLabel(used: boolean, endsAt: Date | null, active = true): string {
  if (used) return "Utilise";
  if (!active || (endsAt && new Date(endsAt).getTime() <= Date.now())) return "Expire";
  return "Actif";
}

/**
 * Shows a trader's boxes: unopened ones, the latest openings and their lots, revoked ones, then the codes and vouchers
 * won in a box or at a level. Read-only, shared by the consultation screen and the support action.
 */
export async function renderMysteryBoxes(conn: mysql.Connection, user: DbUser): Promise<boxQ.BoxRow[]> {
  ui.sectionHeader("Mystery Box");

  const [boxes, draws, vouchers, boosts] = await Promise.all([
    boxQ.listBoxes(conn, user.user_uuid),
    boxQ.listDraws(conn, user.user_uuid),
    boxQ.listVouchers(conn, user.user_uuid),
    boxQ.listBoostVouchers(conn, user.user_uuid),
  ]);
  const unopened = boxes.filter((row) => row.status === "unopened");
  const opened = boxes.filter((row) => row.status === "opened");
  const revoked = boxes.filter((row) => row.status === "revoked");

  const counts = Object.keys(BOX_TYPE_LABELS)
    .map((type) => [BOX_TYPE_LABELS[type], unopened.filter((row) => row.box_type === type).length] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`);
  renderKeyValue({
    "Non ouvertes": counts.length > 0 ? counts.join(", ") : "aucune",
    "Ouvertes": String(opened.length),
    "Retirees": String(revoked.length),
  });

  if (unopened.length > 0) {
    console.log("");
    renderTable(
      ["Acquise le", "Box", "Motif / reference", "Auteur"],
      unopened.map((row) => [
        formatSqlDateTime(row.acquired_at),
        boxLabel(row),
        truncate(row.reason ?? row.origin_ref, 44),
        truncate(row.author ?? "systeme", 24),
      ])
    );
  }

  if (opened.length > 0) {
    console.log("");
    const lotsOf = (boxUuid: string) => draws.filter((draw) => draw.box_uuid === boxUuid);
    const shown = [...opened]
      .sort((a, b) => new Date(b.opened_at ?? 0).getTime() - new Date(a.opened_at ?? 0).getTime())
      .slice(0, OPENINGS_SHOWN);
    renderTable(
      ["Ouverte le", "Box", "Lots", "Cout"],
      shown.map((row) => {
        const lots = lotsOf(row.box_uuid);
        return [
          formatSqlDateTime(row.opened_at),
          boxLabel(row),
          truncate(lots.map((lot) => `${lot.lot_key}${lot.substituted ? " (remplace)" : ""}`).join(", "), 60),
          euros(lots.reduce((sum, lot) => sum + lot.cost_cents, 0)),
        ];
      })
    );
    if (opened.length > shown.length) ui.info(`${shown.length} dernieres ouvertures sur ${opened.length}.`);
  }

  if (revoked.length > 0) {
    console.log("");
    renderTable(
      ["Retiree le", "Box", "Motif", "Par"],
      revoked.map((row) => [
        formatSqlDateTime(row.revoked_at),
        boxLabel(row),
        truncate(row.revoke_reason ?? "", 44),
        truncate(row.revoked_by ?? "", 24),
      ])
    );
  }

  console.log("");
  if (vouchers.length === 0 && boosts.length === 0) {
    ui.info("Aucun bon ni code gagne.");
  } else {
    renderTable(
      ["Bon / code", "Gagne", "Remise", "Sur", "Expire le", "Statut"],
      [
        ...vouchers.map((row) => [
          row.code,
          row.internal_label === "level_reward" ? "Palier" : "Box",
          discountLabel(row),
          row.products ?? "challenge",
          formatDate(row.ends_at),
          usageLabel(row.uses > 0, row.ends_at, row.is_active),
        ]),
        ...boosts.map((row) => [
          row.boost_type === "erasure" ? "Boost effacement" : `Boost objectif -${row.reduction_pct ?? 1} %`,
          row.origin === "level" ? "Palier" : "Box",
          "",
          "un compte",
          formatDate(row.expires_at),
          usageLabel(row.used_at !== null, row.expires_at),
        ]),
      ]
    );
  }

  return boxes;
}
