import type mysql from "mysql2/promise";
import type { DbUser } from "../types.js";
import * as xpQ from "../queries/xp.queries.js";
import * as ui from "../ui.js";
import { renderKeyValue, renderTable } from "./table.js";
import { formatDate, formatSqlDateTime, truncate } from "./format.js";

const TIER_LABELS: Record<string, string> = {
  bronze: "Bronze",
  silver: "Argent",
  gold: "Or",
  platinum: "Platine",
  diamond: "Diamant",
  legend: "Legend",
};

const ROMAN = ["I", "II", "III", "IV"];

const KIND_LABELS: Record<string, string> = {
  trading_day: "Jour trade",
  active_week: "Semaine active",
  phase1_passed: "Phase 1 reussie",
  phase2_passed: "Phase 2 reussie",
  unlimited_passed: "Challenge 1 Etape reussi",
  funded_activated: "Funded active",
  payout_paid: "Payout paye",
  purchase: "Achat",
  box_reward: "Lot de box",
  support_adjustment: "Ajustement support",
};

/** Gifts the claim delivers today; the others stay to claim until their feature ships. */
const CLAIMABLE_NOW = new Set([
  "wegetcoin",
  "legend_discount",
  "voucher_challenge",
  "certificate_design",
  "card_design",
  "avatar_skin",
  "mystery_box",
]);

export interface XpState {
  profile: xpQ.XpProfile;
  grid: xpQ.LevelConfig[];
}

export function levelName(grid: xpQ.LevelConfig[], level: number): string {
  const config = grid.find((row) => row.level === level);
  return config ? `${TIER_LABELS[config.tier] ?? config.tier} ${ROMAN[config.sub_level - 1] ?? ""}`.trim() : `Niveau ${level}`;
}

/** The level an XP total reaches; a trader never goes below the level already reached. */
export function levelAfter(grid: xpQ.LevelConfig[], reached: number, xpTotal: number): number {
  const earned = grid.filter((row) => row.xp_required <= xpTotal).reduce((top, row) => Math.max(top, row.level), 1);
  return Math.max(reached, earned);
}

function giftLabel(gift: string, payload: Record<string, unknown>): string {
  const tier = typeof payload.tier === "string" ? TIER_LABELS[payload.tier] ?? payload.tier : "";
  switch (gift) {
    case "wegetcoin":
      return `${payload.coins} WGC`;
    case "voucher_challenge": {
      const size = Number(payload.size ?? 0) / 1000;
      const percent = Number(payload.discount_percent ?? 100);
      return `Bon ${payload.challenge_type} ${size}K ${percent >= 100 ? "offert" : `a -${percent} %`}`;
    }
    case "voucher_option":
      return "Option offerte au choix";
    case "voucher_boost":
      return payload.boost_type === "erasure"
        ? "Boost effacement d'un trade"
        : `Boost reduction d'objectif ${payload.reduction_pct ?? 1} %`;
    case "mystery_box":
      return `Mystery Box ${payload.box_type === "premium" ? "Premium" : "Classique"}`;
    case "certificate_design":
      return `Design de certificat ${tier}`.trim();
    case "card_design":
      return `Design de carte ${tier}`.trim();
    case "legend_discount":
      return "Remise Legend 10 %";
    default:
      return gift;
  }
}

function rewardStatus(row: xpQ.LevelRewardRow): string {
  if (row.status === "claimed") return `Reclamee le ${formatDate(row.claimed_at)}`;
  return CLAIMABLE_NOW.has(row.gift_type) ? "A reclamer" : "A reclamer (bientot livrable)";
}

function voucherStatus(row: xpQ.LevelRewardRow): string {
  if (row.uses > 0) return "Utilise";
  if (row.ends_at && new Date(row.ends_at).getTime() <= Date.now()) return "Expire";
  return "Actif";
}

/**
 * Shows a trader's level, XP, latest journal lines, rewards and vouchers.
 * Read-only, shared by the consultation screen and the support action.
 */
export async function renderXp(conn: mysql.Connection, user: DbUser, journalLimit: number): Promise<XpState> {
  ui.sectionHeader("Niveau et XP");

  const grid = await xpQ.getLevelGrid(conn);
  const profile = (await xpQ.getProfile(conn, user.user_uuid)) ?? { xp_total: 0, level: 1, legend_discount: false };
  const next = grid.find((row) => row.level === profile.level + 1);
  renderKeyValue({
    "Niveau": `${levelName(grid, profile.level)} (niveau ${profile.level})`,
    "XP totale": `${profile.xp_total} XP`,
    "Niveau suivant": next
      ? `${levelName(grid, next.level)} a ${next.xp_required} XP (encore ${Math.max(0, next.xp_required - profile.xp_total)} XP)`
      : "Niveau maximum atteint",
    "Remise Legend": profile.legend_discount ? "Active" : "Non",
  });

  const total = await xpQ.countJournal(conn, user.user_uuid);
  console.log("");
  if (total === 0) {
    ui.info("Aucune ligne d'XP.");
  } else {
    const lines = await xpQ.getJournal(conn, user.user_uuid, journalLimit);
    renderTable(
      ["Date", "Type", "XP", "Total apres", "Auteur", "Motif / reference"],
      lines.map((line) => [
        formatSqlDateTime(line.created_at),
        KIND_LABELS[line.kind] ?? line.kind,
        line.amount > 0 ? `+${line.amount}` : String(line.amount),
        String(line.xp_total_after),
        truncate(line.author, 24),
        truncate(line.reason ?? `${line.reference_type} ${line.reference_id}`, 40),
      ])
    );
    if (total > lines.length) ui.info(`${lines.length} dernieres lignes sur ${total}.`);
  }

  const rewards = await xpQ.getRewards(conn, user.user_uuid);
  console.log("");
  if (rewards.length === 0) {
    ui.info("Aucune recompense debloquee.");
  } else {
    renderTable(
      ["Niveau", "Recompense", "Statut"],
      rewards.map((row) => [levelName(grid, row.level), giftLabel(row.gift_type, row.payload), rewardStatus(row)])
    );
  }

  const vouchers = rewards.filter((row) => row.code);
  if (vouchers.length > 0) {
    console.log("");
    renderTable(
      ["Bon", "Code", "Expire le", "Statut"],
      vouchers.map((row) => [
        giftLabel(row.gift_type, row.payload),
        row.code ?? "",
        formatDate(row.ends_at),
        voucherStatus(row),
      ])
    );
  }

  return { profile, grid };
}
