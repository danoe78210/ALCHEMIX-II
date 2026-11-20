---
name: systematic-debugging
description: Débogage systématique pour AlcheMix II (Tauri 2 / Rust / WebView2 / Svelte 5). À invoquer dès qu'un bug, une erreur runtime, un IPC qui échoue ou une régression apparaît — aucune modification de code n'est autorisée avant que la cause racine exacte soit identifiée et prouvée. Élimine les allers-retours de débogage et les faux correctifs.
---

# Débogage systématique (AlcheMix II)

**Règle d'or :** aucune modification de code hasardeuse tant que la cause racine exacte n'est
pas identifiée par des faits réels. Toute correction doit être **minimale, prouvée** et suivie
d'un **test de non-régression**.

## Sources de preuve (stack Tauri 2 / Rust / WebView2 / Svelte 5)
- **Logs Rust** (terminal `tauri dev` / `cargo run`) : `eprintln!`/`dbg!` au maillon soupçonné.
- **Console WebView2** (DevTools frontend) : erreurs JS, exceptions Svelte, `console.*`.
- **Pont IPC** : vérifier l'`invoke('commande', args)` côté Svelte, la signature `#[tauri::command]`
  côté Rust, l'enregistrement dans `src-tauri/src/lib.rs` (generate_handler) et la sérialisation Serde
  (renommage camelCase ↔ snake_case).
- **Permissions** : capacités/plugins autorisées dans `src-tauri/tauri.conf.json` si un IPC est refusé.
- **Protocoles** : pré-écoute et lecture via `read_audio_file_bytes → Blob URL` (jamais `asset://` ni
  `convertFileSrc` seuls) pour éviter le blocage CORS WebView2.

## Cycle en 4 phases
1. **Reproduire & collecter les faits réels** (message exact, entrée réelle, traces).
2. **Isoler le maillon fautif** : Frontend Svelte / Pont IPC / Backend Rust (bisection par exclusion).
3. **Hypothèse unique vérifiable** : une seule cause, testée avant tout correctif.
4. **Correction minimale + test de non-régression** (`npm run check`, `cargo test --lib`).

## Garde-fou (2 tentatives)
Après **2 tentatives infructueuses** sur la même erreur : **STOP** — ne plus modifier au hasard.
Documenter le blocage dans `project-tracker/journals.json` (ticket concerné, faits, hypothèses écartées),
puis **re-diagnostiquer l'architecture** (lecture de la chaîne complète désignée) avant toute nouvelle
modification.