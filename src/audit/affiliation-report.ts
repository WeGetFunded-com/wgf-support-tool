import type { DatabaseSession } from "../db.js";
import * as affQ from "../queries/affiliation.queries.js";
import * as ui from "../ui.js";
import { searchUserPrompt } from "../utils/prompts.js";
import { renderKeyValue, renderTable } from "../utils/table.js";
import { formatDate, formatCurrency, formatPercent, formatChallengeName } from "../utils/format.js";

export async function affiliationReport(session: DatabaseSession): Promise<void> {
  const { connection: conn } = session;

  const user = await searchUserPrompt(conn);
  if (!user) return;

  ui.sectionHeader(`Analyse de l'affiliation : ${user.firstname} ${user.lastname}`);
  renderKeyValue({
    "Email": user.email,
    "CTID": String(user.CTID),
    "UUID": user.user_uuid,
  });

  // ── Code d'affiliation ──
  ui.sectionHeader("Code(s) d'affiliation");

  const codes = await affQ.getAffiliationCodesByOwner(conn, user.user_uuid);
  if (codes.length === 0) {
    ui.warn("Cet utilisateur n'a pas de code d'affiliation.");
    return;
  }

  renderTable(
    ["Code", "Reduction", "Commission", "Usage unique", "Expiration"],
    codes.map((c) => [
      c.code,
      formatPercent(c.percent_promo),
      formatPercent(c.percent_profits),
      c.one_time_use ? "Oui" : "Non",
      c.expires_at ? formatDate(c.expires_at) : "Jamais",
    ])
  );

  // ── Filleuls (inscriptions via le code) ──
  ui.sectionHeader("Filleuls (inscriptions via le code)");

  const registrations = await affQ.getRegistrationsByOwner(conn, user.user_uuid);

  if (registrations.length === 0) {
    ui.info("Aucun filleul inscrit.");
  } else {
    const withAccount = registrations.filter((r) => r.account_user_uuid !== null).length;
    const withoutAccount = registrations.length - withAccount;

    renderTable(
      ["Email", "Nom", "CTID", "Code", "Inscrit le", "Compte cree"],
      registrations.map((r) => [
        r.email,
        r.account_firstname && r.account_lastname
          ? `${r.account_firstname} ${r.account_lastname}`
          : "-",
        r.account_ctid != null ? String(r.account_ctid) : "-",
        r.code,
        formatDate(r.date_registration),
        r.account_user_uuid ? "Oui" : "Non",
      ])
    );

    ui.info(
      `${registrations.length} filleul(s) inscrit(s) : ${withAccount} avec compte WGF, ${withoutAccount} sans compte.`
    );
  }

  // ── Ventes generees par le code ──
  ui.sectionHeader("Ventes generees par l'affiliation");

  const sales = await affQ.getSalesByOwner(conn, user.user_uuid);

  if (sales.length === 0) {
    ui.info("Aucune vente generee.");
    return;
  }

  renderTable(
    ["Date", "Acheteur", "Challenge", "Type", "Balance", "Promo", "Reduction", "Prix paye", "Commission"],
    sales.map((s) => {
      const price = s.payment_price != null ? Number(s.payment_price) / 100 : 0;
      const percentProfits = Number(s.percent_profits);
      const commission = price * percentProfits;
      return [
        formatDate(s.payment_date),
        s.buyer_email,
        s.challenge_name ? formatChallengeName(s.challenge_name) : "N/A",
        s.challenge_type ?? "N/A",
        s.challenge_initial_coins_amount != null
          ? formatCurrency(s.challenge_initial_coins_amount)
          : "N/A",
        s.promo_code ?? "-",
        s.promo_percent != null ? formatPercent(s.promo_percent) : "-",
        s.payment_price != null ? formatCurrency(price, s.payment_currency ?? "EUR") : "N/A",
        formatCurrency(commission, s.payment_currency ?? "EUR"),
      ];
    })
  );

  // ── Reglements precedents ──
  ui.sectionHeader("Reglements precedents");

  const settlements = await affQ.getSettlementsByOwner(conn, user.user_uuid);

  if (settlements.length === 0) {
    ui.info("Aucun reglement enregistre.");
  } else {
    renderTable(
      ["Date", "Montant", "Operateur", "Environnement", "Note"],
      settlements.map((s) => [
        formatDate(s.settled_at),
        formatCurrency(s.amount, s.currency),
        s.operator,
        s.environment,
        s.note ?? "-",
      ])
    );
  }

  // ── Resume des commissions ──
  ui.sectionHeader("Resume des commissions");

  const salesWithPayment = sales.filter((s) => s.payment_price != null);
  const freeSales = sales.length - salesWithPayment.length;

  const totalRevenue = salesWithPayment.reduce(
    (sum, s) => sum + Number(s.payment_price) / 100,
    0
  );
  const totalCommission = salesWithPayment.reduce(
    (sum, s) => sum + (Number(s.payment_price) / 100) * Number(s.percent_profits),
    0
  );

  const totalSettled = settlements.reduce((sum, s) => sum + Number(s.amount), 0);
  const currentBalance = totalCommission - totalSettled;

  const currency = salesWithPayment[0]?.payment_currency ?? "EUR";
  const uniqueBuyers = new Set(sales.map((s) => s.buyer_user_uuid)).size;

  renderKeyValue({
    "Filleuls inscrits": String(registrations.length),
    "Acheteurs uniques": String(uniqueBuyers),
    "Ventes totales": `${sales.length} (${salesWithPayment.length} payees, ${freeSales} gratuites)`,
    "Chiffre d'affaires": formatCurrency(totalRevenue, currency),
    "Commission totale generee": formatCurrency(totalCommission, currency),
    "Deja regle": formatCurrency(totalSettled, currency),
    "Solde actuel a payer": formatCurrency(currentBalance, currency),
  });
}
