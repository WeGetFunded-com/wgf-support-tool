import { input, select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as promoQ from "../queries/promo.queries.js";
import * as challengeQ from "../queries/challenge.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { searchUserPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue } from "../utils/table.js";
import { formatPercent, formatDate, formatBoolean, formatChallengeName } from "../utils/format.js";
import { generateUuid } from "../utils/uuid.js";

export async function createPromo(session: DatabaseSession): Promise<void> {
  const { connection: conn, env, operator } = session;

  // 1. Code
  const code = await input({
    message: "Code promo :",
    validate: (v) => {
      if (v.trim().length < 2) return "Minimum 2 caracteres";
      return true;
    },
  });

  // Check if code already exists
  const existing = await promoQ.getPromoByCode(conn, code.trim());
  if (existing) {
    ui.error(`Le code "${code.trim()}" existe deja.`);
    return;
  }

  // 2. Percent
  const percentStr = await input({
    message: "Pourcentage de reduction (decimal, ex: 0.10 pour 10%) :",
    validate: (v) => {
      const n = parseFloat(v);
      if (isNaN(n) || n <= 0 || n > 1) return "Doit etre un decimal entre 0 et 1";
      return true;
    },
  });
  const percentPromo = parseFloat(percentStr);

  // 3. Global
  const isGlobal = await select({
    message: "Promo globale (disponible pour tout le monde) ?",
    choices: [
      { name: "Oui", value: true },
      { name: "Non", value: false },
    ],
  });

  // 4. Unlimited
  const isUnlimited = await select({
    message: "Reutilisable plusieurs fois ?",
    choices: [
      { name: "Oui (illimite)", value: true },
      { name: "Non (usage unique)", value: false },
    ],
  });

  // 5. Challenge specifique
  const linkChallenge = await select({
    message: "Lier a un challenge specifique ?",
    choices: [
      { name: "Non", value: "no" },
      { name: "Oui", value: "yes" },
    ],
  });

  let challengeUuid: string | null = null;
  if (linkChallenge === "yes") {
    const challenges = await challengeQ.getPublishedChallenges(conn);
    if (challenges.length === 0) {
      ui.warn("Aucun challenge publie trouve.");
    } else {
      const idx = await select({
        message: "Challenge :",
        choices: challenges.map((c, i) => ({
          name: `${formatChallengeName(c.name)} (${c.type}) — ${c.price} EUR`,
          value: i,
        })),
      });
      challengeUuid = challenges[idx].challenge_uuid;
    }
  }

  // 6. User specifique
  const linkUser = await select({
    message: "Lier a un utilisateur specifique ?",
    choices: [
      { name: "Non", value: "no" },
      { name: "Oui", value: "yes" },
    ],
  });

  let userUuid: string | null = null;
  if (linkUser === "yes") {
    const user = await searchUserPrompt(conn);
    if (user) userUuid = user.user_uuid;
  }

  // 7. Phase
  const phaseStr = await input({
    message: "Phase specifique (0-5, ou laisser vide pour 0) :",
    default: "0",
  });
  const phase = parseInt(phaseStr, 10) || 0;

  // 8. Expiration
  const expiresAtStr = await input({
    message: "Date d'expiration (YYYY-MM-DD, ou laisser vide pour aucune) :",
  });
  const expiresAt = expiresAtStr.trim() || null;

  // 9. Stripe ID
  const stripeId = await input({
    message: "Stripe coupon ID (ou laisser vide) :",
  });

  // 10. Descriptions
  const descriptionFr = await input({ message: "Description FR (ou laisser vide) :" });
  const descriptionEn = await input({ message: "Description EN (ou laisser vide) :" });
  const descriptionEs = await input({ message: "Description ES (ou laisser vide) :" });
  const descriptionDe = await input({ message: "Description DE (ou laisser vide) :" });
  const descriptionIt = await input({ message: "Description IT (ou laisser vide) :" });

  // Preview
  ui.sectionHeader("Preview du code promo");
  renderKeyValue({
    "Code": code.trim(),
    "Reduction": formatPercent(percentPromo),
    "Global": formatBoolean(isGlobal ? 1 : 0),
    "Illimite": formatBoolean(isUnlimited ? 1 : 0),
    "Challenge": challengeUuid ?? "Tous",
    "Utilisateur": userUuid ?? "Tous",
    "Phase": String(phase),
    "Expiration": expiresAt ?? "Sans",
    "Stripe ID": stripeId.trim() || "N/A",
    "Desc FR": descriptionFr.trim() || "N/A",
    "Desc EN": descriptionEn.trim() || "N/A",
  });

  const confirmed = await confirmProductionAction(env, `Creer le code promo "${code.trim()}"`);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  const promoUuid = generateUuid();

  await conn.beginTransaction();
  try {
    await promoQ.createPromo(conn, {
      promoUuid,
      code: code.trim(),
      percentPromo,
      isUnlimited,
      isGlobal,
      phase,
      expiresAt,
      stripeId: stripeId.trim() || null,
      userUuid,
      challengeUuid,
      descriptionFr: descriptionFr.trim() || null,
      descriptionEn: descriptionEn.trim() || null,
      descriptionEs: descriptionEs.trim() || null,
      descriptionDe: descriptionDe.trim() || null,
      descriptionIt: descriptionIt.trim() || null,
    });

    await auditLogQ.insertAuditLog(conn, "CREATE_PROMO", "promo", promoUuid, {
      code: code.trim(),
      percent_promo: percentPromo,
      is_global: isGlobal,
      is_unlimited: isUnlimited,
    }, operator, env);

    await conn.commit();
    ui.success(`Code promo "${code.trim()}" cree avec succes !`);
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}
