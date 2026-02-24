import type mysql from "mysql2/promise";
import type { DbAuditLog } from "../types.js";

type Conn = mysql.Connection;

export async function insertAuditLog(
  conn: Conn,
  actionType: string,
  targetTable: string,
  targetUuid: string | null,
  details: Record<string, unknown>,
  operator: string,
  environment: string
): Promise<void> {
  await conn.execute(
    `INSERT INTO admin_audit_log (action_type, target_table, target_uuid, details, operator, environment)
     VALUES (?, ?, ${targetUuid ? "UUID_TO_BIN(?)" : "NULL"}, ?, ?, ?)`,
    [
      actionType,
      targetTable,
      ...(targetUuid ? [targetUuid] : []),
      JSON.stringify(details),
      operator,
      environment,
    ]
  );
}

export async function getAuditLogsForTarget(
  conn: Conn,
  targetUuid: string,
  limit = 20
): Promise<DbAuditLog[]> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const [rows] = await conn.execute(
    `SELECT id, action_type, target_table,
            BIN_TO_UUID(target_uuid) as target_uuid,
            details, operator, environment, executed_at
     FROM admin_audit_log
     WHERE target_uuid = UUID_TO_BIN(?)
     ORDER BY executed_at DESC
     LIMIT ${safeLimit}`,
    [targetUuid]
  );
  return rows as DbAuditLog[];
}

export async function getRecentAuditLogs(
  conn: Conn,
  limit = 20
): Promise<DbAuditLog[]> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const [rows] = await conn.execute(
    `SELECT id, action_type, target_table,
            BIN_TO_UUID(target_uuid) as target_uuid,
            details, operator, environment, executed_at
     FROM admin_audit_log
     ORDER BY executed_at DESC
     LIMIT ${safeLimit}`,
    []
  );
  return rows as DbAuditLog[];
}
