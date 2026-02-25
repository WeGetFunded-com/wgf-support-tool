# WGF Support Shell

Outil interne WeGetFunded pour le support client. Permet de consulter et modifier les donnees en staging et production.

Aucune connaissance technique requise — l'outil vous guide etape par etape.

---

## Installation

Ouvrez un terminal et collez la commande correspondant a votre systeme :

**macOS / Linux :**

```sh
curl -fsSL https://raw.githubusercontent.com/WeGetFunded-com/wgf-support-tool/main/scripts/install.sh | sh
```

**Windows (PowerShell) :**

```powershell
irm https://raw.githubusercontent.com/WeGetFunded-com/wgf-support-tool/main/scripts/install.ps1 | iex
```

Le script installe automatiquement tout ce qui est necessaire (Node.js, kubectl, l'outil).

---

## Configuration

Apres l'installation, demandez le fichier `.env` a votre administrateur et placez-le dans le dossier de l'outil :

| Systeme | Emplacement |
|---|---|
| macOS / Linux | `~/.wgf-support-tool/.env` |
| Windows | `C:\Users\<votre-nom>\.wgf-support-tool\.env` |

**Vous n'avez pas a modifier ce fichier** — il contient deja tous les acces.

---

## Utilisation

Fermez et rouvrez votre terminal, puis tapez :

```
wgf-support
```

Vous devrez choisir un environnement (Staging ou Production) puis saisir votre nom (pour la tracabilite).

La connexion a la **production** demande une confirmation supplementaire (tapez `PRODUCTION`).

---

## Fonctionnalites

### Audit (consultation — aucune modification)

| Fonction | Description |
|---|---|
| **Rapport utilisateur** | Fiche complete d'un utilisateur : infos perso, commandes, comptes de trading (avec balance, phase, statut), resume des positions actives, et historique des payouts. Recherche par email ou nom. |
| **Rapport compte de trading** | Detail complet d'un compte : infos cTrader, phase, profit target, regles du challenge, balance/equity, options actives, historique des phases, 10 derniers trade history, et resume des positions. Recherche par cTrader ID ou email. |
| **Comptes actifs d'un utilisateur** | Liste rapide de tous les comptes actifs d'un utilisateur avec phase, serveur, profit target et dates. |
| **Rechercher des utilisateurs** | Recherche par email, nom ou CTID. Affiche un tableau avec les resultats trouves. |
| **Rapport des payouts** | Liste toutes les demandes de payout avec filtre par statut (pending, approved, paid, rejected). Permet de voir le detail d'une demande (IBAN, wallet, montant, profit split). |
| **Analyse de desactivation** | Rapport complet d'un compte desactive : toutes les donnees du compte, regles, historique de trading, positions, logs d'audit. Lance ensuite un **chat AI** qui analyse la desactivation et donne un diagnostic. |

---

### Actions (modifications — avec confirmation)

Toutes les actions sont logguees dans la table d'audit avec votre nom d'operateur.

En production, chaque action demande une confirmation explicite.

| Action | Description | Ce que ca fait |
|---|---|---|
| **Creer un compte de trading** | Cree un nouveau compte pour un utilisateur existant. | Choix du challenge et des options, creation de l'order + payment en DB, puis appel au TAM (Trading Account Manager) via un Job Kubernetes pour creer le compte cTrader. Rollback automatique si le Job echoue. |
| **Corriger le profit target** | Modifie le profit target d'un compte. | Recherche du compte par cTrader ID ou email, affichage de la valeur actuelle vs la reference (rules), puis mise a jour en DB. |
| **Activation d'un Funded** | Fait passer un compte en phase funded. | Verifie l'eligibilite (phase correcte, type standard/unlimited), lance un Job K8s pour simuler le funded via le watcher. Pour les unlimited, propose de bypasser les frais d'activation. |
| **Bypass des frais d'activation** | Active un funded sans facturer les 149.90 EUR. | Recherche une funded_activation en statut "pending", puis lance un Job K8s qui appelle le service order pour traiter l'activation sans paiement. |
| **Desactiver un compte** | Desactive un compte de trading actif. | Choix du motif de desactivation, puis mise a jour du statut en DB (success = 0). |
| **Gerer une demande de payout** | Approve, rejette ou marque un payout comme paye. | Affiche les payouts pending (ou d'un autre statut), detail complet (IBAN, wallet, montant), et change le statut. |
| **Reactiver un compte** | Reactive un compte desactive. | Remet le compte en actif (success = null, reason vide). Propose optionnellement de reajuster le profit target. |
| **Creer un code promo** | Cree un nouveau code promo. | Configuration complete : pourcentage, global/personnel, usage unique/illimite, liaison a un challenge ou utilisateur, date d'expiration, ID Stripe, descriptions multilingues. |
| **Gerer les options d'un compte** | Ajoute ou retire une option sur un compte. | Affiche les options actuelles, permet d'en ajouter (parmi celles disponibles) ou d'en retirer. |
| **Mettre a jour le cTrader ID** | Change le cTrader Account ID d'un compte. | Utile quand le compte cTrader a ete recree ou migre. |
| **Verification de la desactivation** | Analyse complete + possibilite de reactiver. | Meme analyse que l'audit (donnees + AI), puis propose directement de reactiver le compte si necessaire. |

---

## Navigation

```
Menu principal
  |
  |-- Staging / Production
        |
        |-- Audit (consultation)
        |     |-- Rapport utilisateur
        |     |-- Rapport compte de trading
        |     |-- Comptes actifs
        |     |-- Recherche utilisateurs
        |     |-- Rapport payouts
        |     |-- Analyse de desactivation (+ AI)
        |
        |-- Actions (modifications)
              |-- Creer un compte de trading
              |-- Corriger le profit target
              |-- Activation d'un Funded
              |-- Bypass des frais d'activation
              |-- Desactiver un compte
              |-- Gerer une demande de payout
              |-- Reactiver un compte
              |-- Creer un code promo
              |-- Gerer les options d'un compte
              |-- Mettre a jour le cTrader ID
              |-- Verification de desactivation (+ AI)
```

---

## Resolution de problemes

| Message | Solution |
|---|---|
| `Fichier .env introuvable` | Verifiez que le fichier `.env` est bien dans `~/.wgf-support-tool/` |
| `kubectl n'est pas installe` | Relancez le script d'installation ou contactez votre administrateur |
| `Identifiants incorrects` | Demandez un fichier `.env` a jour a votre administrateur |
| `Timeout en attendant le tunnel` | Verifiez votre connexion internet et reessayez |
| `Le tunnel a echoue` | Le token Kubernetes a peut-etre expire — demandez un nouveau `.env` |
| `Analyse AI non disponible` | Ajoutez `OPENROUTER_API_KEY` dans le `.env` (optionnel) |

---

## Mise a jour

Pour mettre a jour l'outil, relancez simplement la commande d'installation. Votre fichier `.env` sera conserve.

---

*By 6real — le CTO qui vous veut du bien*
