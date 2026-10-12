import type mysql from "mysql2/promise";

type Conn = mysql.Connection;

/** Amounts are euro cents: 10 cents = 1 WeGetCoin. */
export interface WeGetCoinWallet {
  balance_cents: number;
  reserved_cents: number;
}

export interface WeGetCoinLine {
  transaction_uuid: string;
  amount_cents: number;
  kind: string;
  reference_type: string;
  reference_id: string;
  fx_rate_usd_eur: string | null;
  balance_after_cents: number;
  reason: string | null;
  author: string;
  created_at: Date;
}

/** Null when the trader was never credited: the wallet row is created by the first credit. */
export async function getWallet(conn: Conn, userUuid: string): Promise<WeGetCoinWallet | null> {
  const [rows] = await conn.execute(
    `SELECT balance_cents, reserved_cents
     FROM wegetcoin_wallet
     WHERE user_uuid = UUID_TO_BIN(?)`,
    [userUuid]
  );
  const wallet = (rows as WeGetCoinWallet[])[0];
  return wallet
    ? { balance_cents: Number(wallet.balance_cents), reserved_cents: Number(wallet.reserved_cents) }
    : null;
}

/** The latest journal lines, newest first; id is the strict order of the movements. */
export async function getLines(conn: Conn, userUuid: string, limit: number): Promise<WeGetCoinLine[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(transaction_uuid) AS transaction_uuid, amount_cents, kind,
            reference_type, reference_id, fx_rate_usd_eur, balance_after_cents,
            reason, author, created_at
     FROM wegetcoin_transaction
     WHERE user_uuid = UUID_TO_BIN(?)
     ORDER BY id DESC
     LIMIT ${safeLimit}`,
    [userUuid]
  );
  return (rows as WeGetCoinLine[]).map((line) => ({
    ...line,
    amount_cents: Number(line.amount_cents),
    balance_after_cents: Number(line.balance_after_cents),
  }));
}

export async function countLines(conn: Conn, userUuid: string): Promise<number> {
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS n FROM wegetcoin_transaction WHERE user_uuid = UUID_TO_BIN(?)`,
    [userUuid]
  );
  return Number((rows as { n: number }[])[0]?.n ?? 0);
}
