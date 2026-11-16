# Règle : Spécifications Vivantes (docs/SPECIFICATIONS.md)

Les spécifications d'AlcheMix II sont **vivantes** : elles reflètent exactement ce qui est livré
dans le code, et sont mises à jour **avant** tout passage de ticket en « En revue ».

## 1. Analyse systématique de chaque ticket

Dès qu'un ticket est traité (écriture de code, correction, nouvelle fonctionnalité) :

1. **Lis** `docs/SPECIFICATIONS.md` (lecture ciblée des sections concernées uniquement).
2. **Identifier le delta** : quelle partie du document décrit déjà, ou doit désormais décrire, le
   comportement livré par ce ticket.
3. **Mets à jour** la section dédiée via **`replace_in_file` ciblé** (jamais de réécriture entière)
   : ajoute/ajuste une ligne de l'historique et, si besoin, une phrase d'une section fonctionnelle
   ou technique.

## 2. Règle d'antériorité — avant « En revue »

Un ticket ne peut être basculé **« En revue »** que si `docs/SPECIFICATIONS.md` a déjà été mis à
jour pour ce ticket :

- **Historique des évolutions** : la ligne du ticket (`ID | Domaine | Apport`) doit être présente.
- **Section fonctionnelle / technique** : tout comportement observable livré par le ticket doit
  être décrit à **un seul endroit** (pas de doublon, pas de redondance).

Ordre imposé : **maj de la spec → coche la micro-tâche → passage en En revue.**

## 3. Zéro redondance & pédagogie

- Chaque fonctionnalité, règle métier ou composant technique est décrit **à un seul endroit**.
- Le document reste lisible par tout informaticien débutant : chaque terme technique ou musical
  est expliqué à sa première apparition (IPC, WebAudio, STFT, Clé Camelot, BPM, Runes `$state`, …).

## 4. Immutabilité des tickets « Terminé » (rappel strict)

- **Interdiction absolue** de modifier un ticket `"Terminé"` dans `project-tracker/tasks.json`,
  y compris de renuméroter ou réécrire son contenu sous prétexte de mise à jour des specs.
- Une évolution porte toujours sur **un nouveau ticket** (ex. le périmètre « 143 » non livré a
  été porté par **ALC-146** pour préserver ALC-143/144 « Terminé »).
- Dans `docs/SPECIFICATIONS.md`, les tickets « Terminé » sont **décrits mais jamais altérés** ;
  leur statut ne change pas.

## 5. Cohérence après modification

Après toute mise à jour de `docs/SPECIFICATIONS.md`, vérifie :

- les références croisées internes (« section 3.3 », etc.) restent valides si l'on renumérote ;
- aucun autre fichier du suivi (`tasks.json`, `journals.json`) n'est altéré par cette mise à jour ;
- `npm run check` / `cargo check` restent à 0 erreur si du code a accompagné la spec.