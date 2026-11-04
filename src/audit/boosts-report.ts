import { select } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import * as boostQ from "../queries/challenge-boost.queries.js";
import * as ui from "../ui.js";
import { searchUserPrompt } from "../utils/prompts.js";
import { renderPendingBoosts, renderUserBoosts } from "../utils/challenge-boost.js";

/** Read-only view of the boosts: a trader's, with the possible hedges, or the paid boosts left pending. */
export async function boostsReport(session: DatabaseSession): Promise<void> {
  const scope = await select<"user" | "pending" | "back">({
    message: "Boosts :",
    choices: [
      { name: "Boosts d'un utilisateur (couverture possible)", value: "user" },
      { name: "Boosts payes restes pending (tous les clients)", value: "pending" },
      { name: "Retour", value: "back" },
    ],
  });

  if (scope === "user") {
    const user = await searchUserPrompt(session.connection);
    if (!user) return;
    ui.info(`${user.firstname} ${user.lastname} <${user.email}>`);
    await renderUserBoosts(session.connection, user.user_uuid);
  }
  if (scope === "pending") {
    ui.sectionHeader("Boosts payes restes pending");
    renderPendingBoosts(await boostQ.getPendingBoosts(session.connection));
  }
  if (scope !== "back") ui.info('Pour marquer un boost rembourse ou modifier la grille : Actions > "Boosts".');
}
