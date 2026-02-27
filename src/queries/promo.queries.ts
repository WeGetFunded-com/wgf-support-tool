import type mysql from "mysql2/promise";
import type { DbPromo } from "../types.js";

type Conn = mysql.Connection;

export async function getPromoByCode(conn: Conn, code: string): Promise<DbPromo | null> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(promo_uuid) as promo_uuid,
            BIN_TO_UUID(user_uuid) as user_uuid,
            BIN_TO_UUID(challenge_uuid) as challenge_uuid,
            phase, code, percent_promo, expires_at, is_valid,
            stripe_ID, is_unlimited, \`global\`,
            descriptionFr, descriptionEn, descriptionEs, descriptionDe, descriptionIt
     FROM promo WHERE code = ?`,
    [code]
  );
  const arr = rows as DbPromo[];
  return arr[0] ?? null;
}

export interface CreatePromoData {
  promoUuid: string;
  code: string;
  percentPromo: number;
  isUnlimited: boolean;
  isGlobal: boolean;
  phase: number;
  expiresAt: string | null;
  stripeId: string | null;
  userUuid: string | null;
  challengeUuid: string | null;
  descriptionFr: string | null;
  descriptionEn: string | null;
  descriptionEs: string | null;
  descriptionDe: string | null;
  descriptionIt: string | null;
}

export interface PromoUsageRow {
  promo_uuid: string;
  code: string;
  percent_promo: number;
  is_valid: number;
  is_unlimited: number;
  global: number | null;
  expires_at: Date | null;
  descriptionFr: string | null;
  order_uuid: string;
  user_uuid: string;
  email: string;
  firstname: string;
  lastname: string;
  CTID: number;
  payment_price: number | null;
  payment_currency: string | null;
  payment_method: string | null;
  payment_date: Date | null;
  payment_proof: string | null;
  challenge_name: string | null;
  challenge_type: string | null;
  initial_coins_amount: number | null;
  ctrader_trading_account: number | null;
  ta_success: number | null;
  ta_phase: number | null;
}

export async function getOrdersByPromoCode(conn: Conn, code: string): Promise<PromoUsageRow[]> {
  const [rows] = await conn.execute(
    `SELECT
       BIN_TO_UUID(pr.promo_uuid) as promo_uuid,
       pr.code, pr.percent_promo, pr.is_valid, pr.is_unlimited, pr.\`global\`,
       pr.expires_at, pr.descriptionFr,
       BIN_TO_UUID(o.order_uuid) as order_uuid,
       BIN_TO_UUID(u.user_uuid) as user_uuid,
       u.email, u.firstname, u.lastname, u.CTID,
       p.price as payment_price, p.currency as payment_currency,
       p.method as payment_method, p.payment_date,
       p.proof as payment_proof,
       c.name as challenge_name, c.type as challenge_type,
       c.initial_coins_amount,
       ta.ctrader_trading_account,
       ta.success as ta_success,
       ta.challenge_phase as ta_phase
     FROM orders o
     INNER JOIN promo pr ON o.promo_uuid = pr.promo_uuid
     INNER JOIN user u ON o.user_uuid = u.user_uuid
     LEFT JOIN payment p ON o.payment_uuid = p.payment_uuid
     LEFT JOIN challenge c ON o.challenge_uuid = c.challenge_uuid
     LEFT JOIN trading_account ta ON ta.order_uuid = o.order_uuid
     WHERE pr.code = ?
     ORDER BY p.payment_date DESC`,
    [code]
  );
  return rows as PromoUsageRow[];
}

export async function createPromo(conn: Conn, data: CreatePromoData): Promise<void> {
  await conn.execute(
    `INSERT INTO promo (
       promo_uuid, code, percent_promo, is_valid, is_unlimited, \`global\`,
       phase, expires_at, stripe_ID,
       user_uuid, challenge_uuid,
       descriptionFr, descriptionEn, descriptionEs, descriptionDe, descriptionIt
     ) VALUES (
       UUID_TO_BIN(?), ?, ?, 1, ?, ?,
       ?, ?, ?,
       ${data.userUuid ? "UUID_TO_BIN(?)" : "NULL"},
       ${data.challengeUuid ? "UUID_TO_BIN(?)" : "NULL"},
       ?, ?, ?, ?, ?
     )`,
    [
      data.promoUuid, data.code, data.percentPromo,
      data.isUnlimited ? 1 : 0, data.isGlobal ? 1 : 0,
      data.phase, data.expiresAt, data.stripeId,
      ...(data.userUuid ? [data.userUuid] : []),
      ...(data.challengeUuid ? [data.challengeUuid] : []),
      data.descriptionFr, data.descriptionEn, data.descriptionEs,
      data.descriptionDe, data.descriptionIt,
    ]
  );
}
