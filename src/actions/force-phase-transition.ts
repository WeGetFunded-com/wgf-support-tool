import { select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config, Environment } from "../config.js";
import { PHASE, PHASE_TRANSITIONS, REASONS } from "../types.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as faQ from "../queries/funded-activation.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatPhase, formatChallengeName, formatSuccess } from "../utils/format.js";
import { runJob, getKubeAccess, generateJobName } from "../kube/index.js";
import type { KubeJobSpec } from "../kube/index.js";

function getTamServiceUrl(env: Environment): string {
  const prefix = env === "staging" ? "staging" : "production";
  return `http://${prefix}-trading-account-manager.${prefix}.svc`;
}

function getWatcherServiceUrl(env: Environment): string {
  const prefix = env === "staging" ? "staging" : "production";
  return `http://${prefix}-trading-account-watcher.${prefix}.svc`;
}

function getOrderServiceUrl(env: Environment): string {
  const prefix = env === "staging" ? "staging" : "production";
  return `http://${prefix}-order.${prefix}.svc`;
}

/** Phases that transition to funded (via simulate/funded) */
const FUNDED_PHASES = new Set<number>([PHASE.FUNDED_STANDARD, PHASE.FUNDED_UNLIMITED]);

export async function forcePhaseTransition(
  session: DatabaseSession,
  config: Config
): Promise<void> {
  const { connection: conn, env, operator } = session;
  const kubeAccess = getKubeAccess(config);
  const namespace = env === "staging" ? config.staging.namespace : config.production.namespace;

  // 1. Search trading account
  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  // 2. Load challenge
  const challenge = await challengeQ.getChallengeByUuid(conn, account.challenge_uuid);
  if (!challenge) {
    ui.error("Challenge introuvable.");
    return;
  }

  // 3. Determine available transition
  const transitions = PHASE_TRANSITIONS[challenge.type];
  if (!transitions) {
    ui.warn(`Pas de transition disponible pour le type "${challenge.type}".`);
    return;
  }

  const transition = transitions[account.challenge_phase];
  if (!transition) {
    ui.warn(
      `Pas de transition disponible depuis la phase ${account.challenge_phase} ` +
      `pour un challenge ${challenge.type}.`
    );
    return;
  }

  const isFundedTransition = FUNDED_PHASES.has(transition.nextPhase);
  const isUnlimited = challenge.type === "unlimited";

  // 4. Preview
  ui.sectionHeader("Forcer le passage de phase");

  renderKeyValue({
    "cTrader ID": String(account.ctrader_trading_account),
    "UUID du compte": account.trading_account_uuid,
    "Challenge": `${formatChallengeName(challenge.name)} (${challenge.type})`,
    "Statut actuel": formatSuccess(account.success),
    "Reason": account.reason || "-",
    "Phase actuelle": formatPhase(account.challenge_phase, challenge.type),
    "Phase cible": formatPhase(transition.nextPhase),
    "Serveur cible": transition.nextServer === "live" ? "LIVE" : "Demo",
    "Type de transition": isFundedTransition ? "Funded (via simulate/funded)" : "Phase suivante (via TAM)",
  });

  // 5. For unlimited funded transition: ask about fees
  let bypassFees = false;
  if (isFundedTransition && isUnlimited) {
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
  const description = isFundedTransition
    ? `Forcer le passage en ${formatPhase(transition.nextPhase)} : cTrader ${account.ctrader_trading_account}` +
      (isUnlimited && bypassFees ? " (frais bypasses)" : "")
    : `Forcer le passage en ${formatPhase(transition.nextPhase)} : cTrader ${account.ctrader_trading_account}`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  // 7. Execute transition
  if (isFundedTransition) {
    await executeFundedTransition(
      conn, env, operator, kubeAccess, namespace,
      account, challenge, transition, isUnlimited, bypassFees
    );
  } else {
    await executePhaseTransition(
      conn, env, operator, kubeAccess, namespace,
      account, challenge, transition
    );
  }
}

// ── Phase 1 → Phase 2 (non-funded, via TAM) ──

async function executePhaseTransition(
  conn: any,
  env: Environment,
  operator: string,
  kubeAccess: any,
  namespace: string,
  account: any,
  challenge: any,
  transition: { nextPhase: number; nextServer: string }
): Promise<void> {
  // Step 1: Mark current account as succeeded
  ui.sectionHeader("Etape 1 — Marquer le compte actuel comme reussi");

  await conn.beginTransaction();
  try {
    await taQ.markAccountSuccess(conn, account.trading_account_uuid, REASONS.CHALLENGE_SUCCEED);

    await auditLogQ.insertAuditLog(conn, "FORCE_PHASE_TRANSITION", "trading_account", account.trading_account_uuid, {
      ctrader_id: account.ctrader_trading_account,
      challenge_type: challenge.type,
      from_phase: account.challenge_phase,
      to_phase: transition.nextPhase,
      action: "mark_success",
    }, operator, env);

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  }

  ui.success(`Compte marque comme reussi (success=1, reason=${REASONS.CHALLENGE_SUCCEED}).`);

  // Step 2: Call TAM to create next phase account
  ui.sectionHeader("Etape 2 — Creation du compte Phase suivante via TAM");

  const tamUrl = getTamServiceUrl(env);
  const tamSpec: KubeJobSpec = {
    name: generateJobName("support-force-phase"),
    namespace,
    image: "curlimages/curl:8.1.1",
    command: [
      "/bin/sh",
      "-c",
      `RESP=$(curl -s -X POST -w '\\nHTTP_CODE:%{http_code}' "${tamUrl}/account?order_uuid=${account.order_uuid}&challenge_phase=${transition.nextPhase}"); echo "$RESP"; echo "$RESP" | grep -q 'HTTP_CODE:2' || exit 1`,
    ],
  };

  const tamResult = await runJob(kubeAccess, tamSpec);

  if (!tamResult.success) {
    ui.error("Le Job TAM a echoue.");
    if (tamResult.failureReason) ui.warn(`Raison : ${tamResult.failureReason}`);
    if (tamResult.logs) {
      ui.info("Logs :");
      console.log(tamResult.logs);
    }
    ui.warn(
      "Le compte actuel a ete marque comme reussi (success=1) mais le compte " +
      "de la phase suivante n'a pas pu etre cree. Verifiez manuellement."
    );
    return;
  }

  ui.success(`Compte Phase ${transition.nextPhase} cree via TAM (${tamResult.durationSeconds}s).`);
  if (tamResult.logs) {
    ui.info("Reponse du TAM :");
    console.log(tamResult.logs);
  }

  // Step 3: Query DB to get the new account
  const accounts = await taQ.getAllTradingAccountsByOrder(conn, account.order_uuid);
  const newAccount = accounts.find(
    (a) => a.challenge_phase === transition.nextPhase && a.success === null
  );

  // Recap
  console.log("");
  ui.sectionHeader("Recap");

  renderKeyValue({
    "Resultat": "Passage de phase reussi",
    "Phase precedente": formatPhase(account.challenge_phase, challenge.type),
    "Nouvelle phase": formatPhase(transition.nextPhase, challenge.type),
    "cTrader ID original": String(account.ctrader_trading_account),
    "Nouveau cTrader ID": newAccount ? String(newAccount.ctrader_trading_account) : "N/A (verifier manuellement)",
    "Nouveau UUID": newAccount?.trading_account_uuid ?? "N/A",
  });

  ui.success("Action terminee.");
}

// ── Phase 2 → Funded Standard / Phase 0 → Funded Unlimited (via simulate/funded) ──

async function executeFundedTransition(
  conn: any,
  env: Environment,
  operator: string,
  kubeAccess: any,
  namespace: string,
  account: any,
  challenge: any,
  transition: { nextPhase: number; nextServer: string },
  isUnlimited: boolean,
  bypassFees: boolean
): Promise<void> {
  // Step 1: Call watcher simulate/funded
  ui.sectionHeader("Etape 1 — Simulation Funded (watcher)");

  const watcherUrl = getWatcherServiceUrl(env);
  const simulateSpec: KubeJobSpec = {
    name: generateJobName("support-force-funded"),
    namespace,
    image: "curlimages/curl:8.1.1",
    command: [
      "/bin/sh",
      "-c",
      `RESP=$(curl -s -w '\\nHTTP_CODE:%{http_code}' ${watcherUrl}/simulate/funded/${account.trading_account_uuid}); echo "$RESP"; echo "$RESP" | grep -q 'HTTP_CODE:2' || exit 1`,
    ],
  };

  const simulateResult = await runJob(kubeAccess, simulateSpec);

  if (!simulateResult.success) {
    ui.error("Le Job de simulation funded a echoue.");
    if (simulateResult.failureReason) ui.warn(`Raison : ${simulateResult.failureReason}`);
    if (simulateResult.logs) {
      ui.info("Logs :");
      console.log(simulateResult.logs);
    }
    await auditLogQ.insertAuditLog(conn, "FORCE_PHASE_TRANSITION_FAILED", "trading_account", account.trading_account_uuid, {
      ctrader_id: account.ctrader_trading_account,
      challenge_type: challenge.type,
      target_phase: transition.nextPhase,
      error: simulateResult.failureReason || "Job failed",
    }, operator, env);
    return;
  }

  ui.success(`Simulation funded terminee (${simulateResult.durationSeconds}s).`);
  if (simulateResult.logs) {
    ui.info("Reponse du watcher :");
    console.log(simulateResult.logs);
  }

  // Step 2: Process funded activation (standard = always, unlimited = only if bypass)
  const shouldProcess = !isUnlimited || bypassFees;

  if (shouldProcess) {
    ui.sectionHeader("Etape 2 — Traitement activation (order + TAM)");

    const activation = await faQ.getPendingFundedActivationByTradingAccount(
      conn,
      account.trading_account_uuid
    );

    if (!activation) {
      ui.warn(
        "Aucune funded_activation en statut 'pending' trouvee. " +
        "Le traitement ne peut pas etre effectue automatiquement. " +
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

  // Audit log
  await auditLogQ.insertAuditLog(conn, "FORCE_PHASE_TRANSITION", "trading_account", account.trading_account_uuid, {
    ctrader_id: account.ctrader_trading_account,
    challenge_type: challenge.type,
    from_phase: account.challenge_phase,
    to_phase: transition.nextPhase,
    bypass_fees: bypassFees,
    simulate_duration: simulateResult.durationSeconds,
  }, operator, env);

  // Recap
  console.log("");
  ui.sectionHeader("Recap");

  if (isUnlimited && !bypassFees) {
    renderKeyValue({
      "Resultat": "Funded activation creee (en attente de paiement)",
      "Montant": "149.90 EUR",
      "Action requise": "Le trader doit payer via le lien de paiement envoye par email",
      "Alternative": "Utilisez 'Bypass des frais d'activation' pour bypasser le paiement",
    });
  } else {
    renderKeyValue({
      "Resultat": "Passage en funded reussi",
      "Phase precedente": formatPhase(account.challenge_phase, challenge.type),
      "Phase cible": formatPhase(transition.nextPhase),
      "cTrader ID original": String(account.ctrader_trading_account),
      "Frais bypasses": isUnlimited ? "Oui" : "N/A (standard)",
    });
  }

  ui.success("Action terminee.");
}
