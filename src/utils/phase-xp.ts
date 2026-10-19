import type mysql from "mysql2/promise";
import type { Config, Environment } from "../config.js";
import { PHASE } from "../types.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as xpQ from "../queries/xp.queries.js";
import * as ui from "../ui.js";
import { awardXp } from "../xp-client.js";

const FREE_TRIAL_METHODS = new Set(["free_trial", "free_trial_archived"]);

/** The XP kind of a passed phase, as the watcher awards it; null when the phase earns nothing. */
export function phaseXpKind(challengeType: string, phase: number): string | null {
  if (phase === PHASE.STANDARD_ONE) return "phase1_passed";
  if (challengeType === "standard" && phase === PHASE.STANDARD_TWO) return "phase2_passed";
  if (challengeType === "unlimited" && phase === PHASE.UNLIMITED) return "unlimited_passed";
  return null;
}

/**
 * Gives the XP of a phase the support forced. The reference is the trading account, like the watcher's, so a phase
 * pays once whoever records it first. A failure never undoes the transition: it is shown and traced.
 */
export async function awardForcedPhaseXp(
  conn: mysql.Connection,
  config: Config,
  env: Environment,
  operator: string,
  account: { trading_account_uuid: string; order_uuid: string; challenge_phase: number },
  challengeType: string
): Promise<void> {
  const kind = phaseXpKind(challengeType, account.challenge_phase);
  const owner = await xpQ.getOrderOwner(conn, account.order_uuid);
  if (!kind || !owner || (owner.method && FREE_TRIAL_METHODS.has(owner.method))) {
    ui.info("Pas d'XP de phase pour ce compte (essai gratuit, concours ou phase sans XP).");
    return;
  }

  try {
    const result = await awardXp(config, env, {
      userUuid: owner.user_uuid,
      kind,
      referenceType: "trading_account",
      referenceId: account.trading_account_uuid,
      author: operator,
    });
    if (result.created && result.transaction) {
      ui.success(`XP de phase : +${result.transaction.amount} XP (total ${result.profile.xp_total} XP).`);
    } else {
      ui.info("XP de phase deja attribuee pour ce compte : rien n'a ete ajoute.");
    }
    await auditLogQ.insertAuditLog(conn, "XP_PHASE_AWARD", "trading_account", account.trading_account_uuid, {
      kind,
      created: result.created,
      amount: result.transaction?.amount ?? 0,
      xp_after: result.profile.xp_total,
      level_after: result.profile.level,
    }, operator, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ui.warn(`XP de phase non attribuee (${message}). Ajoutez-la avec "Niveau et XP d'un utilisateur" si besoin.`);
    await auditLogQ.insertAuditLog(conn, "XP_PHASE_AWARD_FAILED", "trading_account", account.trading_account_uuid, {
      kind,
      error: message,
    }, operator, env);
  }
}
