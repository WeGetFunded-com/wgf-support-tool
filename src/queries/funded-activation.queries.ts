import type mysql from "mysql2/promise";
import type { DbFundedActivation } from "../types.js";

type Conn = mysql.Connection;

const FA_COLS = `
  BIN_TO_UUID(activation_uuid) as activation_uuid,
  BIN_TO_UUID(user_uuid) as user_uuid,
  BIN_TO_UUID(trading_account_uuid) as trading_account_uuid,
  BIN_TO_UUID(original_order_uuid) as original_order_uuid,
  BIN_TO_UUID(funded_challenge_uuid) as funded_challenge_uuid,
  amount, currency, geidea_invoice_id, payment_link,
  status, created_at, paid_at, expires_at
`;

export async function getPendingFundedActivationByTradingAccount(
  conn: Conn,
  taUuid: string
): Promise<DbFundedActivation | null> {
  const [rows] = await conn.execute(
    `SELECT ${FA_COLS}
     FROM funded_activation
     WHERE trading_account_uuid = UUID_TO_BIN(?) AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [taUuid]
  );
  const arr = rows as DbFundedActivation[];
  return arr[0] ?? null;
}

export async function getFundedActivationByTradingAccount(
  conn: Conn,
  taUuid: string
): Promise<DbFundedActivation | null> {
  const [rows] = await conn.execute(
    `SELECT ${FA_COLS}
     FROM funded_activation
     WHERE trading_account_uuid = UUID_TO_BIN(?)
     ORDER BY created_at DESC
     LIMIT 1`,
    [taUuid]
  );
  const arr = rows as DbFundedActivation[];
  return arr[0] ?? null;
}

export async function markFundedActivationPaid(
  conn: Conn,
  activationUuid: string
): Promise<void> {
  await conn.execute(
    `UPDATE funded_activation
     SET status = 'paid', paid_at = NOW()
     WHERE activation_uuid = UUID_TO_BIN(?)`,
    [activationUuid]
  );
}
