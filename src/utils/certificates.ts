import type { Environment } from "../config.js";
import type { CertificateRow } from "../queries/certificate.queries.js";
import { renderTable } from "./table.js";
import { formatCurrency, formatDate, formatSqlDateTime } from "./format.js";

const SITE_URL: Record<Environment, string> = {
  staging: "https://next.wegetfunded.com",
  production: "https://wegetfunded.com",
};

/**
 * Only the sources after the launch of the certificates can be reissued: the history before it never had any.
 * Production: set to the release date of the gamification pack.
 */
export const CERTIFICATES_SINCE: Record<Environment, string | null> = {
  staging: "2026-10-20 00:00:00",
  production: null,
};

const TYPE_LABELS: Record<CertificateRow["type"], string> = {
  funded: "Funded",
  payout: "Payout",
  payout_total: "Total payouts",
};

const PRODUCT_LABELS: Record<string, string> = {
  unlimited: "1 Etape",
  standard: "2 Etapes",
};

export const INELIGIBLE_LABELS: Record<string, string> = {
  free_trial: "compte d'essai gratuit",
  contest: "concours",
  instant_funded: "compte Instant Funded (pas de certificat Funded)",
  payout_not_paid: "payout pas encore paye",
};

export function publicUrl(env: Environment, publicId: string): string {
  return `${SITE_URL[env]}/certificate/${publicId}`;
}

export function usd(cents: number | null): string {
  return cents == null ? "N/A" : formatCurrency(cents / 100, "USD");
}

/** "Funded 1 Etape 100K" or "Payout 800.00 USD". */
export function describeCertificate(row: CertificateRow): string {
  if (row.type === "funded") {
    const product = PRODUCT_LABELS[row.challenge_type ?? ""] ?? row.challenge_type ?? "";
    const size = row.account_size ? `${row.account_size % 1000 === 0 ? `${row.account_size / 1000}K` : row.account_size}` : "";
    return `${TYPE_LABELS.funded} ${product} ${size}`.trim();
  }
  return `${TYPE_LABELS[row.type]} ${usd(row.amount_cents)}`;
}

export function renderCertificates(env: Environment, rows: CertificateRow[]): void {
  renderTable(
    ["Certificat", "Statut", "Emis le", "Mail", "Lien public"],
    rows.map((row) => [
      describeCertificate(row),
      row.status === "active" ? "actif" : `revoque (${row.revoked_reason ?? "sans motif"}, ${row.revoked_by ?? "?"})`,
      formatDate(row.issued_at),
      row.type === "payout_total" ? "-" : row.mailed_at ? formatSqlDateTime(row.mailed_at).slice(0, 16) : "a envoyer",
      publicUrl(env, row.public_id),
    ])
  );
}
