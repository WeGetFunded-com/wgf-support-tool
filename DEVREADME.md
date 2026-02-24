# WGF Support Shell — Architecture & Guide Dev

## Stack technique

| Composant | Technologie |
|-----------|------------|
| Langage | TypeScript (strict, ES2022) |
| Runtime | Node.js 18+ |
| CLI prompts | `@inquirer/prompts` v12 (select, input, checkbox) |
| DB | `mysql2/promise` (prepared statements) |
| Styling | `chalk` v5 (ESM) |
| Env | `dotenv` (chargement `.env` local) |
| Build | `esbuild` → single CJS bundle (`dist/wgf-support.cjs`) |
| Dev | `tsx` (exec TypeScript direct) |

## Commandes

```bash
npm run start    # Dev — exec direct via tsx
npm run build    # Prod — bundle esbuild → dist/wgf-support.cjs
```

---

## Architecture

```
src/
│
├── index.ts                  # Point d'entree — menu env → hub → audit/actions
├── config.ts                 # Chargement .env, validation, types Config/Environment
├── tunnel.ts                 # kubectl port-forward vers pod MySQL (k8s)
├── db.ts                     # DatabaseSession persistante + auto-DDL audit_log
├── ui.ts                     # Affichage CLI (banner, success/error/warn, sections)
├── types.ts                  # Toutes les interfaces DB + constantes metier
│
├── utils/
│   ├── uuid.ts               # generateUuid, isValidUuid, formatUuid
│   ├── format.ts             # Formateurs (%, devise, date, phase, success...)
│   ├── table.ts              # renderKeyValue + renderTable (ASCII tables)
│   └── prompts.ts            # Prompts reutilisables (searchUser, searchTA, confirm)
│
├── queries/                  # Couche SQL pure — 1 fichier par entite
│   ├── user.queries.ts
│   ├── challenge.queries.ts
│   ├── order.queries.ts
│   ├── trading-account.queries.ts
│   ├── trade-history.queries.ts
│   ├── payout.queries.ts
│   ├── promo.queries.ts
│   ├── options.queries.ts
│   └── audit-log.queries.ts
│
├── audit/                    # Modules lecture seule
│   ├── index.ts              # Sous-menu Audit
│   ├── user-report.ts
│   ├── trading-account-report.ts
│   ├── active-accounts.ts
│   ├── search-users.ts
│   └── payout-report.ts
│
└── actions/                  # Modules ecriture (transactions)
    ├── index.ts              # Sous-menu Actions
    ├── create-challenge.ts
    ├── fix-profit-target.ts
    ├── phase-transition.ts
    ├── deactivate-account.ts
    ├── reactivate-account.ts
    ├── payout-manage.ts
    ├── create-promo.ts
    ├── manage-options.ts
    └── update-ctrader-id.ts
```

---

## Flux de navigation

```
main()
  └─ banner()
  └─ mainMenu()  ←──────────────────────────────── boucle
       ├─ select env (staging / production / quit)
       ├─ [si prod] productionWarning + saisie "PRODUCTION"
       ├─ saisie nom operateur
       ├─ createSession(config, env, operator)
       │    ├─ openTunnel()  → kubectl port-forward
       │    ├─ mysql.createConnection()
       │    ├─ SELECT 1 (health check)
       │    └─ CREATE TABLE IF NOT EXISTS admin_audit_log
       │
       └─ hubMenu(session)  ←─────────────────── boucle
            ├─ Audit       → auditMenu(session)
            │    ├─ Rapport utilisateur
            │    ├─ Rapport compte trading
            │    ├─ Comptes actifs
            │    ├─ Recherche utilisateurs
            │    └─ Rapport payouts
            │
            ├─ Actions     → actionsMenu(session)
            │    ├─ Creer challenge
            │    ├─ Fix profit target
            │    ├─ Transition de phase
            │    ├─ Desactiver compte
            │    ├─ Reactiver compte
            │    ├─ Gerer payout
            │    ├─ Creer code promo
            │    ├─ Gerer options
            │    └─ Mettre a jour cTrader ID
            │
            └─ Deconnexion → session.close() → retour mainMenu
```

---

## Patterns & conventions

### DatabaseSession

La connexion MySQL est ouverte une seule fois par session et partagee entre tous les modules. L'objet `DatabaseSession` est passe partout :

```typescript
interface DatabaseSession {
  connection: mysql.Connection;   // connexion MySQL persistante
  env: Environment;               // "staging" | "production"
  operator: string;               // nom de l'operateur (audit log)
  close(): Promise<void>;         // ferme connexion + tunnel
}
```

### UUIDs (binary(16))

La BDD stocke les UUIDs en `binary(16)`. On utilise les fonctions MySQL natives :

```sql
-- Lecture : BIN_TO_UUID() dans les SELECT
SELECT BIN_TO_UUID(user_uuid) as user_uuid, email FROM user WHERE ...

-- Ecriture : UUID_TO_BIN() dans les WHERE / INSERT
WHERE user_uuid = UUID_TO_BIN(?)
INSERT INTO ... VALUES (UUID_TO_BIN(?), ...)
```

Generation cote TypeScript : `crypto.randomUUID()` via `utils/uuid.ts`.

### Couche queries

Chaque fichier `queries/*.queries.ts` suit le meme pattern :

```typescript
import type mysql from "mysql2/promise";
import type { DbEntity } from "../types.js";

type Conn = mysql.Connection;

// Lecture
export async function getEntityByX(conn: Conn, x: string): Promise<DbEntity | null> {
  const [rows] = await conn.execute(`SELECT ... FROM table WHERE ...`, [x]);
  return (rows as DbEntity[])[0] ?? null;
}

// Ecriture
export async function updateEntity(conn: Conn, uuid: string, value: string): Promise<void> {
  await conn.execute(`UPDATE table SET ... WHERE uuid = UUID_TO_BIN(?)`, [value, uuid]);
}
```

Regles :
- Toutes les fonctions prennent `mysql.Connection` en premier argument
- Les fonctions de lecture retournent des types de `types.ts`
- Les fonctions d'ecriture retournent `void`
- Pas de logique metier dans les queries, juste du SQL

### Modules action — protocole de securite

Chaque action suit le meme squelette :

```typescript
export async function myAction(session: DatabaseSession): Promise<void> {
  const { connection: conn, env, operator } = session;

  // 1. Recherche / selection de l'entite
  const entity = await searchPrompt(conn);
  if (!entity) return;

  // 2. Affichage etat actuel
  ui.sectionHeader("...");
  renderKeyValue({ ... });

  // 3. Saisie des modifications
  const newValue = await input({ ... });

  // 4. Confirmation (simple + double si prod)
  const confirmed = await confirmProductionAction(env, "description de l'action");
  if (!confirmed) { ui.info("Action annulee."); return; }

  // 5. Transaction SQL
  await conn.beginTransaction();
  try {
    await someQuery.update(conn, ...);
    await auditLogQ.insertAuditLog(conn, "ACTION_TYPE", "table", uuid, { ... }, operator, env);
    await conn.commit();
    ui.success("...");
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}
```

Points cles :
- **Transaction** : toujours `beginTransaction` / `commit` / `rollback`
- **Audit log** : insertion dans `admin_audit_log` avec details JSON (avant/apres)
- **Double confirmation** : en staging = "OUI", en production = "OUI" puis "CONFIRMER"
- **Pas de catch silencieux** : on `throw err` apres rollback, l'erreur remonte au menu

### Modules audit — lecture seule

Les modules audit ne font que des SELECT. Pas de transaction, pas de confirmation. Pattern :

```typescript
export async function myReport(session: DatabaseSession): Promise<void> {
  const { connection: conn } = session;

  const entity = await searchPrompt(conn);
  if (!entity) return;

  ui.sectionHeader("Titre");
  renderKeyValue({ ... });     // donnees cle/valeur
  renderTable([...], [...]);   // tableau ASCII
}
```

---

## Constantes metier

### Phases (depuis le backend Go)

| Constante | Valeur | Contexte |
|-----------|--------|----------|
| `PHASE.UNLIMITED` | 0 | Phase unique unlimited |
| `PHASE.STANDARD_ONE` | 1 | Phase 1 standard (2-step) |
| `PHASE.STANDARD_TWO` | 2 | Phase 2 standard |
| `PHASE.INSTANT_FUNDED_RULES` | 3 | Regles instant funded (dans challenge_rules) |
| `PHASE.FUNDED_STANDARD` | 4 | Compte funded standard |
| `PHASE.FUNDED_UNLIMITED` | 5 | Compte funded unlimited |

### Transitions de phase

```
standard :  Phase 1 → Phase 2 (demo)  →  Funded Standard phase 4 (live)
unlimited : Phase 0 → Funded Unlimited phase 5 (live)
```

Definies dans `PHASE_TRANSITIONS` (`types.ts`).

### Reasons (depuis `watch_controller.go`)

| Reason | Utilisation |
|--------|------------|
| `MAX_DAILY_DRAW_DOWN` | Drawdown journalier depasse |
| `MAX_DRAW_DOWN` | Drawdown total depasse |
| `NEWS_VIOLATION` | Violation regle news trading |
| `CHALLENGE_EXPIRED` | Challenge expire |
| `CHALLENGE_REVIEW` | Mis en revue support |
| `CHALLENGE_SUCCEED` | Challenge reussi (transition) |
| `FUNDED_ACTIVATED` | Compte funded active |
| `PROFIT_TARGET_RECALCULATED` | Profit target recalcule/corrige |
| `NO_TRADE_HISTORY_ZOMBIE` | Compte zombie |
| `TRADER_NOT_FOUND` | Trader non trouve cTrader |

---

## Connexion & infrastructure

```
CLI  →  kubectl port-forward  →  MySQL Pod (k8s)  →  model_db
```

La config est chargee depuis `.env` (pas de commit, fourni par admin) :

```
KUBE_SERVER / KUBE_TOKEN           # Acces cluster k8s
STAGING_NAMESPACE / POD / PORT     # Tunnel staging
PRODUCTION_NAMESPACE / POD / PORT  # Tunnel production
*_DB_NAME / DB_USER / DB_PASSWORD  # Credentials MySQL
```

Le tunnel (`tunnel.ts`) :
1. Trouve un port local libre
2. Spawn `kubectl port-forward pod/<name> <localPort>:<podPort>`
3. Attend que le port reponde (`waitForPort`)
4. Retourne `{ localPort, close() }`

---

## Audit log

Table `admin_audit_log` (auto-creee au `createSession`) :

| Colonne | Type | Description |
|---------|------|-------------|
| `id` | INT AUTO_INCREMENT | PK |
| `action_type` | VARCHAR(64) | `CREATE_CHALLENGE`, `PHASE_TRANSITION`, `FIX_PROFIT_TARGET`... |
| `target_table` | VARCHAR(64) | `trading_account`, `payout_request`, `promo`... |
| `target_uuid` | BINARY(16) | UUID de l'entite modifiee |
| `details` | JSON | Etat avant/apres, params de l'action |
| `operator` | VARCHAR(128) | Nom saisi a la connexion |
| `environment` | VARCHAR(16) | `staging` ou `production` |
| `executed_at` | DATETIME | Timestamp auto |

---

## Ajouter un nouveau module

### Nouvelle action

1. Creer `src/actions/my-action.ts` (suivre le squelette ci-dessus)
2. Ajouter les queries necessaires dans `src/queries/` (ou reutiliser l'existant)
3. Ajouter l'import + le case dans `src/actions/index.ts`
4. Ajouter le type dans `ActionChoice` et l'entree dans `choices`

### Nouvel audit

1. Creer `src/audit/my-report.ts`
2. Ajouter l'import + le case dans `src/audit/index.ts`
3. Ajouter le type dans `AuditChoice` et l'entree dans `choices`

### Nouvelle query

1. Ajouter la fonction dans le fichier `queries/*.queries.ts` existant correspondant a l'entite
2. Si nouvelle entite : creer un fichier `queries/entity.queries.ts` + ajouter l'interface dans `types.ts`

### Nouveau type / constante

Tout dans `types.ts`. Les constantes metier (phases, reasons, transitions) sont centralisees la.

---

## Schema BDD (tables principales)

```
user ──┬──> orders ──┬──> challenge
       │             ├──> payment
       │             ├──> order_options ──> options
       │             └──> trading_account ──┬──> trade_history
       │                                    ├──> positions
       │                                    ├──> trading_account_options ──> options
       │                                    └──> trading_account_last_balance_and_equity
       ├──> payout_request
       └──> funded_activation

challenge ──> challenge_rules (par phase)
promo / used_promo / affiliation_code (codes promo & affiliation)
admin_audit_log (logs des actions support)
```

### Relations cles

- `trading_account.order_uuid` → `orders.order_uuid` (1 order peut avoir N accounts si progression de phase)
- `orders.user_uuid` → `user.user_uuid`
- `orders.challenge_uuid` → `challenge.challenge_uuid`
- `challenge_rules` composite PK = (`challenge_uuid`, `phase`)
- `trading_account.success` : `NULL` = actif, `1` = reussi, `0` = echoue

### Flux metier

```
Achat challenge
  → payment + order (+ order_options)
    → trading_account phase 1 (demo) + trade_history initial

Phase 1 reussie (standard)
  → ancien compte success=1 reason=CHALLENGE_SUCCEED
    → nouveau trading_account phase 2 (demo)

Phase 2 reussie (standard)
  → ancien compte success=1
    → nouveau trading_account phase 4 (live = funded)

Unlimited reussi
  → ancien compte success=1
    → funded_activation (paiement)
      → nouveau trading_account phase 5 (live)
```
