import type { Config, Environment } from "./config.js";
import { openModelCommandTunnel } from "./tunnel.js";

export type PayoutDecision = "approved" | "rejected";

/**
 * Approves or rejects a payout request through model-command, the write side
 * that owns the status flip.
 *
 * Writing `UPDATE payout_request` directly from here used to bypass the
 * tracking emitters living in model-command: payout_approved / payout_rejected
 * were never emitted live and only existed through the reconciliation cron.
 *
 * `validated_at` is the payout reset anchor and is stamped once by the
 * service (COALESCE): sending "now" on approval never moves an existing anchor.
 * `rejection_reason` is not persisted by the model (no column) — it only rides
 * the tracking event; the caller keeps it in admin_audit_log.
 */
export async function decidePayout(
  config: Config,
  env: Environment,
  payoutRequestUuid: string,
  status: PayoutDecision,
  rejectionReason?: string
): Promise<void> {
  const tunnel = await openModelCommandTunnel(config, env);

  try {
    const response = await fetch(
      `http://127.0.0.1:${tunnel.localPort}/payout_request/${payoutRequestUuid}/status`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          validated_at: status === "approved" ? new Date().toISOString() : null,
          rejection_reason: rejectionReason ?? "",
        }),
        signal: AbortSignal.timeout(30_000),
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `model-command a repondu ${response.status}${text ? ` : ${text.slice(0, 200)}` : ""}`
      );
    }
  } finally {
    tunnel.close();
  }
}
