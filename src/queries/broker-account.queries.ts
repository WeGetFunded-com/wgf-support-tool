import type mysql from "mysql2/promise";
import type { DbBrokerAccount, BrokerName, DbTradingAccount } from "../types.js";

type Conn = mysql.Connection;

const BA_COLS = `
  BIN_TO_UUID(ba.id) as id,
  ba.broker_name,
  BIN_TO_UUID(ba.user_id) as user_id,
  BIN_TO_UUID(ba.trading_account_id) as trading_account_id,
  ba.client_id, ba.login, ba.server_type, ba.password, ba.active
`;

export async function getActiveBrokerAccountByTradingAccount(
  conn: Conn,
  taUuid: string
): Promise<DbBrokerAccount | null> {
  const [rows] = await conn.execute(
    `SELECT ${BA_COLS}
     FROM broker_accounts ba
     WHERE ba.trading_account_id = UUID_TO_BIN(?) AND ba.active = 1
     LIMIT 1`,
    [taUuid]
  );
  const arr = rows as DbBrokerAccount[];
  return arr[0] ?? null;
}

export async function getBrokerAccountsByTradingAccount(
  conn: Conn,
  taUuid: string
): Promise<DbBrokerAccount[]> {
  const [rows] = await conn.execute(
    `SELECT ${BA_COLS}
     FROM broker_accounts ba
     WHERE ba.trading_account_id = UUID_TO_BIN(?)
     ORDER BY ba.active DESC`,
    [taUuid]
  );
  return rows as DbBrokerAccount[];
}

export async function getTradingAccountByBrokerLogin(
  conn: Conn,
  login: number,
  brokerName: BrokerName
): Promise<DbTradingAccount | null> {
  const [rows] = await conn.execute(
    `SELECT
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
     FROM trading_account ta
     JOIN broker_accounts ba ON ba.trading_account_id = ta.trading_account_uuid
     WHERE ba.login = ? AND ba.broker_name = ? AND ba.active = 1
     LIMIT 1`,
    [login, brokerName]
  );
  const arr = rows as DbTradingAccount[];
  return arr[0] ?? null;
}

export interface AccountDisplayInfo {
  brokerName: BrokerName;
  login: number;
  label: string;
}

export async function getAccountDisplayId(
  conn: Conn,
  account: DbTradingAccount
): Promise<AccountDisplayInfo> {
  const brokerAccount = await getActiveBrokerAccountByTradingAccount(conn, account.trading_account_uuid);

  if (brokerAccount) {
    return {
      brokerName: brokerAccount.broker_name,
      login: brokerAccount.login,
      label: brokerAccount.broker_name === "mt5"
        ? `MT5 Login ${brokerAccount.login}`
        : `cTrader ${brokerAccount.login}`,
    };
  }

  // Legacy: no broker_account entry → cTrader
  return {
    brokerName: "ctrader",
    login: account.ctrader_trading_account,
    label: `cTrader ${account.ctrader_trading_account}`,
  };
}

export async function updateBrokerAccountLogin(
  conn: Conn,
  brokerAccountId: string,
  newLogin: number
): Promise<void> {
  await conn.execute(
    `UPDATE broker_accounts SET login = ? WHERE id = UUID_TO_BIN(?)`,
    [newLogin, brokerAccountId]
  );
}
