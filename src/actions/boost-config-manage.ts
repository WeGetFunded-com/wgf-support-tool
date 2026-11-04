import { confirm, input, select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as configQ from "../queries/boost-config.queries.js";
import {
  ACCOUNT_GROUPS,
  COEFFICIENT_BANDS,
  type BoostConfigKey,
  type BoostConfigRow,
  type BoostConfigValues,
  type Coefficients,
} from "../queries/boost-config.queries.js";
import * as ui from "../ui.js";
import { confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue, renderTable } from "../utils/table.js";
import { formatSqlDateTime } from "../utils/format.js";

const GROUP_LABELS: Record<configQ.AccountGroup, string> = {
  standard_p1: "2 Etapes P1",
  standard_p2: "2 Etapes P2",
  unlimited: "Unlimited",
};

const KEYS: BoostConfigKey[] = ACCOUNT_GROUPS.flatMap((group) => [
  { account_group: group, boost_type: "reduction" as const, reduction_pct: 1 },
  { account_group: group, boost_type: "reduction" as const, reduction_pct: 2 },
  { account_group: group, boost_type: "erasure" as const, reduction_pct: 0 },
]);

function keyLabel(key: BoostConfigKey): string {
  const boost = key.boost_type === "reduction" ? `Reduction -${key.reduction_pct} %` : "Effacement";
  return `${GROUP_LABELS[key.account_group]} · ${boost}`;
}

const sameKey = (a: BoostConfigKey, b: BoostConfigKey) =>
  a.account_group === b.account_group && a.boost_type === b.boost_type && a.reduction_pct === b.reduction_pct;

const euros = (cents: number | null) => (cents === null ? "-" : `${cents / 100} EUR`);
const coefficientsText = (c: Coefficients | null) => (c === null ? "-" : COEFFICIENT_BANDS.map((band) => c[band]).join(" / "));

function renderGrid(grid: BoostConfigRow[]): void {
  renderTable(
    ["Ligne", "Actif", "Prix base", "Coefficients (<0 / 0-25 / ... / 90-100 %)", "Major.", "Borne", "Min. facture", "Fenetre", "Modifie par (UTC)"],
    grid.map((row) => [
      keyLabel(row),
      row.enabled ? "oui" : "COUPE",
      euros(row.base_price_cents),
      coefficientsText(row.coefficients),
      `x${row.price_multiplier}`,
      row.max_progress_pct === null ? "-" : `${row.max_progress_pct} %`,
      row.min_billed_pct === null ? "-" : `${row.min_billed_pct} %`,
      row.erasure_window_hours === null ? "-" : `${row.erasure_window_hours} h`,
      `${row.updated_by} ${formatSqlDateTime(row.updated_at).slice(0, 16)}`,
    ])
  );
  ui.info("Effacement sans prix propre : prix de la ligne -1 % du groupe. Changement visible tout de suite cote trader.");
}

/** Shows the grid and edits one line; the change is live for the traders at once (no cache). */
export async function boostConfigManage(session: DatabaseSession): Promise<void> {
  ui.sectionHeader("Grille des boosts");
  const grid = await configQ.getBoostConfig(session.connection);
  renderGrid(grid);

  const missing = KEYS.filter((key) => !grid.some((row) => sameKey(row, key)));
  const action = await select<"edit" | "toggle" | "add" | "delete" | "back">({
    message: "Action :",
    choices: [
      { name: "Modifier une ligne", value: "edit", disabled: grid.length === 0 },
      { name: "Couper ou rallumer un boost", value: "toggle", disabled: grid.length === 0 },
      { name: "Ajouter une ligne", value: "add", disabled: missing.length === 0 ? "les 9 lignes existent" : false },
      { name: "Supprimer une ligne", value: "delete", disabled: grid.length === 0 },
      { name: "Retour", value: "back" },
    ],
  });
  if (action === "back") return;
  if (action === "add") return addLine(session, missing);

  const row = await pickLine(grid);
  if (action === "edit") await editLine(session, row);
  if (action === "toggle") await save(session, row, { ...row, enabled: !row.enabled });
  if (action === "delete") await deleteLine(session, row, grid);
}

async function pickLine(grid: BoostConfigRow[]): Promise<BoostConfigRow> {
  return select<BoostConfigRow>({
    message: "Ligne :",
    choices: grid.map((row) => ({ name: `${keyLabel(row)}${row.enabled ? "" : " (coupe)"}`, value: row })),
  });
}

async function numberPrompt(message: string, current: number | null, check: (n: number) => string | true, optional = false) {
  const raw = await input({
    message: optional ? `${message} (vide = aucun)` : message,
    default: current === null ? undefined : String(current),
    validate: (v) => {
      if (optional && v.trim() === "") return true;
      const n = Number(v.trim().replace(",", "."));
      return v.trim() === "" || isNaN(n) ? "Un nombre" : check(n);
    },
  });
  return raw.trim() === "" ? null : Number(raw.trim().replace(",", "."));
}

async function coefficientsPrompt(current: Coefficients | null, optional: boolean): Promise<Coefficients | null> {
  const raw = await input({
    message: `Coefficients ${COEFFICIENT_BANDS.join(" / ")} (6 nombres)${optional ? " (vide = ceux de la ligne -1 %)" : ""}`,
    default: current === null ? undefined : COEFFICIENT_BANDS.map((band) => current[band]).join(" "),
    validate: (v) => {
      if (optional && v.trim() === "") return true;
      const values = v.trim().replace(/,/g, ".").split(/[\s/;]+/).map(Number);
      return values.length === 6 && values.every((n) => n > 0) ? true : "6 nombres positifs, separes par des espaces";
    },
  });
  if (raw.trim() === "") return null;
  const values = raw.trim().replace(/,/g, ".").split(/[\s/;]+/).map(Number);
  return Object.fromEntries(COEFFICIENT_BANDS.map((band, i) => [band, values[i]])) as Coefficients;
}

/** The values of a line, asked one by one; what the database requires for its boost type is mandatory. */
async function valuesPrompt(key: BoostConfigKey, current: BoostConfigValues): Promise<BoostConfigValues> {
  const reduction = key.boost_type === "reduction";
  const positive = (n: number) => (n > 0 ? true : "Superieur a 0");
  const base = await numberPrompt("Prix de base pour 100k, en euros", current.base_price_cents === null ? null : current.base_price_cents / 100, positive, !reduction);
  const values: BoostConfigValues = {
    ...current,
    base_price_cents: base === null ? null : Math.round(base * 100),
    coefficients: await coefficientsPrompt(current.coefficients, !reduction),
    price_multiplier: (await numberPrompt("Majoration (1 = aucune)", current.price_multiplier, (n) => (n >= 1 ? true : "1 au minimum"))) ?? 1,
  };
  if (reduction) {
    values.max_progress_pct = await numberPrompt("Borne : avancement maximum pour acheter, en % de l'objectif", current.max_progress_pct, (n) => (n >= 0 && n <= 100 ? true : "Entre 0 et 100"));
    values.forbid_direct_validation = await confirm({ message: "Interdire d'acheter le % qui manque (validation directe) ?", default: current.forbid_direct_validation });
  } else {
    values.min_billed_pct = await numberPrompt("Minimum facture, en % du capital", current.min_billed_pct, (n) => (n >= 0 ? true : "0 au minimum"));
    values.erasure_window_hours = await numberPrompt("Fenetre apres la cloture, en heures", current.erasure_window_hours, (n) => (Number.isInteger(n) && n > 0 ? true : "Un nombre entier d'heures, superieur a 0"));
    if ((values.base_price_cents === null) !== (values.coefficients === null)) {
      ui.error("Un prix propre demande le prix de base ET les coefficients (ou aucun des deux) : recommencez.");
      return valuesPrompt(key, current);
    }
  }
  return values;
}

async function editLine(session: DatabaseSession, row: BoostConfigRow): Promise<void> {
  await save(session, row, await valuesPrompt(row, row));
}

function describe(values: BoostConfigValues): Record<string, string> {
  return {
    "Actif": values.enabled ? "oui" : "COUPE",
    "Prix de base": euros(values.base_price_cents),
    "Coefficients": coefficientsText(values.coefficients),
    "Majoration": `x${values.price_multiplier}`,
    "Borne": values.max_progress_pct === null ? "-" : `${values.max_progress_pct} %`,
    "Validation directe interdite": values.forbid_direct_validation ? "oui" : "non",
    "Minimum facture": values.min_billed_pct === null ? "-" : `${values.min_billed_pct} %`,
    "Fenetre": values.erasure_window_hours === null ? "-" : `${values.erasure_window_hours} h`,
  };
}

function valuesOf(row: BoostConfigRow): BoostConfigValues {
  const { account_group, boost_type, reduction_pct, updated_by, updated_at, ...values } = row;
  return values;
}

async function save(session: DatabaseSession, row: BoostConfigRow, after: BoostConfigValues): Promise<void> {
  const { connection: conn, env, operator } = session;
  const before = valuesOf(row);
  const changes = Object.entries(describe(after)).filter(([label, value]) => describe(before)[label] !== value);
  if (changes.length === 0) {
    ui.info("Aucun changement.");
    return;
  }
  ui.sectionHeader(keyLabel(row));
  renderKeyValue(Object.fromEntries(changes.map(([label, value]) => [label, `${describe(before)[label]} -> ${value}`])));
  if (!(await confirmProductionAction(env, `Modifier la ligne ${keyLabel(row)} (visible tout de suite)`))) {
    ui.info("Action annulee.");
    return;
  }
  if (!(await configQ.updateBoostConfig(conn, row, after, operator))) {
    ui.error("La ligne n'existe plus : rien n'a change.");
    return;
  }
  await auditLogQ.insertAuditLog(conn, "BOOST_CONFIG_UPDATE", "boost_config", null, { key: keyOf(row), before, after }, operator, env);
  ui.success("Grille mise a jour.");
}

function keyOf(key: BoostConfigKey): BoostConfigKey {
  return { account_group: key.account_group, boost_type: key.boost_type, reduction_pct: key.reduction_pct };
}

async function addLine(session: DatabaseSession, missing: BoostConfigKey[]): Promise<void> {
  const { connection: conn, env, operator } = session;
  const key = await select<BoostConfigKey>({
    message: "Ligne a ajouter :",
    choices: missing.map((k) => ({ name: keyLabel(k), value: k })),
  });
  const empty: BoostConfigValues = {
    enabled: true, base_price_cents: null, coefficients: null, price_multiplier: 1, max_progress_pct: null,
    forbid_direct_validation: true, min_billed_pct: null, erasure_window_hours: null,
  };
  const values = await valuesPrompt(key, empty);
  ui.sectionHeader(keyLabel(key));
  renderKeyValue(describe(values));
  if (!(await confirmProductionAction(env, `Ajouter la ligne ${keyLabel(key)} (visible tout de suite)`))) {
    ui.info("Action annulee.");
    return;
  }
  await configQ.insertBoostConfig(conn, key, values, operator);
  await auditLogQ.insertAuditLog(conn, "BOOST_CONFIG_CREATE", "boost_config", null, { key: keyOf(key), after: values }, operator, env);
  ui.success("Ligne ajoutee.");
}

async function deleteLine(session: DatabaseSession, row: BoostConfigRow, grid: BoostConfigRow[]): Promise<void> {
  const { connection: conn, env, operator } = session;
  ui.warn(`Sans cette ligne, ${keyLabel(row)} n'est plus propose aux traders.`);
  const erasure = grid.find((r) => r.account_group === row.account_group && r.boost_type === "erasure");
  if (row.boost_type === "reduction" && row.reduction_pct === 1 && erasure && erasure.base_price_cents === null) {
    ui.warn(`L'effacement ${GROUP_LABELS[row.account_group]} prend son prix sur cette ligne : il sera ferme aussi.`);
  }
  if (!(await confirmProductionAction(env, `Supprimer la ligne ${keyLabel(row)}`))) {
    ui.info("Action annulee.");
    return;
  }
  if (!(await configQ.deleteBoostConfig(conn, row))) {
    ui.error("La ligne n'existe plus : rien n'a change.");
    return;
  }
  await auditLogQ.insertAuditLog(conn, "BOOST_CONFIG_DELETE", "boost_config", null, { key: keyOf(row), before: valuesOf(row) }, operator, env);
  ui.success("Ligne supprimee.");
}
