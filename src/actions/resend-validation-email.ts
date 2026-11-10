import type { DatabaseSession } from "../db.js";
import type { Config, Environment } from "../config.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { searchUserPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { runJob, getKubeAccess, generateJobName } from "../kube/index.js";
import type { KubeJobSpec } from "../kube/index.js";

function getAuthServiceUrl(env: Environment): string {
  const prefix = env === "staging" ? "staging" : "production";
  return `http://${prefix}-auth.${prefix}.svc`;
}

export async function resendValidationEmail(
  session: DatabaseSession,
  config: Config
): Promise<void> {
  const { connection: conn, env, operator } = session;
  const kubeAccess = getKubeAccess(config);
  const namespace = env === "staging" ? config.staging.namespace : config.production.namespace;

  ui.sectionHeader("Renvoyer le mail de validation");
  const user = await searchUserPrompt(conn);
  if (!user) return;

  renderKeyValue({
    "Utilisateur": `${user.firstname ?? ""} ${user.lastname ?? ""}`.trim() || "(sans nom)",
    "Email": user.email,
    "Langue": user.language ?? "N/A",
    "Email valide": user.valid ? "Oui" : "Non",
  });

  if (user.valid) {
    ui.warn("L'email de cet utilisateur est deja valide, aucun mail a renvoyer.");
    return;
  }

  const confirmed = await confirmProductionAction(env, `Renvoyer le mail de validation a ${user.email}`);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  const authUrl = getAuthServiceUrl(env);
  const spec: KubeJobSpec = {
    name: generateJobName("support-resend-validation"),
    namespace,
    image: "curlimages/curl:8.1.1",
    command: [
      "/bin/sh",
      "-c",
      `RESP=$(curl -s -X POST -w '\\nHTTP_CODE:%{http_code}' "${authUrl}/account/support/${user.user_uuid}/validation/resend"); echo "$RESP"; echo "$RESP" | grep -q 'HTTP_CODE:2' || exit 1`,
    ],
  };

  ui.sectionHeader("Job K8s — Envoi via auth");
  const result = await runJob(kubeAccess, spec);

  if (result.success) {
    ui.success(`Mail de validation envoye a ${user.email} (${result.durationSeconds}s).`);
  } else {
    ui.error("L'envoi du mail de validation a echoue.");
    if (result.failureReason) ui.warn(`Raison : ${result.failureReason}`);
    if (result.logs?.includes("HTTP_CODE:409")) {
      ui.warn("Le service auth indique que l'email est deja valide.");
    }
    if (result.logs) {
      ui.info("Reponse du service auth :");
      console.log(result.logs);
    }
  }

  await auditLogQ.insertAuditLog(conn, "RESEND_VALIDATION_EMAIL", "user", user.user_uuid, {
    email: user.email,
    job_success: result.success,
  }, operator, env);
}
