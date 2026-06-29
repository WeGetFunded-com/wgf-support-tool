import { spawn } from "node:child_process";
import type { KubeAccess } from "./types.js";
import type { Environment } from "../config.js";

function kubectlBaseArgs(access: KubeAccess): string[] {
  return [
    `--server=${access.kubeServer}`,
    `--token=${access.kubeToken}`,
    "--insecure-skip-tls-verify",
  ];
}

function kubectlExec(
  access: KubeAccess,
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("kubectl", [...kubectlBaseArgs(access), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) =>
      resolve({ stdout, stderr, code: code ?? 1 })
    );
  });
}

const TAM_DEPLOYMENT: Record<Environment, string> = {
  production: "production-trading-account-manager",
  staging: "staging-trading-account-manager",
};

const MAIL_ERROR_PATTERNS =
  /can't send mail|SendNew[A-Za-z]*Mail|failed to send email|smtp\/email/i;

const BREVO_400_PATTERN = /400 Bad Request/i;

export type TamErrorContext = {
  logLine: string;
  rawError: string;
  classification: "brevo_mail" | "tam_other";
};

/**
 * Pull recent TAM pod logs and locate the structured zap ERROR for this
 * order_uuid. The TAM router collapses all controller failures into a flat
 * "Bad Request" HTTP body, so the only place the *actual* failure cause
 * (Brevo, model-command, MT5, …) lives is in the pod logs. Surfacing it back
 * to the operator avoids blind rollbacks and manual log archeology.
 */
export async function fetchTamErrorContext(
  access: KubeAccess,
  env: Environment,
  orderUuid: string,
  sinceSeconds = 600
): Promise<TamErrorContext | null> {
  const deployment = TAM_DEPLOYMENT[env];
  const namespace = env;

  const { stdout, code } = await kubectlExec(access, [
    "logs",
    `deployment/${deployment}`,
    "-n",
    namespace,
    `--since=${sinceSeconds}s`,
    "--tail=5000",
  ]);
  if (code !== 0) return null;

  const lines = stdout.split("\n").filter((l) => l.includes(orderUuid));
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    let parsed: { level?: string; error?: string; msg?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.level !== "ERROR") continue;
    const rawError = String(parsed.error ?? parsed.msg ?? "");
    const classification: TamErrorContext["classification"] =
      MAIL_ERROR_PATTERNS.test(rawError) || BREVO_400_PATTERN.test(rawError)
        ? "brevo_mail"
        : "tam_other";
    return { logLine: line, rawError, classification };
  }
  return null;
}
