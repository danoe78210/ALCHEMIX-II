# Cahier des charges de développement — Librairie, Tiroirs, Sliders Lumineux & Finitions (AlcheMix II)

> **Destinataire :** Cline (`Maître Horloger`)
> **Périmètre strict :** Markup Svelte et CSS uniquement (`LibraryView.svelte`, `DeckA.svelte`, `DeckB.svelte`, `MixerCenter.svelte`, `CrossfaderBar.svelte`, fichier de tokens CSS).
> **Interdictions :** Ne touche à aucune logique audio (`player.ts`), aucune action métier du store (`mixer.svelte.ts`), aucun IPC, SQL ni code Rust. Conserve strictement `h-screen overflow-hidden`, la charte **Venezia 1889** et la synchronisation bidirectionnelle Stems.

---

## 0. Gouvernance Kanban (Obligatoire)

* Ne modifie **aucun** ticket `"Terminé"` dans `project-tracker/tasks.json`.
* Crée un nouveau ticket `"En cours"` (`agent: "Maître Horloger"`) découpé selon les 6 étapes de la section 6.
* Coche chaque micro-tâche `"completed": true` + `meta.updatedAt` **immédiatement après son exécution**, journalise chaque étape horodatée (`Europe/Paris`) dans `project-tracker/journals.json` et mets à jour `docs/SPECIFICATIONS.md` en clôture.

---

## 1. DESIGN TOKENS

Réutilise les tokens `--vz-*` existants et ajoute uniquement les variables manquantes dans le fichier de tokens CSS global :

```css
:root {
  /* Drawer physics & elevation */
  --vz-drawer-h: 34px;
  --vz-drawer-bg: #181310;
  --vz-drawer-well: #100c09;
  --vz-drawer-edge: #4f4539;
  --vz-drawer-shadow-open:
    0 -12px 28px rgba(0, 0, 0, 0.65),
    0 -2px 6px rgba(0, 0, 0, 0.85),
    inset 0 1px 0 rgba(237, 191, 122, 0.22);

  /* Stems unified height */
  --vz-stems-panel-h: 142px;

  /* Luminous slider tracks & markers */
  --vz-slider-rail-bg: #100c09;
  --vz-slider-rail-edge: #3a3128;
  --vz-slider-tick-idle: #5a4e41;
  --vz-slider-tick-zero: #edbf7a;
  --vz-slider-glow-a: 0 0 8px rgba(16, 185, 129, 0.75);
  --vz-slider-glow-b: 0 0 8px rgba(0, 163, 255, 0.75);
  --vz-slider-glow-brass: 0 0 8px rgba(237, 191, 122, 0.75);

  /* Motion (respect prefers-reduced-motion) */
  --vz-ease-drawer: cubic-bezier(0.2, 0.8, 0.2, 1);
  --vz-t-drawer: 280ms;
  --vz-t-key: 140ms;
}
```

---

## 2. COMPOSANTS

### A. Table Librairie (`src/lib/components/LibraryView.svelte`)
* **Grille unique partagée** entre `.vz-lib-head` et `.vz-lib-row` (supprimer `auto` sur `[act]` qui provoque le décalage de 2 colonnes) :
  ```css
  .vz-lib-row {
    display: grid;
    align-items: center;
    column-gap: 12px;
    padding: 0 12px;
    grid-template-columns: [cover] 32px [title] minmax(0, 1fr) [genre] 104px [key] 56px [bpm] 88px [act] 216px;
  }
  .vz-lib-row.has-ref {
    grid-template-columns: [aff] 84px [cover] 32px [title] minmax(0, 1fr) [genre] 104px [key] 56px [bpm] 88px [act] 216px;
  }
  ```
* **Placement explicite dans `.vz-lib-head` :**
  * `AFFINITÉ` → `grid-column: aff` (uniquement si `has-ref`)
  * `TITRE & ARTISTE` → `grid-column: cover / span 2`
  * `GENRE` → `grid-column: genre`
  * `CLÉ` → `grid-column: key; text-align: center`
  * `TEMPO` → `grid-column: bpm; text-align: right`
  * `ACTIONS` → `grid-column: act; text-align: right`
* **Compensation scrollbar :** Appliquer `scrollbar-gutter: stable` sur la liste scrollable **et** un padding droit équivalent sur `.vz-lib-head` pour éviter tout décalage de 8 px.

### B. Repères lumineux sur tous les Sliders (`DeckA.svelte`, `DeckB.svelte`, `CrossfaderBar.svelte`)
Appliquer un traitement instrumental cohérent sur tous les curseurs horizontaux (rail encastré `#100c09`, hauteur `6px`, bordure `1px solid var(--vz-slider-rail-edge)`, `border-radius: 999px`) avec **repères lumineux dynamiques** et **piste illuminée** :

1. **Égaliseur Analogique (`LOW EQ 120 HZ` & `HIGH EQ 3.2 KHZ`) :**
   * **Repère central lumineux (`0.0 dB`) :** Trait vertical gravé `2px × 12px` centré à `50 %` + micro-point lumineux (`4px × 4px`) en **or vénitien `#edbf7a`** avec `box-shadow: var(--vz-slider-glow-brass)` lorsque la valeur est au neutre (`|eq| < 0.2 dB`), qui s'atténue (`opacity: 0.35`, sans glow) dès que le DJ coupe ou booste.
   * **Piste lumineuse bipolaire :** Remplissage lumineux partant du centre (`50 %`) jusqu'à la position du curseur (couleur canal `#10b981` + `var(--vz-slider-glow-a)` sur Deck A ; `#00A3FF` + `var(--vz-slider-glow-b)` sur Deck B).
   * **Graduations secondaires :** Repères fins (`1px × 6px`, `--vz-slider-tick-idle`) à `-6`, `-3`, `+3`, `+6 dB` qui s'illuminent légèrement lorsque le curseur les dépasse.

2. **Volume Canal (`VOLUME CANAL`) :**
   * **Repère nominal lumineux (`0.0 dB / 80 %`) :** Repère vertical `2px × 12px` à la position `0.0 dB` (80 %) avec micro-LED laiton `#edbf7a` (`var(--vz-slider-glow-brass)`).
   * **Piste lumineuse unipolaire progressive :** Remplissage continu de `0 %` jusqu'au curseur en couleur canal (`#10b981` sur A / `#00A3FF` sur B), avec transition vers l'**or vénitien `#edbf7a`** dans la zone de boost (`> 80 %`, entre `0 dB` et `+6 dB`).
   * **Curseur (thumb) :** Micro-LED centrale `4px × 4px` incrustée sur la poignée, allumée en couleur canal tant que le volume est `> 0 %` (éteinte à `-INF`).

3. **Cadence / Pitch (`CADENCE (PITCH)`) :**
   * **Repère de verrouillage `0 %` :** Trait central `2px × 12px` + micro-LED lumineuse au centre (`50 %`) allumée en couleur canal (`#10b981` / `#00A3FF`) lorsque le pitch est exactement à `0 %` (`|pitch| < 0.05 %`), et éteinte en laiton discret dès qu'un décalage est appliqué.
   * **Piste lumineuse bipolaire :** Remplissage lumineux depuis le centre (`50 %`) vers la gauche ou la droite selon la valeur du pitch, en couleur canal.

4. **Crossfader Master (`CrossfaderBar.svelte` / `MixerCenter.svelte`) :**
   * **Repère d'équilibre `50 / 50` :** Trait central gravé `2px × 14px` + micro-LED dorée `#edbf7a` (`var(--vz-slider-glow-brass)`) allumée quand le crossfader est centré (`48 %–52 %`).
   * **Piste lumineuse bidirectionnelle :** Depuis le centre (`50 %`), s'illumine en **Vert Émeraude `#10b981`** lorsque le curseur glisse vers le **Canal A** (gauche) et en **Bleu Électrique `#00A3FF`** lorsque le curseur glisse vers le **Canal B** (droite).
   * **Repères d'extrémité :** Micro-traits lumineux aux butées `100 % A` (émeraude) et `100 % B` (bleu).

### C. Tiroir Stems IA (`DeckA.svelte` / `DeckB.svelte`)
* **Hauteur verrouillée :** Appliquer `height: var(--vz-stems-panel-h)` (`142px`) au contenu interne du tiroir ouvert dans les deux états (`EXTRAIRE STEMS` et `STEMS PRÊTS`) avec `display: flex; flex-direction: column; justify-content: space-between; padding: 10px 12px;` afin que Deck A et Deck B conservent un alignement vertical de `±1 px`.
* **États physiques des 4 touches Stems (`aria-pressed`) :**
  * `pressed="true"` (actif) : `transform: translateY(1px)`, ombre interne `inset 0 2px 5px rgba(0,0,0,.8)`, LED cabochon `6×6px` allumée (`#10b981` sur A / `#00A3FF` sur B) avec glow `0 0 6px`.
  * `pressed="false"` (muté) : fond mat `#14100d`, bordure `#342b23`, LED éteinte (`#2a231d`), texte `#8c7d68` (≥ 4.5:1).
  * `disabled` (avant extraction) : fond `#120e0b`, texte `#7a6a55` (≥ 3.2:1), `aria-disabled="true"` + infobulle `VzTip` (`Extraire d'abord`).

### D. Façades de Tiroirs & Tiroir Métadonnées (`DeckA.svelte` / `DeckB.svelte`)
* **Anatomie de façade :** Hauteur `34px`, fond `linear-gradient(180deg, #241d18, #17120e)`, biseau supérieur `inset 0 1px 0 rgba(237,191,122,.20)`, poignée centrale gravée (`28px × 3px`, `border-radius: 2px`, `#4f4539`), chevron `14px` avec rotation `180deg` en `280ms var(--vz-ease-drawer)`.
* **Visibilité conditionnelle des pastilles Métadonnées :**
  * Tiroir **fermé** : afficher uniquement `MÉTADONNÉES & SPECS AUDIO` + pastille `MP3 • 44.1 KHZ` (masquer BPM et Clé pour éviter le doublon avec la télémétrie juste au-dessus).
  * Tiroir **ouvert** (`position: absolute; bottom: 100%; z-index: 30; box-shadow: var(--vz-drawer-shadow-open)`) : afficher dans la façade les deux pastilles compactes `tabular-nums` **`[ 131.5 BPM ]`** et **`[ 11B ]`** (`whitespace-nowrap shrink-0`, couleur `--vz-ch-a-text` / `--vz-ch-b-text`) sans jamais tronquer la clé.
* **Accessibilité :** `aria-expanded`, fermeture du tiroir Métadonnées par `Escape` et clic extérieur, `:focus-visible` `2px solid #edbf7a` (jamais d'anneau blanc natif).

---

## 3. ÉCRANS

* **`LibraryView.svelte` (mise en page verticale) :**
  * Utiliser un conteneur `display: flex; flex-direction: column; height: 100%; min-height: 0;`.
  * Donner `flex: 1 1 0%; min-height: 0; overflow-y: auto;` à la liste de morceaux pour qu'elle absorbe intégralement l'espace vide au-dessus du Crossfader et ancre les cartes `MEILLEURE ASSOCIATION MASHUP` / `PONT A→B` (`flex-shrink: 0`) tout en bas du panneau.
  * Supprimer le compteur redondant `34 TITRES ARCHIVÉS` (doublon de `TOUS (34)`).
* **`MixerCenter.svelte` (carrousel) :**
  * Remplacer les points rouges et le point vert du carrousel par des pastilles neutres (`#4f4539`) et actif laiton (`#edbf7a`).

---

## 4. CRITÈRES D'ACCEPTATION

1. Dans la Librairie, chaque en-tête (`AFFINITÉ`, `TITRE & ARTISTE`, `GENRE`, `CLÉ`, `TEMPO`, `ACTIONS`) est aligné à `±1 px` avec sa colonne de données, avec et sans platine chargée.
2. La liste Librairie occupe tout l'espace vertical disponible (≥ 8 lignes visibles à 1080p) sans aucun vide mort au-dessus du Crossfader.
3. Tous les sliders (EQ Low/High, Volume, Pitch, Crossfader) affichent leurs repères lumineux (zéro/nominal/centre) et leur piste illuminée dynamique respectant les couleurs de canal (`#10b981` / `#00A3FF`) et l'or vénitien (`#edbf7a`), sans impact sur la fluidité (60 fps).
4. Avec Stems ouverts sur Deck A (`STEMS PRÊTS`) et Deck B (`EXTRAIRE STEMS`), l'écart vertical entre chaque bloc correspondant de A et B est `≤ 1 px`, et aucun élément ne touche ni ne déborde du bord bas en `1920×1080` et `1366×768`.
5. Tiroir Métadonnées ouvert : `[ BPM ]` et `[ CLÉ ]` sont tous deux visibles et non tronqués ; tiroir fermé : aucune répétition du BPM/Clé.
6. États actif / muté / désactivé des 4 touches Stems distinguables en niveaux de gris (relief + LED).
7. `npm run check` : **0 erreur / 0 warning** ; `node --import ./tests/loader.mjs --test tests/` : **100 % vert**.

---

## 5. CONTRAINTES

* Conserver `h-screen overflow-hidden` (scroll interne uniquement dans la liste Librairie).
* Animations sur `transform` et `opacity` uniquement (60 fps), désactivées sous `@media (prefers-reduced-motion: reduce)`.
* Ne modifier aucune commande Rust/IPC, aucun calcul DSP ni aucune action du store.

---

## 6. ORDRE D'EXÉCUTION (Micro-tâches Kanban)

1. **`-1` — Tokens CSS :** Ajouter `--vz-drawer-*`, `--vz-stems-panel-h`, `--vz-slider-*` et `--vz-ease-drawer`.
2. **`-2` — Librairie (`LibraryView.svelte`) :** Grille unifiée (largeur fixe `216px` sur `[act]`), compensation scrollbar, flex-fill vertical et suppression du compteur dupliqué.
3. **`-3` — Sliders lumineux (`DeckA.svelte`, `DeckB.svelte`, `CrossfaderBar.svelte`) :** Repères lumineux zéro/nominal/centre + pistes illuminées bipolaires/unipolaires + micro-LEDs sur curseurs.
4. **`-4` — Tiroir Stems (`DeckA.svelte`, `DeckB.svelte`) :** Hauteur verrouillée `142px` + états physiques LED des 4 touches.
5. **`-5` — Façades & Tiroir Métadonnées (`DeckA.svelte`, `DeckB.svelte`) :** Poignée gravée, chevron `14px`, visibilité conditionnelle `[ BPM ] [ CLÉ ]`, fermeture `Escape` / clic extérieur.
6. **`-6` — Carrousel & Validation finale :** Pastilles laiton/neutre dans `MixerCenter.svelte`, exécution de `npm run check` et `node --import ./tests/loader.mjs --test tests/`, mise à jour de `docs/SPECIFICATIONS.md`, journalisation dans `project-tracker/journals.json` et passage du ticket en `"En revue"`.