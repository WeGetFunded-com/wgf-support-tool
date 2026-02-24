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
