import type { Config, Environment } from "./config.js";
import { openModelCommandTunnel } from "./tunnel.js";

export interface IssuedCertificate {
  certificate_uuid: string;
  public_id: string;
  status: string;
}

export interface CertificateIssueResult {
  certificate: IssuedCertificate | null;
  total?: { amount_cents: number | null } | null;
  created: boolean;
  total_created: boolean;
  /** free_trial, contest, instant_funded or payout_not_paid: the source gets no certificate. */
  ineligible?: string;
}

/** A refusal by the certificate service: code is certificate_not_found, invalid_request... */
export class CertificateRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Revokes and issues certificates through model-command, which locks the trader, keeps one certificate per source and
 * brings the payout total up to date. Never write the certificate table directly.
 */
async function post<T>(config: Config, env: Environment, path: string, body: unknown): Promise<T> {
  const tunnel = await openModelCommandTunnel(config, env);
  try {
    const response = await fetch(`http://127.0.0.1:${tunnel.localPort}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (payload && typeof payload === "object" && "error" in payload) {
        const { error, message } = payload as { error: unknown; message?: unknown };
        if (typeof error === "string") {
          throw new CertificateRefusedError(error, typeof message === "string" ? message : error);
        }
      }
      throw new Error(`model-command a repondu ${response.status}`);
    }
    return payload as T;
  } finally {
    tunnel.close();
  }
}

export function revokeCertificate(
  config: Config,
  env: Environment,
  certificateUuid: string,
  reason: string,
  author: string
): Promise<IssuedCertificate> {
  return post(config, env, `/certificates/${certificateUuid}/revoke`, { reason, author });
}

export function issueFundedCertificate(
  config: Config,
  env: Environment,
  tradingAccountUuid: string
): Promise<CertificateIssueResult> {
  return post(config, env, "/certificates/funded", { trading_account_uuid: tradingAccountUuid });
}

export function issuePayoutCertificate(
  config: Config,
  env: Environment,
  payoutRequestUuid: string
): Promise<CertificateIssueResult> {
  return post(config, env, "/certificates/payout", { payout_request_uuid: payoutRequestUuid });
}
