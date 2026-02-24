# WGF Support Shell

Outil interne WeGetFunded pour accéder aux bases de données staging et production.

Aucune connaissance technique requise — l'outil vous guide étape par étape.

---

## Installation

Ouvrez un terminal et collez la commande correspondant à votre système :

**macOS / Linux :**

```sh
curl -fsSL https://raw.githubusercontent.com/WeGetFunded-com/wgf-support-tool/main/scripts/install.sh | sh
```

**Windows (PowerShell) :**

```powershell
irm https://raw.githubusercontent.com/WeGetFunded-com/wgf-support-tool/main/scripts/install.ps1 | iex
```

Le script installe automatiquement tout ce qui est nécessaire (Node.js, kubectl, l'outil).

---

## Configuration

Après l'installation, demandez le fichier `.env` à votre administrateur et placez-le dans le dossier de l'outil :

| Système | Emplacement |
|---|---|
| macOS / Linux | `~/.wgf-support-tool/.env` |
| Windows | `C:\Users\<votre-nom>\.wgf-support-tool\.env` |

**Vous n'avez pas à modifier ce fichier** — il contient déjà tous les accès.

---

## Utilisation

Fermez et rouvrez votre terminal, puis tapez :

```
wgf-support
```

Un menu s'affiche :

```
? Que souhaitez-vous faire ?
❯ Se connecter à la BDD Staging
  Se connecter à la BDD Production
  Quitter
```

Sélectionnez un environnement avec les flèches et appuyez sur Entrée.

La connexion à la **production** demande une confirmation supplémentaire (vous devrez taper `PRODUCTION`).

---

## Résolution de problèmes

| Message | Solution |
|---|---|
| `Fichier .env introuvable` | Vérifiez que le fichier `.env` est bien dans le dossier `~/.wgf-support-tool/` |
| `kubectl n'est pas installé` | Relancez le script d'installation ou contactez votre administrateur |
| `Identifiants incorrects` | Demandez un fichier `.env` à jour à votre administrateur |
| `Timeout en attendant le tunnel` | Vérifiez votre connexion internet et réessayez |
| `Le tunnel a échoué` | Le token Kubernetes a peut-être expiré — demandez un nouveau `.env` |

---

## Mise à jour

Pour mettre à jour l'outil, relancez simplement la commande d'installation. Votre fichier `.env` sera conservé.

---

*By 6real — le CTO qui vous veut du bien*
