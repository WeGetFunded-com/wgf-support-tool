import type { Config, Environment } from "./config.js";
import { openModelCommandTunnel } from "./tunnel.js";

export interface XpAward {
  userUuid: string;
  kind: string;
  referenceType: string;
  referenceId: string;
  /** Signed: only a support_adjustment may withdraw. Absent for an event priced by the XP scale. */
  amount?: number;
  reason?: string;
  author: string;
}

export interface XpAwardResult {
  transaction: { amount: number; xp_total_after: number } | null;
  profile: { xp_total: number; level: number };
  levels_reached: { level: number; tier: string; sub_level: number }[] | null;
  rewards_created: { level: number; gift_type: string }[] | null;
  created: boolean;
}

/** A refusal by the XP engine: code is insufficient_xp, invalid_request, unknown_user... */
export class XpRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Awards or withdraws XP through the XP engine of model-command: it locks the
 * profile, writes the journal line, keeps the level and unlocks the rewards.
 * Never write xp_* tables directly.
 */
export async function awardXp(config: Config, env: Environment, award: XpAward): Promise<XpAwardResult> {
  const tunnel = await openModelCommandTunnel(config, env);

  try {
    const response = await fetch(`http://127.0.0.1:${tunnel.localPort}/xp/award`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_uuid: award.userUuid,
        kind: award.kind,
        reference_type: award.referenceType,
        reference_id: award.referenceId,
        amount: award.amount,
        reason: award.reason,
        author: award.author,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (payload && typeof payload === "object" && "error" in payload) {
        const { error, message } = payload as { error: unknown; message?: unknown };
        if (typeof error === "string") {
          throw new XpRefusedError(error, typeof message === "string" ? message : error);
        }
      }
      throw new Error(`model-command a repondu ${response.status}`);
    }
    return payload as XpAwardResult;
  } finally {
    tunnel.close();
  }
}
