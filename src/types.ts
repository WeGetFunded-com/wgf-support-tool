// ──────────────────────────────────────────────
//  Types & interfaces pour toutes les entites DB
// ──────────────────────────────────────────────

// ── Phase constants (du backend Go) ──

export const PHASE = {
  UNLIMITED: 0,
  STANDARD_ONE: 1,
  STANDARD_TWO: 2,
  INSTANT_FUNDED_RULES: 3,
  FUNDED_STANDARD: 4,
  FUNDED_UNLIMITED: 5,
} as const;

export type ChallengeType =
  | "standard"
  | "unlimited"
  | "instant_funded"
  | "funded_standard"
  | "funded_unlimited"
  | "funded";

// ── Reason constants (du backend Go watch_controller.go) ──

export const REASONS = {
  MAX_DAILY_DRAW_DOWN: "MAX_DAILY_DRAW_DOWN",
  MAX_DRAW_DOWN: "MAX_DRAW_DOWN",
  NEWS_VIOLATION: "NEWS_VIOLATION",
  CHALLENGE_EXPIRED: "CHALLENGE_EXPIRED",
  CHALLENGE_REVIEW: "CHALLENGE_REVIEW",
  CHALLENGE_SUCCEED: "CHALLENGE_SUCCEED",
  FUNDED_ACTIVATED: "FUNDED_ACTIVATED",
  PROFIT_TARGET_RECALCULATED: "PROFIT_TARGET_RECALCULATED",
  NO_TRADE_HISTORY_ZOMBIE: "NO_TRADE_HISTORY_ZOMBIE",
  TRADER_NOT_FOUND: "TRADER_NOT_FOUND",
} as const;

// ── DB Entities ──

export interface DbUser {
  user_uuid: string;
  CTID: number;
  email: string;
  firstname: string;
  lastname: string;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  country_id: number | null;
  language: string | null;
  phone_number: string | null;
  birthday: string | null;
  valid: number | null;
  provider_id: string | null;
}

export interface DbChallenge {
  challenge_uuid: string;
  stripe_ID: string | null;
  name: string;
  description: string | null;
  type: ChallengeType;
  price: number;
  initial_coins_amount: number;
  expiration_date: Date | null;
  published: number;
}

export interface DbChallengeRule {
  challenge_uuid: string;
  phase: number;
  max_daily_drawdown_percent: number | null;
  profit_target_percent: number;
  min_trading_days: number;
  phase_duration: string;
  max_total_drawdown_percent: number | null;
}

export interface DbOrder {
  order_uuid: string;
  challenge_uuid: string;
  user_uuid: string;
  payment_uuid: string | null;
  order_challenge_configuration: string | null;
  joker: number | null;
  promo_uuid: string | null;
  affiliation_code_uuid: string | null;
}

export interface DbPayment {
  payment_uuid: string;
  proof: string;
  payment_date: Date;
  method: string;
  price: number;
  currency: string;
}

export interface DbTradingAccount {
  trading_account_uuid: string;
  order_uuid: string;
  challenge_uuid: string;
  ctrader_trading_account: number;
  ctrader_server: "demo" | "live";
  challenge_phase: number;
  challenge_phase_begin: Date;
  challenge_phase_end: Date;
  current_profit_target_percent: number;
  success: number | null;
  number_of_won_trades: number;
  number_of_lost_trades: number;
  win_sum: number;
  loss_sum: number;
  max_trading_day: number;
  latest_update: Date;
  reason: string;
  promo_uuid: string | null;
}

export interface DbTradingAccountBalance {
  trading_account_uuid: string;
  balance: number;
  equity: number;
  last_update: Date;
}

export interface DbTradeHistory {
  trade_history_uuid: string;
  trading_account_uuid: string;
  pull_date: Date;
  balance: number;
  equity: number;
  number_of_trade_open: number;
  number_of_trade_closed: number;
  pnl: number;
  volume: number;
}

export interface DbPosition {
  position_id: number;
  trading_account_uuid: string;
  symbol: string;
  direction: string;
  entry_price: number;
  close_price: number | null;
  volume: number;
  commission: number;
  swap: number;
  pnl: number | null;
  open_timestamp: Date;
  close_timestamp: Date | null;
  spread_betting: number;
  invalid: number;
  created_at: Date;
}

export interface DbPayoutRequest {
  payout_request_uuid: string;
  user_uuid: string;
  trading_account_uuid: string;
  payout_method: "iban" | "crypto";
  iban: string | null;
  wallet_address: string | null;
  wallet_protocol: "ERC20" | "TRC20" | null;
  first_name: string | null;
  last_name: string | null;
  postal_address: string | null;
  balance_before_request: number;
  total_profit: number;
  payout_amount: number;
  profit_split: string;
  status: "pending" | "approved" | "paid" | "rejected";
  created_at: Date;
  updated_at: Date;
}

export interface DbPromo {
  promo_uuid: string;
  user_uuid: string | null;
  challenge_uuid: string | null;
  phase: number;
  code: string;
  percent_promo: number;
  expires_at: Date | null;
  is_valid: number;
  stripe_ID: string | null;
  is_unlimited: number;
  global: number | null;
  descriptionFr: string | null;
  descriptionEn: string | null;
  descriptionEs: string | null;
  descriptionDe: string | null;
  descriptionIt: string | null;
}

export interface DbOption {
  option_uuid: string;
  name: string;
  majoration_percent: number;
}

export interface DbFundedActivation {
  activation_uuid: string;
  user_uuid: string;
  trading_account_uuid: string;
  original_order_uuid: string;
  funded_challenge_uuid: string;
  amount: number;
  currency: string;
  geidea_invoice_id: string | null;
  payment_link: string | null;
  status: string;
  created_at: Date;
  paid_at: Date | null;
  expires_at: Date;
}

export interface DbAuditLog {
  id: number;
  action_type: string;
  target_table: string;
  target_uuid: string | null;
  details: string | null;
  operator: string;
  environment: string;
  executed_at: Date;
}

// ── Phase transition map ──

export interface PhaseTransition {
  nextPhase: number;
  nextServer: "demo" | "live";
}

export const PHASE_TRANSITIONS: Record<string, Record<number, PhaseTransition>> = {
  standard: {
    [PHASE.STANDARD_ONE]: { nextPhase: PHASE.STANDARD_TWO, nextServer: "demo" },
    [PHASE.STANDARD_TWO]: { nextPhase: PHASE.FUNDED_STANDARD, nextServer: "live" },
  },
  unlimited: {
    [PHASE.UNLIMITED]: { nextPhase: PHASE.FUNDED_UNLIMITED, nextServer: "live" },
  },
};

// ── Challenge type → initial phase map ──

export const INITIAL_PHASE: Record<string, number> = {
  standard: PHASE.STANDARD_ONE,
  unlimited: PHASE.UNLIMITED,
  instant_funded: PHASE.UNLIMITED,
};

// ── Deactivation reasons (from Go backend) ──

export const DEACTIVATION_REASONS = [
  { value: REASONS.MAX_DAILY_DRAW_DOWN, label: "Drawdown journalier depasse" },
  { value: REASONS.MAX_DRAW_DOWN, label: "Drawdown total depasse" },
  { value: REASONS.NEWS_VIOLATION, label: "Violation regle news trading" },
  { value: REASONS.CHALLENGE_EXPIRED, label: "Challenge expire" },
  { value: REASONS.CHALLENGE_REVIEW, label: "Mis en revue par le support" },
  { value: REASONS.NO_TRADE_HISTORY_ZOMBIE, label: "Compte zombie sans historique" },
  { value: REASONS.TRADER_NOT_FOUND, label: "Trader non trouve sur cTrader" },
] as const;
