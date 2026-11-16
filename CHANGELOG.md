# Changelog

Toutes les modifications notables d'**AlcheMix II** sont documentées dans ce fichier.

Le format s'inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/) et respecte
[Semantic Versioning](https://semver.org/lang/fr/).

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