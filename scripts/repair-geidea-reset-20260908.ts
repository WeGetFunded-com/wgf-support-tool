/**
 * Incident-specific repair, authorized on 2026-09-08.
 * Default is a read-only plan. --apply removes only unpaid-delivery duplicates
 * AFTER the reset has produced exactly one active MT5 account and closed its
 * payment session. Full deleted rows are preserved in admin_audit_log in the
 * same transaction. No payment capture/refund or broker call is performed.
 */
import assert from "node:assert/strict";
import mysql, { type RowDataPacket, type ResultSetHeader } from "mysql2/promise";
import { loadConfig } from "../src/config.js";
import { openTunnel } from "../src/tunnel.js";
import { insertAuditLog } from "../src/queries/audit-log.queries.js";

const USER = "037d989c-6198-4a04-b66e-8ce0a7bbdb35";
const REF = "a2313ca1-36c7-4103-b126-cfa775520b2a";
const PROOF = "a449cd85-7851-4158-3194-08def6fa8991";
const OLD_ACCOUNT = "72d8bffe-82f7-454d-ab52-7efe42cd874c";
const apply = process.argv.includes("--apply");
const retryCleanup = process.argv.includes("--retry-cleanup");
const write = apply || retryCleanup;
assert(!(apply && retryCleanup), "Choose a single operation");
assert(process.argv.slice(2).every(arg => arg === "--apply" || arg === "--retry-cleanup"), "Unsupported operation");

async function main() {
  const config = loadConfig();
  const tunnel = await openTunnel(config, "production");
  let conn: mysql.Connection | undefined;
  try {
    conn = await mysql.createConnection({
      host: "127.0.0.1", port: tunnel.localPort,
      user: config.production.user, password: config.production.password,
      database: config.production.database, connectTimeout: 10000,
      ssl: { rejectUnauthorized: false }, dateStrings: true,
    });
    const rows = async (sql: string, args: unknown[] = []) => {
      const [result] = await conn!.execute<RowDataPacket[]>({ sql, timeout: 30000 }, args);
      return result;
    };
    if (write) await conn.beginTransaction();
    const lock = write ? " FOR UPDATE" : "";
    const [session] = await rows(
      "SELECT status, amount, currency, geidea_order_id, confirmed_at FROM payment_session WHERE merchant_reference_id=? AND user_uuid=UUID_TO_BIN(?) LIMIT 1" + lock,
      [REF, USER]);
    assert(session, "Payment session not found");
    assert.equal(session.status, "confirmed", "Wait for successful reset delivery; do not close a pending session manually");
    assert.equal(session.geidea_order_id, PROOF);
    assert.equal(Number(session.amount), 224.16);
    assert.equal(session.currency.toUpperCase(), "EUR");
    assert(session.confirmed_at);
    const [oldAccount] = await rows(
      "SELECT success, reason FROM trading_account WHERE trading_account_uuid=UUID_TO_BIN(?) LIMIT 1" + lock, [OLD_ACCOUNT]);
    assert.equal(Number(oldAccount?.success), 0);
    assert.equal(oldAccount?.reason, "RESET_CHALLENGE");

    const orders = await rows(
      "SELECT o.*, BIN_TO_UUID(o.order_uuid) AS order_id, BIN_TO_UUID(o.payment_uuid) AS payment_id FROM orders o JOIN payment p USING(payment_uuid) WHERE o.user_uuid=UUID_TO_BIN(?) AND p.proof=? ORDER BY p.payment_date, o.order_uuid LIMIT 100" + lock,
      [USER, PROOF]);
    assert(orders.length > 0 && orders.length < 100, "Unexpected incident size");
    const ids = orders.map(row => row.order_id as string);
    const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");
    const delivered = await rows(
      `SELECT BIN_TO_UUID(ta.order_uuid) AS order_id, BIN_TO_UUID(ta.trading_account_uuid) AS account_id, ta.success, ba.broker_name, ba.active FROM trading_account ta LEFT JOIN broker_accounts ba ON ba.trading_account_id=ta.trading_account_uuid AND ba.active=1 WHERE ta.order_uuid IN (${placeholders}) LIMIT 100`, ids);
    assert.equal(delivered.length, 1, "Exactly one delivered account is required");
    assert.equal(delivered[0].broker_name, "mt5");
    assert.equal(delivered[0].active, 1);
    assert.equal(delivered[0].success, null);
    const keep = orders.find(row => row.order_id === delivered[0].order_id)!;
    assert(keep);
    const duplicates = orders.filter(row => row.order_id !== keep.order_id);
    const snapshots: Record<string, unknown>[] = [];

    // Include logical links without FK constraints (e.g. funded_activation),
    // so nothing with a downstream business reference can be deleted.
    const references = await rows(
      "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND (COLUMN_NAME LIKE '%order_uuid' OR COLUMN_NAME='payment_uuid') AND TABLE_NAME NOT IN ('orders','payment','order_options') ORDER BY TABLE_NAME,COLUMN_NAME LIMIT 100");
    assert(references.length < 100);
    for (const order of duplicates) {
      for (const ref of references) {
        assert(/^[a-zA-Z0-9_]+$/.test(ref.TABLE_NAME));
        assert(/^[a-zA-Z0-9_]+$/.test(ref.COLUMN_NAME));
        const linked = await rows(
          `SELECT 1 FROM \`${ref.TABLE_NAME}\` WHERE \`${ref.COLUMN_NAME}\`=UUID_TO_BIN(?) LIMIT 1`,
          [ref.COLUMN_NAME === "payment_uuid" ? order.payment_id : order.order_id]);
        assert.equal(linked.length, 0, `Duplicate has a downstream link in ${ref.TABLE_NAME}`);
      }
      const [payment] = await rows("SELECT *, BIN_TO_UUID(payment_uuid) AS payment_id FROM payment WHERE payment_uuid=UUID_TO_BIN(?) LIMIT 1" + lock, [order.payment_id]);
      assert.equal(payment?.proof, PROOF);
      assert.equal(Number(payment?.price), 22416);
      assert.equal(payment?.currency.toUpperCase(), "EUR");
      const shared = await rows("SELECT BIN_TO_UUID(order_uuid) AS order_id FROM orders WHERE payment_uuid=UUID_TO_BIN(?) LIMIT 2", [order.payment_id]);
      assert.equal(shared.length, 1, "Payment is shared by another order");
      assert.equal(shared[0].order_id, order.order_id);
      const options = await rows("SELECT * FROM order_options WHERE order_uuid=UUID_TO_BIN(?) LIMIT 100" + lock, [order.order_id]);
      assert(options.length < 100);
      snapshots.push({ order, payment, options });
    }
    const [keptPayment] = await rows("SELECT price, proof, currency FROM payment WHERE payment_uuid=UUID_TO_BIN(?) LIMIT 1", [keep.payment_id]);
    assert.equal(Number(keptPayment?.price), 22416);
    assert.equal(keptPayment?.proof, PROOF);
    const report = {
      mode: retryCleanup ? "retry-cleanup" : apply ? "apply" : "plan", reference: REF,
      keep_order: keep.order_id, keep_account: delivered[0].account_id,
      duplicates_to_remove: duplicates.length, revenue_removed_eur: Number((duplicates.length * 224.16).toFixed(2)),
      final_orders: 1, final_payment_eur: 224.16,
    };
    console.log(JSON.stringify(report, null, 2));
    if (retryCleanup) {
      assert.equal(duplicates.length, 0, "Complete duplicate cleanup first");
      await insertAuditLog(conn, "retry_geidea_reset_broker_cleanup", "trading_account", OLD_ACCOUNT,
        { ...report, previous_session: session, authorization: "Authorized incident repair; replacement already delivered; v1.4.36 retries broker cleanup only" },
        "codex-authorized-by-cyril", "production");
      const [requeued] = await conn.execute<ResultSetHeader>(
        "UPDATE payment_session SET status='pending', confirmed_at=NULL WHERE merchant_reference_id=? AND user_uuid=UUID_TO_BIN(?) AND status='confirmed' AND geidea_order_id=?",
        [REF, USER, PROOF]);
      assert.equal(requeued.affectedRows, 1);
      await conn.commit();
      console.log("COMMITTED: only this session requeued for broker cleanup; order/payment/account retained");
      return;
    }
    if (!apply || duplicates.length === 0) {
      if (apply) await conn.rollback();
      return;
    }

    await insertAuditLog(conn, "repair_geidea_reset_duplicates", "orders", keep.order_id,
      { ...report, proof: PROOF, old_account: OLD_ACCOUNT, deleted_rows: snapshots,
        authorization: "User requested production deployment and repair of this incident on 2026-09-08" },
      "codex-authorized-by-cyril", "production");
    for (const order of duplicates) {
      await conn.execute("DELETE FROM order_options WHERE order_uuid=UUID_TO_BIN(?)", [order.order_id]);
      const [deletedOrder] = await conn.execute<ResultSetHeader>(
        "DELETE FROM orders WHERE order_uuid=UUID_TO_BIN(?) AND user_uuid=UUID_TO_BIN(?) AND payment_uuid=UUID_TO_BIN(?) AND NOT EXISTS(SELECT 1 FROM trading_account ta WHERE ta.order_uuid=orders.order_uuid)",
        [order.order_id, USER, order.payment_id]);
      assert.equal(deletedOrder.affectedRows, 1);
      const [deletedPayment] = await conn.execute<ResultSetHeader>(
        "DELETE FROM payment WHERE payment_uuid=UUID_TO_BIN(?) AND proof=? AND price=22416 AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.payment_uuid=payment.payment_uuid)",
        [order.payment_id, PROOF]);
      assert.equal(deletedPayment.affectedRows, 1);
    }
    const [after] = await rows("SELECT COUNT(*) AS n, SUM(p.price) AS total FROM orders o JOIN payment p USING(payment_uuid) WHERE o.user_uuid=UUID_TO_BIN(?) AND p.proof=? LIMIT 1", [USER, PROOF]);
    assert.equal(after.n, 1);
    assert.equal(Number(after.total), 22416);
    await conn.commit();
    console.log("COMMITTED: duplicates removed, one paid MT5 account retained, complete preimages saved in admin_audit_log");
  } catch (error) {
    if (conn && write) await conn.rollback().catch(() => {});
    throw error;
  } finally {
    if (conn) await conn.end().catch(() => {});
    tunnel.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
