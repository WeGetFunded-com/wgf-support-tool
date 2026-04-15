import type mysql from "mysql2/promise";

type Conn = mysql.Connection;

export interface DbAffiliationCode {
  affiliation_code_uuid: string;
  owner_uuid: string;
  code: string;
  percent_promo: number;
  percent_profits: number;
  one_time_use: number;
  expires_at: string | null;
}

export interface AffiliationRegistrationRow {
  registration_uuid: string;
  email: string;
  date_registration: Date;
  code: string;
  account_user_uuid: string | null;
  account_ctid: number | null;
  account_firstname: string | null;
  account_lastname: string | null;
}

export interface AffiliationSaleRow {
  order_uuid: string;
  payment_uuid: string | null;
  payment_date: Date | null;
  payment_method: string | null;
  payment_price: number | null;
  payment_currency: string | null;
  payment_proof: string | null;
  buyer_user_uuid: string;
  buyer_email: string;
  buyer_firstname: string;
  buyer_lastname: string;
  challenge_name: string | null;
  challenge_type: string | null;
  challenge_initial_coins_amount: number | null;
  promo_code: string | null;
  promo_percent: number | null;
  code: string;
  percent_profits: number;
}

export async function getAffiliationCodesByOwner(
  conn: Conn,
  userUuid: string
): Promise<DbAffiliationCode[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(affiliation_code_uuid) as affiliation_code_uuid,
            BIN_TO_UUID(owner_uuid) as owner_uuid,
            code, percent_promo, percent_profits, one_time_use, expires_at
     FROM affiliation_code
     WHERE owner_uuid = UUID_TO_BIN(?)`,
    [userUuid]
  );
  return rows as DbAffiliationCode[];
}

export async function getRegistrationsByOwner(
  conn: Conn,
  userUuid: string
): Promise<AffiliationRegistrationRow[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(r.registration_uuid) as registration_uuid,
            r.email, r.date_registration,
            ac.code,
            BIN_TO_UUID(u.user_uuid) as account_user_uuid,
            u.CTID as account_ctid,
            u.firstname as account_firstname,
            u.lastname as account_lastname
     FROM registration r
     JOIN affiliation_code ac ON ac.affiliation_code_uuid = r.used_affiliation_code
     LEFT JOIN user u ON u.email = r.email
     WHERE ac.owner_uuid = UUID_TO_BIN(?)
     ORDER BY r.date_registration DESC`,
    [userUuid]
  );
  return rows as AffiliationRegistrationRow[];
}

export async function getSalesByOwner(
  conn: Conn,
  userUuid: string
): Promise<AffiliationSaleRow[]> {
  const [rows] = await conn.execute(
    `SELECT BIN_TO_UUID(o.order_uuid) as order_uuid,
            BIN_TO_UUID(o.payment_uuid) as payment_uuid,
            p.payment_date, p.method as payment_method,
            p.price as payment_price, p.currency as payment_currency,
            p.proof as payment_proof,
            BIN_TO_UUID(u.user_uuid) as buyer_user_uuid,
            u.email as buyer_email,
            u.firstname as buyer_firstname,
            u.lastname as buyer_lastname,
            c.name as challenge_name,
            c.type as challenge_type,
            c.initial_coins_amount as challenge_initial_coins_amount,
            pr.code as promo_code,
            pr.percent_promo as promo_percent,
            ac.code, ac.percent_profits
     FROM orders o
     JOIN affiliation_code ac ON ac.affiliation_code_uuid = o.affiliation_code_uuid
     JOIN user u ON u.user_uuid = o.user_uuid
     LEFT JOIN payment p ON p.payment_uuid = o.payment_uuid
     LEFT JOIN challenge c ON c.challenge_uuid = o.challenge_uuid
     LEFT JOIN promo pr ON pr.promo_uuid = o.promo_uuid
     WHERE ac.owner_uuid = UUID_TO_BIN(?)
     ORDER BY p.payment_date DESC`,
    [userUuid]
  );
  return rows as AffiliationSaleRow[];
}
