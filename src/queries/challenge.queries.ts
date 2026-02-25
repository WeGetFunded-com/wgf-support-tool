import type mysql from "mysql2/promise";
import type { DbChallenge, DbChallengeRule } from "../types.js";

type Conn = mysql.Connection;

const CHALLENGE_COLS = `
  BIN_TO_UUID(challenge_uuid) as challenge_uuid, stripe_ID, name, description,
  type, price, initial_coins_amount, expiration_date, published
`;

export async function getPublishedChallenges(conn: Conn): Promise<DbChallenge[]> {
  const [rows] = await conn.execute(
    `SELECT ${CHALLENGE_COLS} FROM challenge WHERE published = 1 ORDER BY type, price`
  );
  return rows as DbChallenge[];
}

export async function getPublishedAndFundedChallenges(conn: Conn): Promise<DbChallenge[]> {
  const [rows] = await conn.execute(
    `SELECT ${CHALLENGE_COLS} FROM challenge
     WHERE published = 1 OR type IN ('funded_standard', 'funded_unlimited')
     ORDER BY type, price`
  );
  return rows as DbChallenge[];
}

export async function getAllChallenges(conn: Conn): Promise<DbChallenge[]> {
  const [rows] = await conn.execute(
    `SELECT ${CHALLENGE_COLS} FROM challenge ORDER BY type, price`
  );
  return rows as DbChallenge[];
}

export async function getChallengeByUuid(conn: Conn, uuid: string): Promise<DbChallenge | null> {
  const [rows] = await conn.execute(
    `SELECT ${CHALLENGE_COLS} FROM challenge WHERE challenge_uuid = UUID_TO_BIN(?)`,
    [uuid]
  );
  const arr = rows as DbChallenge[];
  return arr[0] ?? null;
}

export async function getChallengeRules(
  conn: Conn,
  challengeUuid: string,
  phase: number
): Promise<DbChallengeRule | null> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(challenge_uuid) as challenge_uuid, phase,
            max_daily_drawdown_percent, profit_target_percent,
            min_trading_days, phase_duration, max_total_drawdown_percent
     FROM challenge_rules
     WHERE challenge_uuid = UUID_TO_BIN(?) AND phase = ?`,
    [challengeUuid, phase]
  );
  const arr = rows as DbChallengeRule[];
  return arr[0] ?? null;
}

export async function getAllChallengeRules(
  conn: Conn,
  challengeUuid: string
): Promise<DbChallengeRule[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(challenge_uuid) as challenge_uuid, phase,
            max_daily_drawdown_percent, profit_target_percent,
            min_trading_days, phase_duration, max_total_drawdown_percent
     FROM challenge_rules
     WHERE challenge_uuid = UUID_TO_BIN(?)
     ORDER BY phase`,
    [challengeUuid]
  );
  return rows as DbChallengeRule[];
}
