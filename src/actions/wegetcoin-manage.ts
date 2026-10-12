import { randomUUID } from "node:crypto";
import { input, select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { Config } from "../config.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { searchUserPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { CENTS_PER_COIN, formatCoins, renderWeGetCoins } from "../utils/wegetcoin.js";
import {
  moveWeGetCoins,
  WeGetCoinRefusedError,
  type SupportKind,
  type WeGetCoinDirection,
} from "../wegetcoin-client.js";

const REASON_MAX_LENGTH = 255;

/**
 * Credits or debits a trader's WeGetCoins by hand: balance corrections,
 * commercial gestures, and refunds, since nothing is refunded automatically.
 * Open to every support account, without cap. The movement goes through the
 * wallet API; the operator is its author and is traced in admin_audit_log.
 */
export async function weGetCoinManage(session: DatabaseSession, config: Config): Promise<void> {
  const { connection: conn, env, operator } = session;

  const user = await searchUserPrompt(conn);
  if (!user) return;

  ui.info(`${user.firstname} ${user.lastname} <${user.email}>`);
  const wallet = await renderWeGetCoins(conn, user, 15);
  const availableCents = wallet.balance_cents - wallet.reserved_cents;

  const direction = await select<WeGetCoinDirection | "back">({
    message: "Action :",
    choices: [
      { name: "Crediter des WeGetCoins", value: "credit" },
      { name: "Debiter des WeGetCoins", value: "debit" },
      { name: "Retour", value: "back" },
    ],
  });
  if (direction === "back") return;

  const kind = await select<SupportKind>({
    message: "Type :",
    choices: [
      { name: "Geste commercial (support_gesture)", value: "support_gesture" },
      { name: "Correction de solde (support_correction)", value: "support_correction" },
    ],
  });

  const coinsStr = await input({
    message:
      direction === "debit"
        ? `Nombre de WeGetCoins a debiter (disponible : ${Math.trunc(availableCents / CENTS_PER_COIN)}) :`
        : "Nombre de WeGetCoins a crediter :",
    validate: (v) => (/^[1-9]\d*$/.test(v.trim()) ? true : "Un nombre entier de WeGetCoins, superieur a 0"),
  });
  const amountCents = Number(coinsStr.trim()) * CENTS_PER_COIN;

  if (direction === "debit" && amountCents > availableCents) {
    ui.error(`Debit refuse : ${formatCoins(amountCents)} demandes, ${formatCoins(availableCents)} disponibles.`);
    return;
  }

  const reason = (
    await input({
      message: "Motif (obligatoire, garde sur la ligne du journal et en audit) :",
      validate: (v) => {
        const trimmed = v.trim();
        if (!trimmed) return "Le motif est obligatoire";
        if (trimmed.length > REASON_MAX_LENGTH) return `${REASON_MAX_LENGTH} caracteres maximum`;
        return true;
      },
    })
  ).trim();

  const signedCents = direction === "debit" ? -amountCents : amountCents;
  ui.sectionHeader("Recapitulatif");
  renderKeyValue({
    "Trader": `${user.firstname} ${user.lastname} <${user.email}>`,
    "Mouvement": `${direction === "debit" ? "-" : "+"}${formatCoins(amountCents)}`,
    "Type": kind,
    "Motif": reason,
    "Solde apres": formatCoins(wallet.balance_cents + signedCents),
    "Auteur": operator,
  });

  const description =
    `${direction === "debit" ? "Debiter" : "Crediter"} ${formatCoins(amountCents)} ` +
    `${direction === "debit" ? "du wallet de" : "sur le wallet de"} ${user.email} (${kind})`;
  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  let result;
  try {
    result = await moveWeGetCoins(config, env, direction, {
      userUuid: user.user_uuid,
      amountCents,
      kind,
      reason,
      operator,
      referenceId: randomUUID(),
    });
  } catch (err) {
    if (err instanceof WeGetCoinRefusedError && err.code === "insufficient_funds") {
      ui.error("Debit refuse par le wallet : solde disponible insuffisant (il a pu changer entre-temps).");
    } else {
      ui.error(`Mouvement refuse : ${err instanceof Error ? err.message : String(err)}`);
    }
    ui.info("Aucun WeGetCoin n'a bouge.");
    return;
  }

  await auditLogQ.insertAuditLog(conn, "WEGETCOIN_SUPPORT_MOVEMENT", "user", user.user_uuid, {
    email: user.email,
    direction,
    kind,
    amount_coins: signedCents / CENTS_PER_COIN,
    reason,
    transaction_uuid: result.transaction.transaction_uuid,
    balance_after_coins: result.wallet.balance_cents / CENTS_PER_COIN,
  }, operator, env);

  ui.success(
    `${direction === "debit" ? "Debit" : "Credit"} enregistre : ` +
      `nouveau solde ${formatCoins(result.wallet.balance_cents)}.`
  );
}
