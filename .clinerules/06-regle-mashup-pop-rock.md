# Règle Métier — Mashup Pop vs Rock / Rock vs Pop

Lorsque une platine porte une piste de genre **Pop** et l'autre une piste de genre **Rock** (ou
l'inverse), l'automate bascule automatiquement sur la spécialité **POP × ROCK** selon ces **cinq
invariants** (voir aussi `resolveMashupSpecialty` dans `src/lib/audio/stemMix.ts`) :

## 1. Choix automatique du sens de la recette
- **Voix Pop + Riff Rock** : la piste Pop (voix lead) est portée en platine vocale, la piste Rock
  (riffs / power chords) en platine instrumentale.
- **Voix Rock + Prod Pop** : la piste Rock (voix / grit) est portée en platine vocale, la piste Pop
  (production / nappes / programmation) en platine instrumentale.
- Le sens est déterminé par la télémétrie `vocalsRms` / `drumsRms` / `otherRms` + le genre : le
  **vote` (platines vocale vs instrumentale) suit la platine à la plus forte énergie vocale.

## 2. Guitar Pocket EQ (creux médium sur l'instrumental)
- Sur le stem `other` de la platine **instrumentale** :
  - instrumental **Rock** → creux **`−4,0 dB` à `2 200 Hz`** (`Q = 1.0`) pour loger la voix Pop dans
    le médium supérieur sans conflit de guitares ("guitar pocket") ;
  - instrumental **Pop** → creux **`−3,5 dB` à `1 250 Hz`** (`Q = 1.0`) pour dégager la bande vocale
    Rock / gritty.
- Implémentation : `player.setStemMidNotch('other', freq, gainDb)` (filtre `peaking` pré-câblé
  transparent, gain borné `[-6, 0] dB`). `resolveMashupSpecialty` retourne la fréquence cible
  (`2 200 Hz` si l'instrumental est Rock, `1 250 Hz` s'il est Pop).

## 3. Beatmatch continu avec Key Lock (calé sur `drums.wav`)
- Normalisation d'octave du tempo (ratios `1:1`, `2:1`, `1:2`) et tempo maître continu
  (`effectiveBpmA === effectiveBpmB`) avec `preservesPitch = true`, grille ancrée sur le premier
  transitoire percussif de `drums.wav`. Aucun re-seek périodique en cours de phrase.

## 4. Tolérance harmonique (power chords)
- Le couple Pop/Rock tolère la **relative majeure/mineure** (`A ↔ B` de la Roue de Camelot) et
  l'écart `Δ_C ∈ {0, ±1}` ; les *power chords* (quinte juste) restent stables sur ces relations,
  évitant toute dissonance. Au-delà d'un cran, privilégier une transition courte.

## 5. Phrasé par blocs de 8 / 16 mesures & respiration sur solo instrumental
- Aligner les sections sur des frontières complètes de **8 ou 16 mesures** ; ouvrir la voix sur le
  refrain (bloc de 8 mesures), ménager une **respiration sur le solo instrumental** (fondu vocal
  40–60 ms) aux frontières 8/16, sans jamais couper une syllabe en plein mot.