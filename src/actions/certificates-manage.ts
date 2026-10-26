import { input, select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import type { DbUser } from "../types.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as certQ from "../queries/certificate.queries.js";
import * as ui from "../ui.js";
import { searchUserPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatChallengeName, formatDate } from "../utils/format.js";
import {
  CERTIFICATES_SINCE,
  INELIGIBLE_LABELS,
  describeCertificate,
  publicUrl,
  renderCertificates,
  usd,
} from "../utils/certificates.js";
import {
  CertificateRefusedError,
  issueFundedCertificate,
  issuePayoutCertificate,
  revokeCertificate,
  type CertificateIssueResult,
} from "../certificate-client.js";

// model-command stores the reason in a VARCHAR(255) and counts bytes.
const REASON_MAX_BYTES = 255;

type Source =
  | { kind: "funded"; row: certQ.MissingFundedRow }
  | { kind: "payout"; row: certQ.MissingPayoutRow };

/**
 * Shows a trader's certificates with their public links, revokes a Funded or Payout certificate, or reissues a missing
 * one. The service keeps one certificate per source and recomputes the payout total; the operator and the reason are
 * traced in admin_audit_log.
 */
export async function certificatesManage(session: DatabaseSession, config: Config): Promise<void> {
  const { connection: conn, env } = session;

  const user = await searchUserPrompt(conn);
  if (!user) return;

  ui.info(`${user.firstname} ${user.lastname} <${user.email}>`);
  const certificates = await certQ.listCertificates(conn, user.user_uuid);
  ui.sectionHeader(`Certificats (${certificates.length})`);
  renderCertificates(env, certificates);

  const action = await select<"revoke" | "reissue" | "back">({
    message: "Action :",
    choices: [
      { name: "Revoquer un certificat", value: "revoke" },
      { name: "Reemettre un certificat manquant", value: "reissue" },
      { name: "Retour", value: "back" },
    ],
  });
  if (action === "revoke") await revoke(session, config, user, certificates);
  if (action === "reissue") await reissue(session, config, user);
}

async function reasonPrompt(): Promise<string> {
  return (
    await input({
      message: "Motif (obligatoire, garde en audit) :",
      validate: (v) => {
        const trimmed = v.trim();
        if (!trimmed) return "Le motif est obligatoire";
        if (Buffer.byteLength(trimmed, "utf8") > REASON_MAX_BYTES) return `${REASON_MAX_BYTES} octets maximum`;
        return true;
      },
    })
  ).trim();
}

async function revoke(
  session: DatabaseSession,
  config: Config,
  user: DbUser,
  certificates: certQ.CertificateRow[]
): Promise<void> {
  const { connection: conn, env, operator } = session;
  // The total follows the active payouts by itself: only Funded and Payout certificates are revoked by hand.
  const revocable = certificates.filter((row) => row.status === "active" && row.type !== "payout_total");
  if (revocable.length === 0) {
    ui.info("Aucun certificat Funded ou Payout actif a revoquer.");
    return;
  }

  const certificateUuid = await select<string>({
    message: "Certificat a revoquer :",
    choices: [
      ...revocable.map((row) => ({
        name: `${describeCertificate(row)} — emis le ${formatDate(row.issued_at)} — ${row.public_id}`,
        value: row.certificate_uuid,
      })),
      { name: "Retour", value: "" },
    ],
  });
  const row = revocable.find((candidate) => candidate.certificate_uuid === certificateUuid);
  if (!row) return;

  const reason = await reasonPrompt();
  const url = publicUrl(env, row.public_id);
  ui.sectionHeader("Recapitulatif");
  renderKeyValue({
    "Trader": `${user.firstname} ${user.lastname} <${user.email}>`,
    "Certificat": describeCertificate(row),
    "Page publique": `${url} (affichera « Certificat revoque »)`,
    "Total": row.type === "payout" ? "recalcule sans ce payout" : "inchange",
    "Motif": reason,
    "Auteur": operator,
  });

  const confirmed = await confirmProductionAction(env, `Revoquer le certificat ${describeCertificate(row)} de ${user.email}`);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  try {
    await revokeCertificate(config, env, row.certificate_uuid, reason, operator);
  } catch (err) {
    ui.error(`Revocation refusee : ${err instanceof Error ? err.message : String(err)}`);
    ui.info("Aucun certificat n'a bouge.");
    return;
  }

  await auditLogQ.insertAuditLog(conn, "CERTIFICATE_REVOKE", "certificate", row.certificate_uuid, {
    email: user.email,
    type: row.type,
    public_id: row.public_id,
    certificate: describeCertificate(row),
    reason,
  }, operator, env);

  ui.success(`Certificat revoque : ${url} affiche « Certificat revoque ».`);
  if (row.type === "payout") ui.info("Le Total des payouts a ete recalcule.");
}

function sourceLabel(source: Source): string {
  if (source.kind === "funded") {
    const { row } = source;
    return `Funded — compte ${row.login ?? "?"} (${formatChallengeName(row.challenge_name ?? "?")}), active le ${formatDate(row.activated_at)}`;
  }
  const { row } = source;
  return `Payout ${row.payout_amount.toFixed(2)} USD avant split (${row.profit_split}) — compte ${row.login ?? "?"}, paye le ${formatDate(row.paid_at)}`;
}

async function reissue(session: DatabaseSession, config: Config, user: DbUser): Promise<void> {
  const { connection: conn, env, operator } = session;
  const since = CERTIFICATES_SINCE[env];
  if (!since) {
    ui.error("Date de lancement des certificats non renseignee pour cet environnement (CERTIFICATES_SINCE).");
    return;
  }

  const [funded, payouts] = await Promise.all([
    certQ.listMissingFunded(conn, user.user_uuid, since),
    certQ.listMissingPayouts(conn, user.user_uuid, since),
  ]);
  const sources: Source[] = [
    ...funded.map((row) => ({ kind: "funded" as const, row })),
    ...payouts.map((row) => ({ kind: "payout" as const, row })),
  ];
  if (sources.length === 0) {
    ui.info(`Aucun certificat manquant depuis le ${since.slice(0, 10)} : chaque funded et chaque payout paye a le sien.`);
    return;
  }

  const index = await select<number>({
    message: "Certificat manquant a emettre :",
    choices: [
      ...sources.map((source, i) => ({ name: sourceLabel(source), value: i })),
      { name: "Retour", value: -1 },
    ],
  });
  const source = sources[index];
  if (!source) return;

  const reason = await reasonPrompt();
  ui.sectionHeader("Recapitulatif");
  renderKeyValue({
    "Trader": `${user.firstname} ${user.lastname} <${user.email}>`,
    "Certificat": sourceLabel(source),
    "Total": source.kind === "payout" ? "recalcule avec ce payout" : "inchange",
    "Mail": "envoye au trader dans les 5 minutes",
    "Motif": reason,
    "Auteur": operator,
  });

  const confirmed = await confirmProductionAction(env, `Emettre le certificat manquant de ${user.email}`);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  let result: CertificateIssueResult;
  try {
    result =
      source.kind === "funded"
        ? await issueFundedCertificate(config, env, source.row.trading_account_uuid)
        : await issuePayoutCertificate(config, env, source.row.payout_request_uuid);
  } catch (err) {
    const detail = err instanceof CertificateRefusedError ? `${err.code} (${err.message})` : err instanceof Error ? err.message : String(err);
    ui.error(`Emission refusee : ${detail}`);
    ui.info("Aucun certificat n'a ete cree.");
    return;
  }

  if (result.ineligible) {
    ui.error(`Emission refusee : ${INELIGIBLE_LABELS[result.ineligible] ?? result.ineligible}.`);
    return;
  }
  if (!result.created || !result.certificate) {
    ui.error(
      `Emission refusee : ce certificat existe deja${result.certificate ? ` (${publicUrl(env, result.certificate.public_id)})` : ""}, aucun doublon.`
    );
    return;
  }

  const url = publicUrl(env, result.certificate.public_id);
  await auditLogQ.insertAuditLog(conn, "CERTIFICATE_REISSUE", "certificate", result.certificate.certificate_uuid, {
    email: user.email,
    type: source.kind,
    source_uuid: source.kind === "funded" ? source.row.trading_account_uuid : source.row.payout_request_uuid,
    public_id: result.certificate.public_id,
    total_amount_cents: result.total?.amount_cents ?? null,
    reason,
  }, operator, env);

  ui.success(`Certificat emis : ${url}`);
  if (source.kind === "payout") ui.info(`Total des payouts : ${usd(result.total?.amount_cents ?? null)}.`);
  ui.info("Le mail du certificat part au prochain passage du cron (5 minutes au plus).");
}

