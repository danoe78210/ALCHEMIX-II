# Règle Métier — Crossover OST × OST (Double Instrumental / Cinéma)

Lorsqu'aucune des deux platines ne possède de piste vocale dominante (`vocalsRms` inférieur au seuil
vocal sur Deck A et Deck B) et qu'au moins une piste appartient au profil `'ost-cinema'` (ou
instrumental électronique/symphonique), l'automate bascule automatiquement sur la recette
**CROSSOVER OST × OST** selon ces **cinq invariants** :

## 1. Interdiction du mode `VOIX SEULE` sur une piste sans chant
- Si `vocalsRmsA < seuil` et `vocalsRmsB < seuil`, ne jamais muter `drums` + `bass` + `other`
  simultanément sur une platine.
  → Dans `recommendMashupRecipe` : si `vocalActivityRatio < 0.12` (quasi-null) sur les **deux**
  platines **et** une genre OST → `mode = 'crossover'` (jamais `acapella`).

## 2. Répartition complémentaire des 4 stems HTDemucs (« Moteur Rythmique » vs « Thème Mélodique »)
- **Platine Rythmique / Pulsation** (Daft Punk / Électro / Ostinato) : conserve **`drums` + `bass` +
  `other`** actifs (`vocals` muté) afin de porter le kick, les sub-basses (`< 120 Hz`) et la pulsation.
- **Platine Thème / Orchestre** (Hans Zimmer / Symphonique) : coupe **`drums` + `bass` + `vocals`** (ou
  applique un coupe-bas strict à **`140 Hz`**) et ne conserve que **`other`** (cordes, cuivres, thèmes
  mélodiques) pour éliminer tout conflit de grosse caisse et de sous-basses.
- La platine portant la **plus forte énergie percussive (`drumsRms`)** est automatiquement désignée
  **Platine Rythmique**, l'autre **Platine Thème**.
  → `resolveCrossoverStems(rhythm)` : Rythmique = preset `instrumental`, Thème = preset `theme`
  (nouveau : mute tout sauf `other`).

## 3. Sculpture spectrale asymétrique (Partage du médium)
- Appliquer un léger creux d'égalisation de **`−3,0 dB` à `1 500 Hz` (`Q = 1.0`)** sur le stem `other`
  de la **Platine Rythmique** afin d'ouvrir une niche fréquentielle nette pour les cuivres et cordes
  de la Platine Thème (`500 Hz – 4 kHz`).
  → `player.setStemMidNotch('other', 1500, -3)` (filtre `peaking` pré-câblé transparent, gain borné
  `[-6, 0] dB`).

## 4. Beatmatch continu avec Key Lock & compatibilité Camelot
- Vérifier la compatibilité harmonique ($\Delta_C \in \{0, \pm 1\}$ ou relatif $A \leftrightarrow B$)
  et verrouiller les deux platines sur un tempo maître continu (`effectiveBpmA === effectiveBpmB`,
  ratios `1:1` ou `2:1`) avec `preservesPitch = true`, ancré sur le premier transitoire de `drums.wav`.
  → Dans le crossover (`runFullAutoMashup`), les **deux** platines restent à `1.0x` (Key Lock).

## 5. Dramaturgie en paliers de 8 / 16 mesures
- Ouvrir la Platine Rythmique dès la mesure `M1`, introduire le thème orchestral de la Platine B après
  **8 mesures** d'installation (ou sur le premier drop détecté), et ménager un *breakdown* de
  **8 mesures** avant le climax final.
  → La synchronisation est prise en charge par le Beatgrid / phrasé (frontières 8/16 mesures) ; le
  crossover ne déclenche **aucun** re-seek vocal (pas de voix).