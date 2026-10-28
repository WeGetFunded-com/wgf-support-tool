import type { Config, Environment } from "./config.js";
import { openModelCommandTunnel } from "./tunnel.js";

export type BoxType = "classic" | "premium" | "challenge";

export interface BoxGrant {
  userUuid: string;
  boxType: BoxType;
  quantity: number;
  origin: "support" | "marketing";
  /** Box i takes origin_ref "<originRef>#i": a replayed grant gives nothing more. */
  originRef: string;
  reason: string;
  author: string;
}

export interface GrantedBox {
  box_uuid: string;
  box_type: string;
  status: string;
}

export interface BoxGrantResult {
  boxes: GrantedBox[];
  created: number;
}

/** A refusal by the Mystery Box service: code is box_already_opened, box_revoked, unknown_user... */
export class BoxRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function post<T>(port: number, path: string, body: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
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
        throw new BoxRefusedError(error, typeof message === "string" ? message : error);
      }
    }
    throw new Error(`model-command a repondu ${response.status}`);
  }
  return payload as T;
}

/**
 * Gives boxes through model-command, which keeps each box once per origin_ref. One tunnel for every grant: onResult
 * reports each trader as soon as it is done, a refusal never stops the others.
 */
export async function grantBoxes(
  config: Config,
  env: Environment,
  grants: BoxGrant[],
  onResult: (grant: BoxGrant, result: BoxGrantResult | Error) => Promise<void>
): Promise<void> {
  const tunnel = await openModelCommandTunnel(config, env);
  try {
    for (const grant of grants) {
      let result: BoxGrantResult | Error;
      try {
        result = await post<BoxGrantResult>(tunnel.localPort, "/boxes/grant", {
          user_uuid: grant.userUuid,
          box_type: grant.boxType,
          quantity: grant.quantity,
          origin: grant.origin,
          origin_ref: grant.originRef,
          reason: grant.reason,
          author: grant.author,
        });
      } catch (err) {
        result = err instanceof Error ? err : new Error(String(err));
      }
      await onResult(grant, result);
    }
  } finally {
    tunnel.close();
  }
}

/** Takes back an unopened box; model-command refuses an opened or already revoked one. */
export async function revokeBox(
  config: Config,
  env: Environment,
  boxUuid: string,
  reason: string,
  author: string
): Promise<GrantedBox> {
  const tunnel = await openModelCommandTunnel(config, env);
  try {
    return await post<GrantedBox>(tunnel.localPort, `/boxes/${boxUuid}/revoke`, { reason, author });
  } finally {
    tunnel.close();
  }
}
