import { input, select } from "@inquirer/prompts";
import type mysql from "mysql2/promise";
import type { DbUser, DbTradingAccount } from "../types.js";
import * as userQ from "../queries/user.queries.js";
import * as taQ from "../queries/trading-account.queries.js";
import * as ui from "../ui.js";
import { isValidUuid } from "./uuid.js";
import { renderTable } from "./table.js";
import type { Environment } from "../config.js";

export async function searchUserPrompt(conn: mysql.Connection): Promise<DbUser | null> {
  const method = await select({
    message: "Rechercher un utilisateur par :",
    choices: [
      { name: "Email", value: "email" },
      { name: "UUID", value: "uuid" },
      { name: "Nom", value: "name" },
      { name: "CTID", value: "ctid" },
    ],
  });

  const query = await input({ message: "Valeur de recherche :" });
  if (!query.trim()) return null;

  let users: DbUser[] = [];

  switch (method) {
    case "email": {
      if (query.includes("@")) {
        const user = await userQ.getUserByEmail(conn, query.trim());
        if (user) users = [user];
      } else {
        users = await userQ.searchUsersByEmail(conn, query.trim());
      }
      break;
    }
    case "uuid": {
      if (!isValidUuid(query.trim())) {
        ui.error("UUID invalide.");
        return null;
      }
      const user = await userQ.getUserByUuid(conn, query.trim());
      if (user) users = [user];
      break;
    }
    case "name":
      users = await userQ.searchUsersByName(conn, query.trim());
      break;
    case "ctid": {
      const ctid = parseInt(query.trim(), 10);
      if (isNaN(ctid)) {
        ui.error("CTID invalide (doit etre un nombre).");
        return null;
      }
      const user = await userQ.getUserByCtid(conn, ctid);
      if (user) users = [user];
      break;
    }
  }

  if (users.length === 0) {
    ui.warn("Aucun utilisateur trouve.");
    return null;
  }

  if (users.length === 1) return users[0];

  // Multiple results → let user choose
  renderTable(
    ["#", "Email", "Nom", "CTID"],
    users.map((u, i) => [
      String(i + 1),
      u.email,
      `${u.firstname} ${u.lastname}`,
      String(u.CTID),
    ])
  );

  const choice = await select({
    message: "Selectionner un utilisateur :",
    choices: users.map((u, i) => ({
      name: `${u.email} (${u.firstname} ${u.lastname})`,
      value: i,
    })),
  });

  return users[choice];
}

export async function searchTradingAccountPrompt(
  conn: mysql.Connection
): Promise<DbTradingAccount | null> {
  const method = await select({
    message: "Rechercher un compte de trading par :",
    choices: [
      { name: "cTrader Account ID", value: "ctrader" },
      { name: "UUID", value: "uuid" },
    ],
  });

  const query = await input({ message: "Valeur de recherche :" });
  if (!query.trim()) return null;

  let account: DbTradingAccount | null = null;

  switch (method) {
    case "ctrader": {
      const ctraderId = parseInt(query.trim(), 10);
      if (isNaN(ctraderId)) {
        ui.error("cTrader ID invalide (doit etre un nombre).");
        return null;
      }
      account = await taQ.getTradingAccountByCtrader(conn, ctraderId);
      break;
    }
    case "uuid": {
      if (!isValidUuid(query.trim())) {
        ui.error("UUID invalide.");
        return null;
      }
      account = await taQ.getTradingAccountByUuid(conn, query.trim());
      break;
    }
  }

  if (!account) {
    ui.warn("Aucun compte de trading trouve.");
  }

  return account;
}

export async function confirmAction(description: string): Promise<boolean> {
  ui.actionWarning(description);
  const answer = await input({
    message: 'Tapez "OUI" pour confirmer (ou Entree pour annuler) :',
  });
  return answer.trim() === "OUI";
}

export async function confirmProductionAction(
  env: Environment,
  description: string
): Promise<boolean> {
  const confirmed = await confirmAction(description);
  if (!confirmed) return false;

  if (env === "production") {
    ui.productionWarning();
    const answer = await input({
      message: 'Double confirmation PRODUCTION - Tapez "CONFIRMER" :',
    });
    return answer.trim() === "CONFIRMER";
  }

  return true;
}
