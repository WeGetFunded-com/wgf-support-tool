import type { DatabaseSession } from "../db.js";
import * as ui from "../ui.js";
import { searchUserPrompt } from "../utils/prompts.js";
import { renderXp } from "../utils/xp.js";

/** Read-only view of a trader's level: XP, journal, rewards and vouchers. */
export async function xpReport(session: DatabaseSession): Promise<void> {
  const { connection: conn } = session;

  const user = await searchUserPrompt(conn);
  if (!user) return;

  ui.info(`${user.firstname} ${user.lastname} <${user.email}>`);
  await renderXp(conn, user, 30);
  ui.info('Pour ajouter ou retirer de l\'XP : Actions > "Niveau et XP d\'un utilisateur".');
}
