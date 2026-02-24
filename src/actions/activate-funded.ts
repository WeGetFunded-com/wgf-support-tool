import { select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config, Environment } from "../config.js";
import { PHASE } from "../types.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as faQ from "../queries/funded-activation.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatPhase, formatChallengeName, formatSuccess } from "../utils/format.js";
import { runJob, getKubeAccess, generateJobName } from "../kube/index.js";
import type { KubeJobSpec } from "../kube/index.js";

/** Phases eligible for funded activation via this action */
const FUNDED_ELIGIBLE: Record<string, number> = {
  standard: PHASE.STANDARD_TWO,
  unlimited: PHASE.UNLIMITED,
};

function getWatcherServiceUrl(env: Environment): string {
  const prefix = env === "staging" ? "staging" : "production";
  return `http://${prefix}-trading-account-watcher.${prefix}.svc`;
}

function getOrderServiceUrl(env: Environment): string {
  const prefix = env === "staging" ? "staging" : "production";
  return `http://${prefix}-order.${prefix}.svc`;
}

export async function activateFunded(
  session: DatabaseSession,
  config: Config
): Promise<void> {
  const { connection: conn, env, operator } = session;
  const kubeAccess = getKubeAccess(config);
  const namespace = env === "staging" ? config.staging.namespace : config.production.namespace;

  // 1. Search trading account
  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  if (account.success !== null) {
    ui.warn(`Ce compte n'est pas actif (statut: ${formatSuccess(account.success)}).`);
    return;
  }

  // 2. Load challenge
  const challenge = await challengeQ.getChallengeByUuid(conn, account.challenge_uuid);
  if (!challenge) {
    ui.error("Challenge introuvable.");
    return;
  }

  // 3. Validate eligibility
  const eligiblePhase = FUNDED_ELIGIBLE[challenge.type];
  if (eligiblePhase === undefined) {
    ui.error(
      `Ce type de challenge ("${challenge.type}") n'est pas eligible ` +
      `pour une activation funded via cet outil.`
    );
    return;
  }

  if (account.challenge_phase !== eligiblePhase) {
    if (challenge.type === "standard" && account.challenge_phase === PHASE.STANDARD_ONE) {
      ui.warn(
        "Ce compte est en Phase 1 (standard). La transition Phase 1 → Phase 2 " +
        "est geree automatiquement par le watcher lorsque le profit target est atteint."
      );
    } else {
      ui.error(
        `Ce compte est en phase ${account.challenge_phase}, pas en phase ${eligiblePhase}. ` +
        `Activation funded impossible.`
      );
    }
    return;
  }

  // 4. Preview
  const isUnlimited = challenge.type === "unlimited";
  const targetPhase = isUnlimited ? PHASE.FUNDED_UNLIMITED : PHASE.FUNDED_STANDARD;

  ui.sectionHeader("Activation d'un Funded");

  renderKeyValue({
    "cTrader ID": String(account.ctrader_trading_account),
    "UUID du compte": account.trading_account_uuid,
    "Challenge": `${formatChallengeName(challenge.name)} (${challenge.type})`,
    "Phase actuelle": formatPhase(account.challenge_phase, challenge.type),
    "Phase cible": formatPhase(targetPhase),
  });

  // 5. Ask about bypass for unlimited
  let bypassFees = false;
  if (isUnlimited) {
    console.log("");
    ui.info(
      "Ce compte unlimited necessite 149.90 EUR de frais d'activation " +
      "pour passer en funded."
    );

    const bypassChoice = await select({
      message: "Frais d'activation :",
      choices: [
        {
          name: "Facturer normalement (le trader recevra un lien de paiement)",
          value: "charge",
        },
        {
          name: "Bypasser les frais (activation gratuite)",
          value: "bypass",
        },
      ],
    });
    bypassFees = bypassChoice === "bypass";
  }

  // 6. Confirm
  const description = bypassFees
    ? `Activation funded + bypass des frais : cTrader ${account.ctrader_trading_account} → ${formatPhase(targetPhase)}`
    : `Activation funded : cTrader ${account.ctrader_trading_account} → ${formatPhase(targetPhase)}`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  // 7. K8s Job #1 : simulate/funded (watcher)
  const watcherUrl = getWatcherServiceUrl(env);
  const simulateSpec: KubeJobSpec = {
    name: generateJobName("support-simulate-funded"),
    namespace,
    image: "curlimages/curl:8.1.1",
    command: [
      "/bin/sh",
      "-c",
      `RESP=$(curl -s -w '\\nHTTP_CODE:%{http_code}' ${watcherUrl}/simulate/funded/${account.trading_account_uuid}); echo "$RESP"; echo "$RESP" | grep -q 'HTTP_CODE:2' || exit 1`,
    ],
  };

  ui.sectionHeader("Job K8s — Simulation Funded");
  const simulateResult = await runJob(kubeAccess, simulateSpec);

  if (!simulateResult.success) {
    ui.error("Le Job de simulation funded a echoue.");
    if (simulateResult.failureReason) ui.warn(`Raison : ${simulateResult.failureReason}`);
    if (simulateResult.logs) {
      ui.info("Logs :");
      console.log(simulateResult.logs);
    }
    await auditLogQ.insertAuditLog(conn, "ACTIVATE_FUNDED_FAILED", "trading_account", account.trading_account_uuid, {
      ctrader_id: account.ctrader_trading_account,
      challenge_type: challenge.type,
      target_phase: targetPhase,
      error: simulateResult.failureReason || "Job failed",
    }, operator, env);
    return;
  }

  ui.success(`Simulation funded terminee (${simulateResult.durationSeconds}s).`);
  if (simulateResult.logs) {
    ui.info("Reponse du watcher :");
    console.log(simulateResult.logs);
  }

  // 8. If unlimited + bypass : call order service internal endpoint
  //    This triggers the full ProcessActivation flow:
  //    create funded order → add payment → create TA via TAM → update activation → deactivate old account
  if (isUnlimited && bypassFees) {
    console.log("");
    ui.sectionHeader("Bypass des frais d'activation");

    // Find the funded_activation just created by simulate/funded
    const activation = await faQ.getPendingFundedActivationByTradingAccount(
      conn,
      account.trading_account_uuid
    );

    if (!activation) {
      ui.warn(
        "Aucune funded_activation en statut 'pending' trouvee. " +
        "Le bypass ne peut pas etre effectue automatiquement. " +
        "Utilisez l'action 'Bypass des frais d'activation' manuellement si necessaire."
      );
    } else {
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
      const processResult = await runJob(kubeAccess, processSpec);

      if (!processResult.success) {
        ui.error("Le Job de traitement de l'activation a echoue.");
        if (processResult.failureReason) ui.warn(`Raison : ${processResult.failureReason}`);
        if (processResult.logs) {
          ui.info("Logs :");
          console.log(processResult.logs);
        }
        ui.warn(
          "La funded_activation existe mais n'a pas pu etre traitee. " +
          "Verifiez manuellement ou utilisez 'Bypass des frais d'activation'."
        );
      } else {
        ui.success(`Activation traitee avec succes (${processResult.durationSeconds}s).`);
        if (processResult.logs) {
          ui.info("Reponse du service order :");
          console.log(processResult.logs);
        }
      }
    }
  }

  // 9. Audit log
  await auditLogQ.insertAuditLog(conn, "ACTIVATE_FUNDED", "trading_account", account.trading_account_uuid, {
    ctrader_id: account.ctrader_trading_account,
    challenge_type: challenge.type,
    target_phase: targetPhase,
    bypass_fees: bypassFees,
    duration_seconds: simulateResult.durationSeconds,
  }, operator, env);

  // 10. Recap
  console.log("");
  ui.sectionHeader("Recap");

  if (isUnlimited && !bypassFees) {
    renderKeyValue({
      "Resultat": "Funded activation creee (en attente de paiement)",
      "Montant": "149.90 EUR",
      "Action requise": "Le trader doit payer via le lien de paiement envoye par email",
      "Alternative": "Utilisez 'Bypass des frais d'activation' pour bypasser le paiement",
    });
  } else if (isUnlimited && bypassFees) {
    renderKeyValue({
      "Resultat": "Compte funded cree (frais bypasses via order + TAM)",
      "cTrader ID original": String(account.ctrader_trading_account),
    });
  } else {
    renderKeyValue({
      "Resultat": "Compte funded standard cree",
      "cTrader ID original": String(account.ctrader_trading_account),
    });
  }

  ui.success("Action terminee.");
}
