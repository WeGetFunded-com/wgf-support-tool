import type { DatabaseSession } from "../db.js";
import type { Config, Environment } from "../config.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as faQ from "../queries/funded-activation.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
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

export async function bypassActivationFees(
  session: DatabaseSession,
  config: Config
): Promise<void> {
  const { connection: conn, env, operator } = session;
  const kubeAccess = getKubeAccess(config);
  const namespace = env === "staging" ? config.staging.namespace : config.production.namespace;

  // 1. Search trading account
  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  // 2. Load challenge for display
  const challenge = await challengeQ.getChallengeByUuid(conn, account.challenge_uuid);

  // 3. Find pending funded_activation
  const activation = await faQ.getPendingFundedActivationByTradingAccount(
    conn,
    account.trading_account_uuid
  );

  if (!activation) {
    ui.warn("Aucune funded_activation en statut 'pending' trouvee pour ce compte.");
    ui.info(
      "Utilisez d'abord l'action 'Activation d'un Funded' pour creer " +
      "une funded_activation, puis revenez ici pour bypasser les frais."
    );
    return;
  }

  // 4. Display details
  ui.sectionHeader("Bypass des frais d'activation");

  renderKeyValue({
    "cTrader ID": String(account.ctrader_trading_account),
    "UUID du compte": account.trading_account_uuid,
    "Challenge": challenge
      ? `${formatChallengeName(challenge.name)} (${challenge.type})`
      : "N/A",
    "Activation UUID": activation.activation_uuid,
    "Montant": formatCurrency(activation.amount, activation.currency),
    "Statut": activation.status,
    "Creee le": formatDate(activation.created_at),
    "Expire le": formatDate(activation.expires_at),
  });

  if (activation.payment_link) {
    ui.info(`Lien de paiement : ${activation.payment_link}`);
  }

  // 5. Confirm
  const description =
    `Bypass des frais d'activation : ${formatCurrency(activation.amount, activation.currency)} ` +
    `pour le compte cTrader ${account.ctrader_trading_account}`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  // 6. K8s Job : call order service internal endpoint
  //    This triggers the full ProcessActivation flow:
  //    create funded order → add payment → create TA via TAM → update activation to paid → deactivate old account
  const orderUrl = getOrderServiceUrl(env);
  const processSpec: KubeJobSpec = {
    name: generateJobName("support-process-activation"),
    namespace,
    image: "curlimages/curl:8.1.1",
    command: [
      "/bin/sh",
      "-c",
      `RESP=$(curl -s -X POST -w '\\nHTTP_CODE:%{http_code}' "${orderUrl}/internal/funded-activation/${activation.activation_uuid}/process"); echo "$RESP"; echo "$RESP" | grep -q 'HTTP_CODE:2' || exit 1`,
    ],
  };

  ui.sectionHeader("Job K8s — Traitement activation (order + TAM)");
  const result = await runJob(kubeAccess, processSpec);

  if (!result.success) {
    ui.error("Le Job de traitement de l'activation a echoue.");
    if (result.failureReason) ui.warn(`Raison : ${result.failureReason}`);
    if (result.logs) {
      ui.info("Logs :");
      console.log(result.logs);
    }
    ui.warn("Verifiez manuellement l'etat de l'activation.");
  } else {
    ui.success(`Activation traitee avec succes (${result.durationSeconds}s).`);
    if (result.logs) {
      ui.info("Reponse du service order :");
      console.log(result.logs);
    }
  }

  // 7. Audit log
  await auditLogQ.insertAuditLog(conn, "BYPASS_ACTIVATION_FEES", "funded_activation", activation.activation_uuid, {
    trading_account_uuid: account.trading_account_uuid,
    ctrader_id: account.ctrader_trading_account,
    original_amount: activation.amount,
    currency: activation.currency,
    process_job_success: result.success,
  }, operator, env);

  // 8. Recap
  console.log("");
  ui.sectionHeader("Recap");

  renderKeyValue({
    "Resultat": result.success
      ? "Frais bypasses + compte funded cree (via order + TAM)"
      : "Traitement echoue — verifier manuellement",
    "Activation UUID": activation.activation_uuid,
    "Montant bypasse": formatCurrency(activation.amount, activation.currency),
    "cTrader ID": String(account.ctrader_trading_account),
  });

  ui.success("Action terminee.");
}
