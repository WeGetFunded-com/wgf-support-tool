import { input } from "@inquirer/prompts";
import chalk from "chalk";
import * as ui from "./ui.js";

// ── Types ──

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── OpenRouter API ──

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "minimax/minimax-m1";

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export function createChat(apiKey: string) {
  const history: ChatMessage[] = [];

  return {
    async send(messages: ChatMessage[]): Promise<string> {
      history.push(...messages);

      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: history,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`OpenRouter API error ${res.status}: ${text}`);
      }

      const data = (await res.json()) as OpenRouterResponse;

      if (data.error?.message) {
        throw new Error(`OpenRouter: ${data.error.message}`);
      }

      const content = data.choices?.[0]?.message?.content ?? "";
      history.push({ role: "assistant", content });
      return content;
    },
  };
}

// ── Interactive chat ──

export async function interactiveChat(
  apiKey: string,
  systemPrompt: string,
  initialUserMessage: string
): Promise<void> {
  const chat = createChat(apiKey);

  const p = chalk.hex("#7C3AED");
  const dim = chalk.gray;

  // Send initial analysis
  ui.sectionHeader("ANALYSE AI (MiniMax)");
  ui.info("Envoi des donnees a MiniMax pour analyse...");
  console.log("");

  try {
    const initialResponse = await chat.send([
      { role: "system", content: systemPrompt },
      { role: "user", content: initialUserMessage },
    ]);

    console.log(p("  ── Analyse initiale ──"));
    console.log("");
    console.log(chalk.white("  " + initialResponse.split("\n").join("\n  ")));
    console.log("");
  } catch (err: unknown) {
    const e = err as { message?: string };
    ui.error(`Erreur API : ${e.message || "Erreur inconnue"}`);
    return;
  }

  // Interactive loop
  console.log(dim("  ╔══════════════════════════════════════════╗"));
  console.log(dim("  ║  CHAT INTERACTIF AVEC MINIMAX           ║"));
  console.log(dim("  ║  (quit/q/exit/Entree vide pour quitter) ║"));
  console.log(dim("  ╚══════════════════════════════════════════╝"));
  console.log("");

  while (true) {
    let question: string;
    try {
      question = await input({
        message: "Votre question :",
      });
    } catch {
      // User pressed Ctrl+C
      break;
    }

    const trimmed = question.trim().toLowerCase();
    if (!trimmed || trimmed === "quit" || trimmed === "q" || trimmed === "exit") {
      ui.info("Fin du chat.");
      break;
    }

    try {
      ui.info("Reflexion en cours...");
      const response = await chat.send([
        { role: "user", content: question },
      ]);

      console.log("");
      console.log(p("  ── Reponse ──"));
      console.log("");
      console.log(chalk.white("  " + response.split("\n").join("\n  ")));
      console.log("");
    } catch (err: unknown) {
      const e = err as { message?: string };
      ui.error(`Erreur API : ${e.message || "Erreur inconnue"}`);
    }
  }
}

// ── System prompt WGF ──

export const WGF_SYSTEM_PROMPT = `Tu es un analyste support expert de la plateforme WeGetFunded (prop trading).
Tu as acces a des donnees brutes d'un compte de trading desactive.

=== TYPES DE CHALLENGES ===
- standard : 2 phases (Phase 1 → Phase 2 → Funded Standard)
  - Phase 1 : DDJ 5%, DDMax 10%, Profit Target 8%, Min 5 jours
  - Phase 2 : DDJ 5%, DDMax 10%, Profit Target 5%, Min 5 jours
- unlimited : 1 phase (Phase 0 → payment 149.90€ → Funded Unlimited)
  - Phase 0 : DDJ 4%, pas de DDMax, Profit Target 10%, Min 5 jours
- instant_funded : directement en phase funded (Phase 3)
  - Phase 3 : DDJ 3%, DDMax 5%, pas de profit target
- funded_standard (Phase 4) : DDJ 5%, DDMax 10%
- funded_unlimited (Phase 5) : DDJ 4%, pas de DDMax

=== RAISONS DE DESACTIVATION ===
- MAX_DAILY_DRAW_DOWN : Le drawdown journalier a depasse le seuil (DDJ)
  Formule : firstEquityOfDay - currentEquity >= initialDeposit × maxDailyDrawdownPercent
- MAX_DRAW_DOWN : Le drawdown total a depasse le seuil (DDMax)
  Formule : currentEquity < initialDeposit × (1 - maxTotalDrawdownPercent)
- CHALLENGE_EXPIRED : Le challenge a depasse sa date de fin
- NEWS_VIOLATION : Violation news trading (SUPPRIME depuis fev 2025, anciennes violations conservees)
- NO_TRADE_HISTORY_ZOMBIE : Compte sans historique de trading
- TRADER_NOT_FOUND : Trader non trouve sur cTrader
- CHALLENGE_REVIEW : Mis en revue manuellement par le support

=== DAILY-VALIDATION (CRON 23h59 UTC) ===
1. Recalcul du profit target : si le profit journalier (BALANCE) depasse un seuil
   (40% standard, 50% unlimited, 30% funded/instant_funded), le target est recalcule
   - Bypass si option "No Consistency" ou "One Day to Pass"
2. Validation du challenge : verifie si objectif atteint + jours minimum + regle de consistance
   (ne peut pas passer le jour meme du recalcul, sauf options)
3. Expiration des activations funded

=== WATCHER TEMPS REEL (TOUTES LES 5 MIN) ===
Verifie : DDJ, DDMax, expiration challenge, trader existe sur cTrader
Si violation → ferme positions, passe en NO_TRADING, desactive (success=0), envoie email

=== TRAILING DRAWDOWN EOD (post 15 mars 2026) ===
Pour unlimited/funded_unlimited crees apres le 15 mars 2026 :
- Remplace le DDJ fixe par un High Water Mark (HWM) dynamique
- Floor = min(HWM - 4%, deposit), monotone croissant, plafonne au deposit
- Calcule sur les records EOD, pas en temps reel

=== OPTIONS ===
- No Consistency : bypass le recalcul du profit target (standard/unlimited)
- One Day to Pass : bypass recalcul + bypass min jours (unlimited uniquement)
- Second Chance : en cas d'echec, cree automatiquement un nouveau compte
- Profit Split 90/10 ou 100/0 : herite dans les funded

Quand tu analyses un compte, tu dois :
1. Identifier la raison exacte de desactivation
2. Verifier si les regles ont bien ete respectees selon le type de challenge
3. Comparer les donnees reelles (balance, equity, historique) aux seuils du challenge
4. Conclure si la desactivation est legitime ou suspecte
5. Recommander une action (confirmer, investiguer, reactiver)

Reponds toujours en francais. Sois precis et factuel.`;
