import type { Config, Environment } from "../config.js";

/** Kubernetes access credentials extracted from Config */
export interface KubeAccess {
  kubeServer: string;
  kubeToken: string;
}

/** Specification for a one-shot Kubernetes Job */
export interface KubeJobSpec {
  /** Unique job name (DNS-safe, lowercase, max 63 chars) */
  name: string;
  /** Kubernetes namespace */
  namespace: string;
  /** Container image */
  image: string;
  /** Command array e.g. ["/bin/sh", "-c", "curl ..."] */
  command: string[];
  /** Optional env vars */
  env?: Array<{ name: string; value: string }>;
  /** Retry limit, default 0 (no retry) */
  backoffLimit?: number;
  /** Auto-cleanup delay in seconds after completion (default 300) */
  ttlSecondsAfterFinished?: number;
}

/** Result of a completed Kubernetes Job */
export interface KubeJobResult {
  success: boolean;
  /** Pod logs (stdout + stderr) */
  logs: string;
  /** Duration in seconds */
  durationSeconds: number;
  /** Exit/failure reason if failed */
  failureReason?: string;
}

/** Extract KubeAccess from Config */
export function getKubeAccess(config: Config): KubeAccess {
  return {
    kubeServer: config.kubeServer,
    kubeToken: config.kubeToken,
  };
}

/** Generate a DNS-safe job name with timestamp + random suffix */
export function generateJobName(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${ts}-${rand}`.toLowerCase().slice(0, 63);
}
