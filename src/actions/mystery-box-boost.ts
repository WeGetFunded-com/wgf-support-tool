import { randomUUID } from "node:crypto";
import { input, select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import type { DbUser } from "../types.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as boxQ from "../queries/mystery-box.queries.js";
import * as ui from "../ui.js";
import { confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue, renderTable } from "../utils/table.js";
import { formatSqlDateTime } from "../utils/format.js";
import { BOX_TYPE_LABELS } from "../utils/mystery-box.js";
import {
  BoxRefusedError,
  createAccountBoost,
  grantBoxes,
  revokeBoost,
  type BoostRules,
  type BoxGrant,
  type BoxType,
} from "../mystery-box-client.js";

// model-command stores the reason in a VARCHAR(255) and counts bytes; it gives at most 100 boxes per grant.
const REASON_MAX_BYTES = 255;
const MAX_BOXES = 100;
const MAX_OPENINGS = 1000;

const RARITY_LABELS: Record<string, string> = {
  common: "commun",
  uncommon: "peu commun",
  rare: "rare",
  epic: "epique",
  legendary: "legendaire",
};

/**
 * Raises a trader's chances at the Mystery Box, unseen by the trader and by the public odds: the rare, epic and
 * legendary lots weigh more, and one draw may give a chosen lot or a minimum rarity. model-command writes the boost;
 * the operator and the reason are traced in admin_audit_log.
 */
export async function mysteryBoxBoost(session: DatabaseSession, config: Config, user: DbUser): Promise<void> {
  const boosts = await boxQ.listBoosts(session.connection, user.user_uuid);
  renderBoosts(boosts);

  const action = await select<"account" | "boxes" | "revoke" | "back">({
    message: "Boost (invisible pour le trader) :",
    choices: [
      { name: "Booster les chances de ses prochaines ouvertures", value: "account" },
      { name: "Offrir des boxes boostees", value: "boxes" },
      { name: "Retirer un boost", value: "revoke" },
      { name: "Retour", value: "back" },
    ],
  });
  if (action === "account") await boostAccount(session, config, user);
  if (action === "boxes") await giftBoostedBoxes(session, config, user);
  if (action === "revoke") await endBoost(session, config, user, boosts);
}

function rulesLabel(rules: { multiplier: number; guaranteed_lot_key?: string | null; min_rarity?: string | null }): string {
  return [
    rules.multiplier > 1 ? `rares et plus x${rules.multiplier}` : null,
    rules.guaranteed_lot_key ? `lot garanti ${rules.guaranteed_lot_key}` : null,
    rules.min_rarity ? `au moins ${RARITY_LABELS[rules.min_rarity] ?? rules.min_rarity}` : null,
  ].filter(Boolean).join(", ");
}

function boostState(row: boxQ.BoostRow): string {
  if (row.revoked_at) return `retire le ${formatSqlDateTime(row.revoked_at)}`;
  if (row.scope === "box") return `${row.opened}/${row.boxes} box(es) ouverte(s)`;
  const left = [
    row.openings_left !== null ? `${row.openings_left} ouverture(s)` : null,
    row.expires_at ? `jusqu'au ${formatSqlDateTime(row.expires_at)}` : null,
  ].filter(Boolean).join(", ");
  return boxQ.isBoostActive(row) ? `actif : ${left}` : `termine (${left})`;
}

function renderBoosts(boosts: boxQ.BoostRow[]): void {
  ui.sectionHeader("Boosts");
  if (boosts.length === 0) {
    ui.info("Aucun boost.");
    return;
  }
  renderTable(
    ["Cree le", "Portee", "Gamme", "Regles", "Etat", "Motif"],
    boosts.map((row) => [
      formatSqlDateTime(row.created_at),
      row.scope === "account" ? "prochaines ouvertures" : "boxes offertes",
      row.box_type ? BOX_TYPE_LABELS[row.box_type] ?? row.box_type : "toutes",
      rulesLabel(row) + (row.extras_used_at ? " (lot/rarete donne)" : ""),
      boostState(row),
      row.reason,
    ])
  );
}

async function multiplierPrompt(): Promise<number> {
  return select<number>({
    message: "Chances des lots rares, epiques et legendaires :",
    choices: [
      { name: "x2", value: 2 },
      { name: "x3", value: 3 },
      { name: "x5", value: 5 },
      { name: "x10", value: 10 },
      { name: "Inchangees (seulement un lot garanti ou une rarete minimum)", value: 1 },
    ],
  });
}

/** The multiplier, then the optional one-time extra: a lot of the range's table or a minimum rarity. */
async function rulesPrompt(session: DatabaseSession, boxType: BoxType | null): Promise<BoostRules> {
  const multiplier = await multiplierPrompt();
  const extra = await select<"none" | "lot" | "rarity">({
    message: "En plus, une seule fois :",
    choices: [
      ...(multiplier > 1 ? [{ name: "Rien de plus", value: "none" as const }] : []),
      ...(boxType ? [{ name: "Garantir un lot precis", value: "lot" as const }] : []),
      { name: "Garantir une rarete minimum sur un tirage", value: "rarity" },
    ],
  });
  if (extra === "lot" && boxType) {
    const lots = await boxQ.listTableLots(session.connection, boxType);
    const guaranteedLotKey = await select<string>({
      message: `Lot garanti (${BOX_TYPE_LABELS[boxType]}) :`,
      choices: lots.map((lot) => ({
        name: `${lot.lot_key} — ${RARITY_LABELS[lot.lot_rarity] ?? lot.lot_rarity}, ${lot.slot}, ` +
          `${(lot.weight_ppm / 10_000).toFixed(2)} %`,
        value: lot.lot_key,
      })),
    });
    return { multiplier, guaranteedLotKey };
  }
  if (extra === "rarity") {
    const minRarity = await select<string>({
      message: "Rarete minimum d'un tirage :",
      choices: ["legendary", "epic", "rare", "uncommon"].map((rarity) => ({ name: RARITY_LABELS[rarity], value: rarity })),
    });
    return { multiplier, minRarity };
  }
  return { multiplier };
}

async function reasonPrompt(): Promise<string> {
  return (
    await input({
      message: "Motif (obligatoire, garde sur le boost et en audit) :",
      validate: (v) => {
        const trimmed = v.trim();
        if (!trimmed) return "Le motif est obligatoire";
        if (Buffer.byteLength(trimmed, "utf8") > REASON_MAX_BYTES) return `${REASON_MAX_BYTES} octets maximum`;
        return true;
      },
    })
  ).trim();
}

function refusal(err: unknown): string {
  if (err instanceof BoxRefusedError) {
    switch (err.code) {
      case "box_boost_unknown_lot":
        return "ce lot n'est plus dans la table en vigueur";
      case "box_boost_not_found":
        return "boost introuvable";
      case "unknown_user":
        return "utilisateur inconnu de model-command";
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

async function boostAccount(session: DatabaseSession, config: Config, user: DbUser): Promise<void> {
  const { connection: conn, env, operator } = session;
  const range = await select<BoxType | "all">({
    message: "Gamme boostee :",
    choices: [
      { name: "Toutes", value: "all" },
      ...(Object.keys(BOX_TYPE_LABELS) as BoxType[]).map((type) => ({ name: BOX_TYPE_LABELS[type], value: type })),
    ],
  });
  const boxType = range === "all" ? null : range;
  const rules = await rulesPrompt(session, boxType);

  const openingsRaw = await input({
    message: "Nombre d'ouvertures boostees (vide = pas de limite en nombre) :",
    validate: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return true;
      if (!/^[1-9]\d*$/.test(trimmed) || Number(trimmed) > MAX_OPENINGS) return `Un nombre de 1 a ${MAX_OPENINGS}`;
      return true;
    },
  });
  const openings = openingsRaw.trim() ? Number(openingsRaw.trim()) : undefined;
  const endRaw = await input({
    message: openings ? "Fin (AAAA-MM-JJ, vide = sans date) :" : "Fin (AAAA-MM-JJ, obligatoire sans nombre d'ouvertures) :",
    validate: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return openings ? true : "Un nombre d'ouvertures ou une date de fin";
      const date = new Date(`${trimmed}T23:59:59Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || Number.isNaN(date.getTime())) return "Format AAAA-MM-JJ";
      if (date <= new Date()) return "La date est passee";
      return true;
    },
  });
  const expiresAt = endRaw.trim() ? new Date(`${endRaw.trim()}T23:59:59Z`) : undefined;
  const reason = await reasonPrompt();

  ui.sectionHeader("Recapitulatif");
  renderKeyValue({
    "Trader": `${user.firstname} ${user.lastname} <${user.email}>`,
    "Boost": rulesLabel({ multiplier: rules.multiplier, guaranteed_lot_key: rules.guaranteedLotKey, min_rarity: rules.minRarity }),
    "Gamme": boxType ? BOX_TYPE_LABELS[boxType] : "toutes",
    "Duree": [openings ? `${openings} ouverture(s)` : null, expiresAt ? `jusqu'au ${endRaw.trim()} 23:59 UTC` : null]
      .filter(Boolean).join(", "),
    "Remplace": "le boost de compte en cours, s'il y en a un",
    "Visible": "non : ni le trader, ni la page des probabilites",
    "Motif": reason,
    "Auteur": operator,
  });
  if (!(await confirmProductionAction(env, `Booster les prochaines ouvertures de ${user.email}`))) {
    ui.info("Action annulee.");
    return;
  }

  let boostUuid: string;
  try {
    ({ boost_uuid: boostUuid } = await createAccountBoost(config, env, {
      userUuid: user.user_uuid,
      ...rules,
      ...(boxType ? { boxType } : {}),
      ...(openings ? { openings } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      reason,
      author: operator,
    }));
  } catch (err) {
    ui.error(`Boost refuse : ${refusal(err)}`);
    return;
  }
  await auditLogQ.insertAuditLog(conn, "MYSTERY_BOX_BOOST", "user", user.user_uuid, {
    email: user.email,
    boost_uuid: boostUuid,
    scope: "account",
    box_type: boxType,
    multiplier: rules.multiplier,
    guaranteed_lot_key: rules.guaranteedLotKey ?? null,
    min_rarity: rules.minRarity ?? null,
    openings: openings ?? null,
    expires_at: expiresAt?.toISOString() ?? null,
    reason,
  }, operator, env);
  ui.success(`Boost actif sur les prochaines ouvertures de ${user.email}.`);
}

async function giftBoostedBoxes(session: DatabaseSession, config: Config, user: DbUser): Promise<void> {
  const { env, operator } = session;
  const boxType = await select<BoxType>({
    message: "Gamme :",
    choices: (Object.keys(BOX_TYPE_LABELS) as BoxType[]).map((type) => ({ name: BOX_TYPE_LABELS[type], value: type })),
  });
  const quantityRaw = await input({
    message: "Nombre de boxes :",
    default: "1",
    validate: (v) =>
      /^[1-9]\d*$/.test(v.trim()) && Number(v.trim()) <= MAX_BOXES ? true : `Un nombre de 1 a ${MAX_BOXES}`,
  });
  const quantity = Number(quantityRaw.trim());
  const boost = await rulesPrompt(session, boxType);
  const reason = await reasonPrompt();

  ui.sectionHeader("Recapitulatif");
  renderKeyValue({
    "Trader": `${user.firstname} ${user.lastname} <${user.email}>`,
    "Boxes": `${quantity} ${BOX_TYPE_LABELS[boxType]} (geste du support)`,
    "Boost": rulesLabel({ multiplier: boost.multiplier, guaranteed_lot_key: boost.guaranteedLotKey, min_rarity: boost.minRarity }),
    "Lot ou rarete": boost.guaranteedLotKey || boost.minRarity ? "sur la premiere box ouverte" : "aucun",
    "Visible": "non : la box apparait comme une box ordinaire",
    "Motif": reason,
    "Auteur": operator,
  });
  if (!(await confirmProductionAction(env, `Offrir ${quantity} box(es) ${BOX_TYPE_LABELS[boxType]} boostee(s) a ${user.email}`))) {
    ui.info("Action annulee.");
    return;
  }

  const grant: BoxGrant = {
    userUuid: user.user_uuid,
    boxType,
    quantity,
    origin: "support",
    originRef: randomUUID(),
    reason,
    author: operator,
    boost,
  };
  await grantBoxes(config, env, [grant], async (_, result) => {
    if (result instanceof Error) {
      ui.error(`Don refuse : ${refusal(result)}`);
      ui.info("Aucune box n'a ete donnee.");
      return;
    }
    await auditLogQ.insertAuditLog(session.connection, "MYSTERY_BOX_GRANT", "user", user.user_uuid, {
      email: user.email,
      box_type: boxType,
      quantity,
      origin: "support",
      origin_ref: grant.originRef,
      reason,
      box_uuids: result.boxes.map((box) => box.box_uuid),
      boost: { multiplier: boost.multiplier, guaranteed_lot_key: boost.guaranteedLotKey ?? null, min_rarity: boost.minRarity ?? null },
    }, operator, env);
    ui.success(`${result.created} box(es) ${BOX_TYPE_LABELS[boxType]} boostee(s) ajoutee(s) a l'inventaire de ${user.email}.`);
  });
}

async function endBoost(session: DatabaseSession, config: Config, user: DbUser, boosts: boxQ.BoostRow[]): Promise<void> {
  const { connection: conn, env, operator } = session;
  const active = boosts.filter((row) => boxQ.isBoostActive(row));
  if (active.length === 0) {
    ui.info("Aucun boost actif.");
    return;
  }
  const boostUuid = await select<string>({
    message: "Boost a retirer :",
    choices: [
      ...active.map((row) => ({
        name: `${row.scope === "account" ? "Prochaines ouvertures" : "Boxes offertes"} — ${rulesLabel(row)} — ${boostState(row)}`,
        value: row.boost_uuid,
      })),
      { name: "Retour", value: "" },
    ],
  });
  const row = active.find((candidate) => candidate.boost_uuid === boostUuid);
  if (!row) return;
  if (!(await confirmProductionAction(env, `Retirer le boost de ${user.email} (${rulesLabel(row)})`))) {
    ui.info("Action annulee.");
    return;
  }
  try {
    await revokeBoost(config, env, row.boost_uuid, operator);
  } catch (err) {
    ui.error(`Retrait refuse : ${refusal(err)}`);
    return;
  }
  await auditLogQ.insertAuditLog(conn, "MYSTERY_BOX_BOOST_REVOKE", "user", user.user_uuid, {
    email: user.email,
    boost_uuid: row.boost_uuid,
    scope: row.scope,
  }, operator, env);
  ui.success("Boost retire : les prochaines ouvertures reprennent les chances publiques.");
}
