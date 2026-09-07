import type { Config, Environment } from "./config.js";
import { openManagerTunnel } from "./tunnel.js";

/** Mirrors structs.PayoutCriterion in the manager. */
export interface PayoutCriterion {
  required: number;
  current: number;
  met: boolean;
}

export interface PayoutDaysSinceFirstTrade extends PayoutCriterion {
  firstTradeDate: string | null;
}

export interface PayoutConsistencyRule {
  applicable: boolean;
  maxAllowedPercent: number;
  highestDayPercent: number;
  met: boolean;
  bestDay: number;
  reference: number;
}

export interface PayoutFastTradesRule {
  limitPercent: number;
  maxSeconds: number;
  shortPnl: number;
  totalPnl: number;
  ratio: number;
  met: boolean;
}

/**
 * The manager's payout eligibility verdict, verbatim. Every figure is computed
 * over the current payout cycle only — that is, the trading activity that
 * happened after the last approved payout.
 */
export interface PayoutEligibility {
  eligible: boolean;
  isFunded: boolean;
  hasProfitAboveDeposit: boolean;
  minPayout: number;
  maxPayout: number;
  positiveTradingDays: PayoutCriterion;
  daysSinceFirstTrade: PayoutDaysSinceFirstTrade;
  consistencyRule: PayoutConsistencyRule;
  fastTrades: PayoutFastTradesRule;
}

export interface SimulatePayoutInput {
  tradingAccountUuid: string;
  accountLogin: string;
  platform: string;
  firstName: string;
  lastName: string;
  postalAddress: string;
  payoutAmount: number;
  profitSplit?: string;
  force: boolean;
}

export interface SimulatedPayout {
  payout_request_uuid: string;
  payout_amount: number;
  profit_split: string;
  balance_before_request: number;
  total_profit: number;
  status: string;
}

/**
 * The eligibility rules live in the manager and nowhere else. Recomputing them
 * here would mean maintaining a second copy of rules that keep moving — the
 * 14-day anchor, the consistency denominator and the sub-30s ratio were all
 * corrected recently — so this asks the service that owns them.
 *
 * The route is internal: it is deliberately not under /payout, which the ingress
 * publishes as a Prefix, so it is only reachable through the port-forward below
 * — which already costs a kube token.
 */
export async function getPayoutEligibility(
  config: Config,
  env: Environment,
  tradingAccountUuid: string
): Promise<PayoutEligibility> {
  return callInternal(
    config,
    env,
    `/internal/payout/eligibility/${tradingAccountUuid}`,
    { method: "GET" }
  ) as Promise<PayoutEligibility>;
}

/**
 * Creates a payout request on an account on behalf of the support operator.
 *
 * This goes through the manager rather than writing the row directly: the
 * manager is what refuses a second pending request on the same account, refuses
 * a non-funded account, fixes the profit split from the account type and snaps
 * the balance and profit off the account's last history. Writing the row here
 * would mean owning a second copy of all four.
 *
 * No email is sent — the trader must not be told about a request he did not
 * make. The payout_requested tracking event is emitted, so the simulation
 * exercises the real flow.
 */
export async function simulatePayout(
  config: Config,
  env: Environment,
  input: SimulatePayoutInput
): Promise<SimulatedPayout> {
  return callInternal(config, env, "/internal/payout/request", {
    method: "POST",
    body: JSON.stringify(input),
  }) as Promise<SimulatedPayout>;
}

async function callInternal(
  config: Config,
  env: Environment,
  path: string,
  init: { method: string; body?: string }
): Promise<unknown> {
  const tunnel = await openManagerTunnel(config, env);

  try {
    const response = await fetch(`http://127.0.0.1:${tunnel.localPort}${path}`, {
      method: init.method,
      headers: { "Content-Type": "application/json" },
      body: init.body,
      signal: AbortSignal.timeout(30_000),
    });

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      // 404 means this manager predates the /internal routes — the one case an
      // operator can act on, so it gets its own message.
      if (response.status === 404) {
        throw new Error(
          "le manager ne repond pas sur /internal (version trop ancienne, deploiement requis)"
        );
      }
      throw new Error(readError(payload) ?? `le manager a repondu ${response.status}`);
    }

    return payload;
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
