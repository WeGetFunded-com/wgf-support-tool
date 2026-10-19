import { randomUUID } from "node:crypto";
import { input, select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { searchUserPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { levelAfter, levelName, renderXp } from "../utils/xp.js";
import { awardXp, XpRefusedError } from "../xp-client.js";

const REASON_MAX_LENGTH = 255;

type Direction = "add" | "remove";

/**
 * Adds or withdraws a trader's XP by hand (support_adjustment). An addition may reach new levels and unlock their
 * rewards; a withdrawal never lowers the level nor takes back a reward. The operator is the author of the journal
 * line and is traced in admin_audit_log.
 */
export async function xpManage(session: DatabaseSession, config: Config): Promise<void> {
  const { connection: conn, env, operator } = session;

  const user = await searchUserPrompt(conn);
  if (!user) return;

  ui.info(`${user.firstname} ${user.lastname} <${user.email}>`);
  const { profile, grid } = await renderXp(conn, user, 15);

  const direction = await select<Direction | "back">({
    message: "Action :",
    choices: [
      { name: "Ajouter de l'XP", value: "add" },
      { name: "Retirer de l'XP", value: "remove" },
      { name: "Retour", value: "back" },
    ],
  });
  if (direction === "back") return;

  if (direction === "remove" && profile.xp_total === 0) {
    ui.error("Retrait impossible : le trader n'a aucune XP.");
    return;
  }

  const amountStr = await input({
    message:
      direction === "remove"
        ? `XP a retirer (au plus ${profile.xp_total}) :`
        : "XP a ajouter :",
    validate: (v) => {
      if (!/^[1-9]\d*$/.test(v.trim())) return "Un nombre entier d'XP, superieur a 0";
      if (direction === "remove" && Number(v.trim()) > profile.xp_total) {
        return `Le trader n'a que ${profile.xp_total} XP`;
      }
      return true;
    },
  });
  const amount = Number(amountStr.trim());

  const reason = (
    await input({
      message: "Motif (obligatoire, garde sur la ligne du journal et en audit) :",
      validate: (v) => {
        const trimmed = v.trim();
        if (!trimmed) return "Le motif est obligatoire";
        if (trimmed.length > REASON_MAX_LENGTH) return `${REASON_MAX_LENGTH} caracteres maximum`;
        return true;
      },
    })
  ).trim();

  const signed = direction === "remove" ? -amount : amount;
  const xpAfter = profile.xp_total + signed;
  const expectedLevel = levelAfter(grid, profile.level, xpAfter);
  ui.sectionHeader("Recapitulatif");
  renderKeyValue({
    "Trader": `${user.firstname} ${user.lastname} <${user.email}>`,
    "Mouvement": `${signed > 0 ? "+" : ""}${signed} XP`,
    "XP apres": `${xpAfter} XP`,
    "Niveau apres": `${levelName(grid, expectedLevel)}${
      direction === "remove" ? " (un retrait ne fait jamais redescendre)" : ""
    }`,
    "Motif": reason,
    "Auteur": operator,
  });

  const description = `${direction === "remove" ? "Retirer" : "Ajouter"} ${amount} XP ${
    direction === "remove" ? "a" : "pour"
  } ${user.email}`;
  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  let result;
  try {
    result = await awardXp(config, env, {
      userUuid: user.user_uuid,
      kind: "support_adjustment",
      referenceType: "support_action",
      referenceId: randomUUID(),
      amount: signed,
      reason,
      author: operator,
    });
  } catch (err) {
    if (err instanceof XpRefusedError && err.code === "insufficient_xp") {
      ui.error("Retrait refuse : le trader n'a plus assez d'XP (elle a pu changer entre-temps).");
    } else {
      ui.error(`Ajustement refuse : ${err instanceof Error ? err.message : String(err)}`);
    }
    ui.info("Aucune XP n'a bouge.");
    return;
  }

  const levelsReached = (result.levels_reached ?? []).map((row) => row.level);
  const rewardsUnlocked = (result.rewards_created ?? []).length;
  await auditLogQ.insertAuditLog(conn, "XP_SUPPORT_ADJUSTMENT", "user", user.user_uuid, {
    email: user.email,
    amount: signed,
    reason,
    xp_before: profile.xp_total,
    xp_after: result.profile.xp_total,
    level_before: profile.level,
    level_after: result.profile.level,
    levels_reached: levelsReached,
    rewards_unlocked: rewardsUnlocked,
  }, operator, env);

  ui.success(
    `Ajustement enregistre : ${result.profile.xp_total} XP, niveau ${levelName(grid, result.profile.level)}` +
      (rewardsUnlocked > 0 ? `, ${rewardsUnlocked} recompense(s) debloquee(s).` : ".")
  );
}
