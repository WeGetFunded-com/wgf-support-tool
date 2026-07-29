import type { Config, Environment } from "./config.js";
import { openManagerTunnel } from "./tunnel.js";

export interface SettlePayoutResult {
  payoutRequestUuid: string;
  status: string;
  mt5Login?: number;
  mt5Ticket?: number;
  debitedAmount?: number;
  validatedAt?: string;
  alreadySettled?: boolean;
}

/**
 * Settles a payout: the manager withdraws the amount from the trader's MT5
 * account and only then marks the request as paid.
 *
 * This is the only supported way to pay a request. Flipping the status in database
 * without moving the money on MT5 leaves the trader's balance showing funds that
 * have already left the company — the balance is what the withdrawable amount and
 * the drawdown rules are computed from.
 *
 * Throws when MT5 refuses the operation, in which case nothing has changed.
 */
export async function settlePayout(
  config: Config,
  env: Environment,
  tradingAccountUuid: string,
  payoutRequestUuid: string
): Promise<SettlePayoutResult> {
  const tunnel = await openManagerTunnel(config, env);

  try {
    const response = await fetch(`http://127.0.0.1:${tunnel.localPort}/payout/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradingAccountUuid, payoutRequestUuid }),
      signal: AbortSignal.timeout(60_000),
    });

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(readError(payload) ?? `le manager a repondu ${response.status}`);
    }

    return payload as SettlePayoutResult;
  } finally {
    tunnel.close();
  }
}

function readError(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "error" in payload) {
    const { error } = payload as { error: unknown };
    if (typeof error === "string") {
      return error;
    }
  }

  return null;
}
