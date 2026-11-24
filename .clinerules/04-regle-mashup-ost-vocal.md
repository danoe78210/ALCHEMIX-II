# Règle Métier — Association OST / Cinéma & Vocal (Mashup)

Toute modification touchant à `src/lib/audio/stemMix.ts`, `src/lib/audio/player.ts`,
`src/lib/stores/mixer.svelte.ts`, `src/lib/components/BeatgridView.svelte` ou à l'Oracle Acoustique
doit respecter ces **six invariants** dérivés de l'analyse des mashups « OST + Vocal ».

## 1. Ancrage harmonique Camelot & Mode mineur
- Vérifier la compatibilité sur la roue de Camelot (**Δ_C ∈ {0, ±1}** ou relatif majeur/mineur
  **A ↔ B**, ex. `8A` / `8B`).
- Au-delà d'un cran d'écart, privilégier une **transition courte** ou suggérer une **correction
  tonale minimale (±1 à ±2 demi-tons)** plutôt qu'une superposition harmonique longue
  (source : `harmony.ts` → `relationFrom` / `affinityFrom`).

## 2. Beatmatch continu avec Key Lock (`preservesPitch = true`)
- Appliquer la **normalisation d'octave** de tempo (ratios `1:1`, `2:1`, `1:2` ; ex. `70 ↔ 140 BPM`)
  et aligner les deux platines sur un **tempo maître continu** (`effectiveBpmA === effectiveBpmB`)
  avec `preservesPitch = true` sur les 4 éléments `<audio>`.
- **Interdiction absolue** de réintroduire un *re-seek* périodique toutes les 2 ou 4 mesures en cours
  de couplet/refrain (proscrit depuis **ALC-246** car il hache le phrasé naturel du chanteur).
  → Dans le moteur : `computeContinuousOstMashupPlan` garde `ostPlaybackRate = 1` et plie le vocal
  à l'octave la plus proche (`vocalPlaybackRate ∈ [0.75, 1.35]`) ; le décalage de phase est absorbé
  par les `breathingWindows` et le gain (fondu 180 ms), **jamais** par un re-seek.

## 3. Calage sur le temps 1 réel (`drums.wav`) & Dramaturgie en crescendo
- Ancrer la grille sur le **premier transitoire percussif réel** (`drums.wav` *onset grid*, en
  ignorant le silence d'encodage initial) → `ostFirstDownbeatSeconds` / `vocalFirstDownbeatSeconds`.
- Laisser une **intro instrumentale courte de 4 à 8 mesures** sur l'OST avant d'ouvrir le vocal
  (`ostEntrySeconds` ≤ 8 mesures après le downbeat), puis **rétro-calage de l'entrée vocale** pour
  que le refrain coïncide avec le *climax* orchestral.

## 4. Dialogue « Question-Réponse » avec le thème signature / lyrique de l'OST
- Une OST peut contenir une **voix lyrique soliste** (ex. soprano) ou un **thème de cuivres** dominant
  dans `ostStems.vocals` et `ostStems.other`.
- **Ne jamais superposer le chant principal** par-dessus l'apothéose lyrique/cuivrée : planifier les
  fenêtres **`THÈME OST SOLO`** et les sauts de ponts vocaux vides (`vocalBridgeSkips` ≥ 8 mesures)
  **uniquement sur des frontières complètes de 8 ou 16 mesures** avec un **fondu doux (40 à 60 ms)**,
  sans jamais couper une syllabe en plein mot.
  → Détection : `detectContinuousBreathingWindows` combine l'énergie de `ostOther` **et** `ostVocals`
  (soprano), interdit les fenêtres pendant un **drop actif** (`drums ≥ 0.35 × pic`), fusionne puis
  **filtre à ≥ 8 mesures** (macro-fenêtre) avec plafond `OST_MAX_BREATHING_BARS = 8`.

## 5. Séparation spectrale & Dynamic Orchestral Ducking borné
- Conserver **l'isolation stricte des stems mutés** (`syncStemMediaState` + `stemDesiredGains`,
  `el.muted = true` quand `gain === 0`).
- Sur le stem `other` de l'OST (`role = 'ost-instrumental'`), appliquer un **creux médium dynamique à
  `1 800 Hz` (`Q = 1.0`)** asservi à l'enveloppe vocale opposée, **strictement borné à `[-3.0, 0] dB`**
  (`updateDynamicOrchestralDucking`) uniquement lorsque le vocal est audible.

## 6. Activation automatique sur métadonnée Genre
- Basculer automatiquement sur le profil **`'ost-cinema'`** dès qu'une piste porte un genre contenant
  `ost`, `cinéma`, `cinema`, `soundtrack` ou `score` (**insensible à la casse**), tout en laissant le
  forçage manuel `[ CLUB | 🎬 OST ]` disponible.
  → `genreHintsOstCinema(...)` (utilisé par `recommendMashupRecipe` et `shouldSuggestOstCinema`).

## 7. Relais rythmique hybride (`hybridGrooveWindows`) — voix en apesanteur, groove au refrain
- Si l'OST a une **faible énergie percussive** (`ostDeck.drumsRms` bas) et que la platine vocale
  possède un **groove marqué** (`vocDeck.drumsRms` élevé) :
  - conserver uniquement le stem `vocals` de la platine vocale sur l'intro, les couplets et l'outro
    (voix en apesanteur sur piano/cordes de l'OST) ;
  - ouvrir `drums + bass` de la platine vocale (avec **passe-haut 140 Hz** sur l'OST) **uniquement
    sur les blocs de refrain/climax** (8 ou 16 mesures complètes).
- Plan : `computeContinuousOstMashupPlan` expose `hybridGrooveWindows` (fenêtres alignées sur des
  blocs complets de 8/16 mesures de la grille OST).

## 8. Protection des *Drops* & ponts orchestraux
- Placer une fenêtre **`THÈME OST SOLO`** (quantifiée sur 8 ou 16 mesures complètes) lorsque l'OST
  entre dans un **pont symphonique ascendant** ou un **drop instrumental pur**
  (`other` > 85 % du pic sans refrain vocal actif).
- Détection : renforcée dans `detectContinuousBreathingWindows` (`ostOther` ∪ `ostVocals`, drop
  actif `drums ≥ 0.35 × pic` interdit).

## 9. Respiration *Call-and-Response* inter-phrases
- Régler le **Dynamic Orchestral Ducking** : `−4,5 dB @ 1 800 Hz` (`Q = 1.0`), **attaque rapide
  `15 ms`** et **relâchement `90 ms`**, afin que les cordes et chœurs de l'OST gonflent naturellement
  pendant les respirations entre deux vers.
- `updateDynamicOrchestralDucking` : `setTargetAtTime(0, t, 0.09)` au relâchement (90 ms) vs
  `setTargetAtTime(depth, t, 0.015)` à l'attaque (15 ms).

## 10. Outro symphonique nue (`bareOutroStartSeconds`)
- Muter le vocal et les percussions sur les **4 à 8 dernières mesures** pour laisser l'OST résoudre
  seule (orgue/cordes final).
- Plan : `computeContinuousOstMashupPlan` expose `bareOutroStartSeconds` (début 4/8 dernières
  mesures, aligné sur la grille OST).