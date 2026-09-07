import { input, select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import type { DbOption } from "../types.js";
import * as userQ from "../queries/user.queries.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as baQ from "../queries/broker-account.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatCurrency, formatDate } from "../utils/format.js";
import {
  getPayoutEligibility,
  simulatePayout as postSimulatePayout,
  type PayoutEligibility,
} from "../payout-simulation-client.js";

/** Marker shown next to each rule. Plain ASCII, so it survives a Windows console. */
function mark(met: boolean): string {
  return met ? "OK " : "NON";
}

/**
 * The profit split the trader's own request would carry.
 *
 * The manager does not derive this: it takes the value the client sends, only
 * overriding it for instant_funded (which cannot hold a split option anyway) and
 * falling back to 80/20 when the field is empty. Sending nothing therefore
 * silently downgrades an account that paid for the 90/10 or 100/0 upgrade.
 *
 * So the shell has to do what the dashboard does — same rule, same order, see
 * getProfitSplitPercent in next-wgf dashboard-payouts-page.service.ts. Keeping
 * the two in step is the price of a contract where the client owns the value;
 * deriving it server-side would remove the duplication for good.
 */
function profitSplitFromOptions(options: DbOption[]): string {
  if (options.some((o) => o.name.includes("100/0"))) return "100/0";
  if (options.some((o) => o.name.includes("90/10"))) return "90/10";
  return "80/20";
}

/**
 * The range the trader may ask for, or why there is none.
 *
 * The maximum is a share of the account's profit while the minimum is a fixed
 * floor, so the two cross as soon as the profit is small: printing
 * "100,00 EUR — 30,00 EUR" would read as a range when in fact nothing can be
 * requested at all.
 */
function describeRequestableRange(e: PayoutEligibility): string {
  if (e.maxPayout < e.minPayout) {
    return (
      `aucun — le maximum (${formatCurrency(e.maxPayout)}) est sous ` +
      `le minimum de ${formatCurrency(e.minPayout)}`
    );
  }
  return (
    `entre ${formatCurrency(e.minPayout)} et ${formatCurrency(e.maxPayout)}` +
    `   (max = 50 % du profit, plafonne par taille de compte)`
  );
}

function renderEligibility(e: PayoutEligibility): void {
  ui.sectionHeader("Eligibilite au payout");

  renderKeyValue({
    "Eligible": e.eligible ? "OUI" : "NON",
    "Funded": e.isFunded ? "oui" : "non",
    "Profit > depot": e.hasProfitAboveDeposit ? "oui" : "non",
    "Peut demander": describeRequestableRange(e),
  });

  console.log("");

  const consistency = e.consistencyRule;
  renderKeyValue({
    "Jours positifs": `${mark(e.positiveTradingDays.met)}  ${e.positiveTradingDays.current} / ${e.positiveTradingDays.required}` +
      `   (jours a >= 0,5 % du depot)`,
    "Jours depuis 1er trade": `${mark(e.daysSinceFirstTrade.met)}  ${e.daysSinceFirstTrade.current} / ${e.daysSinceFirstTrade.required}` +
      `   (1er trade ${formatDate(e.daysSinceFirstTrade.firstTradeDate)})`,
    "Consistency": consistency.applicable
      ? `${mark(consistency.met)}  ${consistency.highestDayPercent} % / ${consistency.maxAllowedPercent} %` +
        `   (meilleur jour ${formatCurrency(consistency.bestDay)} sur ${formatCurrency(consistency.reference)})`
      : "—    non applicable (compte sous son depot)",
    "Trades < 30 s": `${mark(e.fastTrades.met)}  ${e.fastTrades.ratio} % / ${e.fastTrades.limitPercent} %` +
      `   (${formatCurrency(e.fastTrades.shortPnl)} sur ${formatCurrency(e.fastTrades.totalPnl)})`,
  });

  console.log("");
  ui.info("Tous les compteurs repartent du dernier payout approuve, pas de la creation du compte.");
}

/**
 * Creates a payout request on an account as if the trader had asked for it, so
 * support can either explain to a trader why his withdrawal is blocked, or walk
 * the whole payout flow on a test account.
 *
 * The eligibility verdict and the creation both go through the manager: it owns
 * the rules and the guards, and duplicating either here would mean maintaining a
 * second copy of logic that keeps moving.
 */
export async function simulatePayout(
  session: DatabaseSession,
  config: Config
): Promise<void> {
  const { connection: conn, env, operator } = session;

  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  const display = await baQ.getAccountDisplayId(conn, account);
  const options = await taQ.getTradingAccountOptions(conn, account.trading_account_uuid);
  const profitSplit = profitSplitFromOptions(options);
  const user = await userQ.getUserByOrderUuid(conn, account.order_uuid);
  if (!user) {
    ui.error("Impossible de retrouver le proprietaire du compte.");
    return;
  }

  ui.sectionHeader("Compte cible");
  renderKeyValue({
    "Compte": display.label,
    "Proprietaire": `${user.firstname} ${user.lastname} <${user.email}>`,
    "Phase": String(account.challenge_phase),
    "UUID": account.trading_account_uuid,
  });

  let eligibility: PayoutEligibility;
  try {
    eligibility = await getPayoutEligibility(config, env, account.trading_account_uuid);
  } catch (err) {
    ui.error(`Calcul d'eligibilite impossible : ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  renderEligibility(eligibility);

  const next = await select({
    message: "Suite :",
    choices: [
      { name: "Creer une demande de payout sur ce compte", value: "create" },
      { name: "Retour (diagnostic seulement)", value: "back" },
    ],
  });

  if (next === "back") return;

  if (!eligibility.isFunded) {
    ui.error("Ce compte n'est pas un compte funded.");
    ui.info("La simulation ne couvre que les comptes funded.");
    return;
  }

  let force = false;
  if (!eligibility.eligible) {
    ui.warn("Ce compte ne remplit pas toutes les conditions.");
    const forced = await select({
      message: "Forcer la creation malgre tout ?",
      choices: [
        { name: "Non, annuler", value: false },
        { name: "Oui, forcer (ignore les regles et les bornes de montant)", value: true },
      ],
    });
    if (!forced) {
      ui.info("Action annulee.");
      return;
    }
    force = true;
  }

  // Reachable only when the account is eligible: a non-eligible one has already
  // gone through the force prompt above.
  if (!force && eligibility.maxPayout < eligibility.minPayout) {
    ui.error(
      `Aucun montant demandable : le maximum (${formatCurrency(eligibility.maxPayout)}) ` +
        `est sous le minimum de ${formatCurrency(eligibility.minPayout)}.`
    );
    ui.info("Seule une creation forcee est possible sur ce compte.");
    return;
  }

  const suggested =
    eligibility.maxPayout >= eligibility.minPayout ? eligibility.maxPayout.toFixed(2) : "";
  const amountStr = await input({
    message: force
      ? "Montant du payout (bornes ignorees) :"
      : `Montant du payout (entre ${formatCurrency(eligibility.minPayout)} et ${formatCurrency(eligibility.maxPayout)}) :`,
    default: suggested,
    validate: (v) => {
      const n = parseFloat(v);
      if (isNaN(n) || n <= 0) return "Doit etre un montant positif";
      return true;
    },
  });
  const payoutAmount = parseFloat(amountStr);

  const postalAddress = [user.address, [user.postal_code, user.city].filter(Boolean).join(" ")]
    .filter((part) => part && String(part).trim())
    .join(", ");

  if (!postalAddress) {
    ui.error("Cet utilisateur n'a pas d'adresse postale : le manager refusera la demande.");
    return;
  }

  ui.sectionHeader("Recapitulatif");
  renderKeyValue({
    "Compte": display.label,
    "Trader": `${user.firstname} ${user.lastname} <${user.email}>`,
    "Montant": formatCurrency(payoutAmount),
    "Profit split": profitSplit + (options.length > 0 ? "" : "   (aucune option sur le compte)"),
    "Adresse": postalAddress,
    "Regles": force ? "FORCEES (compte non eligible)" : "respectees",
    "Emails": "aucun (le trader ne sera pas notifie)",
    "Tracking": "payout_requested emis avec le vrai user_uuid",
  });

  // The account this payout would later be settled against, spelled out before
  // anything is created. Staging and production share one MT5 server, so the
  // login is the only thing that says which account a later "marquer comme paye"
  // would actually debit — and an operator can have pasted a production login
  // onto a staging account to reproduce a bug.
  if (display.brokerName === "mt5") {
    ui.warn(
      `Un passage ulterieur a "paye" debitera le compte MT5 ${display.login} ` +
        `sur mt5.wegetfunded.com (serveur partage staging/production).`
    );
  }

  const description =
    `Creer une demande de payout de ${formatCurrency(payoutAmount)} sur ${display.label} ` +
    `(${user.email})${force ? " en FORCANT les regles d'eligibilite" : ""}`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  let created;
  try {
    created = await postSimulatePayout(config, env, {
      tradingAccountUuid: account.trading_account_uuid,
      accountLogin: String(display.login),
      platform: display.brokerName,
      firstName: user.firstname,
      lastName: user.lastname,
      postalAddress,
      payoutAmount,
      profitSplit,
      force,
    });
  } catch (err) {
    ui.error(`Creation refusee : ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // The audit entry is also what makes this request deletable later: the
  // deletion action only lists payouts carrying a PAYOUT_SIMULATED log, so a
  // genuine trader request can never be removed by mistake.
  await auditLogQ.insertAuditLog(
    conn,
    "PAYOUT_SIMULATED",
    "payout_request",
    created.payout_request_uuid,
    {
      email: user.email,
      account: display.label,
      trading_account_uuid: account.trading_account_uuid,
      amount: payoutAmount,
      profit_split: created.profit_split,
      forced: force,
      eligible_at_creation: eligibility.eligible,
    },
    operator,
    env
  );

  ui.success(`Demande de payout creee : ${created.payout_request_uuid}`);
  renderKeyValue({
    "Statut": created.status,
    "Montant": formatCurrency(created.payout_amount),
    "Profit split": created.profit_split,
    "Balance avant": formatCurrency(created.balance_before_request),
    "Profit total": formatCurrency(created.total_profit),
  });

  console.log("");
  ui.info('Suite du flux via "Gerer une demande de payout" : approuver, puis marquer comme paye.');
  ui.warn("Tant qu'elle est en attente, cette demande empeche le trader d'en faire une vraie.");
  ui.info('Pour nettoyer : "Supprimer une demande de payout simulee".');
}
