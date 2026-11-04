import type { Config, Environment } from "./config.js";
import { openModelCommandTunnel } from "./tunnel.js";

/** A refusal by model-command: code is boost_not_pending, boost_being_applied, boost_not_found... */
export class BoostRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Marks refunded a paid boost left pending, through model-command which sends boost_refunded. No money moves: the
 * support gives it back with the WeGetCoin tool or at the PSP. refunded is false when the boost already was.
 */
export async function refundBoost(
  config: Config,
  env: Environment,
  boostUuid: string,
  author: string
): Promise<{ refunded: boolean }> {
  const tunnel = await openModelCommandTunnel(config, env);
  try {
    const response = await fetch(`http://127.0.0.1:${tunnel.localPort}/challenge-boosts/${boostUuid}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
        const message = "message" in payload && typeof payload.message === "string" ? payload.message : payload.error;
        throw new BoostRefusedError(payload.error, message);
      }
      throw new Error(`model-command a repondu ${response.status}`);
    }
    const refunded = typeof payload === "object" && payload !== null && "refunded" in payload && payload.refunded === true;
    return { refunded };
  } finally {
    tunnel.close();
  }
}
