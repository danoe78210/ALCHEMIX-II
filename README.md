# AlcheMix II — Console de mixage harmonique DJ

> **Venezia · 1889 · Chrono-Deck Master Console**
> L'ambiance visuelle du projet : matériel audiophile Steampunk vénitien, dorures `#edbf7a`,
> lueurs émeraude/bleu électrique, cadrans parchemin et roue harmonique de Camelot.

Console de mixage DJ orientée mixage harmonique (Roue de Camelot), portée par
**Tauri 2** avec backend **Rust** et front-end **Svelte 5 / SvelteKit**.

---

## 🧱 Stack technique

| Couche | Technologie |
|---|---|
| Frontend | [Svelte 5](https://svelte.dev) (Runes) + **SvelteKit** (adapter-static) |
| Styling | **Tailwind CSS v4** (`@import "tailwindcss"` + bloc `@theme`) |
| Backend | **Rust** (edition 2021), commandes `#[tauri::command]` |
| Desktop | **Tauri 2** (plugins `dialog`, `fs`, `opener`) |
| Audio | Rodio / Symphonia (sélection & analyse — moteur Rust) |

## 📁 Structure

```
src/                      # Frontend SvelteKit
  routes/                 # +layout, +page (console 3 colonnes)
  lib/components/         # DeckA, DeckB, MixerCenter, CrossfaderBar
  lib/stores/             # mixer.svelte.ts (état global, BPM, Camelot)
  lib/ipc/                # client.ts (pont IPC vers Rust)
src-tauri/                # Backend Rust / Tauri
  src/commands/           # load_audio_file, open_audio_file, detect_tempo_camelot…
  capabilities/           # Permissions (dialog, fs…)
project-tracker/          # Kanban + journaux de travail (board.html, ticket.html)
```

## 🎚️ Fonctionnalités clés

- **3 colonnes symétriques** : Deck A (émeraude) · Console centrale Camelot · Deck B (bleu).
- **Platines photoréalistes** : cassettes, VU-mètres balistiques, faders dorés avec micro-LEDs.
- **Roue de Camelot** : arc harmonique court (≤ 180°) relié aux clés actives, aiguilles dynamiques.
- **Pont IPC temps réel** : BPM effectif + clé Camelot → Roue (plus analyse ONNX des stems).

## 🚀 Démarrage

```bash
npm install
npm run tauri dev        # mode desktop
# ou
npm run dev              # uniquement le frontend web
```

## 🪟 Installation Windows (exécutable autonome)

Téléchargez l'exécutable `AlcheMix-II-vX.Y.Z-windows-x64.exe` depuis la
[page des releases GitHub](https://github.com/danoe78210/ALCHEMIX-II/releases) et lancez-le.

> ### 🛡️ Note d'installation Windows (SmartScreen)
>
> **AlcheMix II** est un logiciel indépendant en cours de certification publique Microsoft :
> **Windows peut afficher l'écran « Windows a protégé votre ordinateur » lors du premier
> lancement.** Cliquez simplement sur **« Informations complémentaires »** puis **« Exécuter
> quand même »** pour démarrer l'application en toute sécurité.

Cet avertissement disparaîtra une fois le binaire signé par un certificat reconnu par Microsoft
(Azure Trusted Signing / SignPath.io) — la procédure officielle est préparée dans les notes de
release et le workflow GitHub Actions.

## 🌿 Branches

- `main` (ou `master`) : branche principale stable.
- `dev` : branche de travail de développement.

## 📊 Suivi de projet

- `project-tracker/board.html` : Kanban (filtres par agent, micro-tâches, live sync).
- `project-tracker/ticket.html?id=ALC-XXX` : journal de travail horodaté par ticket.

## 📜 Licence / Auteur

© DJ Danoë — AlcheMix II. Usage personnel / démonstration.