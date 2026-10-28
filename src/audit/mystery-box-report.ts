import type { DatabaseSession } from "../db.js";
import * as ui from "../ui.js";
import { searchUserPrompt } from "../utils/prompts.js";
import { renderMysteryBoxes } from "../utils/mystery-box.js";

/** Read-only view of a trader's Mystery Boxes: inventory, openings, revoked boxes, codes and vouchers. */
export async function mysteryBoxReport(session: DatabaseSession): Promise<void> {
  const user = await searchUserPrompt(session.connection);
  if (!user) return;

  ui.info(`${user.firstname} ${user.lastname} <${user.email}>`);
  await renderMysteryBoxes(session.connection, user);
  ui.info('Pour offrir ou retirer des boxes : Actions > "Mystery Box".');
}
