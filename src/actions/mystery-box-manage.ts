import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { input, select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import type { DbUser } from "../types.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as boxQ from "../queries/mystery-box.queries.js";
import * as userQ from "../queries/user.queries.js";
import * as ui from "../ui.js";
import { mysteryBoxBoost } from "./mystery-box-boost.js";
import { searchUserPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatSqlDateTime } from "../utils/format.js";
import { BOX_TYPE_LABELS, boxLabel, euros, renderMysteryBoxes } from "../utils/mystery-box.js";
import {
  BoxRefusedError,
  grantBoxes,
  revokeBox,
  type BoxGrant,
  type BoxType,
} from "../mystery-box-client.js";

// model-command stores the reason in a VARCHAR(255) and counts bytes.
const REASON_MAX_BYTES = 255;
// model-command gives at most 100 boxes per grant.
const MAX_BOXES = 100;

/**
 * Shows a trader's boxes, gives boxes to a trader (support gesture) or to a list of emails (marketing campaign), or
 * takes back an unopened box before a manual refund. model-command writes the boxes; the operator and the reason are
 * traced in admin_audit_log.
 */
export async function mysteryBoxManage(session: DatabaseSession, config: Config): Promise<void> {
  const scope = await select<"trader" | "campaign" | "back">({
    message: "Mystery Box :",
    choices: [
      { name: "Un trader (voir, offrir, retirer)", value: "trader" },
      { name: "Campagne : offrir des boxes a une liste d'emails", value: "campaign" },
      { name: "Retour", value: "back" },
    ],
  });
  if (scope === "trader") await traderBoxes(session, config);
  if (scope === "campaign") await campaign(session, config);
}

async function traderBoxes(session: DatabaseSession, config: Config): Promise<void> {
  const user = await searchUserPrompt(session.connection);
  if (!user) return;

  ui.info(`${user.firstname} ${user.lastname} <${user.email}>`);
  const boxes = await renderMysteryBoxes(session.connection, user);

  const action = await select<"gift" | "revoke" | "boost" | "back">({
    message: "Action :",
    choices: [
      { name: "Offrir des boxes (geste du support)", value: "gift" },
      { name: "Retirer une box non ouverte", value: "revoke" },
      { name: "Booster ses chances (invisible pour le trader)", value: "boost" },
      { name: "Retour", value: "back" },
    ],
  });
  if (action === "gift") await gift(session, config, user);
  if (action === "revoke") await revoke(session, config, user, boxes);
  if (action === "boost") await mysteryBoxBoost(session, config, user);
}

async function boxTypePrompt(): Promise<BoxType> {
  return select<BoxType>({
    message: "Gamme :",
    choices: (Object.keys(BOX_TYPE_LABELS) as BoxType[]).map((type) => ({ name: BOX_TYPE_LABELS[type], value: type })),
  });
}

async function quantityPrompt(message: string): Promise<number> {
  const raw = await input({
    message,
    default: "1",
    validate: (v) => {
      if (!/^[1-9]\d*$/.test(v.trim())) return "Un nombre entier, superieur a 0";
      if (Number(v.trim()) > MAX_BOXES) return `${MAX_BOXES} boxes maximum`;
      return true;
    },
  });
  return Number(raw.trim());
}

async function reasonPrompt(message: string): Promise<string> {
  return (
    await input({
      message,
      validate: (v) => {
        const trimmed = v.trim();
        if (!trimmed) return "Le motif est obligatoire";
        if (Buffer.byteLength(trimmed, "utf8") > REASON_MAX_BYTES) return `${REASON_MAX_BYTES} octets maximum`;
        return true;
      },
    })
  ).trim();
}

function refusal(err: Error): string {
  if (err instanceof BoxRefusedError) {
    switch (err.code) {
      case "unknown_user":
        return "utilisateur inconnu de model-command";
      case "box_already_opened":
        return "box deja ouverte";
      case "box_revoked":
        return "box deja retiree";
      case "box_not_found":
        return "box introuvable";
    }
  }
  return err.message;
}

async function gift(session: DatabaseSession, config: Config, user: DbUser): Promise<void> {
  const { env, operator } = session;
  const boxType = await boxTypePrompt();
  const quantity = await quantityPrompt("Nombre de boxes :");
  const reason = await reasonPrompt("Motif (obligatoire, garde sur la box et en audit) :");

  ui.sectionHeader("Recapitulatif");
  renderKeyValue({
    "Trader": `${user.firstname} ${user.lastname} <${user.email}>`,
    "Boxes": `${quantity} ${BOX_TYPE_LABELS[boxType]}`,
    "Origine": "geste du support",
    "Motif": reason,
    "Auteur": operator,
  });
  const confirmed = await confirmProductionAction(env, `Offrir ${quantity} box(es) ${BOX_TYPE_LABELS[boxType]} a ${user.email}`);
  if (!confirmed) {
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
  };
  await grantBoxes(config, env, [grant], async (_, result) => {
    if (result instanceof Error) {
      ui.error(`Don refuse : ${refusal(result)}`);
      ui.info("Aucune box n'a ete donnee.");
      return;
    }
    await auditGrant(session, user.email, grant, result.boxes.map((box) => box.box_uuid));
    ui.success(`${result.created} box(es) ${BOX_TYPE_LABELS[boxType]} ajoutee(s) a l'inventaire de ${user.email}.`);
  });
}

async function auditGrant(session: DatabaseSession, email: string, grant: BoxGrant, boxUuids: string[]): Promise<void> {
  const { connection: conn, env, operator } = session;
  await auditLogQ.insertAuditLog(conn, "MYSTERY_BOX_GRANT", "user", grant.userUuid, {
    email,
    box_type: grant.boxType,
    quantity: grant.quantity,
    origin: grant.origin,
    origin_ref: grant.originRef,
    reason: grant.reason,
    box_uuids: boxUuids,
  }, operator, env);
}

/** A file path (one email per line) or emails separated by commas, semicolons or spaces. */
function parseEmails(raw: string): string[] {
  const path = raw.trim();
  const text = existsSync(path) ? readFileSync(path, "utf8") : raw;
  return [...new Set(text.split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

async function campaign(session: DatabaseSession, config: Config): Promise<void> {
  const { connection: conn, env, operator } = session;
  const raw = await input({
    message: "Emails separes par des virgules, ou chemin d'un fichier (un email par ligne) :",
    validate: (v) => (parseEmails(v).length > 0 ? true : "Aucun email"),
  });
  const emails = parseEmails(raw);

  const found: DbUser[] = [];
  const unknown: string[] = [];
  for (const email of emails) {
    const user = await userQ.getUserByEmail(conn, email);
    if (user) found.push(user);
    else unknown.push(email);
  }
  if (unknown.length > 0) ui.error(`Emails inconnus, ignores (${unknown.length}) : ${unknown.join(", ")}`);
  if (found.length === 0) {
    ui.info("Aucun trader a qui offrir des boxes.");
    return;
  }

  const boxType = await boxTypePrompt();
  const quantity = await quantityPrompt("Nombre de boxes par trader :");
  const reason = await reasonPrompt("Motif de la campagne (obligatoire, le meme pour toute la liste) :");
  // One reference per run, kept on each box: "<campaign>-<user_uuid>#i" stays within the 60 characters of origin_ref.
  const campaignRef = randomUUID().slice(0, 8);

  ui.sectionHeader("Recapitulatif");
  renderKeyValue({
    "Traders": `${found.length} (sur ${emails.length} emails)`,
    "Boxes": `${quantity} ${BOX_TYPE_LABELS[boxType]} chacun, ${quantity * found.length} au total`,
    "Origine": `campagne marketing ${campaignRef}`,
    "Ignores": unknown.length > 0 ? `${unknown.length} email(s) inconnu(s)` : "aucun",
    "Motif": reason,
    "Auteur": operator,
  });
  const confirmed = await confirmProductionAction(
    env,
    `Offrir ${quantity} box(es) ${BOX_TYPE_LABELS[boxType]} a ${found.length} trader(s) (campagne ${campaignRef})`
  );
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  const emailOf = new Map(found.map((user) => [user.user_uuid, user.email]));
  const grants: BoxGrant[] = found.map((user) => ({
    userUuid: user.user_uuid,
    boxType,
    quantity,
    origin: "marketing",
    originRef: `${campaignRef}-${user.user_uuid}`,
    reason,
    author: operator,
  }));
  let given = 0;
  const failed: string[] = [];
  await grantBoxes(config, env, grants, async (grant, result) => {
    const email = emailOf.get(grant.userUuid) ?? grant.userUuid;
    if (result instanceof Error) {
      failed.push(`${email} (${refusal(result)})`);
      return;
    }
    await auditGrant(session, email, grant, result.boxes.map((box) => box.box_uuid));
    given += result.created;
  });

  ui.success(`Campagne ${campaignRef} : ${given} box(es) donnee(s) a ${found.length - failed.length} trader(s).`);
  if (failed.length > 0) ui.error(`Refuses (${failed.length}) : ${failed.join(", ")}`);
  if (unknown.length > 0) ui.info(`Emails inconnus, non traites : ${unknown.join(", ")}`);
}

async function revoke(session: DatabaseSession, config: Config, user: DbUser, boxes: boxQ.BoxRow[]): Promise<void> {
  const { connection: conn, env, operator } = session;
  const unopened = boxes.filter((row) => row.status === "unopened");
  if (unopened.length === 0) {
    ui.info("Aucune box non ouverte : une box ouverte ou deja retiree ne se retire pas.");
    return;
  }

  const boxUuid = await select<string>({
    message: "Box a retirer (seules les boxes non ouvertes se retirent) :",
    choices: [
      ...unopened.map((row) => ({
        name: `${boxLabel(row)} — acquise le ${formatSqlDateTime(row.acquired_at)} — ${row.reason ?? row.origin_ref}`,
        value: row.box_uuid,
      })),
      { name: "Retour", value: "" },
    ],
  });
  const row = unopened.find((candidate) => candidate.box_uuid === boxUuid);
  if (!row) return;

  const order = row.origin === "purchase" ? await boxQ.getBoxOrder(conn, row.origin_ref) : null;
  const reason = await reasonPrompt("Motif (obligatoire, garde sur la box et en audit) :");
  ui.sectionHeader("Recapitulatif");
  renderKeyValue({
    "Trader": `${user.firstname} ${user.lastname} <${user.email}>`,
    "Box": `${boxLabel(row)}, acquise le ${formatSqlDateTime(row.acquired_at)}`,
    ...(order
      ? {
          "Commande": `pack de ${order.pack_size}, ${euros(order.price_cents)} dont ${euros(order.money_cents)} payes ` +
            `(${order.provider ?? "?"}, ${order.merchant_reference_id ?? "?"}) et ${euros(order.wegetcoin_cents)} en WeGetCoins`,
        }
      : {}),
    "Motif": reason,
    "Auteur": operator,
  });

  const confirmed = await confirmProductionAction(env, `Retirer la box ${boxLabel(row)} de ${user.email}`);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  try {
    await revokeBox(config, env, row.box_uuid, reason, operator);
  } catch (err) {
    ui.error(`Retrait refuse : ${refusal(err instanceof Error ? err : new Error(String(err)))}`);
    ui.info("Aucune box n'a bouge.");
    return;
  }

  await auditLogQ.insertAuditLog(conn, "MYSTERY_BOX_REVOKE", "mystery_box", row.box_uuid, {
    email: user.email,
    box_type: row.box_type,
    origin: row.origin,
    origin_ref: row.origin_ref,
    reason,
    ...(order ? { order_uuid: order.order_uuid, merchant_reference_id: order.merchant_reference_id } : {}),
  }, operator, env);

  ui.success(`Box retiree : elle ne s'ouvre plus et sort de l'inventaire de ${user.email}.`);
  if (order) {
    ui.info(
      "Le remboursement reste manuel : la part carte chez le prestataire, " +
        'les WeGetCoins avec Actions > "WeGetCoins d\'un utilisateur (crediter, debiter)".'
    );
  }
}
