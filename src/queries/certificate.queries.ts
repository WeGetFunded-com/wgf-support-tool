import type mysql from "mysql2/promise";

type Conn = mysql.Connection;

export interface CertificateRow {
  certificate_uuid: string;
  public_id: string;
  type: "funded" | "payout" | "payout_total";
  status: "active" | "revoked";
  challenge_type: string | null;
  account_size: number | null;
  amount_cents: number | null;
  issued_at: Date;
  mailed_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  revoked_by: string | null;
}

/** A challenge account turned funded (paid activation or One Time Payment) that has no Funded certificate. */
export interface MissingFundedRow {
  trading_account_uuid: string;
  login: number | null;
  challenge_name: string | null;
  activated_at: Date | null;
}

/** A paid payout, outside contests, that has no Payout certificate. */
export interface MissingPayoutRow {
  payout_request_uuid: string;
  payout_amount: number;
  profit_split: string;
  login: number | null;
  paid_at: Date;
}

export async function listCertificates(conn: Conn, userUuid: string): Promise<CertificateRow[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(certificate_uuid) AS certificate_uuid, public_id, type, status, challenge_type, account_size,
            amount_cents, issued_at, mailed_at, revoked_at, revoked_reason, revoked_by
     FROM certificate
     WHERE user_uuid = UUID_TO_BIN(?)
     ORDER BY issued_at DESC
     LIMIT 200`,
    [userUuid]
  );
  return (rows as CertificateRow[]).map((row) => ({
    ...row,
    account_size: row.account_size == null ? null : Number(row.account_size),
    amount_cents: row.amount_cents == null ? null : Number(row.amount_cents),
  }));
}

export async function listMissingFunded(conn: Conn, userUuid: string, since: string): Promise<MissingFundedRow[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(ta.trading_account_uuid) AS trading_account_uuid, ta.ctrader_trading_account AS login,
            c.name AS challenge_name, ta.state_changed_at AS activated_at
     FROM trading_account ta
     JOIN orders o ON ta.order_uuid = o.order_uuid
     LEFT JOIN challenge c ON c.challenge_uuid = o.challenge_uuid
     WHERE o.user_uuid = UUID_TO_BIN(?)
       AND ta.reason = 'FUNDED_ACTIVATED'
       AND ta.state_changed_at >= ?
       AND NOT EXISTS (SELECT 1 FROM certificate ce WHERE ce.funded_account_uuid = ta.trading_account_uuid)
     ORDER BY ta.state_changed_at DESC
     LIMIT 50`,
    [userUuid, since]
  );
  return rows as MissingFundedRow[];
}

export async function listMissingPayouts(conn: Conn, userUuid: string, since: string): Promise<MissingPayoutRow[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(p.payout_request_uuid) AS payout_request_uuid, p.payout_amount, p.profit_split,
            ta.ctrader_trading_account AS login, p.updated_at AS paid_at
     FROM payout_request p
     LEFT JOIN trading_account ta ON ta.trading_account_uuid = p.trading_account_uuid
     WHERE p.user_uuid = UUID_TO_BIN(?)
       AND p.status = 'paid'
       AND p.profit_split <> 'contest'
       AND p.updated_at >= ?
       AND NOT EXISTS (SELECT 1 FROM certificate ce WHERE ce.payout_request_uuid = p.payout_request_uuid)
     ORDER BY p.updated_at DESC
     LIMIT 50`,
    [userUuid, since]
  );
  return (rows as MissingPayoutRow[]).map((row) => ({ ...row, payout_amount: Number(row.payout_amount) }));
}
