import type { DbChallenge, DbChallengeRule, DbTradeHistory, DbTradingAccount, DbOption } from "../types.js";
import { formatCurrency, formatDate } from "./format.js";
import { extendedDrawdownPoints, isExtendedDrawdownActive } from "./extended-drawdown.js";

// Challenge types on which the watcher applies a trailing floor instead of the
// fixed daily one (accounts started after the trailing cutoff). For those the
// daily verdict below does not apply.
const TRAILING_TYPES: ReadonlySet<string> = new Set(["unlimited", "funded_unlimited"]);

export interface DailyDrawdownVerdict {
  firstEquity: number;
  firstEquityAt: Date;
  lastEquity: number;
  lastEquityAt: Date;
  effectivePercent: number;
  allowedAmount: number;
  floor: number;
  // Positive when the floor was crossed (loss >= allowed amount, watcher rule
  // is inclusive), negative when the account was still above it.
  margin: number;
  breached: boolean;
}

// computeDailyDrawdownVerdict replays the watcher's fixed daily drawdown rule
// on the entries of the deactivation day: first equity of the UTC day minus
// initialDeposit x (rule % + Extended Drawdown points) gives the floor; the
// last recorded equity is compared to it.
//
// Returns null when the rule does not apply (no daily rule, trailing type, or
// no entry that day), so callers can stay silent instead of showing a verdict
// that the watcher never computed.
export function computeDailyDrawdownVerdict(
  challenge: Pick<DbChallenge, "type" | "initial_coins_amount"> | null,
  rules: Pick<DbChallengeRule, "max_daily_drawdown_percent"> | null,
  account: Pick<DbTradingAccount, "drawdown_reset_at">,
  options: Pick<DbOption, "name">[],
  dayHistory: Pick<DbTradeHistory, "pull_date" | "equity">[]
): DailyDrawdownVerdict | null {
  if (!challenge || !rules || rules.max_daily_drawdown_percent == null) return null;
  if (TRAILING_TYPES.has(challenge.type)) return null;
  if (dayHistory.length === 0) return null;

  const sorted = [...dayHistory].sort(
    (a, b) => new Date(a.pull_date).getTime() - new Date(b.pull_date).getTime()
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const points = extendedDrawdownPoints(options);
  const extension = isExtendedDrawdownActive(points, account.drawdown_reset_at) ? points / 100 : 0;
  const effectivePercent = Number(rules.max_daily_drawdown_percent) + extension;

  const initialDeposit = Number(challenge.initial_coins_amount);
  const firstEquity = Number(first.equity);
  const lastEquity = Number(last.equity);
  const allowedAmount = initialDeposit * effectivePercent;
  const floor = firstEquity - allowedAmount;
  const margin = floor - lastEquity;

  return {
    firstEquity,
    firstEquityAt: new Date(first.pull_date),
    lastEquity,
    lastEquityAt: new Date(last.pull_date),
    effectivePercent,
    allowedAmount,
    floor,
    margin,
    breached: margin >= 0,
  };
}

// describeDailyDrawdownVerdict renders the verdict on two lines, e.g.
//   1ere equity 52885.50 EUR a 2026-08-25 00:01:33 UTC - 2500.00 EUR (5.00%) = plancher 50385.50 EUR
//   equity finale 50305.37 EUR a 2026-08-25 13:56:26 UTC -> plancher franchi de 80.13 EUR
export function describeDailyDrawdownVerdict(v: DailyDrawdownVerdict): { computation: string; verdict: string } {
  const pct = `${(v.effectivePercent * 100).toFixed(2)}%`;
  const computation =
    `1ere equity ${formatCurrency(v.firstEquity)} a ${formatDate(v.firstEquityAt)}` +
    ` - ${formatCurrency(v.allowedAmount)} (${pct}) = plancher ${formatCurrency(v.floor)}`;
  const verdict = v.breached
    ? `equity finale ${formatCurrency(v.lastEquity)} a ${formatDate(v.lastEquityAt)}` +
      ` -> plancher franchi de ${formatCurrency(v.margin)} (desactivation DDJ justifiee)`
    : `equity finale ${formatCurrency(v.lastEquity)} a ${formatDate(v.lastEquityAt)}` +
      ` -> ${formatCurrency(-v.margin)} au-dessus du plancher (pas de franchissement DDJ sur cette journee)`;
  return { computation, verdict };
}
