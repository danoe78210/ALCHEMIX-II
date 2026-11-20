---
name: tdd-audio-logic
description: TDD ciblé (RED → GREEN → REFACTOR) pour la logique métier critique et les calculs DSP/MIR d'AlcheMix II (src-tauri/src/audio.rs, stems.rs, library.rs, src/lib/utils/mashupMatcher.ts). À invoquer avant d'implémenter une nouvelle formule Camelot, un calcul de piste pont, une courbe Crossfader/Auto-Mix ou une requête SQLite. Réduit les faux positifs de validation.
---

# TDD ciblé (logique audio / DSP / MIR)

Applicable **uniquement** à la logique métier critique et aux calculs : clés Camelot, scoring de piste
pont (mashupMatcher), courbes Crossfader / Auto-Mix / Bass-Swap, requêtes SQLite (library).
Ne s'applique pas au positionnement UI/CSS (validation visuelle, pas de TDD).

## Cycle RED → GREEN → REFACTOR
1. **RED** : écrire d'abord le test unitaire qui **échoue** sur le cas attendu :
   - Rust : `#[test]` dans le module `tests` du fichier cible (`cargo test --lib`);
   - TS : `node --test` (tests/mashupMatcher.test.ts, loader.mjs pour `$lib`).
2. **GREEN** : implémenter le **code minimal** (`#[tauri::command]` / fonction pure / constante)
   pour faire passer le test au vert (aucune sur-ingénierie).
3. **REFACTOR** : nettoyer sans changer le comportement ; relancer le test.

## Cibles typiques (une formule = un test)
- `normalize_camelot_key` / clés Camelot (1A–12B), mi-distances (piste pont).
- `scoreMatch` / `findLocalBridgeTracks` (harmonique 50%, rythmique 35%, duo 10%).
- AUTO-MIX : durée `T = bars×4×60/BPM`, Bass-Swap courbe, pitch glide ≤6%.
- SQLite library : upsert idempotent, `ON CONFLICT`, `ON DELETE CASCADE` des duos.

## Règle de clôture
Une formule/courbe/requête n'est livrée qu'après **`npm run check` 0/0** (TS) et
**`cargo test --lib` 100 % verts** (Rust) — la preuve est enregistrée avant toute coche `completed:true`.