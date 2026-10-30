import type mysql from "mysql2/promise";

type Conn = mysql.Connection;

export interface BoxRow {
  box_uuid: string;
  box_type: string;
  status: string;
  origin: string;
  origin_ref: string;
  acquired_at: Date;
  opened_at: Date | null;
  revoked_at: Date | null;
  reason: string | null;
  author: string | null;
  revoke_reason: string | null;
  revoked_by: string | null;
}

export interface DrawRow {
  box_uuid: string;
  draw_index: number;
  lot_key: string;
  gift_type: string;
  lot_rarity: string;
  substituted: boolean;
  cost_cents: number;
}

export interface VoucherRow {
  code: string;
  internal_label: string;
  discount_percent: number | null;
  discount_amount: number | null;
  products: string | null;
  ends_at: Date | null;
  uses: number;
  is_active: boolean;
}

export interface BoostVoucherRow {
  boost_type: string;
  reduction_pct: number | null;
  origin: string;
  expires_at: Date | null;
  used_at: Date | null;
}

export interface BoxOrderRow {
  order_uuid: string;
  box_type: string;
  pack_size: number;
  price_cents: number;
  money_cents: number;
  wegetcoin_cents: number;
  provider: string | null;
  merchant_reference_id: string | null;
  paid_at: Date | null;
}

/** Every box of the trader, newest first, whatever its status. */
export async function listBoxes(conn: Conn, userUuid: string): Promise<BoxRow[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(box_uuid) AS box_uuid, box_type, status, origin, origin_ref, acquired_at, opened_at, revoked_at,
            reason, author, revoke_reason, revoked_by
     FROM mystery_box
     WHERE user_uuid = UUID_TO_BIN(?)
     ORDER BY acquired_at DESC, origin_ref DESC`,
    [userUuid]
  );
  return rows as BoxRow[];
}

/** The lots of the trader's opened boxes, in draw order. */
export async function listDraws(conn: Conn, userUuid: string): Promise<DrawRow[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(d.box_uuid) AS box_uuid, d.draw_index, d.lot_key, d.gift_type, d.lot_rarity, d.substituted,
            d.cost_cents
     FROM mystery_box_draw d
     JOIN mystery_box b ON b.box_uuid = d.box_uuid
     WHERE b.user_uuid = UUID_TO_BIN(?)
     ORDER BY d.box_uuid, d.draw_index`,
    [userUuid]
  );
  return (rows as DrawRow[]).map((row) => ({
    ...row,
    draw_index: Number(row.draw_index),
    substituted: Boolean(row.substituted),
    cost_cents: Number(row.cost_cents),
  }));
}

/** The codes and vouchers won in a box or at a level, newest first, with the products they apply to. */
export async function listVouchers(conn: Conn, userUuid: string): Promise<VoucherRow[]> {
  const [rows] = await conn.execute(
    `SELECT p.code, p.internal_label, p.discount_percent, p.discount_amount, p.ends_at, p.is_active,
            (SELECT GROUP_CONCAT(DISTINCT COALESCE(s.product, 'challenge') ORDER BY s.product SEPARATOR ', ')
             FROM promo_scope s WHERE s.promo_uuid = p.promo_uuid) AS products,
            COALESCE((SELECT SUM(u.uses) FROM used_promo u WHERE u.promo_uuid = p.promo_uuid), 0) AS uses
     FROM promo p
     WHERE p.user_uuid = UUID_TO_BIN(?) AND p.internal_label IN ('box_reward', 'level_reward')
     ORDER BY p.starts_at DESC`,
    [userUuid]
  );
  return (rows as VoucherRow[]).map((row) => ({
    ...row,
    discount_percent: row.discount_percent === null ? null : Number(row.discount_percent),
    discount_amount: row.discount_amount === null ? null : Number(row.discount_amount),
    uses: Number(row.uses),
    is_active: Boolean(row.is_active),
  }));
}

export async function listBoostVouchers(conn: Conn, userUuid: string): Promise<BoostVoucherRow[]> {
  const [rows] = await conn.execute(
    `SELECT boost_type, reduction_pct, origin, expires_at, used_at
     FROM boost_voucher
     WHERE user_uuid = UUID_TO_BIN(?)
     ORDER BY created_at DESC`,
    [userUuid]
  );
  return (rows as BoostVoucherRow[]).map((row) => ({
    ...row,
    reduction_pct: row.reduction_pct === null ? null : Number(row.reduction_pct),
  }));
}

/** The paid order behind a bought box: its origin_ref is "<order_uuid>#<index>". */
export async function getBoxOrder(conn: Conn, originRef: string): Promise<BoxOrderRow | null> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(order_uuid) AS order_uuid, box_type, pack_size, price_cents, money_cents, wegetcoin_cents,
            provider, merchant_reference_id, paid_at
     FROM mystery_box_order
     WHERE order_uuid = UUID_TO_BIN(?)`,
    [originRef.split("#")[0]]
  );
  const order = (rows as BoxOrderRow[])[0];
  return order
    ? {
        ...order,
        pack_size: Number(order.pack_size),
        price_cents: Number(order.price_cents),
        money_cents: Number(order.money_cents),
        wegetcoin_cents: Number(order.wegetcoin_cents),
      }
    : null;
}

export interface BoostRow {
  boost_uuid: string;
  scope: "account" | "box";
  multiplier: number;
  box_type: string | null;
  guaranteed_lot_key: string | null;
  min_rarity: string | null;
  openings_left: number | null;
  expires_at: Date | null;
  extras_used_at: Date | null;
  reason: string;
  author: string;
  created_at: Date;
  revoked_at: Date | null;
  boxes: number;
  opened: number;
}

/** The trader's boosts, newest first, with the boxes each gave or opened. Never shown to the trader. */
export async function listBoosts(conn: Conn, userUuid: string): Promise<BoostRow[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(bo.boost_uuid) AS boost_uuid, bo.scope, bo.multiplier, bo.box_type, bo.guaranteed_lot_key,
            bo.min_rarity, bo.openings_left, bo.expires_at, bo.extras_used_at, bo.reason, bo.author, bo.created_at,
            bo.revoked_at,
            (SELECT COUNT(*) FROM mystery_box b WHERE b.boost_uuid = bo.boost_uuid) AS boxes,
            (SELECT COUNT(*) FROM mystery_box b WHERE b.boost_uuid = bo.boost_uuid AND b.status = 'opened') AS opened
     FROM mystery_box_boost bo
     WHERE bo.user_uuid = UUID_TO_BIN(?)
     ORDER BY bo.created_at DESC
     LIMIT 20`,
    [userUuid]
  );
  return (rows as BoostRow[]).map((row) => ({
    ...row,
    multiplier: Number(row.multiplier),
    openings_left: row.openings_left === null ? null : Number(row.openings_left),
    boxes: Number(row.boxes),
    opened: Number(row.opened),
  }));
}

/** A boost still raises chances: not revoked, not ended, openings left; a box boost lasts while its boxes are unopened. */
export function isBoostActive(row: BoostRow, now: Date = new Date()): boolean {
  if (row.revoked_at) return false;
  if (row.scope === "box") return row.opened < row.boxes;
  return (row.openings_left === null || row.openings_left > 0) && (row.expires_at === null || row.expires_at > now);
}

export interface TableLotRow {
  lot_key: string;
  slot: string;
  lot_rarity: string;
  gift_type: string;
  weight_ppm: number;
}

/** The lots of the table in force of a range, rarest first: the choices of a guaranteed lot. */
export async function listTableLots(conn: Conn, boxType: string): Promise<TableLotRow[]> {
  const [rows] = await conn.execute(
    `SELECT l.lot_key, l.slot, l.lot_rarity, l.gift_type, l.weight_ppm
     FROM mystery_box_lot l
     WHERE l.box_type = ?
       AND l.table_version = (SELECT MAX(s.table_version) FROM mystery_box_slot s
                              WHERE s.box_type = ? AND s.active_from <= UTC_TIMESTAMP(6))
     ORDER BY FIELD(l.lot_rarity, 'legendary', 'epic', 'rare', 'uncommon', 'common'), l.weight_ppm, l.lot_key`,
    [boxType, boxType]
  );
  return (rows as TableLotRow[]).map((row) => ({ ...row, weight_ppm: Number(row.weight_ppm) }));
}
