import { select, input } from "@inquirer/prompts";
import type { DatabaseSession } from "../db.js";
import type { DbUser } from "../types.js";
import * as userQ from "../queries/user.queries.js";
import * as ui from "../ui.js";
import { renderTable } from "../utils/table.js";
import { formatBoolean } from "../utils/format.js";

export async function searchUsers(session: DatabaseSession): Promise<void> {
  const { connection: conn } = session;

  const method = await select({
    message: "Rechercher par :",
    choices: [
      { name: "Email", value: "email" },
      { name: "Nom", value: "name" },
      { name: "CTID", value: "ctid" },
    ],
  });

  const query = await input({ message: "Valeur de recherche :" });
  if (!query.trim()) return;

  let users: DbUser[] = [];

  switch (method) {
    case "email":
      users = await userQ.searchUsersByEmail(conn, query.trim());
      break;
    case "name":
      users = await userQ.searchUsersByName(conn, query.trim());
      break;
    case "ctid": {
      const ctid = parseInt(query.trim(), 10);
      if (isNaN(ctid)) {
        ui.error("CTID invalide.");
        return;
      }
      const user = await userQ.getUserByCtid(conn, ctid);
      if (user) users = [user];
      break;
    }
  }

  if (users.length === 0) {
    ui.warn("Aucun utilisateur trouve.");
    return;
  }

  renderTable(
    ["Email", "Nom", "CTID", "Pays", "Actif"],
    users.map((u) => [
      u.email,
      `${u.firstname} ${u.lastname}`,
      String(u.CTID),
      String(u.country_id ?? "N/A"),
      formatBoolean(u.valid),
    ])
  );
}
