import { select, checkbox } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config, Environment } from "../config.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as orderQ from "../queries/order.queries.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as optionsQ from "../queries/options.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as baQ from "../queries/broker-account.queries.js";
import * as contestQ from "../queries/contest.queries.js";
import { INITIAL_PHASE, type ChallengeType, type BrokerName } from "../types.js";

// cTrader account creation has been removed from the tool — every new TA is
// created on MT5. The full cTrader migration (Apr 2026) means the broker is no
// longer used for new accounts; the older cTrader code paths in TAM remain only
// for legacy reads. If you need to recreate a cTrader account specifically,
// use the cTrader Manager terminal directly.
const FORCED_BROKER: BrokerName = "mt5";
import * as ui from "../ui.js";
import { searchUserPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatPercent, formatCurrency, formatPhase, formatDuration, formatChallengeName, formatBrokerName } from "../utils/format.js";
import { generateUuid } from "../utils/uuid.js";
import { runJob, getKubeAccess, generateJobName, fetchTamErrorContext } from "../kube/index.js";
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

  // 2. Trading platform — MT5 only (cTrader creation deprecated, see file header)
  const brokerName: BrokerName = FORCED_BROKER;
  ui.info(`Plateforme : ${formatBrokerName(brokerName)} (cTrader desactive)`);

  // 3. Select challenge
  const challenges = await challengeQ.getPublishedAndFundedChallenges(conn);
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

  // 5. Select options
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

  const previewFields: Record<string, string> = {};
  previewFields["Utilisateur"] = `${user.firstname} ${user.lastname} (${user.email})`;
  previewFields["Plateforme"] = formatBrokerName(brokerName);
  previewFields["Challenge"] = `${formatChallengeName(challenge.name)} (${challenge.type})`;
  previewFields["Prix"] = formatCurrency(challenge.price);
  previewFields["Balance initiale"] = formatCurrency(challenge.initial_coins_amount);
  previewFields["Phase initiale"] = formatPhase(initialPhase, challenge.type);
  previewFields["Profit Target"] = formatPercent(currentPhaseRules.profit_target_percent);
  previewFields["Duree phase"] = formatDuration(currentPhaseRules.phase_duration);
  previewFields["Options"] = selectedOptionNames.length > 0 ? selectedOptionNames.join(", ") : "Aucune";
  previewFields["Methode paiement"] = "admin_manual";
  previewFields["Compte"] = `Sera cree automatiquement par le TAM (${formatBrokerName(brokerName)})`;

  renderKeyValue(previewFields);

  const description =
    `Creer le compte ${formatBrokerName(brokerName)} "${formatChallengeName(challenge.name)}" pour ${user.email} ` +
    `(balance: ${formatCurrency(challenge.initial_coins_amount)})`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  // 9. Generate UUIDs
  const paymentUuid = generateUuid();
  const orderUuid = generateUuid();

  // 10. Insert order + payment in DB (TAM needs the order to exist)
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

  // 11. K8s Job: call TAM to create trading account + trade history + email
  const tamUrl = getTamServiceUrl(env);
  const tamSpec: KubeJobSpec = {
    name: generateJobName("support-create-ta"),
    namespace,
    image: "curlimages/curl:8.1.1",
    command: [
      "/bin/sh",
      "-c",
      `RESP=$(curl -s -X POST -w '\\nHTTP_CODE:%{http_code}' "${tamUrl}/account?order_uuid=${orderUuid}&challenge_phase=${initialPhase}&broker_name=${brokerName}"); echo "$RESP"; echo "$RESP" | grep -q 'HTTP_CODE:2' || exit 1`,
    ],
  };

  ui.sectionHeader("Job K8s — Creation du compte via TAM");
  const result = await runJob(kubeAccess, tamSpec);

  let welcomeMailMaybeSkipped = false;
  if (!result.success) {
    // The TA / MT5 / contest_entry may already exist if only a post-creation
    // step (e.g. the welcome email) failed. Never roll back a real account —
    // check the DB first.
    const alreadyCreated = await taQ.getAllTradingAccountsByOrder(conn, orderUuid);
    if (alreadyCreated.length > 0) {
      ui.warn("Le TAM a renvoye une erreur, mais le compte est deja cree (echec d'une etape post-creation, ex. email de bienvenue).");
      ui.warn("Aucun rollback effectue. Envoyer les identifiants MT5 manuellement si l'email n'est pas parti.");
      welcomeMailMaybeSkipped = true;
    } else {
      ui.error("Le Job TAM a echoue.");
      if (result.failureReason) ui.warn(`Raison : ${result.failureReason}`);
      if (result.logs) {
        ui.info("Logs job (HTTP) :");
        console.log(result.logs);
      }

      // The TAM router flattens every controller error into "Bad Request" in the
      // HTTP body — the actual cause (Brevo 400, model-command timeout, MT5 down…)
      // only exists in the TAM pod's structured logs. Pull it back so the
      // operator sees what really failed.
      try {
        const tamCtx = await fetchTamErrorContext(kubeAccess, env, orderUuid);
        if (tamCtx) {
          ui.info("Erreur TAM detaillee :");
          console.log(tamCtx.rawError);
        } else {
          ui.warn("Pas de log ERROR TAM trouve pour cet order_uuid (logs rotates ?).");
        }
      } catch (logErr) {
        const e = logErr as { message?: string };
        ui.warn(`Impossible de recuperer les logs TAM : ${e.message || "erreur inconnue"}`);
      }

      ui.info("Rollback de l'order en cours...");
      // No trading account was created. Clear the contest_entry first (concours
      // FK fk_contest_entry_order), then order_options, order, payment.
      try {
        await contestQ.deleteContestEntryByOrder(conn, orderUuid);
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
  }

  if (welcomeMailMaybeSkipped) {
    ui.success("Compte cree (etape post-creation echouee, voir avertissement ci-dessus).");
  } else {
    ui.success(`Compte cree avec succes via TAM (${result.durationSeconds}s).`);
  }
  if (result.logs) {
    ui.info("Reponse du TAM :");
    console.log(result.logs);
  }

  // 12. Query DB to get the created trading account
  const accounts = await taQ.getAllTradingAccountsByOrder(conn, orderUuid);
  const createdAccount = accounts[0];

  // Get broker account info for MT5 accounts
  let accountLogin: string = "N/A";
  if (createdAccount) {
    const displayInfo = await baQ.getAccountDisplayId(conn, createdAccount);
    accountLogin = String(displayInfo.login);
  }

  // 13. Audit log
  await auditLogQ.insertAuditLog(conn, "CREATE_TRADING_ACCOUNT", "trading_account",
    createdAccount?.trading_account_uuid ?? null, {
    user_email: user.email,
    user_uuid: user.user_uuid,
    user_ctid: user.CTID,
    broker_name: brokerName,
    challenge_name: challenge.name,
    challenge_type: challenge.type,
    challenge_uuid: challenge.challenge_uuid,
    order_uuid: orderUuid,
    payment_uuid: paymentUuid,
    initial_phase: initialPhase,
    initial_balance: challenge.initial_coins_amount,
    options: selectedOptionNames,
    account_login: accountLogin,
    tam_job_duration: result.durationSeconds,
  }, operator, env);

  // 14. Recap
  console.log("");
  ui.sectionHeader("Recap");

  const recapFields: Record<string, string> = {
    "Resultat": "Compte de trading cree avec succes",
    "Plateforme": formatBrokerName(brokerName),
    "Utilisateur": `${user.firstname} ${user.lastname} (${user.email})`,
    "Challenge": `${formatChallengeName(challenge.name)} (${challenge.type})`,
    "Phase": formatPhase(initialPhase, challenge.type),
    "Balance": formatCurrency(challenge.initial_coins_amount),
    "Order UUID": orderUuid,
    "Trading Account UUID": createdAccount?.trading_account_uuid ?? "N/A",
  };

  recapFields["MT5 Login"] = accountLogin;
  recapFields["Info"] = welcomeMailMaybeSkipped
    ? "Email NON envoye (echec etape TAM) — transmettre les identifiants MT5 manuellement"
    : "Les identifiants MT5 ont ete envoyes par email";

  recapFields["Options"] = selectedOptionNames.length > 0 ? selectedOptionNames.join(", ") : "Aucune";

  renderKeyValue(recapFields);

  ui.success("Action terminee.");
}
