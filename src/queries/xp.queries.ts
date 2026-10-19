import type mysql from "mysql2/promise";

type Conn = mysql.Connection;

export interface XpProfile {
  xp_total: number;
  level: number;
  legend_discount: boolean;
}

export interface LevelConfig {
  level: number;
  tier: string;
  sub_level: number;
  xp_required: number;
}

export interface XpLine {
  amount: number;
  kind: string;
  reference_type: string;
  reference_id: string;
  xp_total_after: number;
  reason: string | null;
  author: string;
  created_at: Date;
}

export interface LevelRewardRow {
  level: number;
  gift_type: string;
  payload: Record<string, unknown>;
  status: "unlocked" | "claimed";
  claimed_at: Date | null;
  code: string | null;
  ends_at: Date | null;
  uses: number;
}

/** Null when the trader never earned XP: the profile row is created by the first award. */
export async function getProfile(conn: Conn, userUuid: string): Promise<XpProfile | null> {
  const [rows] = await conn.execute(
    `SELECT xp_total, level, legend_discount FROM xp_profile WHERE user_uuid = UUID_TO_BIN(?)`,
    [userUuid]
  );
  const row = (rows as { xp_total: number; level: number; legend_discount: number }[])[0];
  return row
    ? { xp_total: Number(row.xp_total), level: Number(row.level), legend_discount: Boolean(row.legend_discount) }
    : null;
}

export async function getLevelGrid(conn: Conn): Promise<LevelConfig[]> {
  const [rows] = await conn.execute(
    `SELECT level, tier, sub_level, xp_required FROM level_config ORDER BY level`
  );
  return (rows as LevelConfig[]).map((row) => ({
    ...row,
    level: Number(row.level),
    sub_level: Number(row.sub_level),
    xp_required: Number(row.xp_required),
  }));
}

/** The latest journal lines, newest first; id is the strict order of the awards. */
export async function getJournal(conn: Conn, userUuid: string, limit: number): Promise<XpLine[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const [rows] = await conn.execute(
    `SELECT amount, kind, reference_type, reference_id, xp_total_after, reason, author, created_at
     FROM xp_transaction
     WHERE user_uuid = UUID_TO_BIN(?)
     ORDER BY id DESC
     LIMIT ${safeLimit}`,
    [userUuid]
  );
  return (rows as XpLine[]).map((line) => ({
    ...line,
    amount: Number(line.amount),
    xp_total_after: Number(line.xp_total_after),
  }));
}

export async function countJournal(conn: Conn, userUuid: string): Promise<number> {
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS n FROM xp_transaction WHERE user_uuid = UUID_TO_BIN(?)`,
    [userUuid]
  );
  return Number((rows as { n: number }[])[0]?.n ?? 0);
}

/** Every reward of the trader with its voucher, if the claim created one. */
export async function getRewards(conn: Conn, userUuid: string): Promise<LevelRewardRow[]> {
  const [rows] = await conn.execute(
    `SELECT r.level, r.gift_type, r.payload, r.status, r.claimed_at, p.code, p.ends_at,
            COALESCE((SELECT SUM(u.uses) FROM used_promo u WHERE u.promo_uuid = r.promo_uuid), 0) AS uses
     FROM level_reward r
     LEFT JOIN promo p ON p.promo_uuid = r.promo_uuid
     WHERE r.user_uuid = UUID_TO_BIN(?)
     ORDER BY r.level, r.gift_type`,
    [userUuid]
  );
  return (rows as LevelRewardRow[]).map((row) => ({
    ...row,
    level: Number(row.level),
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
    uses: Number(row.uses),
  }));
}

/** Owner and payment method of the order behind a trading account: free trials earn no XP. */
export async function getOrderOwner(
  conn: Conn,
  orderUuid: string
): Promise<{ user_uuid: string; method: string | null } | null> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(o.user_uuid) AS user_uuid, p.method
     FROM orders o LEFT JOIN payment p ON p.payment_uuid = o.payment_uuid
     WHERE o.order_uuid = UUID_TO_BIN(?)`,
    [orderUuid]
  );
  return (rows as { user_uuid: string; method: string | null }[])[0] ?? null;
}
