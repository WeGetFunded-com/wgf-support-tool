import type { ChallengeType } from "../types.js";

export function formatPercent(value: number | string | null | undefined): string {
  if (value == null) return "N/A";
  const n = Number(value);
  if (isNaN(n)) return "N/A";
  return `${(n * 100).toFixed(2)}%`;
}

export function formatCurrency(amount: number | string | null | undefined, currency = "EUR"): string {
  if (amount == null) return "N/A";
  const n = Number(amount);
  if (isNaN(n)) return "N/A";
  return `${n.toFixed(2)} ${currency}`;
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "N/A";
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "N/A";
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function formatPhase(phase: number, challengeType?: ChallengeType | string): string {
  const labels: Record<number, string> = {
    0: "Phase 0 (Unlimited/Instant)",
    1: "Phase 1",
    2: "Phase 2",
    3: "Phase 3 (Instant Funded)",
    4: "Funded Standard",
    5: "Funded Unlimited",
  };
  const label = labels[phase] ?? `Phase ${phase}`;
  if (challengeType) return `${label} [${challengeType}]`;
  return label;
}

export function formatSuccess(success: number | null): string {
  if (success === null || success === undefined) return "Actif";
  if (success === 1) return "Reussi";
  return "Echoue";
}

export function formatServer(server: string): string {
  return server === "live" ? "LIVE" : "Demo";
}

export function formatDuration(durationStr: string | null | undefined): string {
  if (!durationStr) return "N/A";
  const match = durationStr.match(/^(\d+)h/);
  if (!match) return durationStr;
  const hours = parseInt(match[1], 10);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days} jours`;
  return `${hours} heures`;
}

export function formatBoolean(value: number | null | undefined): string {
  if (value === null || value === undefined) return "N/A";
  return value ? "Oui" : "Non";
}

export function formatChallengeName(name: string): string {
  return name.replace(/\bStandard\b/gi, "2 Steps").replace(/\bUnlimited\b/gi, "1 Step");
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}
