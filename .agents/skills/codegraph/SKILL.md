# Skill : CodeGraph — Pré-index du graphe de code

**CodeGraph** (`@colbymchenry/codegraph`, MIT, 100 % local) a pré-indexé le graphe de
code d'**AlcheMix II** (Svelte/TypeScript ↔ IPC Tauri ↔ Rust) dans `.codegraph/codegraph.db`
(local, non versionné). **Interrogez CodeGraph AVANT tout `grep` ou lecture multi-fichiers**
pour économiser les tokens d'exploration.

## Commandes clés (à privilégier en premier)

| Besoin | Commande / outil MCP |
|---|---|
| **Explorer un sujet ou un pont IPC Tauri** d'un coup (symboles + chemins d'appel + source) | Outil MCP `codegraph_explore` \| CLI `codegraph explore "<sujet>"` |
| **Trouver un symbole** par nom | `codegraph query "<terme>"` |
| **Analyse d'impact** avant de modifier un symbole critique (`Player`, `mixerStore`, `audio.rs`, `stems.rs`) | `codegraph impact <symbole>` |
| **Appelants** d'un symbole (qui l'utilise ?) | `codegraph callers <symbole>` |
| **Appelés** par un symbole | `codegraph callees <symbole>` |
| **Détection des tests impactés** par des fichiers sources modifiés | `codegraph affected` |
| **Resynchronisation manuelle** de l'index | `codegraph sync` |
| **Reconstruction intégrale** de l'index | `codegraph init --yes` \| `codegraph index` |
| **État de l'index** | `codegraph status` |

> Exemple réel de pont IPC résolu : `codegraph callers load_audio_file` → affiche la
> fonction Rust `load_audio_file` et son vis-à-vis frontend `loadAudioFile` (`src/lib/ipc/client.ts`).

## Contexte CLI (Windows)

- Le chemin binaire s'ajoute via `$env:Path += ';' + (npm prefix -g)` dans chaque session
  PowerShell (binaire `codegraph.ps1` / `codegraph.cmd`).
- Backend stockage : `node:sqlite` natif (full WAL). Base locale `.codegraph/` ignorée par Git.
- Serveur MCP (Cline) : `codegraph serve --mcp` (auto-sync temps réel via file watcher).