# Changelog

Toutes les modifications notables d'**AlcheMix II** sont documentées dans ce fichier.

Le format s'inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/) et respecte
[Semantic Versioning](https://semver.org/lang/fr/).

## [0.4.0] — 2026-11-20

### ✨ Fonctionnalités majeures
- **Séparation IA locale des 4 Stems (HTDemucs / ONNX) fiable** : succès sur morceaux réels
  (vocals / drums / bass / other), cache disque `stems-v7` versionné, rack STEMS IA
  (VOIX / BATT / BASSE / INST, presets ACAPELLA / INST).
- **Profil anti-bleed du stem `vocals`** : Wiener soft-mask `K(f)` par bande
  (sub <120 Hz / formants 300-4200 Hz préservés / cymbales >6,5 kHz atténuées) + gate
  d'activité vocale doux qui nettoie les intros/ponts sans chant.

### 🔧 Correctifs & fiabilité
- **En-tête WAV des stems corrigé** (bitsPerSample = 16) + reconstruction WOLA exacte
  + caches versionnés (stems-v4 → v7 sur morceaux réels).
- **STOP / EJECT en mode stems** : coupure matérielle `AudioContext.suspend()`, branches
  réactives du transport (explicites), unicité du `Player` — plus aucun résidu sonore après STOP.

### 📦 Artefacts v0.4.0
- Exécutable autonome : `AlcheMix-II-0.4.0-windows-x64.exe` (signé Authenticode).
- Installeurs : `AlcheMix II_0.4.0_x64-setup.exe`, `AlcheMix II_0.4.0_x64_en-US.msi`.

## [0.3.0] — 2026-11-18

### ✨ Fonctionnalités majeures
- **Onglet LIBRAIRIE (catalogue SQLite local)** : base `library.db` (rusqlite bundled), import de dossiers,
  recherche/filtres/duos ★, édition inline des métadonnées, export Setlist `.m3u`/`.txt`.
- **AUTO-MIX (Crossfader assisté & Bass-Swap)** : transition 8/16 mesures avec déplacement assisté du
  Crossfader Master, échange automatique des LOW EQ (120 Hz) et pitch glide (écart ≤ 6 %), interruption sur saisie manuelle.
- **Pistes Ponts locales (Harmonic Bridge Finder)** : recherche dans la Librairie SQLite des meilleurs ponts
  harmoniques/rythmiques (A↔B) proposés en priorité par l'Oracle (« LIBRAIRIE LOCALE ») et dans la Librairie (« PONT A↔B »).
- **Séparation IA des 4 Stems** (ONNX, htdemucs-v4) via `extract_stems_onnx`.

### 🔧 Correctifs & fiabilité
- **Pré-écoute audio locale unifiée** : `read_audio_file_bytes → Blob URL` (fin du blocage `asset://`/CORS WebView2),
  bascule ▶/❚❚ et révocation des URL blob.
- **Détection robuste des pistes déjà chargées** (normalisation `filePath` / titre+artiste) : plus de gonflement
  des compteurs COMPATIBLE A/B, exclusion des pistes actives et badging `SUR PLATINE A/B` dans la Librairie et l'Oracle.

### 🪟 Installation Windows
Voir `README.md` § Installation Windows. **Note SmartScreen** : le certificat LOCAL de développement
(`CN=AlcheMix II`) ne lève pas SmartScreen sur les autres postes → en **SmartScreen**, cliquez
« Informations complémentaires » puis « Exécuter quand même », ou préférez plus tard la signature officielle
(Azure Trusted Signing / SignPath.io) via `.github/workflows/release.yml`.

### 📦 Artefacts v0.3.0
- Exécutable autonome : `AlcheMix-II-v0.3.0-windows-x64.exe` (signé Authenticode).
- Installeurs : `AlcheMix II_0.3.0_x64-setup.exe`, `AlcheMix II_0.3.0_x64_en-US.msi`.

## [0.2.0] — 2026-11-16

### 🎛️ Nouveautés UI Beatgrid
- **Lecture synchronisée A+B** : bouton doré « ▶ Lancer A + B » (⇄ « ⏸ Pause A + B ») qui aligne,
  mémorise `startPosA/startPosB` et démarre les deux platines dans le même tick ; bouton « ↺ Retour
  Calage » pour re-tester la transition en un clic.
- **Retour visuel de cible d'édition** : « GRILLE CIBLE : PLATINE A | PLATINE B », waveform ciblée
  illuminée (bordure + halo + badge « Cible grille »), clic sur l'onde pour basculer, offset courant
  (`+0 ms` / `+15 ms`) affiché après ×2.
- **Atelier Beatgrid complet** : waveform miroir HD 200 px, pistes télémétriques TEMPO/CLÉS, phrasé
  M1/M5/M9, grille hiérarchisée dorée, Auto-Loop quantifié, Zoom 4/8/16 MES.

### 🔊 Améliorations DSP Audio
- **Moteur BPM haute précision** : peigne gaussien continu, normalisation par **densité d'impulsions**
  (+ pénalité de hors-phase) → suppression du biais +3..+10 % vers le haut ; interpolation linéaire
  de l'autocorrélation (lags pairs/impairs uniformes) ; tempo réel 123/91/85/142.
- **Accélération majeure du pipeline** : profil `dev` optimisé, décimation 48→12 kHz, peigne
  Coarse-to-Fine, DP linéaire O(N) → analyse < 1,5 s (fin des > 1 min).
- **Tonalité sur l'intégralité du morceau** : HPCP sur tout le signal (0–100 %, passe-bas ordre 2)
  → restaure la tonique mineure des intros/outros (6A sur Hand In My Pocket, Money for Nothing).

### 🏷️ Extraction ID3 / Vorbis / MP4
- Extraction complète des métadonnées via `lofty` : titre, artiste, album, genre, année, **BPM
  tagué** et **clé taguée** normalisée Camelot (1A–12B) ; suppression des valeurs de test dans
  l'affichage (tiret « — » si absent).

### 🐛 Correctifs
- Parité des lags pairs dans le peigne BPM et re-quantification DP supprimées (fini les +4 à +9 BPM).
- Régression tonale sur les intros/outros corrigée (6A), triton 4A sur Cutting Crew corrigé.
- Valeurs de test (« DJ Danoë », « Venetian Clockwork ») retirées de l'affichage.

### ✨ Mises à jour transverses
- `docs/SPECIFICATIONS.md` & `CHANGELOG.md` tenus à jour ; gouvernance Kanban étendue aux tickets
  récurrents (règle 5 de `.clinerules/02-kanban-et-journaux.md`).

### 🔏 Signature & SmartScreen
- **Exécutable signé Authenticode** (Publisher « AlcheMix II ») — certificat local de dev (supprime
  l'alerte sur le poste de build) ; **vérifié** `signtool verify /pa /v` (timestamp DigiCert RFC 3161).
- **Note SmartScreen** ajoutée dans `README.md` (§ 🪟 Installation Windows) et les notes de la
  release GitHub v0.2.0 : « Informations complémentaires / Exécuter quand même ».
- **Workflow de signature officielle** `.github/workflows/release.yml` créé : étape
  `azure/trusted-signing-action@v0` (Azure Trusted Signing, secrets `AZURE_*`) ou **SignPath.io**
  (gratuit Open Source) → prochaines releases signées par une CA reconnue Microsoft sans
  manipulation locale (l'alerte SmartScreen disparaît pour les utilisateurs externes).

[0.2.0]: https://github.com/danoe78210/ALCHEMIX-II/releases/tag/v0.2.0