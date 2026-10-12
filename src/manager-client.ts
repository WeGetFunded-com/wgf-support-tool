import type { Config, Environment } from "./config.js";
import { openManagerTunnel } from "./tunnel.js";

/** What a payout paid in WeGetCoins converts into, at the rate frozen on the wallet lines. */
export interface WeGetCoinPayoutCredit {
  fxRateUsdEur: number;
  rateDate: string;
  rateSource: string;
  rateFallback: boolean;
  profitSplit: string;
  usdAfterSplit: number;
  conversionCoins: number;
  bonusCoins: number;
  totalCoins: number;
}

export interface SettlePayoutResult {
  payoutRequestUuid: string;
  status: string;
  mt5Login?: number;
  mt5Ticket?: number;
  debitedAmount?: number;
  validatedAt?: string;
  alreadySettled?: boolean;
  weGetCoins?: WeGetCoinPayoutCredit;
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
  payoutRequestUuid: string,
  operator: string
): Promise<SettlePayoutResult> {
  const tunnel = await openManagerTunnel(config, env);

  try {
    // Moved server-side from /payout/settle to /internal/payout/settle so it is
    // no longer routed by the manager's public ingress. Reached here via the
    // port-forward tunnel, so the internal path works unchanged.
    const response = await fetch(`http://127.0.0.1:${tunnel.localPort}/internal/payout/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradingAccountUuid, payoutRequestUuid, operator }),
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

/**
 * The WeGetCoins a payout paid in WeGetCoins would credit if settled now, at
 * today's rate. Nothing moves: shown to the operator before approving.
 */
export async function previewWeGetCoinPayout(
  config: Config,
  env: Environment,
  tradingAccountUuid: string,
  payoutRequestUuid: string
): Promise<WeGetCoinPayoutCredit> {
  const tunnel = await openManagerTunnel(config, env);

  try {
    const response = await fetch(
      `http://127.0.0.1:${tunnel.localPort}/internal/payout/wegetcoin/${tradingAccountUuid}/${payoutRequestUuid}`,
      { signal: AbortSignal.timeout(30_000) }
    );

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(readError(payload) ?? `le manager a repondu ${response.status}`);
    }

    return payload as WeGetCoinPayoutCredit;
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
