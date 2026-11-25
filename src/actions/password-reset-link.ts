import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { searchUserPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { openAuthTunnel } from "../tunnel.js";

interface ResetLinkResponse {
  reset_url: string;
  expires_at: number;
}

/**
 * Gets from auth the reset link of the "forgot password" email, for a client
 * who doesn't receive it. The link only goes through the HTTP response: never
 * written in the audit nor in a pod log.
 */
export async function passwordResetLink(
  session: DatabaseSession,
  config: Config
): Promise<void> {
  const { connection: conn, env, operator } = session;

  ui.sectionHeader("Lien de reinitialisation du mot de passe");
  const user = await searchUserPrompt(conn);
  if (!user) return;

  renderKeyValue({
    "Utilisateur": `${user.firstname ?? ""} ${user.lastname ?? ""}`.trim() || "(sans nom)",
    "Email": user.email,
    "Langue": user.language ?? "N/A",
  });

  ui.warn("Le lien donne acces au compte : ne l'envoyer que dans la conversation ouverte depuis cette adresse email.");

  const confirmed = await confirmProductionAction(env, `Generer un lien de reinitialisation pour ${user.email}`);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  const tunnel = await openAuthTunnel(config, env);
  let link: ResetLinkResponse;
  try {
    const response = await fetch(
      `http://127.0.0.1:${tunnel.localPort}/account/support/${user.user_uuid}/password/reset-link`,
      { method: "POST", signal: AbortSignal.timeout(30_000) }
    );
    if (!response.ok) {
      ui.error(`Le service auth a refuse la demande (HTTP ${response.status}).`);
      return;
    }
    link = (await response.json()) as ResetLinkResponse;
  } finally {
    tunnel.close();
  }

  const expiresAt = new Date(link.expires_at * 1000);
  ui.success("Lien genere. A copier et envoyer au client :");
  console.log("");
  console.log(link.reset_url);
  console.log("");
  ui.info(`Valable jusqu'au ${expiresAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} (heure de Paris).`);

  await auditLogQ.insertAuditLog(conn, "PASSWORD_RESET_LINK", "user", user.user_uuid, {
    email: user.email,
    expires_at: expiresAt.toISOString(),
  }, operator, env);
}
