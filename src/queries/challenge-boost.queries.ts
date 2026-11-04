import type mysql from "mysql2/promise";

type Conn = mysql.Connection;

export interface BoostRow {
  boost_uuid: string;
  trading_account_uuid: string;
  login: string | null;
  email: string | null;
  phase: number;
  boost_type: "reduction" | "erasure";
  reduction_pct: number | null;
  position_id: number;
  credited_cents: number | null;
  progress_at_purchase: number;
  price_cents: number;
  money_cents: number;
  wegetcoin_cents: number;
  /** Part of the coins debited beyond the WeGetCoin share, to give back with it. */
  wegetcoin_rounding_cents: number;
  payment_method: string;
  provider: string;
  merchant_reference_id: string | null;
  provider_payment_id: string;
  status: "pending" | "applied" | "refunded";
  pending_reason: string | null;
  claimed_at: Date | null;
  created_at: Date;
  applied_at: Date | null;
}

/** A position summed over its partial closes. */
export interface PositionSummary {
  trading_account_uuid: string;
  login: string | null;
  position_id: number;
  symbol: string;
  direction: string;
  volume: number;
  pnl: number;
  opened_at: Date;
  closed_at: Date;
}

const LOGIN = `CAST((SELECT ba.login FROM broker_accounts ba WHERE ba.trading_account_id = cb.trading_account_uuid
  ORDER BY ba.active DESC LIMIT 1) AS CHAR)`;

const BOOST_COLS = `
  BIN_TO_UUID(cb.boost_uuid) AS boost_uuid,
  BIN_TO_UUID(cb.trading_account_uuid) AS trading_account_uuid,
  ${LOGIN} AS login, u.email,
  cb.phase, cb.boost_type, cb.reduction_pct, cb.position_id, cb.credited_cents, cb.progress_at_purchase,
  cb.price_cents, cb.money_cents, cb.wegetcoin_cents, cb.wegetcoin_rounding_cents, cb.payment_method, cb.provider, cb.merchant_reference_id,
  cb.provider_payment_id, cb.status, cb.pending_reason, cb.claimed_at, cb.created_at, cb.applied_at
`;

export async function getUserBoosts(conn: Conn, userUuid: string): Promise<BoostRow[]> {
  const [rows] = await conn.execute(
    `SELECT ${BOOST_COLS}
     FROM challenge_boost cb
     LEFT JOIN user u ON u.user_uuid = cb.user_uuid
     WHERE cb.user_uuid = UUID_TO_BIN(?)
     ORDER BY cb.created_at DESC
     LIMIT 200`,
    [userUuid]
  );
  return rows as BoostRow[];
}

/** Paid boosts never applied, oldest first: the support refunds them by hand. */
export async function getPendingBoosts(conn: Conn): Promise<BoostRow[]> {
  const [rows] = await conn.execute(
    `SELECT ${BOOST_COLS}
     FROM challenge_boost cb
     LEFT JOIN user u ON u.user_uuid = cb.user_uuid
     WHERE cb.status = 'pending'
     ORDER BY cb.created_at
     LIMIT 200`,
    []
  );
  return rows as BoostRow[];
}

export async function getBoost(conn: Conn, boostUuid: string): Promise<BoostRow | null> {
  const [rows] = await conn.execute(
    `SELECT ${BOOST_COLS}
     FROM challenge_boost cb
     LEFT JOIN user u ON u.user_uuid = cb.user_uuid
     WHERE cb.boost_uuid = UUID_TO_BIN(?)`,
    [boostUuid]
  );
  return (rows as BoostRow[])[0] ?? null;
}

const POSITION_COLS = `
  BIN_TO_UUID(p.trading_account_uuid) AS trading_account_uuid,
  CAST((SELECT ba.login FROM broker_accounts ba WHERE ba.trading_account_id = p.trading_account_uuid
    ORDER BY ba.active DESC LIMIT 1) AS CHAR) AS login,
  p.position_id, p.symbol, p.direction,
  SUM(p.volume) AS volume, SUM(p.pnl) AS pnl,
  MIN(p.open_timestamp) AS opened_at, MAX(p.close_timestamp) AS closed_at
`;

export async function getErasedPosition(
  conn: Conn,
  tradingAccountUuid: string,
  positionId: number
): Promise<PositionSummary | null> {
  const [rows] = await conn.execute(
    `SELECT ${POSITION_COLS}
     FROM positions p
     WHERE p.trading_account_uuid = UUID_TO_BIN(?) AND p.position_id = ? AND COALESCE(p.invalid, 0) = 0
     GROUP BY p.trading_account_uuid, p.position_id, p.symbol, p.direction`,
    [tradingAccountUuid, positionId]
  );
  return (rows as PositionSummary[])[0] ?? null;
}

/**
 * Possible hedge of an erased position: the same symbol the other way, on another account of the same trader,
 * open at some moment while the erased position was.
 */
export async function getOppositePositions(
  conn: Conn,
  userUuid: string,
  erased: PositionSummary
): Promise<PositionSummary[]> {
  const [rows] = await conn.execute(
    `SELECT ${POSITION_COLS}
     FROM positions p
     JOIN trading_account ta ON ta.trading_account_uuid = p.trading_account_uuid
     JOIN orders o ON o.order_uuid = ta.order_uuid
     WHERE o.user_uuid = UUID_TO_BIN(?) AND p.trading_account_uuid <> UUID_TO_BIN(?)
       AND p.symbol = ? AND p.direction <> ? AND COALESCE(p.invalid, 0) = 0
     GROUP BY p.trading_account_uuid, p.position_id, p.symbol, p.direction
     HAVING MIN(p.open_timestamp) < ? AND MAX(p.close_timestamp) > ?
     ORDER BY opened_at
     LIMIT 50`,
    [userUuid, erased.trading_account_uuid, erased.symbol, erased.direction, erased.closed_at, erased.opened_at]
  );
  return rows as PositionSummary[];
}
