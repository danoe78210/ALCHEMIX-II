# Règle Métier — Medley & Alternance Thématique OST ↔ OST

Inspirée des transitions synthé/orchestrales : quand les deux platines sont instrumentales
(`OST × OST`), le moteur peut jouer un **Medley** thématique — les deux thèmes d'OST se répondent
plutôt que de se superposer en continu. Ces **cinq invariants** s'appliquent (voir aussi
`computeOstMedleyPlan` dans `src/lib/audio/stemMix.ts`) :

## 1. Socle rythmique unique `drums + bass`
- Une seule **Platine Socle** porte la pulsation (`drums + bass` verrouillés à 1) ;
- Tableaux : jamais `drums` ou `bass` actifs **sur les deux platines simultanément** pendant
  l'exposition.

## 2. Alternance `other A` ↔ `other B` en question-réponse (blocs de 8 mesures)
- Pendant l'exposition, basculer `other A` actif / `other B` muté PUIS `other A` muté / `other B`
  actif **sur chaque frontière de bloc complet de 8 mesures** ;
- Fondu croisé d'**1 temps** sur le *downbeat* (jamais de coupe à sec ni de syllabe coupée — ici
  pas de chant).

## 3. Breakdown pivot de 8 mesures sans batterie (changement de thème)
- À mi-parcours, ménager un **breakdown** de **8 mesures** : `drums` (et `bass`) coupe(s) sur la
  Platine Socle, un seul `other` ouvert (le thème ENTRANT), pour marquer le changement thématique —
  fondu doux et frontière quantifiée au downbeat.

## 4. Climax contrapuntique — séparation spectacle grave / aigu
- Dans le **tiers final**, ouvrir `other A` **et** `other B` **simultanément** ;
- Filtrage complémentaire : **LPF 950 Hz** sur le thème **grave** (socle) vs **HPF 1 050 Hz** sur le
  thème **aigu** (`player.setStemBandFilter('other', 'lowpass'|'highpass', freq)`), pour un contrepoint
  lisible sans collision fréquentielle.

## 5. Intro minimaliste de 4–8 mesures sans batterie
- Ouvrir la timeline par une **intro de 4 à 8 mesures sans batterie** : `drums` muté, seul le
  `other` d'amorce est ouvert, avant d'ancrer le socle rythmique sur le premier *downbeat* réel
  (`drums.wav`).

La grille reste **strictement** `effectiveBpmA === effectiveBpmB` (`preservesPitch = true`),
quantifiée en blocs de 8 mesures sur le downbeat percussif de `drums.wav`.