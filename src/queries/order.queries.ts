import type mysql from "mysql2/promise";
import type { DbOrder, DbPayment } from "../types.js";

type Conn = mysql.Connection;

export interface OrderWithDetails extends DbOrder {
  payment_proof?: string;
  payment_method?: string;
  payment_price?: number;
  payment_currency?: string;
  payment_date?: Date;
  challenge_name?: string;
  challenge_type?: string;
  challenge_initial_coins_amount?: number;
}

export async function getOrdersByUser(conn: Conn, userUuid: string): Promise<OrderWithDetails[]> {
  const [rows] = await conn.execute(
    `SELECT
       BIN_TO_UUID(o.order_uuid) as order_uuid,
       BIN_TO_UUID(o.challenge_uuid) as challenge_uuid,
       BIN_TO_UUID(o.user_uuid) as user_uuid,
       BIN_TO_UUID(o.payment_uuid) as payment_uuid,
       o.order_challenge_configuration,
       o.joker,
       BIN_TO_UUID(o.promo_uuid) as promo_uuid,
       BIN_TO_UUID(o.affiliation_code_uuid) as affiliation_code_uuid,
       p.proof as payment_proof,
       p.method as payment_method,
       p.price as payment_price,
       p.currency as payment_currency,
       p.payment_date,
       c.name as challenge_name,
       c.type as challenge_type,
       c.initial_coins_amount as challenge_initial_coins_amount
     FROM orders o
     LEFT JOIN payment p ON o.payment_uuid = p.payment_uuid
     LEFT JOIN challenge c ON o.challenge_uuid = c.challenge_uuid
     WHERE o.user_uuid = UUID_TO_BIN(?)
     ORDER BY p.payment_date DESC`,
    [userUuid]
  );
  return rows as OrderWithDetails[];
}

export async function getOrderByUuid(conn: Conn, uuid: string): Promise<OrderWithDetails | null> {
  const [rows] = await conn.execute(
    `SELECT
       BIN_TO_UUID(o.order_uuid) as order_uuid,
       BIN_TO_UUID(o.challenge_uuid) as challenge_uuid,
       BIN_TO_UUID(o.user_uuid) as user_uuid,
       BIN_TO_UUID(o.payment_uuid) as payment_uuid,
       o.order_challenge_configuration,
       o.joker,
       BIN_TO_UUID(o.promo_uuid) as promo_uuid,
       BIN_TO_UUID(o.affiliation_code_uuid) as affiliation_code_uuid,
       p.proof as payment_proof,
       p.method as payment_method,
       p.price as payment_price,
       p.currency as payment_currency,
       p.payment_date,
       c.name as challenge_name,
       c.type as challenge_type
     FROM orders o
     LEFT JOIN payment p ON o.payment_uuid = p.payment_uuid
     LEFT JOIN challenge c ON o.challenge_uuid = c.challenge_uuid
     WHERE o.order_uuid = UUID_TO_BIN(?)`,
    [uuid]
  );
  const arr = rows as OrderWithDetails[];
  return arr[0] ?? null;
}

export async function createPayment(
  conn: Conn,
  paymentUuid: string,
  method: string,
  price: number,
  currency: string,
  proof: string
): Promise<void> {
  await conn.execute(
    `INSERT INTO payment (payment_uuid, proof, payment_date, method, price, currency)
     VALUES (UUID_TO_BIN(?), ?, NOW(), ?, ?, ?)`,
    [paymentUuid, proof, method, price, currency]
  );
}

export async function createOrder(
  conn: Conn,
  orderUuid: string,
  challengeUuid: string,
  userUuid: string,
  paymentUuid: string,
  challengeConfiguration: string
): Promise<void> {
  await conn.execute(
    `INSERT INTO orders (order_uuid, challenge_uuid, user_uuid, payment_uuid, order_challenge_configuration)
     VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), ?)`,
    [orderUuid, challengeUuid, userUuid, paymentUuid, challengeConfiguration]
  );
}

export async function createOrderOption(
  conn: Conn,
  orderUuid: string,
  optionUuid: string
): Promise<void> {
  await conn.execute(
    `INSERT INTO order_options (order_uuid, option_uuid)
     VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?))`,
    [orderUuid, optionUuid]
  );
}

// ── Cleanup functions (for rollback when TAM job fails) ──

export async function deleteOrderOptions(conn: Conn, orderUuid: string): Promise<void> {
  await conn.execute(
    `DELETE FROM order_options WHERE order_uuid = UUID_TO_BIN(?)`,
    [orderUuid]
  );
}

export async function deleteOrder(conn: Conn, orderUuid: string): Promise<void> {
  await conn.execute(
    `DELETE FROM orders WHERE order_uuid = UUID_TO_BIN(?)`,
    [orderUuid]
  );
}

export async function deletePayment(conn: Conn, paymentUuid: string): Promise<void> {
  await conn.execute(
    `DELETE FROM payment WHERE payment_uuid = UUID_TO_BIN(?)`,
    [paymentUuid]
  );
}
