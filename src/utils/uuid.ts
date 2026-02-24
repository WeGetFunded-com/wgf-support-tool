import { randomUUID } from "node:crypto";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(input: string): boolean {
  return UUID_REGEX.test(input.trim());
}

export function generateUuid(): string {
  return randomUUID();
}

export function formatUuid(uuid: string): string {
  const clean = uuid.replace(/-/g, "").toLowerCase();
  if (clean.length !== 32) return uuid;
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}
