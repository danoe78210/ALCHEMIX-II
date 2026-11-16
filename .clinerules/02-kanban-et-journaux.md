# Gouvernance Kanban (`tasks.json`) & Journaux de Travail (`journals.json`)

1. Pilotage du projet via `project-tracker/tasks.json` :
   - Chaque macro-tâche (ALC-XXX) possède un sous-tableau `subtasks` (chaque sous-tâche : `id`, `title`, `completed`).
   - JALON MICRO-TÂCHES (règle active) : dès qu'une macro-tâche est confiée, rédige immédiatement ses sous-tâches dans `tasks.json`. Coche chaque micro-tâche (`completed: true`) au fur et à mesure de l'écriture du code réel. Ne déplace le ticket principal en `En revue` (REVIEW) que lorsque TOUTES ses micro-tâches sont validées (`completed: true`). Ne le laisse jamais en `En revue` avec des sous-tâches inachevées.
   - L'état de l'art des tickets est visualisable dans `project-tracker/board.html` (Kanban + filtres par agent + cases à cocher + import/export JSON).
   - **Conflit de synchronisation (règle) :** l'utilisateur peut déplacer manuellement des tickets dans `board.html`, mémorisés via `alchemix_status_overrides` (localStorage). Toute écriture de `project-tracker/tasks.json` par Cline doit **conserver les statuts déplacés manuellement** et ne jamais les rétrograder (y compris hors « Terminé »), sauf demande explicite. Relire l'état courant du fichier avant de modifier et ne pas recréer/écraser un ticket avec un statut qui annulerait un mouvement local.

2. JOURNAUX DE TRAVAIL PAR TICKET (règle active) :
   - Chaque ticket possède sa page de journal horodaté : `project-tracker/ticket.html?id=ALC-XXX`, alimentée par `project-tracker/journals.json`.
   - À chaque avancement d'un ticket (écriture de code, micro-tâche cochée, fichier modifié, bascule de colonne, rapport d'étape), ajoute une entrée horodatée `{ ts, type, message }` dans `journals.json` sous la clé du ticket.
   - Expose ce journal en accès direct depuis le Kanban : bouton « Journal » (📓) sur chaque carte et dans la sidebar.

3. RÈGLE STRICTE DE MISE À JOUR DES MICRO-TÂCHES (AU FIL DE L'EAU) :
   - Dès qu'une micro-tâche (`subtask`) d'un ticket est implémentée et validée, ouvre **immédiatement** `project-tracker/tasks.json` et passe son champ `"completed"` de `false` à `true`, **avant même de passer à la micro-tâche suivante**.
   - **Interdit** d'attendre la fin complète du ticket pour cocher toutes les micro-tâches d'un seul coup : `tasks.json` doit refléter l'avancement réel **en direct** dans `project-tracker/board.html`.
   - Consigne **simultanément** l'horodatage correspondant (heure de Paris `Europe/Paris`) dans `project-tracker/journals.json`.
   - Conséquence visuelle : toute micro-tâche ayant `"completed": true` doit s'afficher dans `board.html` avec **sa case cochée** et son **texte barré** (`line-through opacity-60`).
   - **RÈGLE D'ATOMICITÉ DES MICRO-TÂCHES** : pour chaque ticket `En cours`, traite les `subtasks` **une par une** et mets à jour `project-tracker/tasks.json` (`"completed": true` **+ `meta.updatedAt`**) **immédiatement après chaque sous-tâche terminée**, **avant de commencer la sous-tâche suivante**. **Strictement interdit** d'attendre la fin du ticket pour cocher toutes les sous-tâches en une seule fois.

4. IMMUTABILITÉ DU STATUT « Terminé » (règle absolue) :
   - **Interdiction absolue** de rétrograder un ticket ayant le statut `"Terminé"` dans `project-tracker/tasks.json` (ex. vers `"En revue"`, `"En cours"` ou `"Backlog"`), sauf sur demande explicite et écrite de l'utilisateur.
   - Un ticket `"Terminé"` est définitivement livré : ne pas modifier son `status`, ne pas redescendre sa colonne dans `board.html`, ne pas rouvrir ses micro-tâches.
   - L'interface Kanban (`project-tracker/board.html`) protège les passages locaux en « Terminé » via la clé `alchemix_completed_overrides` (localStorage) : ne jamais la contourner ni réintroduire une rétrogradation automatique.
   - Consigne dans `journals.json` toute anomalie de statut « Terminé » détectée plutôt que de « corriger » silencieusement la colonne.

5. TICKETS RÉCURRENTS (`"recurrent": true`, ex. « Release GitHub ») :
   - Un ticket marqué `"recurrent": true` est un **modèle réutilisable** : il n'est jamais laissé « Terminé ». Chaque exécution le passe en `En cours`, coche ses subtasks au fil de l'eau puis, une fois le travail terminé avec succès, le **replace en `Backlog` avec toutes ses subtasks remises à `"completed": false`**, prêt pour la prochaine exécution.
   - La **trace de chaque exécution** est conservée par une entrée horodatée (heure de Paris `Europe/Paris`) dans `project-tracker/journals.json` sous la clé du ticket (URL de release, artefacts, bilan), sans jamais modifier les tickets « Terminé ».
   - La mise à jour du `meta.version` / `meta.updatedAt` de `tasks.json` reste appliquée à chaque bascule.