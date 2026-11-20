---
name: verification-before-completion
description: Discipline « Evidence over claims » pour AlcheMix II. À invoquer avant de cocher une sous-tâche à completed:true dans project-tracker/tasks.json ou de basculer un ticket en « En revue » — interdit de déclarer un travail terminé sur simple lecture de code : une preuve d'exécution réelle adaptée au périmètre est requise. Élimine les faux positifs de validation.
---

# Preuve avant clôture (Evidence over claims)

**Règle :** il est **interdit** de déclarer une sous-tâche `"completed": true` (ou un ticket en
« En revue ») sur la **simple lecture de code**. Chaque validation exige une **preuve d'exécution
réelle** du périmètre modifié.

## Preuves requises selon le périmètre
| Périmètre | Preuve d'exécution |
|---|---|
| Svelte / TypeScript / composants | `npm run check` → **0 erreur / 0 warning** |
| Backend Rust (audio, stems, library, IPC) | `cargo check` **0 erreur** + `cargo test --lib` **100 % verts** |
| Logique mashup / bridge / TDD TS | `node --test` (tests/mashupMatcher.test.ts) |
| `project-tracker/board.html` (JS inline) | `node --check` sur chaque bloc `<script>` extrait |
| Artefact généré (PNG, `.exe`, `.msi`, image) | **vérification physique** du fichier (taille non nulle, dimensions/ratio, présence) |

## Suite (chaîne Kanban)
1. Preuve exécutée et collée dans le journal (commande + résultat, ex. « npm run check 0/0 »).
2. **Ensuite seulement** : passer `"completed": true` + `meta.updatedAt` dans `tasks.json`.
3. `journals.json` horodaté (Europe/Paris) ; un ticket n'est « En revue » qu'avec **toutes** ses
   sous-tâches prouvées.

## Rappels
- Ne jamais reporter une preuve non exécutée ; en cas d'impossibilité d'exécution (environnement bloqué),
  le consigner en `type: report` dans `journal.json` et **ne pas** cocher la sous-tâche.
- Ne jamais modifier un ticket `"Terminé"` dans `tasks.json`.