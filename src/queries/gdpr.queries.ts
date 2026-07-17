import type mysql from "mysql2/promise";

type Conn = mysql.Connection;

/** Tout ce qui rattache un utilisateur a ses donnees, resolu une fois. */
export interface GdprScope {
  userUuid: string;
  email: string;
  orderUuids: string[];
  paymentUuids: string[];
  tradingAccountUuids: string[];
  affiliationCodeUuids: string[];
}

/**
 * Un motif de conservation : la ligne doit survivre pour une raison legale
 * (livres comptables = 10 ans, art. L123-22 C. com.) ou parce que la
 * supprimer corromprait le dossier d'un tiers. Ne bloque jamais la demande :
 * fait basculer l'effacement en anonymisation, ce qui satisfait l'art. 17.
 */
export interface GdprHold {
  reason: string;
  detail: string;
}

const REDACTED = "[RGPD-EFFACE]";

/** Les tables optionnelles varient entre prod et staging : on sonde avant. */
export async function listTables(conn: Conn): Promise<Set<string>> {
  const [rows] = await conn.execute(
    `SELECT TABLE_NAME as t FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`,
    []
  );
  return new Set((rows as { t: string }[]).map((r) => r.t));
}

export async function buildScope(conn: Conn, userUuid: string, email: string): Promise<GdprScope> {
  const [orders] = await conn.execute(
    `SELECT BIN_TO_UUID(order_uuid) as o, BIN_TO_UUID(payment_uuid) as p
     FROM orders WHERE user_uuid = UUID_TO_BIN(?)`,
    [userUuid]
  );
  const orderRows = orders as { o: string; p: string | null }[];

  const [tas] = await conn.execute(
    `SELECT BIN_TO_UUID(ta.trading_account_uuid) as ta
     FROM trading_account ta
     JOIN orders o ON o.order_uuid = ta.order_uuid
     WHERE o.user_uuid = UUID_TO_BIN(?)`,
    [userUuid]
  );

  const [codes] = await conn.execute(
    `SELECT BIN_TO_UUID(affiliation_code_uuid) as ac
     FROM affiliation_code WHERE owner_uuid = UUID_TO_BIN(?)`,
    [userUuid]
  );

  return {
    userUuid,
    email,
    orderUuids: orderRows.map((r) => r.o),
    paymentUuids: orderRows.map((r) => r.p).filter((p): p is string => !!p),
    tradingAccountUuids: (tas as { ta: string }[]).map((r) => r.ta),
    affiliationCodeUuids: (codes as { ac: string }[]).map((r) => r.ac),
  };
}

async function count(conn: Conn, sql: string, params: unknown[]): Promise<number> {
  const [rows] = await conn.execute(sql, params);
  return (rows as { n: number }[])[0].n;
}

const placeholders = (list: string[]) => list.map(() => "UUID_TO_BIN(?)").join(",");

export async function detectHolds(
  conn: Conn,
  scope: GdprScope,
  tables: Set<string>
): Promise<GdprHold[]> {
  const holds: GdprHold[] = [];

  if (scope.paymentUuids.length > 0) {
    const [rows] = await conn.execute(
      `SELECT COUNT(*) as n, COALESCE(SUM(price), 0) as total FROM payment
       WHERE payment_uuid IN (${placeholders(scope.paymentUuids)}) AND price > 0`,
      scope.paymentUuids
    );
    const r = (rows as { n: number; total: number }[])[0];
    if (r.n > 0) {
      holds.push({
        reason: "Comptabilite",
        detail: `${r.n} paiement(s) non nuls (${r.total} EUR) - piece comptable, conservation 10 ans`,
      });
    }
  }

  const payouts = await count(
    conn,
    `SELECT COUNT(*) as n FROM payout_request
     WHERE user_uuid = UUID_TO_BIN(?) AND status IN ('approved', 'paid')`,
    [scope.userUuid]
  );
  if (payouts > 0) {
    holds.push({ reason: "Payout", detail: `${payouts} payout(s) approuve(s)/paye(s) - flux financier sortant` });
  }

  if (scope.affiliationCodeUuids.length > 0) {
    const refs = await count(
      conn,
      `SELECT COUNT(*) as n FROM orders
       WHERE affiliation_code_uuid IN (${placeholders(scope.affiliationCodeUuids)})`,
      scope.affiliationCodeUuids
    );
    if (refs > 0) {
      holds.push({
        reason: "Affiliation",
        detail: `${refs} commande(s) de filleuls rattachees a son code - supprimer casserait leur historique`,
      });
    }
  }

  if (tables.has("affiliation_settlement")) {
    const settled = await count(
      conn,
      `SELECT COUNT(*) as n FROM affiliation_settlement WHERE owner_uuid = UUID_TO_BIN(?)`,
      [scope.userUuid]
    );
    if (settled > 0) {
      holds.push({ reason: "Commission", detail: `${settled} reglement(s) de commission verses - piece comptable` });
    }
  }

  return holds;
}

export async function inventory(
  conn: Conn,
  scope: GdprScope,
  tables: Set<string>
): Promise<Record<string, number>> {
  const c: Record<string, number> = {};
  const u = [scope.userUuid];

  c["user"] = await count(conn, `SELECT COUNT(*) as n FROM user WHERE user_uuid = UUID_TO_BIN(?)`, u);
  c["registration"] = await count(conn, `SELECT COUNT(*) as n FROM registration WHERE email = ?`, [scope.email]);
  c["tokens"] = await count(conn, `SELECT COUNT(*) as n FROM tokens WHERE user_uuid = UUID_TO_BIN(?)`, u);
  c["orders"] = await count(conn, `SELECT COUNT(*) as n FROM orders WHERE user_uuid = UUID_TO_BIN(?)`, u);
  c["promo"] = await count(conn, `SELECT COUNT(*) as n FROM promo WHERE user_uuid = UUID_TO_BIN(?)`, u);
  c["used_promo"] = await count(conn, `SELECT COUNT(*) as n FROM used_promo WHERE user_uuid = UUID_TO_BIN(?)`, u);
  c["payout_request"] = await count(conn, `SELECT COUNT(*) as n FROM payout_request WHERE user_uuid = UUID_TO_BIN(?)`, u);
  c["funded_activation"] = await count(conn, `SELECT COUNT(*) as n FROM funded_activation WHERE user_uuid = UUID_TO_BIN(?)`, u);
  c["affiliation_code"] = await count(conn, `SELECT COUNT(*) as n FROM affiliation_code WHERE owner_uuid = UUID_TO_BIN(?)`, u);
  c["archive"] = await count(conn, `SELECT COUNT(*) as n FROM archive WHERE email = ?`, [scope.email]);

  if (tables.has("contest_entry"))
    c["contest_entry"] = await count(conn, `SELECT COUNT(*) as n FROM contest_entry WHERE user_uuid = UUID_TO_BIN(?)`, u);
  if (tables.has("payment_session"))
    c["payment_session"] = await count(conn, `SELECT COUNT(*) as n FROM payment_session WHERE user_uuid = UUID_TO_BIN(?)`, u);
  if (tables.has("broker_accounts"))
    c["broker_accounts"] = await count(conn, `SELECT COUNT(*) as n FROM broker_accounts WHERE user_id = UUID_TO_BIN(?)`, u);
  if (tables.has("affiliation_settlement"))
    c["affiliation_settlement"] = await count(conn, `SELECT COUNT(*) as n FROM affiliation_settlement WHERE owner_uuid = UUID_TO_BIN(?)`, u);

  // Comptes lus en base, pas deduits de la taille du scope : l'inventaire doit
  // rester honnete meme rappele apres une suppression.
  c["payment"] =
    scope.paymentUuids.length === 0
      ? 0
      : await count(
          conn,
          `SELECT COUNT(*) as n FROM payment WHERE payment_uuid IN (${placeholders(scope.paymentUuids)})`,
          scope.paymentUuids
        );

  const ta = scope.tradingAccountUuids;
  c["trading_account"] =
    ta.length === 0
      ? 0
      : await count(
          conn,
          `SELECT COUNT(*) as n FROM trading_account WHERE trading_account_uuid IN (${placeholders(ta)})`,
          ta
        );

  if (ta.length > 0) {
    const ph = placeholders(ta);
    c["trade_history"] = await count(conn, `SELECT COUNT(*) as n FROM trade_history WHERE trading_account_uuid IN (${ph})`, ta);
    c["positions"] = await count(conn, `SELECT COUNT(*) as n FROM positions WHERE trading_account_uuid IN (${ph})`, ta);
    c["trading_account_last_balance_and_equity"] = await count(
      conn,
      `SELECT COUNT(*) as n FROM trading_account_last_balance_and_equity WHERE trading_account_uuid IN (${ph})`,
      ta
    );
    c["trading_account_options"] = await count(
      conn,
      `SELECT COUNT(*) as n FROM trading_account_options WHERE trading_account_uuid IN (${ph})`,
      ta
    );
  } else {
    c["trade_history"] = 0;
    c["positions"] = 0;
    c["trading_account_last_balance_and_equity"] = 0;
    c["trading_account_options"] = 0;
  }

  return c;
}

/** Les logins MT5/cTrader a supprimer a la main cote broker apres coup. */
export async function getBrokerLoginsToPurge(
  conn: Conn,
  scope: GdprScope,
  tables: Set<string>
): Promise<string[]> {
  const logins: string[] = [];

  if (scope.tradingAccountUuids.length > 0) {
    const [rows] = await conn.execute(
      `SELECT ctrader_trading_account as login FROM trading_account
       WHERE trading_account_uuid IN (${placeholders(scope.tradingAccountUuids)})
         AND ctrader_trading_account IS NOT NULL AND ctrader_trading_account > 0`,
      scope.tradingAccountUuids
    );
    for (const r of rows as { login: number }[]) logins.push(String(r.login));
  }

  if (tables.has("broker_accounts")) {
    const [rows] = await conn.execute(
      `SELECT broker_name, login FROM broker_accounts WHERE user_id = UUID_TO_BIN(?)`,
      [scope.userUuid]
    );
    for (const r of rows as { broker_name: string; login: string }[]) {
      logins.push(`${r.broker_name}:${r.login}`);
    }
  }

  return [...new Set(logins)];
}

/** Suppression physique. Ordre impose par les contraintes FK. */
export async function erase(conn: Conn, scope: GdprScope, tables: Set<string>): Promise<string[]> {
  const applied: string[] = [];
  const run = async (label: string, sql: string, params: unknown[]) => {
    const [res] = await conn.execute(sql, params);
    const n = (res as mysql.ResultSetHeader).affectedRows;
    if (n > 0) applied.push(`${label}: ${n}`);
  };

  const ta = scope.tradingAccountUuids;
  if (ta.length > 0) {
    const ph = placeholders(ta);
    await run("trading_account_last_balance_and_equity", `DELETE FROM trading_account_last_balance_and_equity WHERE trading_account_uuid IN (${ph})`, ta);
    await run("trading_account_options", `DELETE FROM trading_account_options WHERE trading_account_uuid IN (${ph})`, ta);
    await run("trade_history", `DELETE FROM trade_history WHERE trading_account_uuid IN (${ph})`, ta);
    await run("positions", `DELETE FROM positions WHERE trading_account_uuid IN (${ph})`, ta);
  }

  if (tables.has("contest_entry"))
    await run("contest_entry", `DELETE FROM contest_entry WHERE user_uuid = UUID_TO_BIN(?)`, [scope.userUuid]);
  if (tables.has("broker_accounts"))
    await run("broker_accounts", `DELETE FROM broker_accounts WHERE user_id = UUID_TO_BIN(?)`, [scope.userUuid]);

  if (ta.length > 0) {
    await run("trading_account", `DELETE FROM trading_account WHERE trading_account_uuid IN (${placeholders(ta)})`, ta);
  }

  await run("funded_activation", `DELETE FROM funded_activation WHERE user_uuid = UUID_TO_BIN(?)`, [scope.userUuid]);
  await run("payout_request", `DELETE FROM payout_request WHERE user_uuid = UUID_TO_BIN(?)`, [scope.userUuid]);
  await run("orders", `DELETE FROM orders WHERE user_uuid = UUID_TO_BIN(?)`, [scope.userUuid]);

  if (scope.paymentUuids.length > 0) {
    await run("payment", `DELETE FROM payment WHERE payment_uuid IN (${placeholders(scope.paymentUuids)})`, scope.paymentUuids);
  }
  if (tables.has("payment_session"))
    await run("payment_session", `DELETE FROM payment_session WHERE user_uuid = UUID_TO_BIN(?)`, [scope.userUuid]);

  await run("used_promo", `DELETE FROM used_promo WHERE user_uuid = UUID_TO_BIN(?)`, [scope.userUuid]);
  await run("promo", `DELETE FROM promo WHERE user_uuid = UUID_TO_BIN(?)`, [scope.userUuid]);
  await run("affiliation_code", `DELETE FROM affiliation_code WHERE owner_uuid = UUID_TO_BIN(?)`, [scope.userUuid]);
  await run("archive", `DELETE FROM archive WHERE email = ?`, [scope.email]);
  await run("tokens", `DELETE FROM tokens WHERE user_uuid = UUID_TO_BIN(?)`, [scope.userUuid]);
  await run("registration", `DELETE FROM registration WHERE email = ?`, [scope.email]);
  await run("user", `DELETE FROM user WHERE user_uuid = UUID_TO_BIN(?)`, [scope.userUuid]);

  return applied;
}

/**
 * Garde les lignes a valeur comptable, detruit l'identite.
 * birthday / nationality_uuid / gender_uuid sont NOT NULL : on neutralise
 * au lieu de nullifier.
 */
export async function anonymize(conn: Conn, scope: GdprScope, tables: Set<string>): Promise<string[]> {
  const applied: string[] = [];
  const run = async (label: string, sql: string, params: unknown[]) => {
    const [res] = await conn.execute(sql, params);
    const n = (res as mysql.ResultSetHeader).affectedRows;
    if (n > 0) applied.push(`${label}: ${n}`);
  };

  const tombstone = `rgpd-${scope.userUuid.slice(0, 8)}@supprime.invalid`;

  await run(
    "user",
    `UPDATE user SET email = ?, firstname = ?, lastname = ?, phone_number = '',
       birthday = '1970-01-01', address = '', postal_code = '', city = '',
       hashed_password = '', provider_id = '', valid = 0
     WHERE user_uuid = UUID_TO_BIN(?)`,
    [tombstone, REDACTED, REDACTED, scope.userUuid]
  );
  await run("registration", `UPDATE registration SET email = ? WHERE email = ?`, [tombstone, scope.email]);
  await run("archive", `UPDATE archive SET email = ?, name = ? WHERE email = ?`, [tombstone, REDACTED, scope.email]);
  await run(
    "payout_request",
    `UPDATE payout_request SET first_name = ?, last_name = ?, postal_address = ?,
       iban = NULL, wallet_address = NULL
     WHERE user_uuid = UUID_TO_BIN(?)`,
    [REDACTED, REDACTED, REDACTED, scope.userUuid]
  );
  if (tables.has("broker_accounts"))
    await run("broker_accounts", `UPDATE broker_accounts SET password = '', active = 0 WHERE user_id = UUID_TO_BIN(?)`, [scope.userUuid]);

  // Surface d'auth et de paiement : aucune valeur comptable, on supprime.
  await run("tokens", `DELETE FROM tokens WHERE user_uuid = UUID_TO_BIN(?)`, [scope.userUuid]);
  if (tables.has("payment_session"))
    await run("payment_session", `DELETE FROM payment_session WHERE user_uuid = UUID_TO_BIN(?)`, [scope.userUuid]);

  return applied;
}

export async function userStillExists(conn: Conn, userUuid: string): Promise<boolean> {
  const n = await count(conn, `SELECT COUNT(*) as n FROM user WHERE user_uuid = UUID_TO_BIN(?)`, [userUuid]);
  return n > 0;
}

export async function emailStillExists(conn: Conn, email: string): Promise<boolean> {
  const n = await count(conn, `SELECT COUNT(*) as n FROM user WHERE email = ?`, [email]);
  return n > 0;
}
