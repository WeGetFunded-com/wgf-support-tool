import type { DatabaseSession } from "../db.js";
import type { Config, Environment } from "../config.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as btfQ from "../queries/back-to-funded.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as baQ from "../queries/broker-account.queries.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatDate, formatCurrency, formatChallengeName } from "../utils/format.js";
import { runJob, getKubeAccess, generateJobName } from "../kube/index.js";
import type { KubeJobSpec } from "../kube/index.js";

function getOrderServiceUrl(env: Environment): string {
  const prefix = env === "staging" ? "staging" : "production";
  return `http://${prefix}-order.${prefix}.svc`;
}

export async function processBackToFunded(
  session: DatabaseSession,
  config: Config
): Promise<void> {
  const { connection: conn, env, operator } = session;
  const kubeAccess = getKubeAccess(config);
  const namespace = env === "staging" ? config.staging.namespace : config.production.namespace;

  // 1. Search the breached funded account
  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  const accountDisplay = await baQ.getAccountDisplayId(conn, account);

  // 2. Load challenge for display
  const challenge = await challengeQ.getChallengeByUuid(conn, account.challenge_uuid);

  // 3. Find pending back_to_funded offer for this breached account
  const offer = await btfQ.getPendingBackToFundedByAccount(
    conn,
    account.trading_account_uuid
  );

  if (!offer) {
    ui.warn("Aucune offre back_to_funded en statut 'pending' trouvee pour ce compte.");
    ui.info(
      "Une offre est creee automatiquement par le watcher lorsqu'un compte " +
      "funded est crame. Verifiez que le compte a bien breach."
    );
    return;
  }

  // 4. Display details
  ui.sectionHeader("Traitement d'une offre Back to Funded");

  renderKeyValue({
    "Compte crame": accountDisplay.label,
    "UUID du compte": account.trading_account_uuid,
    "Challenge": challenge
      ? `${formatChallengeName(challenge.name)} (${challenge.type})`
      : "N/A",
    "Offer UUID": offer.offer_uuid,
    "Prix catalogue de base": formatCurrency(offer.base_challenge_price, offer.currency),
    "Montant": formatCurrency(offer.amount, offer.currency),
    "Statut": offer.status,
    "Creee le": formatDate(offer.created_at),
    "Expire le": formatDate(offer.expires_at),
  });

  if (offer.payment_link) {
    ui.info(`Lien de paiement : ${offer.payment_link}`);
  }

  // 5. Confirm
  const description =
    `Traitement Back to Funded (bypass paiement) : ${formatCurrency(offer.amount, offer.currency)} ` +
    `pour le compte ${accountDisplay.label}`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  // 6. K8s Job : call order service internal endpoint.
  //    This triggers the full ProcessBackToFunded flow:
  //    create funded order → add payment → create TA via TAM → mark offer paid → deactivate breached account
  const orderUrl = getOrderServiceUrl(env);
  const processSpec: KubeJobSpec = {
    name: generateJobName("support-process-back-to-funded"),
    namespace,
    image: "curlimages/curl:8.1.1",
    command: [
      "/bin/sh",
      "-c",
      `RESP=$(curl -s -X POST -w '\\nHTTP_CODE:%{http_code}' "${orderUrl}/internal/back-to-funded/${offer.offer_uuid}/process"); echo "$RESP"; echo "$RESP" | grep -q 'HTTP_CODE:2' || exit 1`,
    ],
  };

  ui.sectionHeader("Job K8s — Traitement Back to Funded (order + TAM)");
  const result = await runJob(kubeAccess, processSpec);

  if (!result.success) {
    ui.error("Le Job de traitement de l'offre a echoue.");
    if (result.failureReason) ui.warn(`Raison : ${result.failureReason}`);
    if (result.logs) {
      ui.info("Logs :");
      console.log(result.logs);
    }
    ui.warn("Verifiez manuellement l'etat de l'offre.");
  } else {
    ui.success(`Offre traitee avec succes (${result.durationSeconds}s).`);
    if (result.logs) {
      ui.info("Reponse du service order :");
      console.log(result.logs);
    }
  }

  // 7. Audit log
  await auditLogQ.insertAuditLog(conn, "PROCESS_BACK_TO_FUNDED", "back_to_funded", offer.offer_uuid, {
    breached_account_uuid: account.trading_account_uuid,
    broker_name: accountDisplay.brokerName,
    account_login: accountDisplay.login,
    amount: offer.amount,
    currency: offer.currency,
    process_job_success: result.success,
  }, operator, env);

  // 8. Recap
  console.log("");
  ui.sectionHeader("Recap");

  renderKeyValue({
    "Resultat": result.success
      ? "Offre traitee + nouveau compte funded cree (via order + TAM)"
      : "Traitement echoue — verifier manuellement",
    "Offer UUID": offer.offer_uuid,
    "Montant": formatCurrency(offer.amount, offer.currency),
    "Compte crame": accountDisplay.label,
  });

  ui.success("Action terminee.");
}
