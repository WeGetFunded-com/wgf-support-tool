import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { confirm, select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as certQ from "../queries/certificate.queries.js";
import * as ui from "../ui.js";
import { renderTable } from "../utils/table.js";
import { formatDate, formatSqlDateTime } from "../utils/format.js";
import { describeCertificate, publicUrl } from "../utils/certificates.js";

type Period = "today" | "yesterday" | "last_7_days";

const PERIOD_LABELS: Record<Period, string> = {
  today: "Aujourd'hui",
  yesterday: "Hier",
  last_7_days: "7 derniers jours",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC bounds of a period: today and the last 7 days run up to now, yesterday stops at midnight. */
function periodBounds(period: Period, now = new Date()): { from: Date; to: Date } {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "yesterday") return { from: new Date(midnight.getTime() - DAY_MS), to: midnight };
  const days = period === "today" ? 0 : 6;
  return { from: new Date(midnight.getTime() - days * DAY_MS), to: now };
}

function csvCell(value: string): string {
  return /[";\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Semicolons and a BOM: the file opens straight into columns in a French Excel. */
function writeCsv(fileName: string, headers: string[], rows: string[][]): string {
  const downloads = join(homedir(), "Downloads");
  const path = join(existsSync(downloads) ? downloads : homedir(), fileName);
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(";"));
  writeFileSync(path, `﻿${lines.join("\r\n")}\r\n`, "utf8");
  return path;
}

/**
 * Every Funded and Payout certificate issued in a period, for the marketing: revoked ones and the ones whose
 * holder hid their name are left out.
 */
export async function issuedCertificatesReport(session: DatabaseSession): Promise<void> {
  const { connection: conn, env } = session;

  const period = await select<Period>({
    message: "Periode (jours UTC) :",
    choices: (Object.keys(PERIOD_LABELS) as Period[]).map((value) => ({ name: PERIOD_LABELS[value], value })),
  });
  const { from, to } = periodBounds(period);
  const rows = await certQ.listIssuedCertificates(conn, formatSqlDateTime(from), formatSqlDateTime(to));
  const shown = rows.filter((row) => !row.name_masked);
  const masked = rows.length - shown.length;

  ui.sectionHeader(`Certificats emis - ${PERIOD_LABELS[period]} (${shown.length})`);
  ui.info(`Du ${formatDate(from)} au ${formatDate(to)}.`);
  if (masked > 0) {
    ui.info(`${masked} certificat(s) exclu(s) : le trader a masque son nom.`);
  }

  const headers = ["Emis le", "Certificat", "Trader", "Lien public"];
  const table = shown.map((row) => [
    formatDate(row.issued_at),
    describeCertificate(row),
    `${row.holder_firstname} ${row.holder_lastname}`.trim(),
    publicUrl(env, row.public_id),
  ]);
  renderTable(headers, table);
  if (rows.length === 1000) {
    ui.warn("Limite de 1000 certificats atteinte : la liste est incomplete.");
  }
  if (table.length === 0) return;

  if (await confirm({ message: "Exporter en CSV ?", default: true })) {
    const day = formatSqlDateTime(to).slice(0, 10);
    const path = writeCsv(`certificats-${period.replace(/_/g, "-")}-${day}.csv`, headers, table);
    ui.success(`Export ecrit : ${path}`);
  }
}
