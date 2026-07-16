const FX_API_URL = "https://api.fxratesapi.com/latest";

/**
 * Rates are expressed per unit of `base`, so a foreign amount is converted back to
 * the base currency by dividing. Same source as the admin dashboard, so both tools
 * land on the same figure.
 */
export async function getExchangeRates(base = "EUR"): Promise<Record<string, number>> {
  const response = await fetch(`${FX_API_URL}?base=${base}`);

  if (!response.ok) {
    throw new Error(`Echec de recuperation des taux de change (${response.status} ${response.statusText}).`);
  }

  const data = (await response.json()) as { rates?: Record<string, number> };

  if (!data.rates) {
    throw new Error("Reponse de taux de change invalide : champ 'rates' absent.");
  }

  return data.rates;
}
