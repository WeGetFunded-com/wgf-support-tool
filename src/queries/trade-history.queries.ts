import type mysql from "mysql2/promise";
import type { DbTradeHistory, DbPosition } from "../types.js";

type Conn = mysql.Connection;

export async function getTradeHistory(
  conn: Conn,
  taUuid: string,
  limit = 10
): Promise<DbTradeHistory[]> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(trade_history_uuid) as trade_history_uuid,
            BIN_TO_UUID(trading_account_uuid) as trading_account_uuid,
            pull_date, balance, equity,
            number_of_trade_open, number_of_trade_closed,
            pnl, volume
     FROM trade_history
     WHERE trading_account_uuid = UUID_TO_BIN(?)
     ORDER BY pull_date DESC
     LIMIT ${safeLimit}`,
    [taUuid]
  );
  return rows as DbTradeHistory[];
}

export async function getLatestTradeHistory(
  conn: Conn,
  taUuid: string
): Promise<DbTradeHistory | null> {
  const results = await getTradeHistory(conn, taUuid, 1);
  return results[0] ?? null;
}

export async function getPositions(
  conn: Conn,
  taUuid: string,
  limit = 20
): Promise<DbPosition[]> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const [rows] = await conn.execute(
    `SELECT position_id,
            BIN_TO_UUID(trading_account_uuid) as trading_account_uuid,
            symbol, direction, entry_price, close_price, volume,
            commission, swap, pnl,
            open_timestamp, close_timestamp,
            spread_betting, invalid, created_at
     FROM positions
     WHERE trading_account_uuid = UUID_TO_BIN(?)
     ORDER BY open_timestamp DESC
     LIMIT ${safeLimit}`,
    [taUuid]
  );
  return rows as DbPosition[];
}

export interface PositionsSummary {
  total: number;
  open: number;
  closed: number;
  totalPnl: number;
  invalidCount: number;
}

export async function getPositionsSummary(
  conn: Conn,
  taUuid: string
): Promise<PositionsSummary> {
  const [rows] = await conn.execute(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN close_timestamp IS NULL THEN 1 ELSE 0 END) as open_count,
       SUM(CASE WHEN close_timestamp IS NOT NULL THEN 1 ELSE 0 END) as closed_count,
       COALESCE(SUM(pnl), 0) as total_pnl,
       SUM(CASE WHEN invalid = 1 THEN 1 ELSE 0 END) as invalid_count
     FROM positions
     WHERE trading_account_uuid = UUID_TO_BIN(?)`,
    [taUuid]
  );
  const r = (rows as any[])[0];
  return {
    total: Number(r.total) || 0,
    open: Number(r.open_count) || 0,
    closed: Number(r.closed_count) || 0,
    totalPnl: Number(r.total_pnl) || 0,
    invalidCount: Number(r.invalid_count) || 0,
  };
}

export async function getFirstTradeHistory(
  conn: Conn,
  taUuid: string
): Promise<DbTradeHistory | null> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(trade_history_uuid) as trade_history_uuid,
            BIN_TO_UUID(trading_account_uuid) as trading_account_uuid,
            pull_date, balance, equity,
            number_of_trade_open, number_of_trade_closed,
            pnl, volume
     FROM trade_history
     WHERE trading_account_uuid = UUID_TO_BIN(?)
     ORDER BY pull_date ASC
     LIMIT 1`,
    [taUuid]
  );
  const arr = rows as DbTradeHistory[];
  return arr[0] ?? null;
}

export async function getTradeHistoryForDate(
  conn: Conn,
  taUuid: string,
  date: string
): Promise<DbTradeHistory[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(trade_history_uuid) as trade_history_uuid,
            BIN_TO_UUID(trading_account_uuid) as trading_account_uuid,
            pull_date, balance, equity,
            number_of_trade_open, number_of_trade_closed,
            pnl, volume
     FROM trade_history
     WHERE trading_account_uuid = UUID_TO_BIN(?)
       AND DATE(pull_date) = ?
     ORDER BY pull_date ASC`,
    [taUuid, date]
  );
  return rows as DbTradeHistory[];
}

export async function createInitialTradeHistory(
  conn: Conn,
  tradeHistoryUuid: string,
  taUuid: string,
  initialBalance: number
): Promise<void> {
  await conn.execute(
    `INSERT INTO trade_history (
       trade_history_uuid, trading_account_uuid,
       pull_date, balance, equity,
       number_of_trade_open, number_of_trade_closed,
       pnl, volume
     ) VALUES (
       UUID_TO_BIN(?), UUID_TO_BIN(?),
       NOW(), ?, ?,
       0, 0, 0, 0
     )`,
    [tradeHistoryUuid, taUuid, initialBalance, initialBalance]
  );
}
