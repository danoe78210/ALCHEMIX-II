# Compétence UI / UX (Unslop) & Carte Technique du Dépôt

## 1. Compétence UI / UX (Unslop)
- Avant toute modification d'interface graphique (composants Svelte, CSS, SVG, mise en page), consulte directement la skill `.agents/skills/unslop/SKILL.md` (et `.agents/skills/unslop/references/signs.md` si besoin) — sans dupliquer le dossier.
- Applique le mode **Polish** (préservation stricte de l'identité visuelle *Venezia 1889*, des cassettes photoréalistes, des galvanomètres et de la Roue de Camelot) en veillant à l'alignement des grilles, à la suppression des micro-textes superflus ou badges techniques internes, et à la cohérence des espacements et micro-interactions.
- Maintiens impérativement le conteneur racine plein écran sans barre de défilement (`h-screen overflow-hidden`).

## 2. Carte exacte des fichiers du dépôt (Économie de tokens)
Ne pas lancer `list_files` / `search_files` inutilement :
- **Frontend SvelteKit (Svelte 5 + Tailwind) :**
  - `src/routes/+page.svelte` : Layout principal plein écran (`h-screen overflow-hidden`), en-tête et bouton `POWER OFF`.
  - `src/lib/components/DeckA.svelte` & `DeckB.svelte` : Platines latérales (cassette animée 60 fps, VU-mètre galvanométrique, EQ analogique LOW/HIGH sliders, transport, sliders Volume/Pitch, télémétrie 3 colonnes, pochette, spécifications).
  - `src/lib/components/MixerCenter.svelte` : Console centrale (onglets Roue de Camelot / Beatgrid / Librairie, Roue SVG, affinité harmonique, Oracle Acoustique, itinéraires alternatifs) et Crossfader Master.
  - `src/lib/components/BeatgridView.svelte` : Atelier Beatgrid superposé, Auto-Loop Roll quantifié et vernier de phase.
  - `src/lib/audio/player.ts` : Moteur WebAudio par platine (`MediaElementAudioSourceNode` → `lowshelf` → `highshelf` → `GainNode` → `AnalyserNode` → `destination`).
  - `src/lib/stores/` : État réactif des platines (`$state`), transport, pochettes, arbitrage hybride Camelot et analyse MIR.
- **Backend Rust (Tauri 2) :**
  - `src-tauri/src/audio.rs` : Décodage Symphonia, analyse BPM (STFT/onsets/TPS/DP) et clé Camelot (HPCP 36 bacs, profils KS+Temperley+Shaath) avec indice de confiance, extraction pochette (`lofty`).
  - `src-tauri/src/lib.rs` / `main.rs` : Commandes `#[tauri::command]` exposées via IPC (`read_audio_file_bytes`, etc.).
- **Suivi Kanban :**
  - `project-tracker/tasks.json` (tickets & micro-tâches), `project-tracker/journals.json` (journaux horodatés `Europe/Paris`), `project-tracker/board.html`.

## 3. Commandes de validation exactes (Windows PowerShell)
- Vérification Frontend (TypeScript / Svelte) : `npm run check`
- Vérification Backend Rust : `cargo check --manifest-path src-tauri/Cargo.toml`
- Tests unitaires moteur audio : `cargo test --manifest-path src-tauri/Cargo.toml --lib`

## 4. Lectures ciblées & Garde-fou anti-boucle
- Lire uniquement les plages de lignes nécessaires (`read_file` ciblé) plutôt que des fichiers entiers de plus de 400 lignes (notamment `audio.rs` et `tasks.json`).
- En cas d'échec de compilation répété (2 tentatives sur la même erreur), stopper les modifications hasardeuses, diagnostiquer la cause racine précise et corriger proprement.