import type mysql from "mysql2/promise";
import type { DbUser } from "../types.js";

type Conn = mysql.Connection;

const USER_COLS = `
  BIN_TO_UUID(user_uuid) as user_uuid, CTID, email, firstname, lastname,
  address, postal_code, city, country_id, language, phone_number, birthday,
  valid, provider_id
`;

export async function getUserByEmail(conn: Conn, email: string): Promise<DbUser | null> {
  const [rows] = await conn.execute(
    `SELECT ${USER_COLS} FROM user WHERE email = ?`,
    [email]
  );
  const arr = rows as DbUser[];
  return arr[0] ?? null;
}

export async function getUserByUuid(conn: Conn, uuid: string): Promise<DbUser | null> {
  const [rows] = await conn.execute(
    `SELECT ${USER_COLS} FROM user WHERE user_uuid = UUID_TO_BIN(?)`,
    [uuid]
  );
  const arr = rows as DbUser[];
  return arr[0] ?? null;
}

export async function getUserByCtid(conn: Conn, ctid: number): Promise<DbUser | null> {
  const [rows] = await conn.execute(
    `SELECT ${USER_COLS} FROM user WHERE CTID = ?`,
    [ctid]
  );
  const arr = rows as DbUser[];
  return arr[0] ?? null;
}

export async function searchUsersByEmail(conn: Conn, pattern: string): Promise<DbUser[]> {
  const [rows] = await conn.execute(
    `SELECT ${USER_COLS} FROM user WHERE email LIKE ? LIMIT 20`,
    [`%${pattern}%`]
  );
  return rows as DbUser[];
}

export async function getUserByOrderUuid(conn: Conn, orderUuid: string): Promise<DbUser | null> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(u.user_uuid) as user_uuid, u.CTID, u.email, u.firstname, u.lastname,
            u.address, u.postal_code, u.city, u.country_id, u.language, u.phone_number, u.birthday,
            u.valid, u.provider_id
     FROM user u
     JOIN orders o ON o.user_uuid = u.user_uuid
     WHERE o.order_uuid = UUID_TO_BIN(?)`,
    [orderUuid]
  );
  const arr = rows as DbUser[];
  return arr[0] ?? null;
}

export async function searchUsersByName(conn: Conn, name: string): Promise<DbUser[]> {
  const [rows] = await conn.execute(
    `SELECT ${USER_COLS} FROM user WHERE firstname LIKE ? OR lastname LIKE ? LIMIT 20`,
    [`%${name}%`, `%${name}%`]
  );
  return rows as DbUser[];
}
