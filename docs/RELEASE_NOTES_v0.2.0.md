# AlcheMix II v0.2.0 — Notes de version

- **Titre** : AlcheMix II v0.2.0
- **Date** : 2026-11-16
- **Binaire attaché** : `AlcheMix-II-v0.2.0-windows-x64.exe` (100 % autonome Windows) + installateur NSIS `AlcheMix II_0.2.0_x64-setup.exe`.

## 🎛️ Nouveautés UI Beatgrid
- Lecture synchronisée **A+B** : bouton doré « ▶ Lancer A + B » (⇄ « ⏸ Pause A + B ») — aligne, mémorise `startPosA/B` et démarre les deux platines dans le même tick ; « ↺ Retour Calage ».
- **Retour visuel de cible d'édition** : « GRILLE CIBLE : PLATINE A | PLATINE B », waveform ciblée illuminée (bordure + halo + badge), clic sur l'onde pour basculer, offset courant après ×2.
- Atelier Beatgrid complet : waveform miroir HD, pistes TEMPO/CLÉS, phrasé M1/M5/M9, Auto-Loop, Zoom.

## 🔊 Améliorations DSP Audio
- Peigne BPM haute précision : densité d'impulsions + pénalité hors-phase (fini le biais +3..+10 %).
- Accélération pipeline : profil dev optimisé, décimation 48→12 kHz, Coarse-to-Fine, DP O(N) — < 1,5 s.
- Tonalité sur tout le morceau (HPCP complet, passe-bas ordre 2).

## 🏷️ Extraction ID3 / Vorbis / MP4
- Métadonnées complètes via `lofty` : titre, artiste, album, genre, année, BPM tagué, clé Camelot normalisée.

## 🐛 Correctifs
- Parité des lags pairs + re-quantification DP supprimées.
- Régression tonale intros/outros (6A) corrigée, triton 4A Cutting Crew corrigé.
- Valeurs de test retirées de l'affichage.

## ✨ Mises à jour transverses
- `docs/SPECIFICATIONS.md` & `CHANGELOG.md` tenus à jour ; gouvernance Kanban étendue aux tickets récurrents.