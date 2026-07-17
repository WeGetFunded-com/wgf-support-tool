import { select, input } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as gdprQ from "../queries/gdpr.queries.js";
import * as auditLogQ from "../queries/audit-log.queries.js";
import * as ui from "../ui.js";
import { searchUserPrompt, confirmProductionAction } from "../utils/prompts.js";
import { renderKeyValue, renderTable } from "../utils/table.js";

/**
 * Suppression totale RGPD (art. 17 - droit a l'effacement).
 *
 * Deux modes. L'outil detecte seul les motifs de conservation (comptabilite,
 * payouts, filleuls) et propose l'anonymisation quand un effacement physique
 * detruirait des pieces a conserver. L'anonymisation satisfait l'art. 17 :
 * la ligne comptable survit, l'identite disparait.
 */
export async function gdprErase(session: DatabaseSession): Promise<void> {
  const { connection: conn, env, operator } = session;

  const user = await searchUserPrompt(conn);
  if (!user) return;

  const tables = await gdprQ.listTables(conn);
  const scope = await gdprQ.buildScope(conn, user.user_uuid, user.email);

  ui.sectionHeader("Personne concernee");
  renderKeyValue({
    "Email": user.email,
    "Nom": `${user.firstname} ${user.lastname}`.trim(),
    "CTID": String(user.CTID),
    "UUID": user.user_uuid,
    "Telephone": user.phone_number || "-",
    "Ville": user.city || "-",
  });

  const counts = await gdprQ.inventory(conn, scope, tables);
  const present = Object.entries(counts).filter(([, n]) => n > 0);

  ui.sectionHeader("Donnees rattachees");
  if (present.length === 0) {
    ui.info("Aucune donnee rattachee.");
  } else {
    renderTable(
      ["Table", "Lignes"],
      present.map(([table, n]) => [table, String(n)])
    );
  }

  const holds = await gdprQ.detectHolds(conn, scope, tables);

  ui.sectionHeader("Motifs de conservation");
  if (holds.length === 0) {
    ui.success("Aucun motif : l'effacement physique est possible sans risque.");
  } else {
    ui.warn(`${holds.length} motif(s) detecte(s) - un effacement physique detruirait des pieces a conserver :`);
    renderTable(["Motif", "Detail"], holds.map((h) => [h.reason, h.detail]));
  }

  const recommended = holds.length === 0 ? "erase" : "anonymize";

  const mode = await select<"erase" | "anonymize" | "cancel">({
    message: "Mode de traitement :",
    default: recommended,
    choices: [
      {
        name:
          "Effacement total (suppression physique)" +
          (recommended === "erase" ? " — recommande" : " — DANGER : detruit des pieces comptables"),
        value: "erase",
      },
      {
        name:
          "Anonymisation (garde les lignes comptables, detruit l'identite)" +
          (recommended === "anonymize" ? " — recommande" : ""),
        value: "anonymize",
      },
      { name: "Annuler", value: "cancel" },
    ],
  });

  if (mode === "cancel") {
    ui.info("Action annulee.");
    return;
  }

  if (mode === "erase" && holds.length > 0) {
    ui.warn("Vous forcez l'effacement physique malgre des motifs de conservation.");
    ui.warn("Cela detruit des pieces comptables. N'y allez pas sans avis juridique.");
    const ack = await input({
      message: 'Tapez "JE SAIS" pour passer outre (ou Entree pour annuler) :',
    });
    if (ack.trim() !== "JE SAIS") {
      ui.info("Action annulee.");
      return;
    }
  }

  // Les logins broker sont lus avant la suppression : apres, la trace a disparu.
  const brokerLogins = await gdprQ.getBrokerLoginsToPurge(conn, scope, tables);

  const totalRows = present.reduce((sum, [, n]) => sum + n, 0);
  const description =
    mode === "erase"
      ? `EFFACEMENT TOTAL RGPD de ${user.email} (${totalRows} lignes sur ${present.length} tables, IRREVERSIBLE)`
      : `Anonymisation RGPD de ${user.email} (identite detruite, lignes comptables conservees)`;

  const confirmed = await confirmProductionAction(env, description);
  if (!confirmed) {
    ui.info("Action annulee.");
    return;
  }

  await conn.beginTransaction();
  try {
    const applied =
      mode === "erase"
        ? await gdprQ.erase(conn, scope, tables)
        : await gdprQ.anonymize(conn, scope, tables);

    await auditLogQ.insertAuditLog(
      conn,
      mode === "erase" ? "GDPR_ERASURE" : "GDPR_ANONYMIZATION",
      "user",
      user.user_uuid,
      {
        article: "RGPD art.17",
        ctid: user.CTID,
        rows: counts,
        legal_holds: holds,
        forced_despite_holds: mode === "erase" && holds.length > 0,
        applied,
        broker_logins_to_purge: brokerLogins,
      },
      operator,
      env
    );

    // Verification avant commit : rien ne doit survivre a un effacement,
    // et plus aucun email en clair apres une anonymisation.
    if (mode === "erase") {
      if (await gdprQ.userStillExists(conn, user.user_uuid)) {
        throw new Error("Verification post-suppression : la ligne user survit.");
      }
    } else if (await gdprQ.emailStillExists(conn, user.email)) {
      throw new Error("Verification post-anonymisation : l'email survit.");
    }

    await conn.commit();

    ui.success(
      mode === "erase"
        ? `Donnees de ${user.email} effacees definitivement.`
        : `Donnees de ${user.email} anonymisees.`
    );
    if (applied.length > 0) {
      renderTable(
        ["Table", "Lignes"],
        applied.map((a) => {
          const [table, n] = a.split(": ");
          return [table, n];
        })
      );
    }
  } catch (err) {
    await conn.rollback();
    ui.error("Rollback : aucune modification appliquee.");
    throw err;
  }

  // La base ne suffit pas : ces systemes gardent la donnee de leur cote.
  ui.sectionHeader("A traiter hors base");
  if (brokerLogins.length > 0) {
    ui.warn(`MT5 / cTrader : supprimer le(s) compte(s) ${brokerLogins.join(", ")} cote serveur broker.`);
  } else {
    ui.info("MT5 / cTrader : aucun compte broker rattache.");
  }
  ui.warn(`Brevo : supprimer le contact ${user.email} (sinon il continue de recevoir les emails).`);
  ui.info("Geidea / Stripe : verifier l'absence de donnee client cote PSP.");
}
