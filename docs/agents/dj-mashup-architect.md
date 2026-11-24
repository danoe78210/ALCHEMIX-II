# Agent DJ Mashup Architect — Références métier

Règles métier applicables au rôle **DJ Mashup Architect** (Danoe) au sein d'AlcheMix II.

## Règle métier OST + Vocal (invariants non négociables)

Consulte systématiquement **[`.clinerules/04-regle-mashup-ost-vocal.md`](../../.clinerules/04-regle-mashup-ost-vocal.md)**
avant toute modification de la logique de mashup OST / cinéma :

| # | Invariant | En bref |
|---|---|---|
| 1 | Ancrage harmonique Camelot | Δ_C ∈ {0, ±1} ou relatif A↔B ; sinon transition courte / correction ±1 à ±2 demi-tons |
| 2 | Beatmatch continu Key Lock | `effectiveBpmA === effectiveBpmB`, octave `1:1`/`2:1`/`1:2`, `preservesPitch = true`, **zéro re-seek** en phrase |
| 3 | Temps 1 réel (`drums.wav`) | Grille ancrée sur le premier kick ; intro 4–8 mesures ; refrain = climax orchestral |
| 4 | Dialogue avec le thème OST | `THÈME OST SOLO` / `vocalBridgeSkips` sur frontières **8/16 mesures**, fondu 40–60 ms, jamais de syllabe coupée |
| 5 | Séparation spectrale | Isolation stricte des stems mutés ; creux médium `1 800 Hz` (`Q=1.0`) borné à `[-3, 0] dB` |
| 6 | Auto-profil `'ost-cinema'` | Détection genre `ost`/`cinéma`/`cinema`/`soundtrack`/`score` (insensible à la casse) + forçage manuel |

**Zoom studio — 4 mécanismes avancés (4 mashups de référence : Rüfüs Du Sol × Time, How Deep Is Your
Love × Time, Interstellar × Remedy, Bastille × Pompeii MMXXIII) :**
- **Clause 7 — Relais rythmique hybride** : `hybridGrooveWindows` (blocs refrain/climax 8–16 mes) où
  `drums+bass` de la platine vocale s'ouvrent + **passe-haut 140 Hz** sur l'OST, si `ost.drumsRms` bas
  et `voc.drumsRms` élevé (voix en apesanteur sinon).
- **Clause 8 — Protection des drops/ponts** : fenêtre `THÈME OST SOLO` 8/16 mes sur pont symphonique
  ascendant ou drop instrumental pur (`other` > 85 % du pic, pas de refrain vocal).
- **Clause 9 — Call-and-Response** : ducking sous les chœurs/cuivres à **−4,5 dB @ 1800 Hz**,
  **attaque 15 ms / relâchement 90 ms**.
- **Clause 10 — Outro nue** : `bareOutroStartSeconds` — muter vocal + percussions sur les 4–8
  dernières mesures pour laisser l'OST résoudre seule.

Ces invariants sont implémentés et protégés par tests dans `src/lib/audio/stemMix.ts`
(`computeContinuousOstMashupPlan`, `detectContinuousBreathingWindows`,
`recommendMashupRecipe`) et `src/lib/audio/player.ts` (`updateDynamicOrchestralDucking`).

## Règle métier Crossover OST × OST (Double Instrumental / Cinéma)

Consulte aussi **[`.clinerules/04-regle-crossover-ost-ost.md`](../../.clinerules/04-regle-crossover-ost-ost.md)**
quand les deux platines sont **quasi-instrumentales** (`vocalActivityRatio < 0.12`) et qu'au moins
une piste est de profil `'ost-cinema'`. En résumé : recette `mode='crossover'` (jamais `VOIX SEULE`) ;
**Platine Rythmique** = `drums+bass+other` (`instrumental`), **Platine Thème** = `other` seul
(preset `theme`) ; **creux médium −3 dB @ 1500 Hz (`Q=1.0`)** sur le `other` rythmique
(`player.setStemMidNotch`) ; les deux platines restent à `1.0x` (Key Lock) et la désignation
Rythmique/Thème suit la plus forte `drumsRms`.

## Règle métier Pop vs Rock / Rock vs Pop

Consulte **[`.clinerules/06-regle-mashup-pop-rock.md`](../../.clinerules/06-regle-mashup-pop-rock.md)**
quand une piste est **Pop** et l'autre **Rock** : sens auto (Voix Pop + Riff Rock / Voix Rock + Prod Pop),
**Guitar Pocket EQ** −4,0 dB @ **2 200 Hz** (instrumental Rock) ou −3,5 dB @ **1 250 Hz** (instrumental Pop),
beatmatch continu Key Lock calé sur `drums.wav`, tolérance relative majeure/mineure des *power chords*,
phrasé 8/16 mesures avec respiration sur solo instrumental.

## Routeur unifié des trois spécialités

`resolveMashupSpecialty(deckA, deckB)` (`src/lib/audio/stemMix.ts`) unifie les trois règles métier dans
**un seul arbre de décision** (genre + télémétrie RMS des stems : `vocalsRms` / `drumsRms` / `otherRms`) :

| Priorité | Spécialité | Condition | Creux médium (`other` de l'instrumental) |
|---|---|---|---|
| 1 | `ost-crossover` | les 2 platines quasi-instrumentales + une B.O. | `1 500 Hz` |
| 2 | `ost-vocal` | une voix dominante + une B.O. | `1 800 Hz` |
| 3 | `pop-rock` | une Pop + une Rock | `2 200 Hz` (inst Rock) / `1 250 Hz` (inst Pop) |
| 4 | `standard` | sinon | aucun |

La fréquence cible est branchée dans `mixer.svelte.ts` (`runFullAutoMashup`) via
`player.setStemMidNotch('other', freq, -3)`, sans altérer les modes `'ost-cinema'` / `'crossover'` existants.

## Règle métier Medley & Alternance Thématique OST ↔ OST

Consulte **[`.clinerules/07-regle-medley-transitions-ost.md`](../../.clinerules/07-regle-medley-transitions-ost.md)**
pour les deux-OST instrumentales jouées en **Medley** plutôt qu'en superposition continue :
**distinction clé** — la *superposition continue* (`04-regle-crossover-ost-ost.md`, thèmes rythmiques
simultanés) vs l'*alternance thématique* (`07-regle-medley-transitions-ost.md`, question-réponse par
blocs de **8 mesures**). Cinque invariants : socle rythmique unique `drums+bass` ; alternance
`other A` ↔ `other B` par blocs de 8 mesures (fondu 1 temps sur le downbeat) ; *breakdown pivot* sans
batterie sur changement de thème ; climax contrapuntique **LPF 950 Hz** (grave) / **HPF 1050 Hz**
(aigu) ; intro minimaliste 4–8 mesures sans batterie. `computeOstMedleyPlan` (`stemMix.ts`) génère la
timeline quantifiée, appliquée par `mixer`/`player` (`setStemBandFilter`).

Voir aussi `docs/SPECIFICATIONS.md` (sections « Annonce émotionnelle / Mashup OST »).