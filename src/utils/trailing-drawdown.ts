import type { DbChallenge, DbChallengeRule, DbTradeHistory, DbTradingAccount, DbOption } from "../types.js";
import { formatCurrency, formatDate } from "./format.js";
import { extendedDrawdownPoints, isExtendedDrawdownActive } from "./extended-drawdown.js";

// Challenge types on which the watcher can apply a trailing floor instead of
// the fixed daily one.
const TRAILING_TYPES: ReadonlySet<string> = new Set(["unlimited", "funded_unlimited"]);

// Mirror of TRAILING_DRAWDOWN_CUTOFF in the watcher
// (trading-account-watcher/internal/controller/watch_controller.go). Accounts
// whose phase started strictly after it are on the trailing rule; the ones
// started before keep the fixed daily drawdown.
export const TRAILING_DRAWDOWN_CUTOFF = new Date("2026-02-18T00:00:00.000Z");

// isTrailingDrawdownAccount replays the watcher's isTrailingDrawdownAccount:
// the type alone is not enough, the phase must also have started after the
// cutoff. An `unlimited` opened before it is still on the fixed daily rule.
export function isTrailingDrawdownAccount(
  challenge: Pick<DbChallenge, "type"> | null,
  account: Pick<DbTradingAccount, "challenge_phase_begin">
): boolean {
  if (!challenge || !TRAILING_TYPES.has(challenge.type)) return false;
  return new Date(account.challenge_phase_begin) > TRAILING_DRAWDOWN_CUTOFF;
}

export interface TrailingDrawdownVerdict {
  hwm: number;
  hwmAt: Date | null;
  effectivePercent: number;
  allowedAmount: number;
  floor: number;
  // Locked at the initial deposit once a payout reset the drawdown.
  lockedByPayout: boolean;
  lastEquity: number;
  lastEquityAt: Date;
  // Positive when the floor was crossed (trailing rule is strict: equity < floor),
  // negative when the account was still above it.
  margin: number;
  breached: boolean;
}

// computeTrailingDrawdownVerdict replays the watcher's trailing drawdown on the
// EOD history: floor = min(HWM - deposit x (rule % + Extended Drawdown points),
// deposit), monotone increasing, computed on completed days only. The last
// equity of the deactivation day is then compared to it.
//
// Returns null when the account is not on the trailing rule or when there is no
// entry on the deactivation day, so callers stay silent rather than show a
// verdict the watcher never computed.
export function computeTrailingDrawdownVerdict(
  challenge: Pick<DbChallenge, "type" | "initial_coins_amount"> | null,
  rules: Pick<DbChallengeRule, "max_daily_drawdown_percent"> | null,
  account: Pick<DbTradingAccount, "challenge_phase_begin" | "drawdown_reset_at">,
  options: Pick<DbOption, "name">[],
  eodHistory: Pick<DbTradeHistory, "pull_date" | "equity">[],
  dayHistory: Pick<DbTradeHistory, "pull_date" | "equity">[]
): TrailingDrawdownVerdict | null {
  if (!challenge || !rules || rules.max_daily_drawdown_percent == null) return null;
  if (!isTrailingDrawdownAccount(challenge, account)) return null;
  if (dayHistory.length === 0) return null;

  const sortedDay = [...dayHistory].sort(
    (a, b) => new Date(a.pull_date).getTime() - new Date(b.pull_date).getTime()
  );
  const last = sortedDay[sortedDay.length - 1];
  const deactivationDay = utcDay(last.pull_date);

  const points = extendedDrawdownPoints(options);
  const extension = isExtendedDrawdownActive(points, account.drawdown_reset_at) ? points / 100 : 0;
  const effectivePercent = Number(rules.max_daily_drawdown_percent) + extension;

  const initialDeposit = Number(challenge.initial_coins_amount);
  const allowedAmount = initialDeposit * effectivePercent;
  const resetAt = account.drawdown_reset_at ? new Date(account.drawdown_reset_at) : null;
  const lockedByPayout = resetAt != null;

  let hwm = initialDeposit;
  let hwmAt: Date | null = null;
  // Post-payout the floor is locked at the initial capital: no buffer below it.
  let floor = lockedByPayout ? initialDeposit : initialDeposit - allowedAmount;

  const sortedEod = [...eodHistory].sort(
    (a, b) => new Date(a.pull_date).getTime() - new Date(b.pull_date).getTime()
  );
  for (const record of sortedEod) {
    // EOD is only valid for completed days: the deactivation day itself (and
    // anything after it) never feeds the floor that was enforced that day.
    if (utcDay(record.pull_date) >= deactivationDay) continue;
    // Records prior to the last payout are rebased away.
    if (resetAt && new Date(record.pull_date) < resetAt) continue;

    if (Number(record.equity) > hwm) {
      hwm = Number(record.equity);
      hwmAt = new Date(record.pull_date);
    }
    const newFloor = Math.min(hwm - allowedAmount, initialDeposit);
    if (newFloor > floor) floor = newFloor;
  }

  const lastEquity = Number(last.equity);

  return {
    hwm,
    hwmAt,
    effectivePercent,
    allowedAmount,
    floor,
    lockedByPayout,
    lastEquity,
    lastEquityAt: new Date(last.pull_date),
    margin: floor - lastEquity,
    breached: lastEquity < floor,
  };
}

function utcDay(date: Date | string): string {
  return new Date(date).toISOString().slice(0, 10);
}

// describeTrailingDrawdownVerdict renders the verdict on three lines, e.g.
//   HWM 102340.52 EUR a la cloture du 2026-09-08 23:56:50 UTC
//   plancher = 102340.52 EUR - 4000.00 EUR (4.00%) = 98340.52 EUR
//   equity finale 98318.72 EUR a 2026-09-09 00:34:16 UTC -> plancher franchi de 21.80 EUR
export function describeTrailingDrawdownVerdict(v: TrailingDrawdownVerdict): {
  hwmLine: string;
  computation: string;
  verdict: string;
} {
  const pct = `${(v.effectivePercent * 100).toFixed(2)}%`;
  const hwmLine = v.hwmAt
    ? `HWM ${formatCurrency(v.hwm)} a la cloture du ${formatDate(v.hwmAt)}`
    : `HWM ${formatCurrency(v.hwm)} (depot initial : aucune cloture anterieure superieure)`;
  const computation = v.lockedByPayout
    ? `plancher verrouille au capital initial depuis le payout = ${formatCurrency(v.floor)}`
    : `plancher = ${formatCurrency(v.hwm)} - ${formatCurrency(v.allowedAmount)} (${pct}) = ${formatCurrency(v.floor)}`;
  const verdict = v.breached
    ? `equity finale ${formatCurrency(v.lastEquity)} a ${formatDate(v.lastEquityAt)}` +
      ` -> plancher franchi de ${formatCurrency(v.margin)} (desactivation justifiee)`
    : `equity finale ${formatCurrency(v.lastEquity)} a ${formatDate(v.lastEquityAt)}` +
      ` -> ${formatCurrency(-v.margin)} au-dessus du plancher (pas de franchissement trailing sur cette journee)`;
  return { hwmLine, computation, verdict };
}
