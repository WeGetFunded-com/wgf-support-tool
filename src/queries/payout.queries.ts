import type mysql from "mysql2/promise";
import type { BrokerName, DbPayoutRequest } from "../types.js";

type Conn = mysql.Connection;

export interface PayoutWithEmail extends DbPayoutRequest {
  email: string;
  ctrader_trading_account: number;
  broker_login: number | null;
  broker_name: BrokerName | null;
}

export function payoutAccountLabel(p: PayoutWithEmail): string {
  if (p.broker_login != null) {
    return p.broker_name === "mt5"
      ? `MT5 ${p.broker_login}`
      : `cTrader ${p.broker_login}`;
  }
  if (p.ctrader_trading_account) {
    return `cTrader ${p.ctrader_trading_account}`;
  }
  return "N/A";
}

const PAYOUT_BROKER_JOIN = `
    LEFT JOIN trading_account ta ON pr.trading_account_uuid = ta.trading_account_uuid
    LEFT JOIN broker_accounts ba
      ON ba.trading_account_id = pr.trading_account_uuid AND ba.active = 1
`;

const PAYOUT_BROKER_COLS = `
      ta.ctrader_trading_account,
      ba.login as broker_login,
      ba.broker_name as broker_name
`;

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
      ${PAYOUT_BROKER_COLS}
    FROM payout_request pr
    JOIN user u ON pr.user_uuid = u.user_uuid
    ${PAYOUT_BROKER_JOIN}
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
       ${PAYOUT_BROKER_COLS}
     FROM payout_request pr
     JOIN user u ON pr.user_uuid = u.user_uuid
     ${PAYOUT_BROKER_JOIN}
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
  // validated_at is the payout reset anchor: every eligibility counter (7 positive
  // days, 14 calendar days, consistency, sub-30s ratio) restarts from it. Stamp it
  // once, on the first transition to approved or paid, and never move it — the
  // manager otherwise falls back to updated_at, which shifts on any later edit and
  // silently re-dates the reset for that trader.
  await conn.execute(
    `UPDATE payout_request
        SET status = ?,
            updated_at = NOW(),
            validated_at = CASE
              WHEN validated_at IS NULL AND ? IN ('approved', 'paid') THEN NOW()
              ELSE validated_at
            END
      WHERE payout_request_uuid = UUID_TO_BIN(?)`,
    [status, status, uuid]
  );
}

/**
 * Payout requests this tool created itself, newest first.
 *
 * Provenance comes from admin_audit_log rather than from a column on
 * payout_request: the table is written by the manager and has no notion of a
 * simulation. Matching the PAYOUT_SIMULATED entry we wrote at creation is what
 * makes a genuine trader request impossible to delete by mistake — no audit
 * entry, not in this list. EXISTS rather than a join: the audit log has no
 * unique key on the target, and a join would both duplicate rows and need a
 * GROUP BY that ONLY_FULL_GROUP_BY would reject.
 *
 * Scoped to the current environment, so a staging simulation can never surface
 * while connected to production.
 */
export async function getSimulatedPayouts(
  conn: Conn,
  environment: string
): Promise<PayoutWithEmail[]> {
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
       ${PAYOUT_BROKER_COLS}
     FROM payout_request pr
     JOIN user u ON pr.user_uuid = u.user_uuid
     ${PAYOUT_BROKER_JOIN}
     WHERE EXISTS (
       SELECT 1 FROM admin_audit_log al
        WHERE al.target_uuid = pr.payout_request_uuid
          AND al.action_type = 'PAYOUT_SIMULATED'
          AND al.environment = ?
     )
     ORDER BY pr.created_at DESC
     LIMIT 50`,
    [environment]
  );
  return rows as PayoutWithEmail[];
}

/**
 * Deletes a payout request. Guarded by status: a paid request is never
 * deletable, because the money already left MT5 and this row is the only trace
 * of it in the database.
 *
 * The status is re-checked in the WHERE clause rather than trusted from the
 * caller's earlier read: the operator sits in front of a prompt, and a trader
 * request can reach 'paid' between the moment the list was drawn and the moment
 * he confirms.
 */
export async function deleteSimulatedPayout(
  conn: Conn,
  payoutRequestUuid: string
): Promise<number> {
  const [result] = await conn.execute(
    `DELETE FROM payout_request
      WHERE payout_request_uuid = UUID_TO_BIN(?)
        AND status <> 'paid'`,
    [payoutRequestUuid]
  );
  return (result as { affectedRows: number }).affectedRows;
}
