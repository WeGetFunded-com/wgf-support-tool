import type mysql from "mysql2/promise";
import type { DbBackToFunded } from "../types.js";

type Conn = mysql.Connection;

const BTF_COLS = `
  BIN_TO_UUID(offer_uuid) as offer_uuid,
  BIN_TO_UUID(user_uuid) as user_uuid,
  BIN_TO_UUID(breached_account_uuid) as breached_account_uuid,
  BIN_TO_UUID(original_order_uuid) as original_order_uuid,
  BIN_TO_UUID(funded_challenge_uuid) as funded_challenge_uuid,
  base_challenge_price, amount, currency, geidea_invoice_id, payment_link,
  status, created_at, paid_at, expires_at
`;

export async function getPendingBackToFundedByAccount(
  conn: Conn,
  breachedAccountUuid: string
): Promise<DbBackToFunded | null> {
  const [rows] = await conn.execute(
    `SELECT ${BTF_COLS}
     FROM back_to_funded
     WHERE breached_account_uuid = UUID_TO_BIN(?) AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [breachedAccountUuid]
  );
  const arr = rows as DbBackToFunded[];
  return arr[0] ?? null;
}

export async function getBackToFundedByAccount(
  conn: Conn,
  breachedAccountUuid: string
): Promise<DbBackToFunded | null> {
  const [rows] = await conn.execute(
    `SELECT ${BTF_COLS}
     FROM back_to_funded
     WHERE breached_account_uuid = UUID_TO_BIN(?)
     ORDER BY created_at DESC
     LIMIT 1`,
    [breachedAccountUuid]
  );
  const arr = rows as DbBackToFunded[];
  return arr[0] ?? null;
}
