import { select, checkbox } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config, Environment } from "../config.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as orderQ from "../queries/order.queries.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as optionsQ from "../queries/options.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import { INITIAL_PHASE, type ChallengeType } from "../types.js";
import * as ui from "../ui.js";
import { searchUserPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatPercent, formatCurrency, formatPhase, formatDuration, formatChallengeName } from "../utils/format.js";
import { generateUuid } from "../utils/uuid.js";
import { runJob, getKubeAccess, generateJobName } from "../kube/index.js";
import type { KubeJobSpec } from "../kube/index.js";

function getTamServiceUrl(env: Environment): string {
  const prefix = env === "staging" ? "staging" : "production";
  return `http://${prefix}-trading-account-manager.${prefix}.svc`;
}

export async function createTradingAccount(
  session: DatabaseSession,
  config: Config
): Promise<void> {
  const { connection: conn, env, operator } = session;
  const kubeAccess = getKubeAccess(config);
  const namespace = env === "staging" ? config.staging.namespace : config.production.namespace;

  // 1. Select user
  ui.sectionHeader("Creer un compte de trading");
  const user = await searchUserPrompt(conn);
  if (!user) return;

  ui.info(`Utilisateur : ${user.firstname} ${user.lastname} (${user.email})`);

  // 2. Validate CTID
  if (!user.CTID) {
    ui.error(
      "L'utilisateur n'a pas de CTID (cTrader ID). " +
      "Le CTID est necessaire pour que le TAM puisse lier le compte cTrader. " +
      "L'utilisateur doit d'abord se connecter a la plateforme pour obtenir un CTID."
    );
    return;
  }

  // 3. Select challenge
  const challenges = await challengeQ.getPublishedChallenges(conn);
  if (challenges.length === 0) {
    ui.error("Aucun challenge publie disponible.");
    return;
  }

  const challengeIdx = await select({
    message: "Challenge :",
    choices: challenges.map((c, i) => ({
      name: `${formatChallengeName(c.name)} (${c.type}) — ${formatCurrency(c.price)} — Balance: ${formatCurrency(c.initial_coins_amount)}`,
      value: i,
    })),
  });
  const challenge = challenges[challengeIdx];

  // 4. Select options
  const allOptions = await optionsQ.getAllOptions(conn);
  let selectedOptions: string[] = [];

  if (allOptions.length > 0) {
    selectedOptions = await checkbox({
      message: "Options (espace pour selectionner, entree pour confirmer) :",
      choices: allOptions.map((o) => ({
        name: `${o.name} (${formatPercent(o.majoration_percent)})`,
        value: o.option_uuid,
      })),
    });
  }

  // 5. Determine initial phase
  const initialPhase = INITIAL_PHASE[challenge.type as ChallengeType] ?? 1;

  // For instant_funded, rules are at phase 3 but challenge_phase in DB is 0
  const rulesPhase = challenge.type === "instant_funded" ? 3 : initialPhase;

  // 6. Get challenge rules
  const allRules = await challengeQ.getAllChallengeRules(conn, challenge.challenge_uuid);
  const currentPhaseRules = allRules.find((r) => r.phase === rulesPhase);

  if (!currentPhaseRules) {
    ui.error(`Regles introuvables pour le challenge ${formatChallengeName(challenge.name)}, phase ${rulesPhase}.`);
    return;
  }

  // Build order_challenge_configuration JSON (same format as Go backend)
  const configObj: Record<string, Record<string, unknown>> = {};
  for (const rule of allRules) {
    configObj[String(rule.phase)] = {
      max_daily_drawdown_percent: Number(rule.max_daily_drawdown_percent) / 100,
      max_total_drawdown_percent: Number(rule.max_total_drawdown_percent) / 100,
      profit_target_percent: Number(rule.profit_target_percent) / 100,
      phase_duration: rule.phase_duration,
      min_trading_days: Number(rule.min_trading_days),
    };
  }
  const challengeConfiguration = JSON.stringify(configObj);

  // 7. Preview
  ui.sectionHeader("Preview de la creation");

  const selectedOptionNames = allOptions
    .filter((o) => selectedOptions.includes(o.option_uuid))
    .map((o) => o.name);

  renderKeyValue({
    "Utilisateur": `${user.firstname} ${user.lastname} (${user.email})`,
    "CTID": String(user.CTID),
    "Challenge": `${formatChallengeName(challenge.name)} (${challenge.type})`,
    "Prix": formatCurrency(challenge.price),
    "Balance initiale": formatCurrency(challenge.initial_coins_amount),
    "Phase initiale": formatPhase(initialPhase, challenge.type),
    "Profit Target": formatPercent(currentPhaseRules.profit_target_percent),
    "Duree phase": formatDuration(currentPhaseRules.phase_duration),
    "Options": selectedOptionNames.length > 0 ? selectedOptionNames.join(", ") : "Aucune",
    "Methode paiement": "admin_manual",
    "Compte cTrader": "Sera cree automatiquement par le TAM",
  });

  const description =
    `Creer le compte de trading "${formatChallengeName(challenge.name)}" pour ${user.email} ` +
    `(balance: ${formatCurrency(challenge.initial_coins_amount)})`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  // 8. Generate UUIDs
  const paymentUuid = generateUuid();
  const orderUuid = generateUuid();

  // 9. Insert order + payment in DB (TAM needs the order to exist)
  await conn.beginTransaction();
  try {
    await orderQ.createPayment(conn, paymentUuid, "admin_manual", 0, "EUR", "admin_manual");

    await orderQ.createOrder(
      conn,
      orderUuid,
      challenge.challenge_uuid,
      user.user_uuid,
      paymentUuid,
      challengeConfiguration
    );

    for (const optUuid of selectedOptions) {
      await orderQ.createOrderOption(conn, orderUuid, optUuid);
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  }

  ui.success("Order cree en DB.");
  ui.info(`  Order UUID : ${orderUuid}`);

  // 10. K8s Job: call TAM to create cTrader account + trading account + trade history + email
  const tamUrl = getTamServiceUrl(env);
  const tamSpec: KubeJobSpec = {
    name: generateJobName("support-create-ta"),
    namespace,
    image: "curlimages/curl:8.1.1",
    command: [
      "/bin/sh",
      "-c",
      `RESP=$(curl -s -X POST -w '\\nHTTP_CODE:%{http_code}' "${tamUrl}/account?order_uuid=${orderUuid}&challenge_phase=${initialPhase}"); echo "$RESP"; echo "$RESP" | grep -q 'HTTP_CODE:2' || exit 1`,
    ],
  };

  ui.sectionHeader("Job K8s — Creation du compte via TAM");
  const result = await runJob(kubeAccess, tamSpec);

  if (!result.success) {
    ui.error("Le Job TAM a echoue. Rollback de l'order en cours...");
    if (result.failureReason) ui.warn(`Raison : ${result.failureReason}`);
    if (result.logs) {
      ui.info("Logs :");
      console.log(result.logs);
    }

    // Cleanup: delete order_options, order, payment
    try {
      await orderQ.deleteOrderOptions(conn, orderUuid);
      await orderQ.deleteOrder(conn, orderUuid);
      await orderQ.deletePayment(conn, paymentUuid);
      ui.success("Rollback effectue : order et payment supprimes.");
    } catch (cleanupErr) {
      const e = cleanupErr as { message?: string };
      ui.error(`Echec du rollback : ${e.message || "Erreur inconnue"}`);
      ui.warn(`Order UUID a nettoyer manuellement : ${orderUuid}`);
    }
    return;
  }

  ui.success(`Compte cree avec succes via TAM (${result.durationSeconds}s).`);
  if (result.logs) {
    ui.info("Reponse du TAM :");
    console.log(result.logs);
  }

  // 11. Query DB to get the created trading account (with cTrader ID)
  const accounts = await taQ.getAllTradingAccountsByOrder(conn, orderUuid);
  const createdAccount = accounts[0];

  // 12. Audit log
  await auditLogQ.insertAuditLog(conn, "CREATE_TRADING_ACCOUNT", "trading_account",
    createdAccount?.trading_account_uuid ?? null, {
    user_email: user.email,
    user_uuid: user.user_uuid,
    user_ctid: user.CTID,
    challenge_name: challenge.name,
    challenge_type: challenge.type,
    challenge_uuid: challenge.challenge_uuid,
    order_uuid: orderUuid,
    payment_uuid: paymentUuid,
    initial_phase: initialPhase,
    initial_balance: challenge.initial_coins_amount,
    options: selectedOptionNames,
    ctrader_id: createdAccount?.ctrader_trading_account ?? "unknown",
    tam_job_duration: result.durationSeconds,
  }, operator, env);

  // 13. Recap
  console.log("");
  ui.sectionHeader("Recap");

  renderKeyValue({
    "Resultat": "Compte de trading cree avec succes",
    "Utilisateur": `${user.firstname} ${user.lastname} (${user.email})`,
    "Challenge": `${formatChallengeName(challenge.name)} (${challenge.type})`,
    "Phase": formatPhase(initialPhase, challenge.type),
    "Balance": formatCurrency(challenge.initial_coins_amount),
    "Order UUID": orderUuid,
    "Trading Account UUID": createdAccount?.trading_account_uuid ?? "N/A",
    "cTrader ID": createdAccount ? String(createdAccount.ctrader_trading_account) : "N/A (verifier manuellement)",
    "Options": selectedOptionNames.length > 0 ? selectedOptionNames.join(", ") : "Aucune",
  });

  ui.success("Action terminee.");
}
