import type { Config, Environment } from "./config.js";
import { openModelCommandTunnel } from "./tunnel.js";

export type WeGetCoinDirection = "credit" | "debit";
export type SupportKind = "support_gesture" | "support_correction";

export interface WeGetCoinMovement {
  userUuid: string;
  /** Positive, in euro cents (10 cents = 1 WeGetCoin): the direction gives the sign. */
  amountCents: number;
  kind: SupportKind;
  reason: string;
  operator: string;
  /** A fresh uuid per action, so the same gesture can be repeated on purpose. */
  referenceId: string;
}

export interface WeGetCoinMovementResult {
  transaction: { transaction_uuid: string; amount_cents: number; balance_after_cents: number };
  wallet: { balance_cents: number; reserved_cents: number };
  created: boolean;
}

/** A refusal by the wallet: code is insufficient_funds, invalid_request, unknown_user... */
export class WeGetCoinRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Credits or debits a trader's WeGetCoins through the wallet API of
 * model-command: it locks the wallet, writes the journal line and refuses a
 * debit beyond the available balance. Never write wegetcoin_* tables directly.
 */
export async function moveWeGetCoins(
  config: Config,
  env: Environment,
  direction: WeGetCoinDirection,
  movement: WeGetCoinMovement
): Promise<WeGetCoinMovementResult> {
  const tunnel = await openModelCommandTunnel(config, env);

  try {
    const response = await fetch(`http://127.0.0.1:${tunnel.localPort}/wegetcoin/${direction}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_uuid: movement.userUuid,
        amount_cents: movement.amountCents,
        kind: movement.kind,
        reference_type: "support_action",
        reference_id: movement.referenceId,
        reason: movement.reason,
        author: movement.operator,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const refusal = readRefusal(payload);
      if (refusal) {
        throw new WeGetCoinRefusedError(refusal.code, refusal.message);
      }
      throw new Error(`model-command a repondu ${response.status}`);
    }

    return payload as WeGetCoinMovementResult;
  } finally {
    tunnel.close();
  }
}

function readRefusal(payload: unknown): { code: string; message: string } | null {
  if (payload && typeof payload === "object" && "error" in payload) {
    const { error, message } = payload as { error: unknown; message?: unknown };
    if (typeof error === "string") {
      return { code: error, message: typeof message === "string" ? message : error };
    }
  }
  return null;
}
