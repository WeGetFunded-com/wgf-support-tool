import type { DatabaseSession } from "../db.js";
import type { DbTradingAccount } from "../types.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as btfQ from "../queries/back-to-funded.queries.js";
import * as faQ from "../queries/funded-activation.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as baQ from "../queries/broker-account.queries.js";
import * as ui from "../ui.js";
import { searchTradingAccountPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatDate, formatCurrency, formatChallengeName, formatSqlDateTime } from "../utils/format.js";

const REOPEN_DAYS = 7;

interface ExpiredOffer {
  uuid: string;
  amount: number;
  currency: string;
  status: string;
  created_at: Date;
  expires_at: Date;
}

interface ReopenKind {
  title: string;
  label: string;
  table: string;
  auditAction: string;
  uuidLabel: string;
  missingHint: string;
  load: (session: DatabaseSession, account: DbTradingAccount) => Promise<ExpiredOffer | null>;
  reopen: (session: DatabaseSession, uuid: string, newExpiresAt: string) => Promise<number>;
}

const BACK_TO_FUNDED: ReopenKind = {
  title: "Rouvrir une offre Back to Funded expiree",
  label: "offre Back to Funded",
  table: "back_to_funded",
  auditAction: "REOPEN_BACK_TO_FUNDED",
  uuidLabel: "Offer UUID",
  missingHint: "Aucune offre Back to Funded pour ce compte (il faut le compte funded crame).",
  load: async ({ connection }, account) => {
    const offer = await btfQ.getBackToFundedByAccount(connection, account.trading_account_uuid);
    return offer ? { ...offer, uuid: offer.offer_uuid } : null;
  },
  reopen: ({ connection }, uuid, newExpiresAt) =>
    btfQ.reopenExpiredBackToFunded(connection, uuid, newExpiresAt),
};

const FUNDED_ACTIVATION: ReopenKind = {
  title: "Rouvrir une activation funded expiree",
  label: "activation funded",
  table: "funded_activation",
  auditAction: "REOPEN_FUNDED_ACTIVATION",
  uuidLabel: "Activation UUID",
  missingHint: "Aucune activation funded pour ce compte (il faut le compte de challenge reussi).",
  load: async ({ connection }, account) => {
    const activation = await faQ.getFundedActivationByTradingAccount(connection, account.trading_account_uuid);
    return activation ? { ...activation, uuid: activation.activation_uuid } : null;
  },
  reopen: ({ connection }, uuid, newExpiresAt) =>
    faQ.reopenExpiredFundedActivation(connection, uuid, newExpiresAt),
};

export async function reopenExpiredBackToFunded(session: DatabaseSession): Promise<void> {
  await reopenExpiredOffer(session, BACK_TO_FUNDED);
}

export async function reopenExpiredFundedActivation(session: DatabaseSession): Promise<void> {
  await reopenExpiredOffer(session, FUNDED_ACTIVATION);
}

async function reopenExpiredOffer(session: DatabaseSession, kind: ReopenKind): Promise<void> {
  const { connection: conn, env, operator } = session;

  const account = await searchTradingAccountPrompt(conn);
  if (!account) return;

  const accountDisplay = await baQ.getAccountDisplayId(conn, account);
  const challenge = await challengeQ.getChallengeByUuid(conn, account.challenge_uuid);

  // Only the latest one counts: an older expired row must not be revived.
  const offer = await kind.load(session, account);
  if (!offer) {
    ui.warn(kind.missingHint);
    return;
  }
  if (offer.status !== "expired") {
    ui.warn(`La derniere ${kind.label} de ce compte est en statut '${offer.status}', pas 'expired'. Rien a rouvrir.`);
    return;
  }

  const newExpiresAt = formatSqlDateTime(new Date(Date.now() + REOPEN_DAYS * 24 * 60 * 60 * 1000));

  ui.sectionHeader(kind.title);
  renderKeyValue({
    "Compte": accountDisplay.label,
    "UUID du compte": account.trading_account_uuid,
    "Challenge": challenge
      ? `${formatChallengeName(challenge.name)} (${challenge.type})`
      : "N/A",
    [kind.uuidLabel]: offer.uuid,
    "Montant (inchange)": formatCurrency(offer.amount, offer.currency),
    "Creee le": formatDate(offer.created_at),
    "Expiree le": formatDate(offer.expires_at),
    "Nouvelle echeance": `${newExpiresAt} UTC (+${REOPEN_DAYS} jours)`,
  });
  ui.info("Aucun mail n'est envoye : le client paie depuis son dashboard.");

  const confirmed = await confirmProductionAction(
    env,
    `Rouvrir l'${kind.label} du compte ${accountDisplay.label} jusqu'au ${newExpiresAt} UTC`
  );
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  await conn.beginTransaction();
  try {
    const affected = await kind.reopen(session, offer.uuid, newExpiresAt);
    if (affected !== 1) {
      await conn.rollback();
      ui.error("Aucune ligne modifiee (statut change entre-temps ?). Rien n'a ete fait.");
      return;
    }

    await auditLogQ.insertAuditLog(conn, kind.auditAction, kind.table, offer.uuid, {
      trading_account_uuid: account.trading_account_uuid,
      broker_name: accountDisplay.brokerName,
      account_login: accountDisplay.login,
      amount: offer.amount,
      currency: offer.currency,
      previous_expires_at: formatDate(offer.expires_at),
      new_expires_at: `${newExpiresAt} UTC`,
    }, operator, env);

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  }

  ui.success(
    `${kind.label.charAt(0).toUpperCase()}${kind.label.slice(1)} rouverte. Le client peut payer ${formatCurrency(offer.amount, offer.currency)} ` +
    `depuis son dashboard jusqu'au ${newExpiresAt} UTC.`
  );
}
