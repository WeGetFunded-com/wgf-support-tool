import type mysql from "mysql2/promise";
import type { Config, Environment } from "../config.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as xpQ from "../queries/xp.queries.js";
import * as ui from "../ui.js";
import { awardXp } from "../xp-client.js";
import { issueFundedCertificate } from "../certificate-client.js";
import { INELIGIBLE_LABELS, publicUrl } from "./certificates.js";

const FREE_TRIAL_METHODS = new Set(["free_trial", "free_trial_archived"]);

type ChallengeAccount = { trading_account_uuid: string; order_uuid: string };

/**
 * Gives what a One Time Payment funded earns when the support forces it: the watcher's simulate path creates the
 * funded account but awards neither the funded XP nor the Funded certificate. Both reference the challenge account,
 * like the watcher and the order service, so each is given once. A failure never undoes the transition: it is shown
 * and traced.
 */
export async function grantForcedOtpFunded(
  conn: mysql.Connection,
  config: Config,
  env: Environment,
  operator: string,
  account: ChallengeAccount
): Promise<void> {
  const owner = await xpQ.getOrderOwner(conn, account.order_uuid);
  if (!owner) {
    ui.warn("Proprietaire du compte introuvable : ni XP Funded ni certificat Funded.");
    return;
  }
  await awardFundedXp(conn, config, env, operator, account, owner);
  await issueCertificate(conn, config, env, operator, account);
}

async function awardFundedXp(
  conn: mysql.Connection,
  config: Config,
  env: Environment,
  operator: string,
  account: ChallengeAccount,
  owner: { user_uuid: string; method: string | null }
): Promise<void> {
  if (owner.method && FREE_TRIAL_METHODS.has(owner.method)) {
    ui.info("Pas d'XP Funded pour un essai gratuit.");
    return;
  }
  try {
    const result = await awardXp(config, env, {
      userUuid: owner.user_uuid,
      kind: "funded_activated",
      referenceType: "trading_account",
      referenceId: account.trading_account_uuid,
      author: operator,
    });
    if (result.created && result.transaction) {
      ui.success(`XP Funded : +${result.transaction.amount} XP (total ${result.profile.xp_total} XP).`);
    } else {
      ui.info("XP Funded deja attribuee pour ce compte : rien n'a ete ajoute.");
    }
    await auditLogQ.insertAuditLog(conn, "XP_FUNDED_AWARD", "trading_account", account.trading_account_uuid, {
      created: result.created,
      amount: result.transaction?.amount ?? 0,
      xp_after: result.profile.xp_total,
      level_after: result.profile.level,
    }, operator, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ui.warn(`XP Funded non attribuee (${message}). Ajoutez-la avec "Niveau et XP d'un utilisateur" si besoin.`);
    await auditLogQ.insertAuditLog(conn, "XP_FUNDED_AWARD_FAILED", "trading_account", account.trading_account_uuid, {
      error: message,
    }, operator, env);
  }
}

async function issueCertificate(
  conn: mysql.Connection,
  config: Config,
  env: Environment,
  operator: string,
  account: ChallengeAccount
): Promise<void> {
  try {
    const result = await issueFundedCertificate(config, env, account.trading_account_uuid);
    if (result.ineligible) {
      ui.info(`Pas de certificat Funded : ${INELIGIBLE_LABELS[result.ineligible] ?? result.ineligible}.`);
    } else if (result.created && result.certificate) {
      ui.success(`Certificat Funded emis : ${publicUrl(env, result.certificate.public_id)} (mail sous 5 minutes).`);
    } else {
      ui.info("Certificat Funded deja emis pour ce compte : aucun doublon.");
    }
    await auditLogQ.insertAuditLog(conn, "CERTIFICATE_FORCED_FUNDED", "trading_account", account.trading_account_uuid, {
      created: result.created,
      ineligible: result.ineligible ?? null,
      public_id: result.certificate?.public_id ?? null,
    }, operator, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ui.warn(
      `Certificat Funded non emis (${message}). Emettez-le avec "Certificats d'un utilisateur" > "Reemettre un certificat manquant".`
    );
    await auditLogQ.insertAuditLog(conn, "CERTIFICATE_FORCED_FUNDED_FAILED", "trading_account", account.trading_account_uuid, {
      error: message,
    }, operator, env);
  }
}
