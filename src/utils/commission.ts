import { getExchangeRates } from "./exchange-rates.js";

export interface CommissionSale {
  payment_price: number | null;
  payment_method: string | null;
  payment_currency: string | null;
  percent_profits: number;
}

export interface SettlementAmount {
  amount: number;
  currency: string;
}

export interface AffiliationBalance {
  totalRevenue: number;
  totalCommission: number;
  totalSettled: number;
  currentBalance: number;
}

function roundCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function currencyOf(currency: string | null): string {
  return (currency ?? "EUR").toUpperCase();
}

/**
 * Fiat prices are stored in cents, crypto prices in whole currency units. Dividing
 * everything by 100 under-counts crypto commission a hundredfold.
 */
function priceInCurrencyUnits(sale: CommissionSale): number {
  const price = Number(sale.payment_price);

  return sale.payment_method?.toLowerCase() === "fiat" ? price / 100 : price;
}

function toEur(amount: number, currency: string, rates: Record<string, number>): number {
  if (currency === "EUR") return amount;

  const rate = rates[currency];

  if (!rate) {
    throw new Error(`Taux de change indisponible pour ${currency}. Reglement impossible.`);
  }

  return amount / rate;
}

/**
 * Settlement amounts are already stored in currency units, unlike payments.
 */
export async function computeAffiliationBalance(
  sales: CommissionSale[],
  settlements: SettlementAmount[]
): Promise<AffiliationBalance> {
  const paidSales = sales.filter((s) => s.payment_price != null);

  const currencies = [
    ...paidSales.map((s) => currencyOf(s.payment_currency)),
    ...settlements.map((s) => currencyOf(s.currency)),
  ];

  // Only reach for the network when something is genuinely not in EUR.
  const rates = currencies.some((c) => c !== "EUR") ? await getExchangeRates("EUR") : {};

  const totalRevenue = paidSales.reduce(
    (sum, sale) => sum + toEur(priceInCurrencyUnits(sale), currencyOf(sale.payment_currency), rates),
    0
  );

  const totalCommission = paidSales.reduce((sum, sale) => {
    const commission = priceInCurrencyUnits(sale) * Number(sale.percent_profits);

    return sum + toEur(commission, currencyOf(sale.payment_currency), rates);
  }, 0);

  const totalSettled = settlements.reduce(
    (sum, s) => sum + toEur(Number(s.amount), currencyOf(s.currency), rates),
    0
  );

  // Settlements are stored as DECIMAL(14,2), so rounding to cents before subtracting
  // keeps a fully paid affiliate at exactly zero instead of a sub-cent negative.
  const roundedCommission = roundCents(totalCommission);
  const roundedSettled = roundCents(totalSettled);

  return {
    totalRevenue: roundCents(totalRevenue),
    totalCommission: roundedCommission,
    totalSettled: roundedSettled,
    currentBalance: roundCents(roundedCommission - roundedSettled),
  };
}
