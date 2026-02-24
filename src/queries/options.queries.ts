import type mysql from "mysql2/promise";
import type { DbOption } from "../types.js";

type Conn = mysql.Connection;

export async function getAllOptions(conn: Conn): Promise<DbOption[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(option_uuid) as option_uuid, name, majoration_percent
     FROM options
     ORDER BY name`
  );
  return rows as DbOption[];
}

export async function getOptionByUuid(conn: Conn, uuid: string): Promise<DbOption | null> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(option_uuid) as option_uuid, name, majoration_percent
     FROM options
     WHERE option_uuid = UUID_TO_BIN(?)`,
    [uuid]
  );
  const arr = rows as DbOption[];
  return arr[0] ?? null;
}
