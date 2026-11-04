import type mysql from "mysql2/promise";

type Conn = mysql.Connection;
type Params = (string | number | boolean | null)[];

export const ACCOUNT_GROUPS = ["standard_p1", "standard_p2", "unlimited"] as const;
export type AccountGroup = (typeof ACCOUNT_GROUPS)[number];

/** Progress bands of the coefficients, in % of the objective. */
export const COEFFICIENT_BANDS = ["lt0", "0-25", "25-50", "50-75", "75-90", "90-100"] as const;
export type Coefficients = Record<(typeof COEFFICIENT_BANDS)[number], number>;

export interface BoostConfigKey {
  account_group: AccountGroup;
  boost_type: "reduction" | "erasure";
  /** 1 or 2 for a reduction, 0 for an erasure. */
  reduction_pct: number;
}

export interface BoostConfigValues {
  enabled: boolean;
  base_price_cents: number | null;
  coefficients: Coefficients | null;
  price_multiplier: number;
  max_progress_pct: number | null;
  forbid_direct_validation: boolean;
  min_billed_pct: number | null;
  erasure_window_hours: number | null;
}

export type BoostConfigRow = BoostConfigKey & BoostConfigValues & { updated_by: string; updated_at: Date };

interface RawRow extends Omit<BoostConfigRow, "enabled" | "forbid_direct_validation" | "coefficients"> {
  enabled: number;
  forbid_direct_validation: number;
  coefficients: Coefficients | string | null;
}

function toRow(raw: RawRow): BoostConfigRow {
  return {
    ...raw,
    enabled: raw.enabled === 1,
    forbid_direct_validation: raw.forbid_direct_validation === 1,
    coefficients: typeof raw.coefficients === "string" ? (JSON.parse(raw.coefficients) as Coefficients) : raw.coefficients,
    price_multiplier: Number(raw.price_multiplier),
    max_progress_pct: raw.max_progress_pct === null ? null : Number(raw.max_progress_pct),
    min_billed_pct: raw.min_billed_pct === null ? null : Number(raw.min_billed_pct),
  };
}

const COLS = `account_group, boost_type, reduction_pct, enabled, base_price_cents, coefficients, price_multiplier,
  max_progress_pct, forbid_direct_validation, min_billed_pct, erasure_window_hours, updated_by, updated_at`;

export async function getBoostConfig(conn: Conn): Promise<BoostConfigRow[]> {
  const [rows] = await conn.execute(
    `SELECT ${COLS} FROM boost_config
     ORDER BY FIELD(account_group, 'standard_p1', 'standard_p2', 'unlimited'), boost_type DESC, reduction_pct`,
    []
  );
  return (rows as RawRow[]).map(toRow);
}

function valuesParams(values: BoostConfigValues): Params {
  return [
    values.enabled,
    values.base_price_cents,
    values.coefficients === null ? null : JSON.stringify(values.coefficients),
    values.price_multiplier,
    values.max_progress_pct,
    values.forbid_direct_validation,
    values.min_billed_pct,
    values.erasure_window_hours,
  ];
}

const KEY_WHERE = "account_group = ? AND boost_type = ? AND reduction_pct = ?";

function keyParams(key: BoostConfigKey): Params {
  return [key.account_group, key.boost_type, key.reduction_pct];
}

export async function updateBoostConfig(
  conn: Conn,
  key: BoostConfigKey,
  values: BoostConfigValues,
  operator: string
): Promise<boolean> {
  const [result] = await conn.execute(
    `UPDATE boost_config SET enabled = ?, base_price_cents = ?, coefficients = ?, price_multiplier = ?,
       max_progress_pct = ?, forbid_direct_validation = ?, min_billed_pct = ?, erasure_window_hours = ?, updated_by = ?
     WHERE ${KEY_WHERE}`,
    [...valuesParams(values), operator, ...keyParams(key)]
  );
  return (result as mysql.ResultSetHeader).affectedRows === 1;
}

export async function insertBoostConfig(
  conn: Conn,
  key: BoostConfigKey,
  values: BoostConfigValues,
  operator: string
): Promise<void> {
  await conn.execute(
    `INSERT INTO boost_config (account_group, boost_type, reduction_pct, enabled, base_price_cents, coefficients,
       price_multiplier, max_progress_pct, forbid_direct_validation, min_billed_pct, erasure_window_hours, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...keyParams(key), ...valuesParams(values), operator]
  );
}

export async function deleteBoostConfig(conn: Conn, key: BoostConfigKey): Promise<boolean> {
  const [result] = await conn.execute(`DELETE FROM boost_config WHERE ${KEY_WHERE}`, keyParams(key));
  return (result as mysql.ResultSetHeader).affectedRows === 1;
}
