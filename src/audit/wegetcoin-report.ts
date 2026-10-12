import type { DatabaseSession } from "../db.js";
import * as ui from "../ui.js";
import { searchUserPrompt } from "../utils/prompts.js";
import { renderWeGetCoins } from "../utils/wegetcoin.js";

/** Read-only view of a trader's WeGetCoins: balance, held part and latest movements. */
export async function weGetCoinReport(session: DatabaseSession): Promise<void> {
  const { connection: conn } = session;

  const user = await searchUserPrompt(conn);
  if (!user) return;

  ui.info(`${user.firstname} ${user.lastname} <${user.email}>`);
  await renderWeGetCoins(conn, user, 30);
  ui.info('Pour crediter ou debiter : Actions > "WeGetCoins d\'un utilisateur".');
}
