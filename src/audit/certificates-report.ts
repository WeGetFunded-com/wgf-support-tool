import type { DatabaseSession } from "../db.js";
import * as certQ from "../queries/certificate.queries.js";
import * as ui from "../ui.js";
import { searchUserPrompt } from "../utils/prompts.js";
import { renderTable } from "../utils/table.js";
import { formatChallengeName, formatDate } from "../utils/format.js";
import { CERTIFICATES_SINCE, renderCertificates } from "../utils/certificates.js";

/** Read-only view of a trader's certificates, their public links and mails, and the ones still missing. */
export async function certificatesReport(session: DatabaseSession): Promise<void> {
  const { connection: conn, env } = session;

  const user = await searchUserPrompt(conn);
  if (!user) return;

  ui.info(`${user.firstname} ${user.lastname} <${user.email}>`);
  const certificates = await certQ.listCertificates(conn, user.user_uuid);
  ui.sectionHeader(`Certificats (${certificates.length})`);
  renderCertificates(env, certificates);

  const since = CERTIFICATES_SINCE[env];
  if (since) {
    const [funded, payouts] = await Promise.all([
      certQ.listMissingFunded(conn, user.user_uuid, since),
      certQ.listMissingPayouts(conn, user.user_uuid, since),
    ]);
    ui.sectionHeader(`Certificats manquants depuis le ${since.slice(0, 10)} (${funded.length + payouts.length})`);
    renderTable(
      ["Source", "Compte", "Detail", "Date"],
      [
        ...funded.map((row) => [
          "Funded",
          String(row.login ?? "?"),
          formatChallengeName(row.challenge_name ?? "?"),
          formatDate(row.activated_at),
        ]),
        ...payouts.map((row) => [
          "Payout",
          String(row.login ?? "?"),
          `${row.payout_amount.toFixed(2)} USD avant split (${row.profit_split})`,
          formatDate(row.paid_at),
        ]),
      ]
    );
  }
  ui.info('Pour revoquer ou reemettre : Actions > "Certificats d\'un utilisateur".');
}
