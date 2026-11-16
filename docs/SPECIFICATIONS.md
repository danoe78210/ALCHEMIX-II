# AlcheMix II — Spécifications Vivantes

> **Document vivant.** Cette spécification décrit **ce qui est réellement livré** dans le code,
> consolidé à partir des tickets `project-tracker/tasks.json` (de **ALC-001** à **ALC-146**).
> Elle n'est pas un journal des tickets : chaque fonctionnalité est décrite **une seule fois**,
> dans sa section dédiée. Toute évolution future doit mettre à jour ce document **et** le Kanban.

- **Version courante** : **v0.2.0** (Release GitHub — voir `CHANGELOG.md`).
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
- **Onglet LIBRAIRIE** : réservé à un futur catalogue musical — **en attente de développement**.
- **Favicon / icônes** : monogramme vectoriel AlcheMix II intégré à l'application et au bureau.

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
| ALC-163 | Release | **Release GitHub récurrente + exécutable Windows autonome + Signature numérique Authenticode** : ticket `"recurrent": true` (jamais « Terminé » → Backlog + subtasks `false` après exécution) ; pipeline v0.2.0 (pré-contrôle npm/cargo, bump de version, `npm run tauri build` NSIS/MSI, commit/tag/push, GitHub Release via API REST avec asset `.exe` attaché). **Signature** : detection signtool (Windows Kits), certificat officiel (Azure Trusted Signing/SignPath.io) sinon certificat local dev (`New-SelfSignedCertificate -Type CodeSigningCert`), hook `bundle.windows.signCommand` piloté `TAURI_SIGN_PFX/TAURI_SIGN_PASSWORD/TAURI_SIGNTOOL`, signature `/fd SHA256 /tr http://timestamp.digicert.com /td SHA256`, vérification `signtool verify /pa`, re-upload de l'asset signé sur la release. |

> Les tickets **Terminé** du Kanban (dont ALC-143/144) sont **immuables** : toute amélioration
> future se fait par un **nouveau** ticket, jamais en modifiant un ticket déjà livré. La
> segmentation (RMS/tempo/clé) par exemple, bien qu'initialement évoquée sous un ID « 143 », a été
> livrée sous **ALC-146** pour préserver l'immutabilité des tickets existants.
