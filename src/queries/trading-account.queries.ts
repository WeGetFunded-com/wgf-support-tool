import type mysql from "mysql2/promise";
import type { DbTradingAccount, DbTradingAccountBalance, DbOption } from "../types.js";

type Conn = mysql.Connection;

const TA_COLS = `
  BIN_TO_UUID(ta.trading_account_uuid) as trading_account_uuid,
  BIN_TO_UUID(ta.order_uuid) as order_uuid,
  BIN_TO_UUID(ta.challenge_uuid) as challenge_uuid,
  ta.ctrader_trading_account, ta.ctrader_server,
  ta.challenge_phase, ta.challenge_phase_begin, ta.challenge_phase_end,
  ta.current_profit_target_percent, ta.success,
  ta.number_of_won_trades, ta.number_of_lost_trades,
  ta.win_sum, ta.loss_sum, ta.max_trading_day,
  ta.latest_update, ta.reason,
  BIN_TO_UUID(ta.promo_uuid) as promo_uuid
`;

export async function getTradingAccountByUuid(
  conn: Conn,
  uuid: string
): Promise<DbTradingAccount | null> {
  const [rows] = await conn.execute(
    `SELECT ${TA_COLS} FROM trading_account ta WHERE ta.trading_account_uuid = UUID_TO_BIN(?)`,
    [uuid]
  );
  const arr = rows as DbTradingAccount[];
  return arr[0] ?? null;
}

export async function getTradingAccountByCtrader(
  conn: Conn,
  ctraderId: number
): Promise<DbTradingAccount | null> {
  const [rows] = await conn.execute(
    `SELECT ${TA_COLS} FROM trading_account ta WHERE ta.ctrader_trading_account = ?`,
    [ctraderId]
  );
  const arr = rows as DbTradingAccount[];
  return arr[0] ?? null;
}

export async function getActiveTradingAccountsByUser(
  conn: Conn,
  userUuid: string
): Promise<DbTradingAccount[]> {
  const [rows] = await conn.execute(
    `SELECT ${TA_COLS}
     FROM trading_account ta
     JOIN orders o ON ta.order_uuid = o.order_uuid
     WHERE o.user_uuid = UUID_TO_BIN(?) AND ta.success IS NULL
     ORDER BY ta.challenge_phase_begin DESC`,
    [userUuid]
  );
  return rows as DbTradingAccount[];
}

export async function getAllTradingAccountsByUser(
  conn: Conn,
  userUuid: string
): Promise<DbTradingAccount[]> {
  const [rows] = await conn.execute(
    `SELECT ${TA_COLS}
     FROM trading_account ta
     JOIN orders o ON ta.order_uuid = o.order_uuid
     WHERE o.user_uuid = UUID_TO_BIN(?)
     ORDER BY ta.challenge_phase_begin DESC`,
    [userUuid]
  );
  return rows as DbTradingAccount[];
}

export async function getAllTradingAccountsByOrder(
  conn: Conn,
  orderUuid: string
): Promise<DbTradingAccount[]> {
  const [rows] = await conn.execute(
    `SELECT ${TA_COLS}
     FROM trading_account ta
     WHERE ta.order_uuid = UUID_TO_BIN(?)
     ORDER BY ta.challenge_phase ASC`,
    [orderUuid]
  );
  return rows as DbTradingAccount[];
}

export async function getLastBalanceAndEquity(
  conn: Conn,
  taUuid: string
): Promise<DbTradingAccountBalance | null> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(trading_account_uuid) as trading_account_uuid,
            balance, equity, last_update
     FROM trading_account_last_balance_and_equity
     WHERE trading_account_uuid = UUID_TO_BIN(?)`,
    [taUuid]
  );
  const arr = rows as DbTradingAccountBalance[];
  return arr[0] ?? null;
}

export async function getTradingAccountOptions(
  conn: Conn,
  taUuid: string
): Promise<DbOption[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(o.option_uuid) as option_uuid, o.name, o.majoration_percent
     FROM trading_account_options tao
     JOIN options o ON tao.option_uuid = o.option_uuid
     WHERE tao.trading_account_uuid = UUID_TO_BIN(?)`,
    [taUuid]
  );
  return rows as DbOption[];
}

export async function updateProfitTarget(
  conn: Conn,
  taUuid: string,
  newTarget: number,
  reason: string
): Promise<void> {
  await conn.execute(
    `UPDATE trading_account
     SET current_profit_target_percent = ?, reason = ?
     WHERE trading_account_uuid = UUID_TO_BIN(?)`,
    [newTarget, reason, taUuid]
  );
}

export async function updateCtraderAccountId(
  conn: Conn,
  taUuid: string,
  ctraderId: number
): Promise<void> {
  await conn.execute(
    `UPDATE trading_account
     SET ctrader_trading_account = ?
     WHERE trading_account_uuid = UUID_TO_BIN(?)`,
    [ctraderId, taUuid]
  );
}

export async function deactivateAccount(
  conn: Conn,
  taUuid: string,
  reason: string
): Promise<void> {
  await conn.execute(
    `UPDATE trading_account
     SET success = 0, reason = ?
     WHERE trading_account_uuid = UUID_TO_BIN(?)`,
    [reason, taUuid]
  );
}

export async function reactivateAccount(
  conn: Conn,
  taUuid: string,
  reason: string,
  profitTarget?: number
): Promise<void> {
  if (profitTarget !== undefined) {
    await conn.execute(
      `UPDATE trading_account
       SET success = NULL, reason = ?, current_profit_target_percent = ?
       WHERE trading_account_uuid = UUID_TO_BIN(?)`,
      [reason, profitTarget, taUuid]
    );
  } else {
    await conn.execute(
      `UPDATE trading_account
       SET success = NULL, reason = ?
       WHERE trading_account_uuid = UUID_TO_BIN(?)`,
      [reason, taUuid]
    );
  }
}

export async function markAccountSuccess(
  conn: Conn,
  taUuid: string,
  reason: string
): Promise<void> {
  await conn.execute(
    `UPDATE trading_account
     SET success = 1, reason = ?
     WHERE trading_account_uuid = UUID_TO_BIN(?)`,
    [reason, taUuid]
  );
}

export async function createTradingAccount(
  conn: Conn,
  taUuid: string,
  orderUuid: string,
  challengeUuid: string,
  ctraderId: number,
  ctraderServer: "demo" | "live",
  phase: number,
  profitTarget: number,
  phaseEnd: string,
  promoUuid: string | null
): Promise<void> {
  await conn.execute(
    `INSERT INTO trading_account (
       trading_account_uuid, order_uuid, challenge_uuid,
       ctrader_trading_account, ctrader_server,
       challenge_phase, challenge_phase_begin, challenge_phase_end,
       current_profit_target_percent, success,
       number_of_won_trades, number_of_lost_trades,
       win_sum, loss_sum, max_trading_day,
       latest_update, reason, promo_uuid
     ) VALUES (
       UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?),
       ?, ?,
       ?, NOW(), ?,
       ?, NULL,
       0, 0,
       0, 0, 0,
       NOW(), '', ${promoUuid ? "UUID_TO_BIN(?)" : "NULL"}
     )`,
    promoUuid
      ? [taUuid, orderUuid, challengeUuid, ctraderId, ctraderServer, phase, phaseEnd, profitTarget, promoUuid]
      : [taUuid, orderUuid, challengeUuid, ctraderId, ctraderServer, phase, phaseEnd, profitTarget]
  );
}

export async function addTradingAccountOption(
  conn: Conn,
  taUuid: string,
  optionUuid: string
): Promise<void> {
  await conn.execute(
    `INSERT INTO trading_account_options (trading_account_uuid, option_uuid)
     VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?))`,
    [taUuid, optionUuid]
  );
}

export async function removeTradingAccountOption(
  conn: Conn,
  taUuid: string,
  optionUuid: string
): Promise<void> {
  await conn.execute(
    `DELETE FROM trading_account_options
     WHERE trading_account_uuid = UUID_TO_BIN(?) AND option_uuid = UUID_TO_BIN(?)`,
    [taUuid, optionUuid]
  );
}
