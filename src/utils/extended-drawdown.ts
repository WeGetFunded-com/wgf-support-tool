import type { DbOption } from "../types.js";
import { formatDate, formatPercent } from "./format.js";

const EXTENDED_DRAWDOWN_NAME = /^Extended Drawdown (\d)%$/;

// Points (1 to 3) of the Extended Drawdown option carried by the account, 0 when none.
export function extendedDrawdownPoints(options: Pick<DbOption, "name">[]): number {
  return options.reduce((max, option) => {
    const match = option.name.match(EXTENDED_DRAWDOWN_NAME);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

// The extension applies until the first payout locks the drawdown (drawdown_reset_at set).
export function isExtendedDrawdownActive(points: number, drawdownResetAt: Date | null): boolean {
  return points > 0 && drawdownResetAt == null;
}

// "5.00% + 2% = 7.00% (Extended Drawdown, actif)" or
// "5.00% (Extended Drawdown 2% consomme au payout du 2026-09-01)".
export function describeDailyDrawdown(
  rulePercent: number | string | null | undefined,
  points: number,
  drawdownResetAt: Date | null
): string {
  const base = formatPercent(rulePercent);
  if (points === 0 || rulePercent == null) return base;
  if (isExtendedDrawdownActive(points, drawdownResetAt)) {
    const effective = formatPercent(Number(rulePercent) + points / 100);
    return `${base} + ${points}% = ${effective} (Extended Drawdown, actif)`;
  }
  return `${base} (Extended Drawdown ${points}% consomme au payout du ${formatDate(drawdownResetAt)})`;
}
