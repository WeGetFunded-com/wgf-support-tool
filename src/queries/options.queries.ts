import type mysql from "mysql2/promise";
import type { DbOption } from "../types.js";

type Conn = mysql.Connection;

export async function getAllOptions(conn: Conn): Promise<DbOption[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(option_uuid) as option_uuid, name, majoration_percent, flat_price
     FROM options
     ORDER BY name`
  );
  return rows as DbOption[];
}

// One Time Payment: fixed-price option that pre-pays the funded activation, so
// passing to funded is direct (no funded_activation, no 149.90 EUR fee).
export const OTP_OPTION_NAME = "One Time Payment";

// orderHasOptionByName reports whether an order carries a given option (read from
// order_options — the same source the watcher reads at challenge success).
export async function orderHasOptionByName(
  conn: Conn,
  orderUuid: string,
  optionName: string
): Promise<boolean> {
  const [rows] = await conn.execute(
    `SELECT 1
     FROM order_options oo
     JOIN options o USING (option_uuid)
     WHERE oo.order_uuid = UUID_TO_BIN(?) AND o.name = ?
     LIMIT 1`,
    [orderUuid, optionName]
  );
  return (rows as unknown[]).length > 0;
}

export async function getOptionByUuid(conn: Conn, uuid: string): Promise<DbOption | null> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(option_uuid) as option_uuid, name, majoration_percent, flat_price
     FROM options
     WHERE option_uuid = UUID_TO_BIN(?)`,
    [uuid]
  );
  const arr = rows as DbOption[];
  return arr[0] ?? null;
}
