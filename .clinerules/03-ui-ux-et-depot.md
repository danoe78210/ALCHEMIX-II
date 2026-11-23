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
## Skills methodologiques (obra/superpowers adaptees)
References concises (aucun sous-agent lourd ni questionnaire superflu) :
- .agents/skills/systematic-debugging/SKILL.md : a invoquer des qu'un bug / erreur IPC / regression apparait, avant toute modification hasardeuse (cause racine exacte, cycle 4 phases, garde-fou 2 tentatives).
- .agents/skills/verification-before-completion/SKILL.md : a invoquer avant de cocher completed:true ou de passer un ticket en En revue (preuve d'execution requise adaptee au perimetre).
- .agents/skills/tdd-audio-logic/SKILL.md : a invoquer avant toute nouvelle formule Camelot / piste pont / courbe AUTO-MIX / requete SQLite (RED->GREEN->REFACTOR).

## Compétences Design Engineering (`.agents/skills/`)
Skills ciblées (issues de `jakubkrehel/skills`) à invoquer selon le besoin, en complément d'`unslop` :
- **`.agents/skills/better-motion/SKILL.md`** : Pour toute animation UI (Tambour Chronographe, rotation de roues/potentiomètres, glissement des colonnes, VU-mètres, transitions de panneaux) — imposer des courbes physiques fluides **60 fps** (`cubic-bezier(0.22, 1, 0.36, 1)`) sans désynchronisation d'état.
- **`.agents/skills/better-ui/SKILL.md`** : Pour les contrôles tactiles (potentiomètres rotatifs, faders, pads, boutons directionnels) — alignement optique, rayons concentriques laiton/ébène, zones de clic confortables et états de survol/actif nets.
- **`.agents/skills/better-typography/SKILL.md`** : Pour les badges, titres de modules et valeurs télémétriques — empêcher toute cassure sur 2 lignes des libellés courts (`whitespace-nowrap`), imposer `tabular-nums` sur tous les chiffres (BPM, fréquences, durées, dB) et soigner le contraste sur fond sombre.
- **`.agents/skills/build-design/SKILL.md`** : En binôme avec `.agents/skills/stitch-to-svelte/SKILL.md` lors de la conversion de maquettes Stitch (comme les vues *Rack FX* et *Mix Live*) vers Svelte 5.

**Clause de priorité stricte :** `.stitch/DESIGN.md` (*Venezia 1889*) et le cadrage plein écran `h-screen overflow-hidden` restent prioritaires en cas de divergence stylistique avec ces skills.
