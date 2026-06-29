import type mysql from "mysql2/promise";

type Conn = mysql.Connection;

// eliminateContestEntryByTradingAccount marks the contest entry tied to a trading
// account as eliminated. Idempotent and a no-op for non-concours accounts (no
// matching row), so it is safe to call on every deactivation.
export async function eliminateContestEntryByTradingAccount(
  conn: Conn,
  taUuid: string
): Promise<number> {
  const [result] = await conn.execute(
    `UPDATE contest_entry
     SET status = 'eliminated', eliminated_at = NOW()
     WHERE trading_account_uuid = UUID_TO_BIN(?) AND status <> 'eliminated'`,
    [taUuid]
  );
  const okPacket = result as mysql.ResultSetHeader;
  return okPacket.affectedRows ?? 0;
}

// deleteContestEntryByOrder removes the contest entry tied to an order. Used by
// the create-trading-account rollback: a concours order has a contest_entry FK
// (fk_contest_entry_order) that must be cleared before the order can be deleted.
// No-op for non-concours orders.
export async function deleteContestEntryByOrder(conn: Conn, orderUuid: string): Promise<void> {
  await conn.execute(
    `DELETE FROM contest_entry WHERE order_uuid = UUID_TO_BIN(?)`,
    [orderUuid]
  );
}
