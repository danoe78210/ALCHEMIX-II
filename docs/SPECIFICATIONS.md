# AlcheMix II — Spécifications Vivantes

> **Document vivant.** Cette spécification décrit **ce qui est réellement livré** dans le code,
> consolidé à partir des tickets `project-tracker/tasks.json` (de **ALC-001** à **ALC-146**).
> Elle n'est pas un journal des tickets : chaque fonctionnalité est décrite **une seule fois**,
> dans sa section dédiée. Toute évolution future doit mettre à jour ce document **et** le Kanban.

- **Version courante** : **v0.5.0** (Release GitHub — voir `CHANGELOG.md`).
- **Format** : Markdown, lisible par tout informaticien débutant.
- **Licence du thème** : identité visuelle *Venezia 1889* (réservée au projet).
- **Stack** : Svelte 5 (SvelteKit + Tailwind CSS) · Rust (Tauri 2) · WebAudio.

---

## 1. Présentation & Architecture Générale

### 1.1 Rôle de l'application

**AlcheMix II** est une console de mixage DJ et un atelier de création de mashups, au style
visuel délibérément **steampunk vénitien 1889** (cassettes photoréalistes, galvanomètres,
roue de Camelot). L'interface occupe **tout l'écran, sans barre de défilement** (`h-screen
overflow-hidden`) : tout doit être visible et utilisable d'un coup d'œil.

L'application comprend **deux platines** (Deck A et Deck B) qui jouent chacune une piste audio,
et une **console centrale** qui aide le DJ à les mélanger en harmonie et en rythme.

### 1.2 Les deux moteurs

AlcheMix II repose sur **deux moteurs**, qui communiquent par un **pont IPC**.

- **Backend Rust (Tauri 2)** : lit le fichier audio sur le disque, le **découpe** et l'**analyse**
  (tempo, tonalité, forme d'onde) puis renvoie les résultats au frontend sous forme de données.
- **Frontend SvelteKit (Svelte 5)** : reçoit les données, **joue le son en temps réel** via
  WebAudio, anime les galvanomètres et affiche toute l'interface.

> **IPC (Inter-Process Communication)** : littéralement « communication entre processus ». C'est
> le canal par lequel le frontend (Svelte, côté WebView) et le backend (Rust, côté système)
> s'échangent des commandes et des données. Côté Svelte on appelle `invoke('commande', …)`, côté
> Rust on déclare `#[tauri::command]`. Voir le tableau complet en **section 3.3**.

### 1.3 Schéma global du flux audio

```
  ┌────────────────────────────────── BACKEND RUST (Tauri 2) ──────────────────────────────────┐
  │  Fichier audio sur le disque                                                              │
  │  (MP3, WAV, FLAC, OGG, AIFF)                                                              │
  │        │  Symphonia décode + réduit en MONO 48 kHz                                          │
  │        ▼                                                                                  │
  │  Analyseur musical (src-tauri/src/audio.rs)                                              │
  │   • BPM (tempo)          → menu de halage de grille                                        │
  │   • Clé Camelot (tonalité) → Roue de Camelot                                               │
  │   • Forme d'onde (pics)   → waveform Beatgrid                                              │
  │   • Segments 4 s (RMS 3 bandes, tempo/clé locaux) → calques TEMPO / CLÉS                   │
  │        │   résultats sérialisés JSON renvoyés via IPC                                      │
  └────────▼────────────────────────────────────────────────────────────────────────────────────┘
           │  invoke('load_audio_file') → { bpm, camelot_key, waveform_peaks, segments, … }
  ┌────────▼────────────────────────────── FRONTEND SVELTEKIT (Svelte 5) ──────────────────────┐
  │  Octets lus via read_audio_file_bytes → URL blob: (sans blocage CORS)                     │
  │        ▼                                                                                  │
  │  Moteur WebAudio (src/lib/audio/player.ts) :                                               │
  │   Source <audio> → Filtre EQ → Gain → Analyseur → Haut-parleurs                             │
  │        │  temps réel, 60 fps                                                              │
  │        ▼                                                                                  │
  │  Interface : platines, galvanomètres, Roue de Camelot, atelier Beatgrid, Crossfader       │
  └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Spécifications Fonctionnelles — Ce que l'utilisateur peut faire

### 2.1 Les deux platines : Deck A (Émeraude) & Deck B (Bleu)

Chaque platine reproduit une **cassette analogique photoréaliste** (coque, bobines animées,
vis laiton). Les deux platines sont strictement identiques, hormis la couleur du canal :
**Deck A en émeraude (#10b981)** et **Deck B en bleu électrique (#3b82f6 / #00A3FF)**.

| Fonction | Comportement |
|---|---|
| **Chargement** | Bouton **LOAD** (sélecteur de fichiers système, formats LPCM/compressés) ou **glisser-déposer** sur la cassette ; bouton **EJECT** pour décharger. |
| **Transport** | **PLAY**, **PAUSE**, **STOP**, **REW** / **FFWD** (recul/avance rapide de **±20 s**), **CUE** (pause sur repère). |
| **Compteur ROLL** | Horloge de lecture (écoulé / restant), cliquable, chiffres tabulaires. |
| **Galvanomètre VU** | Aiguille balistique **temps réel** alimentée par les échantillons réels du WebAudio (RMS / Peak en dBFS). |
| **Égaliseur 2 bandes** | Filtres **LOW EQ (120 Hz, graves)** et **HIGH EQ (3.2 kHz, aigus)** avec curseurs analogiques. |
| **Faders** | **Volume** (gain du canal) et **Pitch** (vitesse de lecture, −100 % à +100 %), en style fader doré. |
| **Justesse des notes** | Le Pitch change la **vitesse** sans changer la **tonalité** : `preservesPitch = true`. La clé Camelot reste juste. |
| **Métadonnées & pochette** | Titre (fallback nom de fichier), artiste, album, genre, année, **BPM tagué** et **clé taguée** extraits des tags du fichier via **`lofty`** (ID3v2.3/v2.4, Vorbis, MP4, FLAC, WAV). Genre : index numériques ID3v1 convertis en libellé texte (17 ⇒ Rock, 18 ⇒ Techno…) ; clé taguée normalisée **Camelot 1A–12B**. **Aucune valeur de test** : si un tag est réellement absent, l'interface affiche un tiret discret « — ». Enrichissement complémentaire via **MusicBrainz** et **Cover Art Archive** (+ pochette extraite du fichier ou API musicale en fallback). |
| **Télémétrie Rythme & Clé** | Bloc bas de platine : BPM effectif, clé Camelot + mode, clé standard — aux couleurs du canal. |

### 2.2 La Console Centrale — Roue de Camelot & Oracle Acoustique

La console centrale (au milieu) est le cerveau du mixage.

- **Roue de Camelot** : cercle des quintes en notation **1A–12B** (voir encadré). Deux **aiguilles**
  (Émeraude = Deck A, Bleu = Deck B) pointent la clé de chaque piste ; une **aiguille dorée**
  centrale matérialise la modulation.
- **Affinité harmonique** : un pourcentage d'affinité entre les deux pistes est calculé selon la
  proximité sur la roue. Deux pistes compatibles partagent des accords communs et se mélangent
  sans dissonance.
- **Oracle Acoustique** : propose des **conseils de mixage chiffrés** (fréquences en Hz, gains en
  dB, écarts en BPM, en mesures) pour réussir un enchaînement.
- **Pont de clé (Bridge Finder)** : recherche via **Deezer** les pistes « ponts » permettant de
  passer progressivement d'une clé à l'autre, avec **pré-écoute 30 s**.
- **Crossfader Master** : glissière centrale de transition **à puissance égale** entre les deux
  canaux (gauche = 100 % Deck A, droite = 100 % Deck B, au milieu 50/50 sans coupure de volume).

> **Clé Camelot (notation 1A–12B)** : un classement des tonalités sur un cercle de 24 cases
> (12 numéros × modes A mineur / B majeur). Deux pistes « voisines » sur la roue se mélangent
> bien ; c'est un repère visuel immédiat pour le DJ.
>
> **BPM (Battements Par Minute)** : mesure du tempo, c.-à-d. le nombre de temps (battements) par
> minute. Un morceau à 120 BPM a deux battements par seconde.

### 2.3 L'Atelier Beatgrid & Mashup

Onglet central dédié à la synchronisation fine et au mashup de deux pistes.

- **Double forme d'onde superposée** : la piste A (émeraude) et la piste B (bleu) s'affichent en
  parallèle, autour d'une **aiguille dorée centrale** qui marque le temps de lecture.
  - Rendu **Canvas 2D 60 fps** haute densité en **waveform miroir haute définition** : barres fines
    (2 px de large, ~1 px d'écart) **symétriques autour de l'axe horizontal central**, avec contraste
    dynamique (`Math.pow` 1.5) pour faire ressortir chaque kick et pause. **3 couches de l'intérieur
    vers l'extérieur** : Basses **cuivre** au centre, Voix/Mélodie **émeraude (A) / bleu (B)** au
    milieu, Aigus **or clair** aux pointes. Les ondes sont **agrandies (200 px)** et les pistes
    télémétriques à **60 px** ; scaling `devicePixelRatio` auto. Légende des couleurs en **haut du
    cadre** : *Cuivre : Basses • Vert/Bleu : Voix & Mélodie • Or : Aigus*.
- **2 pistes télémétriques dédiées** (sous les ondes principales) : deux bandes compactes (~60 px),
  émeraude Platine A / bleu Platine B, traversées par la même aiguille dorée et synchronisées sur le
  zoom (4/8/16 MES) et `elapsedSeconds`. Elles affichent l'analyse selon le **calque choisi** :
  - **TEMPO** : courbe lumineuse de l'évolution du **tempo local** (normalisé dans l'octave du BPM
    global de la platine, `0.75× ≤ local ≤ 1.35×` — supprime les faux 240 BPM) + **valeur BPM
    instantanée** et **halo ambré** là où la dérive dépasse **±0.5 BPM** par rapport au tempo moyen.
  - **CLÉS** : **blocs segmentés de clés Camelot** (2A, 8A, 4B…) par phrase musicale, avec
    **surlignage cuivré** en cas de **clash** harmonique entre A et B.
- Sélecteur **CALQUE [ TEMPO | CLÉS ]** dans la barre d'outils pour basculer d'un calque à l'autre.
- **Repères de phrasé** : les traits dorés (toutes les 4 mesures) portent leur **numéro de mesure**
  (M1, M5, M9…) en haut ; la lecture est indiquée par **◄ Passé / À venir ►** de part et d'autre de
  l'aiguille centrale.
- **Vocabulaire starter-friendly** : cartes **Platine A • Maître / Platine B • Synchro**, bouton
  **Caler Temps 1** (ancrage du temps 1), bandeau **Conseil** d'action contextuel en 1 ligne.
- **Vérité de synchronisation** : le statut n'affiche **RYTHME VERROUILLÉ ✓** que si **les 2 platines
  sont chargées** **et** que leur **tempo effectif est aligné (`|ΔBPM| ≤ 0.2`)** ; sinon **TEMPOS
  NON ALIGNÉS** en ambre. L'infobulle donne l'écart en ms / les BPM effectifs.
- **Vernier de phase** : réglage fin du décalage temporel (ms) avec pourcentage de verrouillage.
- **Édition de grille** : **Caler Temps 1** (poser le temps 1), **décalage fin ±10 ms**, correcteur
  d'octave **÷2 / ×2** (demi-tempo / double-tempo). Le canvas est redessiné **immédiatement** (60 fps,
  même tick) et l'**offset courant** (`+0 ms` / `+15 ms`) est affiché juste à droite de **×2**.
- **Cible d'édition GRILLE : PLATINE A | PLATINE B** (ALC-162) : libellés unifiés (au lieu de
  « Tape A/Tape B ») ; la **waveform ciblée est illuminée** — bordure émeraude (`#10b981`) + halo Platine A,
  ou bordure bleue (`#38bdf8`) + halo Platine B — avec un badge discret **CIBLE GRILLE**. Un **clic sur le
  cadre d'une onde (ou la touche Entrée/Espace)** bascule la cible d'édition sur cette platine.
- **Auto-Loop Roll quantifié** : boucle de **1/2 à 16 temps**, parfaitement calée sur la grille
  (`T_beat = 60 / BPM`), avec marqueurs **▲ IN / OUT ▲**.
- **4 Hot Cues par platine** : repères instantanés **INTRO, DROP, ACAP, OUTRO**, **dédoublés
  visuellement par piste** (Tape A émeraude / Tape B bleu). Poser un repère puis cliquer pour
  rappeler la position dans la piste.
- **ALIGNER TEMPO & PHASE** : cale automatiquement le Deck B sur le Deck A (pitch + position).
- **▶ LANCER A + B / ⏸ PAUSE A + B** (ALC-161) : à droite d'« Aligner Tempo & Phase », un **bouton
  doré** lance **simultanément les deux platines** dans le même tick (positions + `transport`
  synchrones dérivées de `setTransport`/`startPlayer` des decks). Si les tempos/phases ne sont pas
  encore alignés, l'alignement automatique de B sur A est exécuté d'abord ; les positions de départ
  (`startPosA`, `startPosB`) sont mémorisées pour le rappel. Le même bouton bascule en
  **⏸ PAUSE A + B** quand les deux platines jouent.
- **↺ RETOUR CALAGE** (ALC-161) : bouton compact qui met en pause (ou repositionne à la volée) les
  deux platines sur `(startPosA, startPosB)` pour **re-tester la transition en un clic**, autant de
  fois que souhaité.
- **Assistant de transition** (BridgeSuggester) : bandeau d'alerte harmonique + **Smart Filter**
  qui atténue automatiquement les graves/médiums en cas d'incompatibilité de clé pendant le mix.
- **Cartes comparatives** : résumé compact « Tape A • Pivot / Tape B • Récepteur » (BPM, clé),
  positionnées en une rangée dense pour ne pas gaspiller d'espace vertical.

### 2.4 Système & Onglets complémentaires

- **POWER OFF** (bouton d'extinction) : purge les caches côté frontend puis **ferme proprement**
  l'application Tauri via la commande `exit_app`.
- **Onglet LIBRAIRIE** (`LibraryView.svelte`) : catalogue musical **local et persistant**
  (base **SQLite** `library.db`, backend Rust `library.rs`). On y **archive** les platines A/B,
  **importe récursivement un dossier** (mp3/flac/wav/m4a/ogg analysés en BPM & clé Camelot par le
  moteur MIR), **recherche** instantanément, filtre par compatibilité (**TOUS** / **COMPATIBLE A** /
  **COMPATIBLE B** / **★ DUOS**) et trie (**AFFINITÉ** / **CLÉ** / **TEMPO**). Chaque piste peut être
  **pré-écoutée au casque** (▶/❚❚ via `convertFileSrc`), **chargée** sur la Platine A ou B (badge
  « SUR PLATINE A/B ») ou **retirée** du catalogue (×). La cartouche **Suggestion Mashup** de
  l'Oracle affiche la meilleure association détectée par le matcher (`mashupMatcher.ts`) et permet
  de la **valider en duo ★** ou de l'**envoyer sur la platine libre**. La platine de
  **référence** du calcul (affinité, labels harmoniques, Δ BPM) **suit le filtre actif** :
  `COMPATIBLE B` → Platine B, sinon Platine A (repli si non chargée) ; toute piste **déjà chargée**
  sur une platine (SUR PLATINE A / SUR PLATINE B) n'obtient plus de **score d'affinité**, est
  **classée en bas de liste** et est **exclue** des compteurs et listes filtrées **COMPATIBLE A/B**
  et de l'**Oracle** (aucune auto-association) pour ne jamais gonfler les vrais partenaires. La
  détection repose sur **`isSameTrack(lib, deck)`** : `filePath` normalisé (`\`→`/`, minuscules,
  espaces retirés) ou, en repli, titre ET artiste normalisés. La cartouche
  Oracle propose **« CHARGER LE DUO → A & B »** à platines vides (sinon envoi sur la platine libre) ;
  la pré-écoute gagne une **barre dorée de scrubbing** et un **volume casque** dédié ; le **liseré du
  badge CLÉ** est coloré selon la compatibilité (émeraude A / bleu B / doré relatif) et des **pochettes
  miniatures** (28×28, encadrées laiton) s'affichent quand disponibles ; le **GENRE** et le **TITRE**
  sont **éditables en double-clic** (commande IPC `library_update_track_meta`) et un bouton discret
  **« EXPORTER SET »** (`.m3u`/`.txt`) exporte la setlist des duos validés. Défilement interne
  `overflow-y-auto`, `h-screen overflow-hidden` préservé.
- **Favicon / icônes** : monogramme vectoriel AlcheMix II intégré à l'application et au bureau.
- **AUTO-MIX (Crossfader assisté & Bass-Swap automatique)** : bloc horlogère sur la barre du
  Crossfader Master — sélecteur **8 MES / 16 MES**, bouton directionnel intelligent (**⇄ AUTO-MIX → B**
  côté A, **⇄ AUTO-MIX → A** côté B), **STOP** et **jauge de progression**. `startAutoMix(bars,
  direction)` calcule la durée **T = bars × 4 × 60 / BPM effectif** (repli à 120 BPM) puis, à **60 fps**,
  déplace le Crossfader Master vers la platine cible, exécute un **Bass-Swap** progressif sur les
  LOW EQ 120 Hz (grave sortant → −20 dB à mi-parcours, grave entrant → 0.0 dB, restauration après
  coupe du volume) et **glisse le pitch** de la platine entrante vers le tempo maître (1re moitié) si
  l'écart ≤ 6 %. Toute saisie manuelle du crossfader ou d'un LOW EQ appelle **`cancelAutoMix()`** immédiatement.
- **Pistes Ponts locales (Harmonic Bridge Finder)** : lorsque les platines A et B ont un écart
  harmonique **≥ 2 quintes** ou rythmique **> 8 %**, l'Oracle Acoustique affiche **en priorité** les
  meilleures pistes PONT issues de la **Librairie SQLite locale** (`findLocalBridgeTracks` : pivot
  harmonique 55 % + palier tempo 35 % + bonus duo 10 %, hors pistes déjà chargées), avec badge
  **LIBRAIRIE LOCALE**, score %, clé pivot et BPM, et actions **▶** (pré-écoute locale), **→ A / → B**
  (chargement + transition) ; le repli Deezer est conservé. La Librairie affiche aussi un cartouche
  **PONT A↔B** avec bouton **CHARGER PONT** pour débloquer la transition en un clic.

---

## 3. Spécifications Techniques — Comment c'est codé

### 3.1 Chaîne audio WebAudio (`src/lib/audio/player.ts`)

Chaque platine possède sa propre instance `Player` (un canal audio isolé).

- **Chargement sécurisé** : le frontend demande les **octets bruts** du fichier à Rust
  (`read_audio_file_bytes`) puis les charge en **URL `blob:`**. Cette astuce évite le blocage CORS
  de la WebView sur le protocole `asset://`. L'URL est **révoquée** (`URL.revokeObjectURL`) à
  l'éjection ou au rechargement pour éviter les fuites mémoire.
- **Routage nodal** :

```
  MediaElementAudioSourceNode  (lecture du <audio>)
        │
        ▼
  BiquadFilterNode  LOW  (lowshelf 120 Hz)   ← curseur LOW EQ
        │
        ▼
  BiquadFilterNode  MID  (peaking 900 Hz)    ← Smart Filter (atténuation automatique)
        ▼
  BiquadFilterNode  HIGH (highshelf 3.2 kHz) ← curseur HIGH EQ
        │
        ▼
  GainNode  (gain = volume canal × crossfader puissance égale)
        │
        ▼
  AnalyserNode  (mesure temps réel → galvanomètre)
        │
        ▼
  ctx.destination  (haut-parleurs)
```

- **Sans clic ni latence** : les changements de gain/filtre utilisent des rampes temporelles
  (`setTargetAtTime` / `setValueAtTime`). L'`AudioContext` est réveillé au clic sur PLAY (règle
  des navigateurs : le son doit démarrer sur un geste utilisateur).
- **Rendu 60 fps** : l'animation (bobines, galvanomètres, aiguille Beatgrid) est pilotée par
  `requestAnimationFrame`, découplée du cycle de rendu DOM de Svelte pour éviter tout ralentissement.

> **Runes Svelte 5** : la nouvelle syntaxe de Svelte pour la réactivité. `$state` déclare une
> variable réactive ; `$derived` calcule une valeur dérivée automatiquement ; `$effect` exécute
> du code quand ses dépendances changent ; `$state.raw` stocke une valeur **sans proxy profond**
> (idéal pour de grands tableaux d'échantillons, voir 3.2, pour rester rapide).

### 3.2 Moteur d'analyse musicale Rust (`src-tauri/src/audio.rs`)

L'analyse est lancée **hors du thread principal IPC** (`tokio::task::spawn_blocking`) pour ne
jamais bloquer l'interface.

| Étape | Technique détaillée |
|---|---|
| **Décodage** | Symphonia décode tout format supporté, réduit en **mono 48 kHz** (« monophonie » : mélange des canaux gauche/droit en un seul). |
| **Référence de calcul** | FFT **4096** sur **48 kHz** (≈11.7 Hz par bac) + saut (hop) **1024** (≈21 ms) — compromis précision/CPU documenté (ALC-008). |
| **Tempo (BPM)** | Rééchantillonnage 8 kHz → **STFT** (spectrogramme temporel) → **onsets sub-basses kick** (40–126 Hz) → **peigne gaussien CONTINU multi-fenêtres** : fenêtres 10 s filtrées < 35 % médiane (et **saut des 25 % initiaux** si intro ambiante < 50 % de la médiane, ALC-158), noyau gaussien **σ_t=0.022 s** aligné sur `t_k = φ + k·60/bpm` (temps **flottants**), **peigne Coarse-to-Fine (ALC-159)** : scan grossier [75–155] pas 1.0 BPM → top 3 → raffinement pas 0.1 sur ±2,5, **rejet des sous-harmoniques 2/3** (comb_parity + comparaison B vs 1.5·B ≥ 88 % et parité suspecte → 1.5·B) → agrégation **KDE σ=0.6** → BPM global exact. **ALC-160 — normalisation par DENSITÉ : score = moyenne par battement THÉORIQUE `N = durée_fenêtre / T`** (plus jamais de somme brute sur la fenêtre fixe → un peigne à 98 BPM n'a aucun avantage numérique sur 91 BPM) **+ pénalité de HORS-PHASE** (`0.35 × énergie_moyenne(t_k + T/2)`, vallées entre temps) → score maximal au vrai tempo 91.0 (> 96.5/98/99). **ALC-158 — interpolation linéaire continue de l'autocorrélation** : helper `interp_autocorr` (Pearson à lag RÉEL entre `r[floor]`/`r[ceil]`) branché sur `tempo_autocorr` (peigne binaire continu `1.0r(b)+0.45r(2b)+0.35r(b/2)−0.30r(1.5b)`, [75–155] pas 0.1 + interp parabolique du sommet). **DP linéaire O(N) (ALC-159)** : prédécesseurs **bornés [0.5·period .. 2.0·period]**, période réelle `period_f` + beats sub-trame `refine_beat_pos` → BPM continu. **ZONE CENTRALE active (ALC-159)** : piste > 110 s → 90 s centrales (−20 % intro / −15 % outro) pour le BPM ; waveform intégrale conservée. (ALC-152 → 160). |
| **Tonalité (Camelot)** | **HPCP** (chromagramme harmonique, **36 bacs/octave** = 3 bacs par demi-ton, **bande 90–1400 Hz**, repli harmonique borné à 1400) replié en 12 classes **par division (bac/3)**, accordage fin sur les 36 bacs avant repli → profils **normalisés en Z-score** (KS + Temperley + Shaath + EDMA/BGATE, égale majeur/mineur) → **pondération des trames HPCP par leur énergie harmonique nette** (refrains/couplets > intros/ponts) → tonique par corrélation + **arbitrage Majeur vs Mineur homonyme** (tierce +3 vs +4 pondérée par `bass_chroma`, trames percussives ×**1.15**) + **ancrage de tonique par la basse** (seuil quinte inférieure **0.82**) → code **Camelot** + confiance [0,1]. **La clé globale est analysée sur TOUT le morceau (0 %–100 %), décimé à 12 kHz** (ALC-159 → 160 : `AnalyzerCfg` proportionnel → résultat identique, et **passe-bas Butterworth ordre 2** `Lowpass2Stream` avant décimation → pas de repliement harmonique) : la TONALITÉ n'est plus bornée à la fenêtre centrale — intros/outros où la tonique mineure est établie sont conservés (restaure 6A sur Hand In My Pocket / Money for Nothing, corrige le triton 4A Cutting Crew). La ZONE CENTRALE 90 s ne sert qu'au BPM. (ALC-151 → 160). |
| **Arbitrage hybride** | La clé DSP locale est **recoupée** avec les références **AcousticBrainz / MusicBrainz** : consensus, voisinage ou divergence → clé arbitrée + indicateur d'origine. |
| **Segmentation (4 mesures)** | Découpe en **segments ~4 s** (fenêtres glissantes, hop 50 %) avec pour chaque segment : **RMS 3 bandes** (<120 Hz sub / 120–4000 Hz médium / >4 kHz aigus), **tempo local** et **clé Camelot locale**. Alimente la sculpture 3 bandes et les calques TEMPO/CLÉS du Beatgrid. |
| **Pochette** | Extraite des métadonnées embarquées (`lofty`), sinon fallback API musicale côté frontend. |

> **STFT** : *Short-Time Fourier Transform*, « transformée de Fourier à court terme ». Elle
> découpe le signal en courtes fenêtres temporelles et calcule les fréquences contenues dans
> chacune — le son devient une « image » (temps × fréquence).
>
> **HPCP** : *Harmonic Pitch Class Profile*, un profil harmonique qui compte l'énergie de chaque
> note dans la piste, utilisé pour décider de la tonalité.

### 3.3 Tableau des Commandes IPC (`Svelte ↔ Rust`)

Commandes `#[tauri::command]` (enregistrées dans `src-tauri/src/lib.rs`) appelées par le frontend :

| Commande (invoke) | Paramètres | Retour principal |
|---|---|---|
| `load_audio_file` | `path: String` | **TrackData** : métadonnées, BPM, clé Camelot + confiance, durée, `waveform_peaks`, `key_timeline`, `segments` (RMS/tempo/clé locaux), pochette (Data-URL). |
| `open_audio_file` | *(aucun)* | `Option<String>` : chemin du fichier choisi (ou `None` si annulé). Ouvre le sélecteur système filtré (`flac, wav, aiff, mp3, ogg`). |
| `detect_tempo_camelot` | `base_bpm`, `pitch_percent`, `camelot_key?` | **TempoCamelot** : BPM, `camelot_key`, `camelot_label`, `pitch_percent`, `effective_bpm`. |
| `extract_stems_onnx` | `path: String` | **StemPaths** : chemins des 4 stems (Vocals, Drums, Bass, Other) calculés via session **ONNX** (htdemucs‑v4). |
| `read_audio_file_bytes` | `path: String` | `Vec<u8>` : octets bruts du fichier pour créer l'URL `blob:` côté WebAudio. |
| `exit_app` | *(aucun)* | *(aucun)* : fermeture propre de l'application (après purge du cache). |
| `library_list_tracks` | *(aucun)* | `Vec<LibraryTrack>` : toutes les pistes du catalogue (de la plus récente à la plus ancienne). |
| `library_upsert_track` | `track: LibraryTrackInput` | **LibraryTrack** (idempotent sur `file_path` ; complété par les tags `lofty` puis l'analyse MIR si besoin). |
| `library_import_folder` | `folder_path: String` | **LibraryImportReport** (`found/inserted/updated/failed/totalTracks`). Scan récursif + analyse hors thread IPC, progression émise sur l'événement `library://scan`. |
| `library_delete_track` | `id: i64` | `bool` : retrait de la piste (et de ses duos ★ via `ON DELETE CASCADE`). |
| `library_toggle_duo` | `track_a_id`, `track_b_id` | `bool` : le duo existe **après** l'opération (paire normalisée `a < b`). |
| `library_list_duos` | *(aucun)* | `Vec<ValidatedDuo>` : les duos ★ validés. |
| `library_update_track_meta` | `id`, `title?`, `genre?` | **LibraryTrack** : édition rapide du titre/sous-genre directement en base, sans ré-écraser par les tags du fichier. |

---

## 4. Historique consolidé des évolutions

Tableau synthétique (un ticket = une ligne, sans duplication du détail — le détail des
fonctionnalités est décrit plus haut dans les sections concernées).

| Jalon / ID | Domaine | Apport fonctionnel ou technique |
|---|---|---|
| ALC-001 | Infrastructure | Amorçage du socle SvelteKit (adapter-static) + Tauri 2 + pont IPC de base. |
| ALC-002 | Architecture | Grille 3 colonnes (Deck A / console / Deck B) + Roue de Camelot + Oracle. |
| ALC-003 | UI Cassette | Restoration 1:1 des cassettes photoréalistes, VU balistique et faders dorés. |
| ALC-004 / ALC-021 | Console | Épuration UX et correction de la Roue de Camelot. |
| ALC-005 | IPC / Fichiers | Sélecteur de fichiers audio Tauri (plugin-dialog) relié à l'interface. |
| ALC-006 / ALC-008 | Analyse | Analyse BPM & clé Camelot temps réel ; choix fidélité FFT 4096/48 kHz. |
| ALC-007 / ALC-010 / ALC-012 | Suivi | Tableau de bord Kanban `board.html`, correction de Live Sync, journaux par ticket. |
| ALC-009 | UI | Micro-LEDs lumineuses sur les faders. |
| ALC-011 | Repo | Initialisation / publication Git-GitHub. |
| ALC-101 | Transport | Gestion du transport et des platines (PLAY, PAUSE, STOP, REW, FFWD, CUE). |
| ALC-102 | UI | Galvanomètres VU-mètres balistiques. |
| ALC-103 | UI | Potentiomètres Volume et régulateurs de cadence (Pitch). |
| ALC-104 | Console | Roue de Camelot & Oracle Acoustique. |
| ALC-105 | Mixage | Crossfader Master à puissance égale ; réconciliation du Backlog. |
| ALC-106 / ALC-120 / ALC-125 / ALC-128 | Télémétrie | Bloc télémétrie Rythme & Clé (refonte typo, 3 indicateurs, cartouche dynamique, états vides). |
| ALC-107 | Suivi | Correction du bug de réinitialisation des tickets (persistance `tasks.json`). |
| ALC-121 / ALC-123 | Console | Lisibilité des clés actives ; aiguilles semi-transparentes Breguet (esthétique roue). |
| ALC-122 | Transport | Correction des commandes de transport (PLAY/REC/CUE/REW/FFWD/STOP). |
| ALC-124 | UX | Indicateur visuel d'analyse en cours au chargement. |
| ALC-126 | Ergonomie | Plein écran sans défilement (`h-screen overflow-hidden`) + état initial vide des platines. |
| ALC-127 | Médias | Récupération des pochettes (embarquée + fallback API musicale). |
| ALC-129 | Ergonomie | LOAD / EJECT + glisser-déposer sur les cassettes. |
| ALC-130 | Polish | Passe de raffinement esthétique (Unslop) : copy, spacing, icônes, motion. |
| ALC-131 | Temps réel | État temps réel (header MOTEUR AUDIO, bandeau harmonique, itinéraires, cartouches crossfader). |
| ALC-132 | Console | Jauges segmentées, Marquee, Timer ROLL, potentiomètre LOW EQ. |
| ALC-133 | Console | Oracle neutre au repos + favicon/icônes Tauri. |
| ALC-134 | Métadonnées | Enrichissement MusicBrainz & Cover Art Archive (genre / année réels). |
| ALC-135 | Console | Harmonic Bridge Finder — pont de clé Camelot via Deezer (pré-écoute 30 s). |
| ALC-136 | Audio | Correction du pipeline de lecture audio + liaison galvanomètre WebAudio/Tauri (URL `blob:`, `preservesPitch`). |
| ALC-137 | Audio | Volume & Crossfader (courbe), bobines rAF différentielles, égaliseur 2 bandes + typo. |
| ALC-138 | Audio | Correction effective du gain Volume/Crossfader + déplacement du Crossfader dans la console. |
| ALC-139 | Système | Sliders EQ horizontaux, purge cache / POWER OFF (commande `exit_app`). |
| ALC-140 | UI | Favicon vectoriel, onglet LIBRAIRIE (placeholder), compteur ROLL agrandi. |
| ALC-141 | Analyse | Arbitrage harmonique hybride DSP local + AcousticBrainz/MusicBrainz. |
| ALC-142 | Beatgrid | Atelier Beatgrid complet : grille hiérarchisée, Auto-Loop Roll quantifié, vernier de phase, synchronisation mashup. |
| ALC-143 | Beatgrid | Assistant de transition harmonique (BridgeSuggester + Smart Filter sur bande médium). |
| ALC-144 | Beatgrid | Heatmap Camelot secondaire (analyse de clé par fenêtres temporelles) sous chaque waveform. |
| ALC-145 | Beatgrid | Corrections UI : dynamique des barres lisible, identité chromatique A/B (émeraude/bleu), cartes comparatives compactes, Hot Cues dédoublés par piste. |
| ALC-146 | Beatgrid | Segmentation sonore (RMS 3 bandes + tempo/clé locaux) & waveform **Canvas 2D 60 fps** avec calques **TEMPO / CLÉS**. |
| ALC-147 | Beatgrid | Séparation visuelle : **2 pistes télémétriques dédiées** sous les ondes principales (émeraude Tape A / bleu Tape B) pour l'évolution du **Tempo** et les **Clés Camelot**, branchées sur CALQUE [ TEMPO \| CLÉS ], ondes principales épurées (sculpture 3 bandes seule). |
| ALC-148 | Beatgrid | Agrandissement des formes d'onde principales (Tape A/B) à **160 px** de haut (constante partagée, scaling devicePixelRatio auto) pour une lisibilité accrue des transitoires, sub-basses et repères de grille. |
| ALC-149 | Beatgrid | Lisibilité & ergonomie débutant : ondes **200 px** + pistes télémétriques **60 px**, **normalisation d'octave** du `local_bpm`, vocabulaire **Platine A/Maître · B/Synchro · Caler Temps 1 · RYTHME VERROUILLÉ ✓**, micro-légende fréquentielle, Hot Cues + Auto-Loop en **2 colonnes symétriques** et bandeau **Conseil** d'action. |
| ALC-150 | Beatgrid | Lisibilité approfondie : **waveform miroir HD** (barres fines 2px symétriques, contraste `Math.pow` 1.5, 3 couches intérieur→extérieur), **phrasé M1/M5/M9**, **◄ Passé / À venir ►**, légende des couleurs en haut du cadre, et **vérité de synchronisation** (RYTHME VERROUILLÉ ✓ seulement si platines chargées + `|ΔBPM| ≤ 0.2`, sinon TEMPOS NON ALIGNÉS en ambre), courbe TEMPO recalée sur `effectiveBpm`. |
| ALC-151 | Audio / DSP | **Calibration de la détection de clé Camelot** : correction du repli HPCP (division par 3 au lieu du modulo 12 qui décalait la tonique ⇒ fin du biais A maj→D♯/E♭), bande 100–2500 Hz, **Z-score des profils**, pénalité conditionnelle de quinte, chroma de **magnitude** prioritaire (tierce majeure/mineure) ; + tests PCM 11B/12B/9B/8A. |
| ALC-152 | Audio / DSP | **Précision sub-BPM & arbitrage homonyme** : interpolation parabolique du pic d'autocorr (BPM continu, fin des paliers 93.8/138.9), plage primaire **[72–162] + prior 118** (fin des décrochages ternaires 208 vs 77), onsets **kick 45–180 Hz** ; bande HPCP **90–1400 Hz** et **arbitrage explicite Majeur/Mineur homonyme** (+ pénalité de quinte ferme < 8 %) ⇒ correction des mineurs 6A/2A (et du glissement rock +1 h) ; tests 6A/2A + 91.0/134.0 BPM. |
| ALC-153 | Audio / DSP | **Correction du biais des harmoniques rythmiques BPM** : onsets resserrés aux **sub-basses de grosse caisse (40–126 Hz)**, **prior plat & large plané** (105/σ38, plateau ~77–155 — ne favorise plus 129–156 vs 77–91), **pénalité des sous-harmoniques rapides** (T/1.5 ternaire, T/2 si ≥150) ; **pénalité de quinte renforcée sur les guitares rock** : ancrage de la tonique par la basse (`quinte inférieure ≥ 85 % de la tonique`). Tests : rythme 85 BPM ternaire → 85 (pas 129), power chord Do → 8B. |
| ALC-154 | Audio / DSP | **Moteur BPM multi-fenêtres par peigne métrique BINAIRE** : suppression de la division T/1.5 (qui cassait 118/133/146), fenêtres 10 s filtrées < 35 % médiane (intros), score continu `1.0r(b)+0.45r(2b)+0.35r(b/2)−0.30r(1.5b)` + agrégation KDE → 89/133/146 BPM exacts ; **raffinement tonal par densité harmonique** (pondération des trames HPCP + seuil de quinte **0.78**). Tests : 146/133 non divisés, croches pointées 89 vs 133.5. |
| ALC-155 | Audio / DSP | **Verrouillage de phase temporelle** : `impulse_comb` (peigne d'impulsions EN PHASE, 4 phases, énergie 1×T & 2×T) en affinage ±12 % — corrige le glissement +5 % (85→93.8, 91→96, 123→129) ; KDE resserrée **σ=0.6** ; **pondération des temps forts (×1.8) dans bass_chroma** + seuil de quinte **0.82**. Tests : peigne 91 vs 96. |
| ALC-156 | Audio / DSP | **Peigne gaussien CONTINU + rejet 2/3** : noyau σ_t=0.022 s en temps flottants (fin des paliers 7500/lag : 93.8/98.7/85.2), balayage [76–154] pas 0.25, `comb_parity` + comparaison B vs 1.5·B (≥88 %) pour éliminer les verrouillages sous-harmoniques 2/3 (118→81.5, 125→85.2, 133→87.2) ; poids percussif tonal ramené à **1.15**. Tests : 125/118/91 sans capture 2/3 ni plateau entier. |
| ALC-157 | Métadonnées | **Extraction complète des métadonnées ID3/Vorbis/MP4 via `lofty`** et suppression des valeurs de test dans l'affichage : `read_tags` lit titre/artiste/album/genre/année/**BPM (TBPM)**/**clé (TKEY)**, normalise la clé en **Camelot 1A–12B** (`normalize_camelot_key`), convertit les index ID3v1 numériques en libellés (`id3v1_genre_label`, 17⇒Rock). `TrackData` étendu (album, year, tagBpm, tagKey) ; frontend affiche les tags réels avec **« — »** si absents (suppression de « DJ Danoë » / « Venetian Clockwork / Electronic » codés en dur). Tests : `read_memory_tagged_metadata_without_test_values` + `id3v1_numeric_genre_converted` (38/38). |
| ALC-158 | Audio / DSP | **Interpolation linéaire continue de l'autocorrélation + suppression du biais de parité des lags pairs** : glissement +4 à +9 BPM (alchemix_tests v1.5, paliers pairs 150/133.9/129.3/96.2/93.8…) causé par la re-quantification entière. Ajout de **`interp_autocorr`** (Pearson à lag RÉEL `r[floor]→r[ceil]`) branché sur `tempo_autocorr` (peigne binaire continu `1.0r(b)+0.45r(2b)+0.35r(b/2)−0.30r(1.5b)`, **balayage [75–155] pas 0.1** + interp parabolique du sommet) ; **DP libéré de la grille entière** (période réelle `period_f` + beats affinés sub-trame `refine_beat_pos` → BPM continu) ; **saut des 25 % initiaux** d'intro ambiante (< 50 % médiane) dans `tempo_comb_windowed`. Tests : 123/92.6/141.5 BPM résolus à ±0.5 sans saut vers 129.3/96.2/150.0 + `interp_autocorr_parity_neutral` + `ambient_intro_25pct_skipped` (45/45). |
| ALC-159 | Audio / DSP | **Accélération majeure du pipeline** (analyse > 1 min → < 1,5 s) : ① **profil dev optimisé** (`[profile.dev] opt-level=2` + deps `opt-level=3` → symphonia/rustfft/boucles DSP à pleine vitesse en `tauri dev`) ; ② **décimation 48 kHz → 12 kHz** (`decimate_to_analysis`, facteur ENTIER 4 + anti-repliement moyenne mobile) ciblée sur la clé CAMELOT GLOBALE via **`AnalyzerCfg`** (fft/hop/bin_hz proportionnels → clé identique, Nyquist 6000 Hz ≥ bande 40–1400 Hz) ; ③ **zone centrale active** (`active_window` : 90 s centrales, −20 % intro / −15 % outro pour piste > 110 s, waveform intégrale) ; ④ **peigne Coarse-to-Fine** (scan 1.0 BPM → top 3 → raffinement 0.1 sur ±2,5) ; ⑤ **DP linéaire O(N)** (prédécesseurs bornés [0.5·period .. 2.0·period]). Tests : `analyze_3min_under_1s5` (piste 3 min 48 kHz < 1,5 s, clé décimée = pleine fréquence) + `active_window_skips_intro_outro` (47/47). |
| ALC-160 | Audio / DSP | **Normalisation du peigne par densité d'impulsions + tonalité sur l'INTÉGRALITÉ du morceau** (correctifs des effets secondaires d'ALC-159, tests v1.6) : ① **biais +3..+10 % vers le haut** (14 titres) causé par la somme du peigne sur fenêtre fixe (plus de dents à 98 BPM qu'à 91) → **`comb_score_normalized`** : moyenne par battement THÉORIQUE `N = durée_fenêtre/T` + **pénalité de hors-phase** `0.35 × énergie(t_k + T/2)` → score maximal au vrai tempo 91.0 (> 96.5/98/99) ; ② **régression tonale 6A→9B** (Hand In My Pocket, Money for Nothing) car la tonalité était bornée à la fenêtre centrale 20–75 % → **découplage** : fenêtre centrale 90 s réservée au BPM, **HPCP/Camelot extraite sur TOUT le morceau (0–100 %) décimé** via **`Lowpass2Stream`** (Butterworth ordre 2 avant décimation, anti-repliement) → restaure 6A, corrige triton 4A Cutting Crew. Tests : `comb_normalized_maximal_at_true_tempo_91` + `comb_density_rejects_fast_tempo_on_fixed_window` + `tonality_uses_full_track_decimated` (50/50). |
| ALC-161 | Beatgrid | **Lecture synchronisée A+B dans la vue Beatgrid** : bouton **doré ▶ LANCER A + B** (⇄ **⏸ PAUSE A + B**) à droite d'« Aligner Tempo & Phase » — rappelle l'alignement automatique de B sur A si ΔBPM/phase non nuls, **mémorise `startPosA` / `startPosB`**, et **démarre simultanément les deux lecteurs dans le même tick** (positions + `transport` synchrones, sans décalage manuel) ; bouton compact **↺ RETOUR CALAGE** qui **met en pause/repositionne les deux platines sur `(startPosA, startPosB)`** pour re-tester la transition en un clic. Mise à jour de la ligne **Conseil** : « 1. Aligner Tempo & Phase • 2. Coupez les basses (LOW EQ) sur B • 3. « ▶ Lancer A + B » ». `npm run check` 0/0, `h-screen overflow-hidden` préservé. |
| ALC-162 | Beatgrid | **Retour visuel de cible d'édition + libellés unifiés** : « CIBLE : TAPE A | TAPE B » → **« GRILLE CIBLE : PLATINE A | PLATINE B »** ; la **waveform ciblée est illuminée** (bordure émeraude `#10b981` + halo ≙ Platine A, bordure bleue `#38bdf8` + halo ≙ Platine B) avec un badge discret **CIBLE GRILLE** ; **clic sur le cadre d'une onde (ou Entrée/Espace)** pour basculer la cible ; **offset de grille courant** (`+0 ms`/`+15 ms`) affiché juste à droite de **×2** ; CALER TEMPS 1 / ◄ / ► redessinent le canvas **immédiatement** (60 fps, même tick). `npm run check` 0/0, `h-screen overflow-hidden` préservé. |
| ALC-163 | Release | **Release GitHub récurrente + exécutable Windows autonome + Signature numérique Authenticode** : ticket `"recurrent": true` (jamais « Terminé » → Backlog + subtasks `false` après exécution) ; pipeline v0.2.0 (pré-contrôle npm/cargo, bump de version, `npm run tauri build` NSIS/MSI, commit/tag/push, GitHub Release via API REST avec asset `.exe` attaché). **Signature** : detection signtool (Windows Kits), certificat officiel (Azure Trusted Signing/SignPath.io) sinon certificat local dev (`New-SelfSignedCertificate -Type CodeSigningCert`), hook `bundle.windows.signCommand` piloté `TAURI_SIGN_PFX/TAURI_SIGN_PASSWORD/TAURI_SIGNTOOL`, signature `/fd SHA256 /tr http://timestamp.digicert.com /td SHA256`, vérification `signtool verify /pa`, re-upload de l'asset signé sur la release. **Signature OFFICIELLE (diffusion publique)** : workflow `.github/workflows/release.yml` prêt à l'emploi — étape `azure/trusted-signing-action@v0` (secrets `AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET/AZURE_CERTIFICATE_NAME`) pour signer par une CA reconnue Microsoft, ou étape **SignPath.io (gratuit Open Source)** décommentée ; **note SmartScreen** documentée dans `README.md` (§ Installation Windows) et les notes de release (certificat auto-signé → « Informations complémentaires / Exécuter quand même » ; disparaît une fois signé par un cert reconnu). |

| ALC-173 | Méthodologie | **Skills superpowers sélectives** : `systematic-debugging` (débogage systématique — règle d'or cause-racine, cycle 4 phases, garde-fou 2 tentatives) ; `verification-before-completion` (*Evidence over claims* — preuve d'exécution requise avant `completed:true` / « En revue » : npm check, cargo check/test --lib, node --check board.html, artefacts) ; `tdd-audio-logic` (RED→GREEN→REFACTOR sur la logique DSP/MIR) ; références concises intégrées dans `.clinerules/03` et `05`. |
| ALC-186 | UI / UX | **Refonte ergonomique verticale par tiroirs horlogers escamotables (`HorologicalDrawer.svelte`)** — nouveau composant réutilisable Svelte 5 (Runes `$props`/`$state`/`$derived`/`$effect`, `open` bindable) habillé charte Venezia 1889 : plaque fermée 30 px ébène/laiton oxydé avec 4 micro-vis d'angle, titre gravé Space Grotesk, badge de statut, **micro-LED d'activité** (accent émeraude/bleu) et loquet doré (▾/▴) ; cuve interne ébène encastrée (`inset 0 4px 12px rgba(0,0,0,0.9)`) bordée de liserés laiton/canal, ouverture par `max-height` + opacité (transition 220 ms `cubic-bezier(0.22,1,0.36,1)`). **Platines `DeckA`/`DeckB`** : 2 tiroirs fermés par défaut en bas de platine — ① **SÉPARATION STEMS IA** (ouverture auto si `stemsStatus==='separating'`, LED si `ready`/mute/solo, badge `4 STEMS`/`%`/`ERREUR` ; contient extraction + progression + 4 boutons M/S VOIX/BATT/BASSE/INST + presets ACAPELLA/INST) ; ② **MÉTADONNÉES & SPECS AUDIO** (badge `codec • échantillonnage`, pochette, artiste/album/genre/année, spécifications Format/Échantillonnage/Débit). Les blocs réflexes (en-tête, ROLL, cassette, galvanomètre, EQ, transport, faders, télémétrie) restent toujours visibles. **`MixerCenter`** : carte **ORACLE ACOUSTIQUE & ITINÉRAIRES** (conseils + 3 itinéraires) encapsulée dans un tiroir fermé par défaut placé au-dessus du Crossfader ; **Roue de Camelot agrandie** (`max-w-[460px] → [520px]`). `h-screen overflow-hidden` préservé. `npm run check` 0/0. *(BeatgridView non touché — partie de spec tronquée dans le message source.)* |
| ALC-185 | Audio / IA | **Profil anti-bleed définitif du stem `vocals` (Wiener K(f) par bande + gate d'activité vocale doux) + cache `stems-v7`** : après Bon Jovi – Livin' On A Prayer (17,5/20), il restait des résidus de **cymbales crash > ~6,5 kHz** dans les refrains denses et des **instruments solistes / talk-box** dans les intros sans chant. **`wiener_soft_mask` : suppression $K(f)$ par bande** (`wiener_k_at`) — sub-grave < 120 Hz → K=4,0 (élimine grosse caisse/basse) ; cœur des formants 300-4200 Hz → K=1,5 (préserve chaleur/intelligibilité) ; aigu cymbales > 6500 Hz → K=3,5 (réduit le bleed métallique). **Gate d'activité vocale doux** `apply_vocal_gate` : trames lissées 250 ms (attaque 20 ms, relâchement 100 ms) — si le RMS vocal < 12 % de l'énergie instrumentale (drums+bass+other), atténuation douce gain 0,125 (−18 dB) qui nettoie les intros sans chant sans couper les attaques de mots. **Cache `stems-v6 → stems-v7`**. **Tests TDD** : `wiener_band_k_attenuates_8k_more_than_1k` (l'atténuation 8 kHz > 1 kHz à dominance égale) ; `vocal_gate_attenuates_instrumental_preserves_voice` (atténue un passage instrumental > 2×, laisse la voix à gain ≥ 0,95). `npm run check` 0/0, `cargo check` 0/0, `cargo test --lib -- --test-threads=1` **63/63**. |
| ALC-184 | Audio / IA | **STOP définitif (coupure matérielle via `AudioContext.suspend()`) + réduction anti-bleed des stems vocals (overlap 50 % + Wiener soft-mask) + cache `stems-v6`** : en test réel le bouton STOP remettait bien le ROLL à 00:00 mais la chanson continuait (régression résiduelle d'ALC-183). **STOP** — câblage direct & réactif : bouton STOP `onClic → player?.stop()` PUIS `mixerStore.stopDeck(id)` (nouvelle méthode store = `getPlayer(id)?.stop()` + `setTransport('stopped')`) ; le `$effect(deck.transport)` a des **branches explicites** `playing → startPlayer()`, `paused → player?.pause()`, `stopped → player?.stop()` ; unicité Player vérifiée (créé dans `startPlayer`, enregistré `registerPlayer`, réutilisé `getPlayer`). `Player.stop()` : `_playGen++`, `pauseStems()` (arrête **et déconnecte** les `stemNodes`), `audio.pause()+currentTime=0+muted` (si stems actifs), et **`void this.ctx?.suspend()`** → **aucun son ne sort** (coupure matérielle), relancé par un nouveau `play()/playStems()` via `resume()`. **Anti-bleed vocals** (`stems.rs`) : overlap-add passé à **50 %** (`HOP_RATIO 0.5`, Hann symétrique COLA) pour affiner les masques sur les mix denses ; **Wiener soft-mask** `wiener_soft_mask` (STFT n_fft 2048 / hop 1024 / Hann sym, masque par bandes `e_voc/(e_voc + K·e_od)` K=2, P=1) appliqué aux vocals contre `other+drums` : atténue le résidu (cymbales > ~7 kHz, guitares saturées — Spaceman) en **préservant les crêtes formants** de la voix ; reconstruction STFT/iSTFT COLA avec **garde de bord** (`wsum>0.1` sinon repli sur le vocal d'origine) pour éviter une épine d'inflation (régression fidélité ALC-180 pic 1.43 → 0.51 corrigée). Cache **`stems-v5 → stems-v6`**. **Tests** : Rust `wiener_mask_attenuates_bleed_preserves_formant` (8 kHz dominant → atténué `m<0.5·o`, formant 440 Hz préservé `m>0.8·o`), node `stemsStop.test.ts` (assert `ctx.state==='suspended'` après STOP). `npm run check` 0/0, `cargo check` 0/0, `cargo test --lib -- --test-threads=1` **61/61**, `node --test stemsStop.test.ts` **4/4**. |
| ALC-183 | Audio / IA | **Réparation critique STOP & EJECT en mode stems (course asynchrone) + garde de génération + nettoyage réel** : l'échec était en conditions réelles — le test mocké ALC-182 a passé mais, dans la vraie UI, cliquer **STOP** pendant la lecture stems **relançait le `<audio>` mono** (ROLL + galvanomètre se figeaient via `deck.transport='stopped'` alors qu'un flux parasite continuait) et **EJECT** ne nettoyait pas le Player. **Cause racine ① (STOP)** : le `$effect(deck.transport==='playing')` des decks lance `startPlayer()` **asynchrone** ; au clic STOP, une **continuation périmée** (mid-await) pouvait encore appeler `player.play()` → `audio.play()` (mono) sans aucune garde invalidant la lecture en vol. **Correctif** : **garde de génération `_playGen`** dans `Player` — `play()`/`playStems()` capturent la génération et sont **avortées** si `stop()`/`pause()` ont incrémenté la génération pendant le démarrage asynchrone ; `stop()` coupe 100 % des sources (stems ET mono `paused`+`currentTime=0`+**`muted`** tant que le mode stems est actif) ; `transport='stopped'` + `elapsedSeconds=0` (ROLL 00:00) + galvanomètre −20 dB (déjà piloté par transport/resetLevels). **Cause racine ② (EJECT)** : `eject()` (store) ne faisait QUE vider les champs d'état, sans jamais arrêter le `Player`. **Correctif** : `eject()` appelle désormais `player.stop()` + `disposeStems()` + `setStemMode(false)` + `clearSource()` (révocation URL blob + vidage src) puis réinitialise intégralement le store (`filePath=null`, `stemsStatus='idle'`, `stems=null`, `transport='stopped'`, `elapsedSeconds=0`, `stemGains`/`stemMutes` par défaut, métriques `—`). **Test** `tests/stemsStop.test.ts` étendu (mocks DOM/WebAudio) : STOP coupe les stems + mono reste muet, **STOP invalide une `play()` en vol (le mono n'est PAS relancé)**, `play()` mono ne part que si aucune génération n'est annulée, séquence EJECT rend le Player silencieux (blob révoqué). `npm run check` 0/0, `cargo check` 0/0, `cargo test --lib -- --test-threads=1` **60/60**, `node --test tests/stemsStop.test.ts` **4/4**. |
| ALC-182 | Audio / IA | **Réparation du mode multi-stems (régression STOP + animation) + filtrage doux du stem `vocals`** : le passage en `stemModeActive` laissait deux régressions de transport/animation et un léger débordement d'aigus sur `vocals`. **Cause racine STOP** : `Player.stop()` ne gérait que le `<audio>` mono (déjà verrouillé muet par `stemModeActive`) → le STOP laissait les **4 `AudioBufferSourceNode` actifs tourner** (le son continuait) et un re-PLAY empilait une seconde couche auditive. **Correctif** : `Player.stop()` appelle désormais `pauseStems()` (arrête/détruit les `stemNodes` + `stemPlaying=false` + `stopTicker`), `audio.currentTime=0` et l'horloge stems remise à zéro (`stemStartOffset=stemStartCtx=0`) → `position()=0` ; le store `setTransport(id,'stopped')` pose déjà `transport='stopped'` + `elapsedSeconds=0` et le galvanomètre retombe à **-20 dB** (cible `transport==='playing' ? rms : -20` + `resetLevels`). **Invariant animation vérifié par code** : bobines (`easeGalvanometer`) et défilement de bande (`tape-bridge class:running`) lisent `deck.transport === 'playing'` + `deck.elapsedSeconds` (valides en mono ET en stems), **aucune** dépendance à `!audioElement.paused` (grep DeckA/DeckB/MarqueeText). **Vocals** : EQ doux transparent NON destructif dans le graphe WebAudio sur le canal `vocals` uniquement — `highpass 85 Hz` (Q 0.7, coupe sub-vocal/ronflement) + `lowpass 11.5 kHz` (Q 0.5, adoucit la zone > ~11 kHz des fuites cymbales/charlestons) ; champ `stemEq` + `disconnect` propre dans `disposeStems` ; les WAV restent intacts (restauration live seulement) ; mapping stems.rs inchangé (vocals = indice 3 HTDemucs, aucun résidu `other`). **Testabilité** : `constructor(readonly id)` converti en champ `id` explicite (le `Player` devient importable sous `node --test`). **Test** `tests/stemsStop.test.ts` (node --test, mocks DOM/WebAudio) : STOP en mode stems arrête les 4 sources (`.stop()`), vide `stemNodes`, force `stemPlaying=false`, `position()=0`, aucun re-PLAY superposé. `npm run check` 0/0, `cargo check` 0/0, `cargo test --lib -- --test-threads=1` **60/60**, `node --test tests/stemsStop.test.ts` **pass** (1/1). |
| ALC-181 | Audio / IA | **Correction de l'échec critique « bourdonnement/grondement saturé à pleine échelle » des stems réels + gate multi-sources + cache `stems-v5`** : l'écoute et la forme d'onde de `vocals.wav` (track réelle, cache `stems-v4`) montraient un grondement continu saturé au lieu de la voix ; le test sinusoïdal 440 Hz passait car les gates lisaient le PCM brut à l'offset 44 sans checker l'en-tête. **Audit réel du contrat I/O** (test dédié exécuté puis retiré) : `session.inputs()` = **UNE seule entrée `mix` Float32 `[1,2,-1]`** (hypothèse « 2e entrée STFT spectrale » **réfutée**), `session.outputs()` = **une seule sortie `sources` Float32 4D** (STFT/iSTFT embarqués, opset 17) ; layout **planar** entrée + offsets `(stem·2+ch)·seg+i` corrects ; diagnostic spectral multi-sources (kick 60 Hz + basse 110 Hz + formants vocaux modulés 300-2500 Hz + zones de silence) : drum→**sub 30-90 Hz = 0.756**, basse→**low 90-180 Hz = 0.998**, formants→other 0.494 + vocals 0.106, **silence_rms = 0.0001-0.0002 (< 0.005)** → le modèle ne génère AUCUN bourdonnement. **Cause racine prouvée (code + artefact)** : `write_wav_stereo_i16` écrivait **`bitsPerSample = 2`** (valeur de canaux) au lieu de **16** dans le chunk `fmt ` (preuve : le WAV réel du cache et une sonde runtime montrent `02 00` à l'octet 34-35) → tout consommateur honnorant l'en-tête (WebAudio `decodeAudioData`, lecteurs, éditeurs) décodait le PCM16 comme du 2-bit → **bourdonnement/grondement saturé continu à pleine échelle**. **Correctif** : `2u16 → 16u16` (bitsPerSample) + commentaire cause racine ; cache incrémenté **`stems-v4 → stems-v5`** (`cache_root()`) pour régénérer tous les WAV corrompus. **Gate de séparation multi-sources** (`stems_multisource_separation_gate`, remplace le test sinusoïdal permissif) : intégrité d'en-tête strict sur les 4 WAV écrits (PCM/stéréo/44,1 kHz/blockAlign=4/**bits=16**), zones silencieuses → rms < 0.005 dans chaque stem, kick 60 Hz → `drums` (sub > 0.4), basse 110 Hz → `bass` (low > 0.6), formants 400-2400 Hz → `vocals/other` (> 1.5 × drums+bass). `npm run check` 0/0, `cargo check` 0/0, `cargo test --lib -- --test-threads=1` **60/60**. |
| ALC-180 | Audio / IA | **Correction du rendu stem (distorsion / son sous-scalé) + gate de fidélité + cache `stems-v4`** : après ALC-179 les WAV contenaient du son mais le rendu était « horrible / déformé ». Diagnostic réel (composite stéréo 10 s, L 440 Hz/0.5, R 880 Hz/0.5) : run_window direct reconstruit déjà la somme des 4 sources à **0.542** (Pearson 0.996) — le modèle somme bien ~le mix en entrée **brute**, la normalisation par segment (hypothèse écartée) n'était pas requise. **Cause racine prouvée** : dans `run_separation`, l'instruction `wsum[out] += hann[i]` était placée **DANS la boucle `for s in 0..4`** → `wsum` accumulé **4 fois** (4 × pic ≡ 2.3e-5 vs 5.8e-6 attendu) → chaque stem divisé par 4 → somme ≈ 0.26× (pic 0.1295 au lieu de 0.5, ≈13 % de la plage i16 → quasi mutisme + dégradation/quantisation = bruit en écoute). **Correctif** : `wsum` déplacé **hors** de la boucle des stems (accumulé une fois par échantillon) — reconstruction WOLA exacte (pic somme **0.5079**, i16 ≈ 16642) ; cache incrémenté `stems-v3 → stems-v4`. **Gate de fidélité** (`stems_reconstruction_fidelity_gate`, composite 10 s) : somme des 4 WAV vs original = **Pearson L/R 0.9984 (> 0.95)**, pic **0.5079 ∈ [0.35, 0.65]** (=16642 ∈ [11400,21300]), canaux non permutés (cross 0.0009). `npm run check` 0/0, `cargo check` 0/0, `cargo test --lib -- --test-threads=1` 59/59. |
| ALC-179 | Audio / IA | **Correction du mutisme des 4 Stems (WAV à 0) + gate acoustique + cache `stems-v3`** : preuve terrain — les 4 WAV exportés ne contenaient que du silence malgré `len > 44`. Diagnostic réel (sinusoïde 440 Hz / 0.5 / 2 s) : entrée ONNX correcte (rms 0.3536), **une seule sortie** `sources [1,4,2,343980]` de `max_abs=0.5268` (le modèle n'est PAS silencieux), mais les WAV écrits étaient ~0. **Cause racine** : dans `run_separation`, le Hann est normalisé par sa somme (`norm ≈ seg/2 ≈ 172 000`) donc `wsum[i] ≈ 1e-5`, **toujours inférieur au seuil de garde `w > 1e-3`** → chaque échantillon était écrasé à `0.0` (pas de `NaN`, aucune erreur → tests `len>44` aveugles). **Correctif** : garde abaissée à `w > 1e-9` (le ratio `acc/wsum` reconstruit l'amplitude exacte des stems, reconstruction WOLA sans écrasement) ; cache incrémenté `stems-v2 → stems-v3` (`cache_root()`) pour ignorer les WAV silencieux ; **gate acoustique strict** dans `stems_2s_4_wavs_and_cache` (mesure directe du PCM i16 des 4 WAV) : `max_i16` global doit être `> 1600` — vérifié `other.wav max_i16=4240`, `vocals=139`, `drums=49`, `bass=52` (la sinusoïde 440 Hz se répartit dans le stem mélodique). `npm run check` 0/0, `cargo check` 0/0, `cargo test --lib -- --test-threads=1` 58/58. |
| ALC-178 | Audio / IA | **Correction de la régression réelle « ✓ 4 STEMS PRÊTS mais VOIX toujours audible »** : au chargement d'une piste, `applyCachedStems()` exécutait `getPlayer(id)?.loadStems(...)` alors que le `Player` n'existe que **lazily** (créé au 1er `PLAY`) → `getPlayer(id)` était `null`, `loadStems` no-op, le store affichait pourtant `stemsStatus='ready'` tandis que le `Player` n'avait ni buffers ni `GainNode` → `play()` retombait sur `audio.play()` (mix mono complet, voix incluse) et `toggleStemMute`/presets repartaient sur des gains inexistants. **Correctif** : nouvelle action store `ensureStemsLoaded(id)` (re-charge le cache stems dans le `Player` réel + verrou exclusif `setStemMode(true)` + `applyStemMutes` des mutes **courantes** — un `VOIX` coupé avant `PLAY` est donc respecté — sans auto-play), appelée dans `startPlayer()` de Deck A/B avant `play()` ; accesseur public `Player.stemGainValue(name)` + **logs `[STEMS-DEBUG]`** à chaque VOIX/BATT/BASSE/INST et au `PLAY` (`deck`, `stemModeActive`, gains réels `.gain.value` des 4 `GainNode`). Cache `stems-v2` confirmé NON en cause (aucun dossier v1/v2 obsolète lu) — pas de migration v3 requise. `npm run check` 0/0, `cargo check` 0/0, `cargo test` 58/58 (`--test-threads=1`). |
| ALC-177 | Audio / IA | **Export des 4 Stems WAV vers un dossier utilisateur** : commande Rust `export_stems_to_folder(file_path, dest_dir, track_prefix?)` — localise le cache stems par SHA-256 (erreur `NotFound` explicite si non séparé), crée le dossier cible et **copie les 4 WAV renommés `<préfixe> - vocals/drums/bass/other.wav`** (nom Windows assaini via `sanitize_prefix`, repli `stem`) ; enregistrée dans `generate_handler`. Wrapper `audioIpc.exportStemsToFolder` + action store `exportDeckStems(deck)` ouvrant le **sélecteur de dossier natif** (`@tauri-apps/plugin-dialog`, `open({directory:true})`), préfixe `Artiste - Titre`, confirmation `✓ EXPORTÉS` 3 s. **Bouton laiton/or `↓ EXPORTER WAV`** dans le rack STEMS IA (visible quand `✓ 4 stems prêts`), bascule vers `✓ EXPORTÉS` ; `h-screen overflow-hidden` conservé. `npm run check` 0/0, `cargo check` 0/0, `cargo test export_stems_copies_4_wavs` vert (+ suite 58/58 `--test-threads=1`). |
| ALC-176 | Audio / IA | **Correction finale du bug « titre original audible » (verrou dur stems)** : `Player.stemModeActive` — dès que le mode stems est actif, le `<audio>` mono est **`audio.pause()` + `audio.muted=true` + `srcNode.disconnect()`**, et `play()` **ne peut plus jamais atteindre `audio.play()`** (même pendant la fenêtre de décodage des buffers stems ou en cas d'échec de décodage → silence contrôlé, jamais le mix mono) ; `disposeStems()/loadStems()` préservent le verrou, `setPlaybackRate()` pilote exclusivement les 4 `AudioBufferSourceNode`, `isStemModeActive()` exposé. **Layout du tenseur de sortie prouvé en runtime** : shape loguée `[1,4,2,343980]`, indexation ordre C `tensor_offset(s,c,i,seg)=s·2·seg+c·seg+i` → `vocals` = indice 3 canonique HTDemucs (aucun mélange de stride, pas de `stems-v3` requis). Tests d'isolation verts : `mute_vocals_zeroes_output` (gain 0 → sortie strictement nulle) + `tensor_layout_offsets_htdemucs_voices_last` ; `npm run check` 0/0, `cargo check` 0 erreur/0 warning, `stems_2s_4_wavs_and_cache` ok. |
| ALC-175 | Audio / IA | **Correction live ALC-174 (la voix restait audible après INST)** : **bascule EXCLUSIVE mono ↔ stems** — `Player.setStemMode()` met en pause et **déconnecte la source single-buffer** dès que les 4 stems sont chargés ; `play()` route alors uniquement les 4 `AudioBufferSourceNode` (position `currentTime` reprise, horloge synthétique + ticker 200 ms, Mute via `cancelScheduledValues + setValueAtTime`) ; **remapping HTDemucs canonique** dans `stems.rs` (`[0=drums, 1=bass, 2=other, 3=vocals]` — le bug étiquetait `vocals` sur l'indice 0 = drums) + cache **`stems-v2`** (invalide les WAV mal étiquetés) ; reprise À CHAUD si les stems deviennent prêts pendant la lecture ; EQ LOW 120 Hz / HIGH 3,2 kHz / VOLUME / CROSSFADER pilotent toujours l'ensemble des 4 stems (GainNode branchés sur la chaîne partagée). `npm run check` 0/0, `cargo check` 0 erreur, `cargo test stems_2s_4_wavs_and_cache` vert. |
| ALC-174 | Audio / IA | **Séparation IA locale des 4 Stems (HTDemucs / ONNX Runtime)** : backend `stems.rs` (`ort` 2.0.0-rc.15, modèle `htdemucs.onnx` 304 Mo, `session` globale `Mutex<Option<Session>>`, `SEGMENT=343980` confirmé, cache `%LOCALAPPDATA%/AlcheMixII/stems/<sha256>/`, décodage symphonia → planar 44,1 kHz, fenêtres glissantes overlap-add Hann 25 % + zero-padding/troncature, WAV 16-bit PCM, commandes `check_cached_stems`/`separate_stems` avec `Channel<f32>` — test `cargo test stems_2s_4_wavs_and_cache` **vert**) ; moteur WebAudio **4-Stems additif** (`Player.ts` : 4 `AudioBufferSourceNode` démarres synchronisés au même échantillon, 4 `GainNode` dans la chaîne EQ partagée, `playStems/pauseStems/setStemGain` Mute/Solo latence zéro) ; store (`stemsStatus/Progress/Gains/Mutes`, `extractDeckStems`, `check_cached_stems` auto au chargement, Mute/Solo/Presets) ; mini-rack **STEMS IA** sur DeckA/B (⚡ EXTRAIRE STEMS + jauge %, VOIX/BATT/BASSE/INST, ACAPELLA/INST). `npm run check` 0/0, `cargo check` 0 erreur. |
| ALC-172 | UI / Deck | **Cassette photographique HD intégrée aux platines Deck A/B** : masque PNG transparent généré programmatiquement (`scripts/make-cassette-mask.mjs`, sharp, depuis `sources/cassette-raw.jpg` → `static/assets/cassette-shell.png`, 960 px, ratio ≈1.57:1 — extérieur coque, alésages bobines et fenêtre centrale transparents) superposé (`pointer-events-none`, z‑30) aux moyeux rotatifs et à la bande magnétique ; étiquette **Serenissima ivoire** relevée en z‑40 avec **liseré émeraude (Deck A) / bleu électrique (Deck B)**, titre en **Marquee**. `h-screen overflow-hidden`, glisser‑déposer et invite au repos conservés. `npm run check` 0/0. |
| ALC-170 | Console / Audio | **Recherche de Pistes Ponts harmoniques dans la Librairie SQLite locale (library.db)** : `findLocalBridgeTracks` (pivot harmonique 55 % + palier tempo 35 % + bonus duo validé 10 %, exclut les pistes déjà chargées, activation ≥ 2 quintes ou écart tempo > 8 %) ; **Oracle Acoustique** — pistes PONT locales en priorité (badge LIBRAIRIE LOCALE, score %, clé pivot, BPM, ▶ / → A / → B) devant les suggestions Deezer ; **Librairie** — cartouche **PONT A↔B** + bouton **CHARGER PONT**. `npm run check` 0/0. |
| ALC-169 | Console / Audio | **Crossfader assisté & Bass-Swap automatique (AUTO-MIX 8 / 16 MES)** : moteur `startAutoMix(bars, direction)` / `cancelAutoMix()` (durée T = bars×4×60/BPM effectif, `requestAnimationFrame` 60 fps) déplaçant le Crossfader Master, **Bass-Swap** progressif LOW EQ 120 Hz (crave sortant → −20 dB, entrant → 0.0 dB, restauration après coupe) + **pitch glide** (écart ≤ 6 %, 1re moitié) ; interface horlogère AUTO-MIX intégrée au Crossfader (8 MES/16 MES, bouton directionnel, STOP, jauge) + indicateur doré **AUTO-EQ** sur les platines ; interruption immédiate sur saisie manuelle. `npm run check` 0/0. |
| ALC-168 | Backend / UI | **Détection robuste des pistes déjà chargées dans la Librairie** : ajout de **`isSameTrack(lib, deck)`** (mashupMatcher) qui normalise `filePath` (`\`→`/`, casse, espaces) puis, en repli, titre ET artiste normalisés — corrige Julia/Mr Jones qui réapparaissaient (filePath `===` insensible à la normalisation des chemins) ; `onDeckA`/`onDeckB` branchés partout (badge SUR PLATINE A/B en émeraude/bleu, masque le score et classe en bas dans TOUS, exclut des compteurs/listes COMPATIBLE A/B et de l'Oracle). `npm run check` 0/0. |
| ALC-167 | Backend / UI | **Exclusion & badging des pistes déjà chargées dans la Librairie** : détection `onA/onB/loaded` (filePath) dans `LibraryView.svelte` ; un morceau déjà sur une platine n'a plus de **score d'affinité** et affiche le badge **SUR PLATINE A/B** (colonne AFFINITÉ), passe **en bas de liste** quel que soit le tri, et est **exclu** des compteurs/listes `COMPATIBLE A/B` et de l'**Oracle** (jamais un morceau avec lui-même) — ne gonfle plus les vrais partenaires. `npm run check` 0/0. |
| ALC-166 | Backend / UI | **Polissage & enrichissements de l'onglet LIBRAIRIE** : cartouche Oracle **« CHARGER LE DUO → A & B »** à platines vides (sinon envoi sur la platine libre) ; **mini-spectre de pré-écoute** (barre dorée de scrubbing `role=slider`) + **curseur volume casque** dans la barre d'astuce ; **code couleur Camelot** du liseré du badge CLÉ (émeraude A, bleu B, doré relatif) + **pochettes miniatures** 28×28 encadrées laiton persistées en base (`cover_data` + migration SQLite `ALTER TABLE`) ; **édition rapide inline** du GENRE/TITRE en double-clic (commande IPC `library_update_track_meta`) + **export Setlist** des duos (`EXPORTER SET`, `.m3u`/`.txt`). `npm run check` 0/0, `cargo check` 0 erreur, `cargo test --lib` 54/54. |
| ALC-165 | Backend / UI | **Onglet LIBRAIRIE : catalogue SQLite + matcher mashup + vue Venezia 1889** — base locale **SQLite** (`rusqlite` bundled, `library.db` dans `app_data_dir()`, tables `tracks`/`validated_duos`) et 6 commandes IPC (`library_list_tracks`, `library_upsert_track`, `library_import_folder` [scan récursif mp3/flac/wav/m4a/ogg, réutilise `lofty` + moteur MIR, progression `library://scan`], `library_delete_track`, `library_toggle_duo`, `library_list_duos`) enregistrées dans `lib.rs`. **Matching mashup** (`mashupMatcher.ts`) : harmonique 50 % / rythmique 35 % / bonus créatif & duos ★ 15 %, tests `node --test` 17/17. **Vue `LibraryView.svelte`** fidèle à `sources/Library v4.html` (grille `84px 1fr 72px 42px 76px 110px`) insérée dans `MixerCenter.svelte` entre les onglets et le Crossfader : ARCHIVER PLATINE A/B, IMPORTER DOSSIER (dialog), recherche instantanée, filtres TOUS/COMPATIBLE A/B/★ DUOS, tri AFFINITÉ/CLÉ/TEMPO, ASTUCE MIX, pré-écoute ▶/❚❚ sécurisée (`convertFileSrc`), chargement A/B + badge SUR PLATINE A/B, retrait ×, cartouche **Suggestion Mashup** de l'Oracle (★ VALIDER DUO, ENVOYER SUR B), défilement interne `overflow-y-auto`. `npm run check` 0/0, `cargo check` 0 erreur, `cargo test --lib` 54/54, `node --test` 17/17, `h-screen overflow-hidden` préservé. |
>
> Les tickets **Terminé** du Kanban (dont ALC-143/144) sont **immuables** : toute amélioration
> future se fait par un **nouveau** ticket, jamais en modifiant un ticket déjà livré. La
> segmentation (RMS/tempo/clé) par exemple, bien qu'initialement évoquée sous un ID « 143 », a été
> livrée sous **ALC-146** pour préserver l'immutabilité des tickets existants.
