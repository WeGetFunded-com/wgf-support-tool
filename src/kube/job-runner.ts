import { spawn } from "node:child_process";
import type { KubeAccess, KubeJobSpec, KubeJobResult } from "./types.js";
import * as ui from "../ui.js";

// ── kubectl helpers ──

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
    const fullArgs = [...kubectlBaseArgs(access), ...args];
    const child = spawn("kubectl", fullArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "kubectl n'est pas installe. Demandez a votre administrateur de l'installer."
          )
        );
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

// ── Manifest generation ──

export function generateJobManifest(spec: KubeJobSpec): string {
  const envSection =
    spec.env && spec.env.length > 0
      ? `
              env:
${spec.env.map((e) => `                - name: ${e.name}\n                  value: "${e.value}"`).join("\n")}`
      : "";

  return `apiVersion: batch/v1
kind: Job
metadata:
  name: ${spec.name}
  namespace: ${spec.namespace}
spec:
  backoffLimit: ${spec.backoffLimit ?? 0}
  ttlSecondsAfterFinished: ${spec.ttlSecondsAfterFinished ?? 300}
  template:
    spec:
      containers:
        - name: ${spec.name}
          image: ${spec.image}
          imagePullPolicy: IfNotPresent
          command:
${spec.command.map((c) => `            - ${JSON.stringify(c)}`).join("\n")}${envSection}
      restartPolicy: Never
`;
}

// ── Job lifecycle ──

export async function applyJob(
  access: KubeAccess,
  spec: KubeJobSpec
): Promise<void> {
  const manifest = generateJobManifest(spec);

  const result = await new Promise<{ stdout: string; stderr: string; code: number }>(
    (resolve, reject) => {
      const fullArgs = [
        ...kubectlBaseArgs(access),
        "apply",
        "-f",
        "-",
        "-n",
        spec.namespace,
      ];
      const child = spawn("kubectl", fullArgs, {
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
      child.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new Error("kubectl n'est pas installe.")
          );
        } else {
          reject(err);
        }
      });
      child.on("close", (code) => {
        resolve({ stdout, stderr, code: code ?? 1 });
      });

      child.stdin.write(manifest);
      child.stdin.end();
    }
  );

  if (result.code !== 0) {
    throw new Error(
      `kubectl apply a echoue (code ${result.code}): ${result.stderr.trim()}`
    );
  }
}

export async function waitForCompletion(
  access: KubeAccess,
  namespace: string,
  jobName: string,
  timeoutMs = 120_000
): Promise<{ succeeded: boolean; failureReason?: string }> {
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 3000;

  while (Date.now() < deadline) {
    const { stdout, code } = await kubectlExec(access, [
      "get",
      "job",
      jobName,
      "-n",
      namespace,
      "-o",
      "jsonpath={.status.conditions[*].type} {.status.conditions[*].status}",
    ]);

    if (code === 0 && stdout.trim()) {
      const parts = stdout.trim().split(" ");
      const mid = Math.floor(parts.length / 2);
      const types = parts.slice(0, mid);
      const statuses = parts.slice(mid);

      for (let i = 0; i < types.length; i++) {
        if (types[i] === "Complete" && statuses[i] === "True") {
          return { succeeded: true };
        }
        if (types[i] === "Failed" && statuses[i] === "True") {
          return { succeeded: false, failureReason: "Job pod a echoue" };
        }
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return { succeeded: false, failureReason: `Timeout apres ${timeoutMs / 1000}s` };
}

export async function getJobLogs(
  access: KubeAccess,
  namespace: string,
  jobName: string
): Promise<string> {
  const { stdout, stderr, code } = await kubectlExec(access, [
    "logs",
    `job/${jobName}`,
    "-n",
    namespace,
    "--tail=200",
  ]);

  if (code !== 0) {
    return `(Impossible de recuperer les logs: ${stderr.trim()})`;
  }
  return stdout;
}

export async function deleteJob(
  access: KubeAccess,
  namespace: string,
  jobName: string
): Promise<void> {
  await kubectlExec(access, [
    "delete",
    "job",
    jobName,
    "-n",
    namespace,
    "--ignore-not-found",
  ]);
}

// ── High-level runner ──

export async function runJob(
  access: KubeAccess,
  spec: KubeJobSpec
): Promise<KubeJobResult> {
  const startTime = Date.now();

  ui.info(`Creation du Job K8s "${spec.name}"...`);
  await applyJob(access, spec);
  ui.success(`Job cree dans le namespace "${spec.namespace}".`);

  ui.info("En attente de completion...");
  const completion = await waitForCompletion(access, spec.namespace, spec.name);

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  ui.info("Recuperation des logs...");
  const logs = await getJobLogs(access, spec.namespace, spec.name);

  ui.info("Nettoyage du Job...");
  await deleteJob(access, spec.namespace, spec.name);

  if (completion.succeeded) {
    return { success: true, logs, durationSeconds };
  }

  return {
    success: false,
    logs,
    durationSeconds,
    failureReason: completion.failureReason,
  };
}
