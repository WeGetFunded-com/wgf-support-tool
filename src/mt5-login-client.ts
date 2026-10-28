import type { Config, Environment } from "./config.js";
import { callInternal } from "./payout-simulation-client.js";

/** Mirrors structs.MT5LoginStatus in the manager. Dates are MT5 server time. */
export interface MT5LoginStatus {
  login: number;
  login_enabled: boolean;
  trader_can_change_password: boolean;
  registered_at: string;
  password_changed_at: string;
  last_access_at: string;
  dashboard_password_valid: boolean;
  dashboard_password_check: string;
}

export interface MT5PasswordReset {
  login: number;
  password: string;
}

/** MT5 only answers the cluster: these calls go through the manager's internal routes. */
export async function getMT5LoginStatus(
  config: Config,
  env: Environment,
  tradingAccountUuid: string
): Promise<MT5LoginStatus> {
  return callInternal(config, env, `/internal/mt5/accounts/${tradingAccountUuid}`, {
    method: "GET",
  }) as Promise<MT5LoginStatus>;
}

export async function enableMT5Login(
  config: Config,
  env: Environment,
  tradingAccountUuid: string
): Promise<MT5LoginStatus> {
  return callInternal(config, env, `/internal/mt5/accounts/${tradingAccountUuid}/enable-login`, {
    method: "POST",
  }) as Promise<MT5LoginStatus>;
}

/** Sets a new MT5 main password; the caller must save it on the broker account. */
export async function resetMT5Password(
  config: Config,
  env: Environment,
  tradingAccountUuid: string
): Promise<MT5PasswordReset> {
  return callInternal(config, env, `/internal/mt5/accounts/${tradingAccountUuid}/reset-password`, {
    method: "POST",
  }) as Promise<MT5PasswordReset>;
}
