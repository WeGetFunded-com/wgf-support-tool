import type mysql from "mysql2/promise";
import type { DbPayoutRequest } from "../types.js";

type Conn = mysql.Connection;

export interface PayoutWithEmail extends DbPayoutRequest {
  email: string;
  ctrader_trading_account: number;
}

export async function getPayoutsByStatus(
  conn: Conn,
  status?: string
): Promise<PayoutWithEmail[]> {
  let sql = `
    SELECT
      BIN_TO_UUID(pr.payout_request_uuid) as payout_request_uuid,
      BIN_TO_UUID(pr.user_uuid) as user_uuid,
      BIN_TO_UUID(pr.trading_account_uuid) as trading_account_uuid,
      pr.payout_method, pr.iban, pr.wallet_address, pr.wallet_protocol,
      pr.first_name, pr.last_name, pr.postal_address,
      pr.balance_before_request, pr.total_profit, pr.payout_amount,
      pr.profit_split, pr.status, pr.created_at, pr.updated_at,
      u.email,
      ta.ctrader_trading_account
    FROM payout_request pr
    JOIN user u ON pr.user_uuid = u.user_uuid
    LEFT JOIN trading_account ta ON pr.trading_account_uuid = ta.trading_account_uuid
  `;
  const params: any[] = [];

  if (status) {
    sql += " WHERE pr.status = ?";
    params.push(status);
  }

  sql += " ORDER BY pr.created_at DESC LIMIT 50";

  const [rows] = await conn.execute(sql, params);
  return rows as PayoutWithEmail[];
}

export async function getPayoutsByUser(
  conn: Conn,
  userUuid: string
): Promise<DbPayoutRequest[]> {
  const [rows] = await conn.execute(
    `SELECT
       BIN_TO_UUID(payout_request_uuid) as payout_request_uuid,
       BIN_TO_UUID(user_uuid) as user_uuid,
       BIN_TO_UUID(trading_account_uuid) as trading_account_uuid,
       payout_method, iban, wallet_address, wallet_protocol,
       first_name, last_name, postal_address,
       balance_before_request, total_profit, payout_amount,
       profit_split, status, created_at, updated_at
     FROM payout_request
     WHERE user_uuid = UUID_TO_BIN(?)
     ORDER BY created_at DESC`,
    [userUuid]
  );
  return rows as DbPayoutRequest[];
}

export async function getPayoutByUuid(
  conn: Conn,
  uuid: string
): Promise<PayoutWithEmail | null> {
  const [rows] = await conn.execute(
    `SELECT
       BIN_TO_UUID(pr.payout_request_uuid) as payout_request_uuid,
       BIN_TO_UUID(pr.user_uuid) as user_uuid,
       BIN_TO_UUID(pr.trading_account_uuid) as trading_account_uuid,
       pr.payout_method, pr.iban, pr.wallet_address, pr.wallet_protocol,
       pr.first_name, pr.last_name, pr.postal_address,
       pr.balance_before_request, pr.total_profit, pr.payout_amount,
       pr.profit_split, pr.status, pr.created_at, pr.updated_at,
       u.email,
       ta.ctrader_trading_account
     FROM payout_request pr
     JOIN user u ON pr.user_uuid = u.user_uuid
     LEFT JOIN trading_account ta ON pr.trading_account_uuid = ta.trading_account_uuid
     WHERE pr.payout_request_uuid = UUID_TO_BIN(?)`,
    [uuid]
  );
  const arr = rows as PayoutWithEmail[];
  return arr[0] ?? null;
}

export async function updatePayoutStatus(
  conn: Conn,
  uuid: string,
  status: string
): Promise<void> {
  await conn.execute(
    `UPDATE payout_request SET status = ?, updated_at = NOW()
     WHERE payout_request_uuid = UUID_TO_BIN(?)`,
    [status, uuid]
  );
}
