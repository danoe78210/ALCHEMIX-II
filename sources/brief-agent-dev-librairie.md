# BRIEF FOR THE DEVELOPMENT AGENT — LIBRARY tab (`03 · LIBRAIRIE`)

> Written by the art-direction / UX critic agent (does not code). It covers the **LIBRARY tab only**
> (`LibraryView.svelte`). It reuses the system defined in `brief-agent-dev-pupitre-beatgrid.md` (tokens `--vz-*`, `.vz-key`)
> and `brief-agent-dev-addendum-tiroirs-stems-id3.md` (`VzTip` tooltip, channel text tokens). If those primitives
> already exist in the code, **reuse them**; if not, create the minimal subset first.
> Rules unchanged: change markup and CSS only; **never touch** `library.rs`, SQL, IPC commands, store actions or audio logic;
> `h-screen overflow-hidden` with internal scroll; no layout shift; report with evidence (§7).

---

## 0. Mission

Make the Library feel like a **luxury record cabinet**: readable at a glance, with a clear hierarchy of actions
(preview → load A/B → edit → delete), keys that look and press like the rest of the console, and states that explain themselves.
Do not change what the Library does; change how it is presented and how safely it can be used.

## 1. State reviewed

Capture reference ≈ 1795×1315 px (assumed 1×). **Both decks empty**, 34 archived tracks, filter `TOUS`, sort `AFFINITÉ`, row 5 hovered.
**Not seen yet:** a deck loaded (compatibility colours, affinity values), `COMPATIBLE A/B` and `★ DUOS` filters active, pre-listen running
(gold scrubber + headphone volume), the `SUR PLATINE A/B` badge, the edit modal, inline double-click edit, delete flow, a scrolled list, 1366×768.

## 2. What the critic observed

| # | Finding | Evidence (measured) |
|---|---|---|
| 1 | Row actions: inconsistent shapes, tiny targets, inverted hierarchy | `▶` (round), `A`, `B`, `✎` (brass-outlined square), `×` are each ≈ **23 px** (minimum 32 px), gaps ≈ 8 px. The `✎` edit key is the **brightest** control of the row, brighter than the primary `A`/`B` load keys. |
| 2 | Destructive `×` too close and too small | `×` glyph ≈ 8 px, ≈ 12 px from `✎`, separated by a hairline only. The spec says deletion also removes the track's duos (`ON DELETE CASCADE`). No confirmation seen. |
| 3 | Affinity column is empty but is also the default sort | Every row shows `–` and an almost invisible bar (1.2:1) in a ≈ 100 px column; the list is sorted by `AFFINITÉ ▾` with no reference deck loaded, so the order carries no meaning. |
| 4 | Ragged left edge | Rows **with** a cover start their title ≈ 35 px further right than rows **without** one (e.g. "James Bond 007 Theme Remix" vs "Crying in the Rain"). No cover placeholder. |
| 5 | Header stack is heavy and partly contradictory | Banner `EN ATTENTE DE CHARGEMENT SUR LES PLATINES A & B` + archive cards + toolbar + filters + `ASTUCE MIX` + table header ≈ **235 px** (about a quarter of the column). The banner says "waiting for loading" on the very tab used to load tracks. `34 TITRES ARCHIVÉS` duplicates `TOUS (34)`. |
| 6 | Archive cards unreadable | `+ ARCHIVER PLATINE A/B` labels ≈ **1.7–1.9:1**; `Aucune piste chargée` ≈ 3.1:1. |
| 7 | Search placeholder weak | `Rechercher un titre, artiste, genre…` ≈ **2.8:1**. |
| 8 | Filter chips: selection and disabled states barely visible | `TOUS (34)` is only slightly lighter than the others; `COMPATIBLE A (–) 0` is not visibly disabled; the `(–)` is cryptic. Chips are ≈ 28 px high, flat. |
| 9 | Genre and key chips | Genre chips have variable widths, and `OST / CINÉMA` **wraps on two lines** (taller than its neighbours). A missing genre is a boxed `–` chip while a missing artist is a bare `—`. Key chips are neutral grey (expected with no reference deck; coloured states unseen). |
| 10 | Table header and scroll | Header labels ≈ 9 px at 4.3–4.5:1; only `AFFINITÉ` shows a sort caret although `CLÉ` and `TEMPO` are sortable via the dropdown. Scrolling is hinted only by a clipped last row; the scrollbar track is almost invisible. |
| 11 | Side columns end early | Deck columns end ≈ 210 px above the bottom while the Library fills the whole centre (same pattern as the Camelot tab). |
| 12 | Carousel / header (known) | Red carousel dots (WP6 of the main brief) and the clock pill straddling the header edge are still present. |

**Strengths to preserve:** excellent title/artist hierarchy (title 14.9:1, artist 5.3:1) and 44 px row rhythm; bold tabular tempo values;
channel-coded `A` / `B` keys (emerald / blue); brass-framed cover thumbnails; elegant row hover (brass title); clear toolbar hierarchy
(`+ IMPORTER DOSSIER` primary, `EXPORTER SET` secondary); channel-coloured archive cards with an explicit empty message;
filter counters; sort control at 11.2:1; the library uses the full column height and scrolls internally; missing tags shown as discreet dashes (spec-compliant).

## 3. Step 0 — Investigate before coding (answer in the report)

1. What order is the list in when no reference deck exists and sort is `AFFINITÉ`? Is there a fallback?
2. What does the delete flow do today (confirmation? undo?) and what is cascaded (duos)?
3. How are the `SUR PLATINE A/B` badge, the "already on deck" ranking and the coloured key-chip rim (emerald / blue / gold) rendered?
4. What is `(–)` in `COMPATIBLE A (–)` (reference key?) and what exactly does `★ DUOS` filter?
5. Is the banner a shared component across tabs? Can it be hidden or replaced on `library` without touching other tabs?
6. Where is the scroll container? Is the table header sticky? Is the list virtualised, or can it grow to thousands of rows (performance budget for per-row styles)?
7. How are inline double-click edit (title / genre) and the edit modal (ALC-232) triggered? Do they share the row's click handlers?
8. Is `ASTUCE MIX` persisted/dismissible today?
9. What is the cover source and fallback when no cover exists?

## 4. P0 work packages

### WP30 — Row actions: one coherent cluster

- Replace the five mixed controls by a **hierarchy of three levels**, all using `.vz-key` states (hover, pressed, focus-visible, disabled):
  1. **Primary (always visible):** `▶` preview, `→ A`, `→ B`. Height **32 px**, width ≥ 36 px, gaps **8 px**.
     `→ A` and `→ B` keep channel identity: 1 px rim `--vz-ch-a` / `--vz-ch-b`, tinted fill ≤ 14 %, text `--vz-ch-a-text` / `--vz-ch-b-text` (≥ 4.5:1).
     If the track is already on a deck (`SUR PLATINE A/B`), that key becomes **latched** (recessed, LED lit) and its tooltip says so.
  2. **Secondary:** `✎` edit as a **neutral ghost icon key** (32 px, `--vz-text-mid`, brass only on hover/focus). It must no longer be the brightest element of the row.
     It may be shown on row hover / focus-within **and** stay reachable by keyboard.
  3. **Tertiary, destructive:** delete as a `ghost` icon key (`delete`) placed **≥ 16 px** from the others behind a hairline, or inside an overflow `⋯` menu. **Two-step confirmation** (recommended): the first click turns it into an inline `RETIRER ?` pair (`✓` / `✕`, 4 s timeout, Esc cancels); no new logic, only presentation around the existing delete handler.
- Tooltips via `VzTip` (400 ms): `Pré-écouter au casque`, `Charger sur la platine A`, `Charger sur la platine B`, `Éditer les tags`, `Retirer de la librairie`. No native `title` tooltips.
- Pre-listen active state: `▶` becomes `❚❚` latched (LED lit), unchanged behaviour.
- Acceptance numbers: every action ≥ **32×32 px**, gaps ≥ 8 px, destructive separated ≥ 16 px, only **one** brass-bright control per row (the primary keys' hover/focus state).

### WP31 — Affinity column and sorting without a reference

- Grid column for affinity is rendered **only when a reference deck exists** (Step 0 item 1). Otherwise the column is collapsed, its width goes to the title column, and the `TRI` control shows `TRI : AFFINITÉ` as **disabled with a reason** (`VzTip`: `Chargez une platine pour classer par affinité`).
- If the current order without a reference is arbitrary, propose and apply a deterministic fallback **only if it already exists in the store**; otherwise report it as a product decision and do not invent logic.
- When the column is shown: a 5-segment bar (brass scale) + the value `58 %` (tabular, 11 px, ≥ 4.5:1) so that the value is never encoded by the bar alone.

### WP32 — Row anatomy and alignment

Use one CSS grid for header and rows so columns align exactly (`display:grid` with the same `grid-template-columns` on both; example at 792 px inner width):

```css
.vz-lib-row{display:grid;align-items:center;column-gap:12px;height:44px;padding:0 12px;
  grid-template-columns:[aff] var(--aff-w,0px) [cover] 32px [title] minmax(0,1fr) [genre] 104px [key] 56px [bpm] 92px [act] auto}
/* with a reference deck: --aff-w:88px */
```

- **Cover slot always present** (28×28 px + 4 px gap): real cover when available, otherwise a **placeholder** with the same brass frame and an `album` icon in `--vz-text-disabled`. All titles then start on the same x.
- **Genre chip:** fixed width 104 px, one line, `text-overflow:ellipsis`, 10 px, text ≥ 4.5:1, full text in a `VzTip` when truncated. `OST / CINÉMA` must never wrap. A missing genre is a **bare** `—` in `--vz-text-disabled` (same as the artist), not a boxed chip.
- **Key chip:** 48×24 px minimum, tabular, text ≥ 4.5:1; rim colour by compatibility exactly as the spec says (emerald A / blue B / gold relative) when a reference exists; neutral otherwise. Add a one-line legend for the three rim colours in the filter row or a `VzTip` on the `CLÉ` header.
- **Tempo:** right-aligned, value bold tabular, unit `BPM` 10 px.
- Row states: hover `rgba(237,191,122,.06)` fill + brass title (keep); **focus-visible** brass inset outline; **on deck** row gets a 3 px left rim in the channel colour. Transitions 140 ms, opacity only.
- Row height stays 44 px; if 32 px keys feel cramped, allow 48 px in the roomy density and report it.

### WP33 — Header zone: fewer strips, readable, contextual

- **Banner:** hide `EN ATTENTE DE CHARGEMENT SUR LES PLATINES A & B` on the Library tab (Step 0 item 5). Its job is covered by the archive cards and the contextual hint below.
- **`ASTUCE MIX` becomes a contextual, dismissible hint** (×, remembered for the session): with no deck loaded `Chargez un titre sur A ou B pour voir l'affinité et les compatibles.`; with a deck loaded the current mix tip. Max one line, ≥ 4.5:1.
- **Archive cards:** `secondary` key look, min height 44 px. Disabled (no track loaded): flat, label ≥ **3:1** (today 1.7–1.9:1), `Aucune piste chargée` ≥ 4.5:1. Enabled: channel rim, label ≥ 4.5:1, LED lit.
- **Search field:** placeholder ≥ **4.5:1**, height 36 px, brass focus ring, clear `×` when non-empty.
- **Counter:** remove `34 TITRES ARCHIVÉS` (duplicate of `TOUS (34)`), or turn it into a dynamic result count `n / 34` shown only when a filter or search is active.
- **Filter chips:** `.vz-key` ghost, **32 px** high. Selected = **latched** (recessed + LED); disabled = flat with reason (`Chargez la platine A`). Replace `(–)` by the reference key when it exists (`COMPATIBLES A · 11B`) and omit it otherwise. Badges keep channel colours with text tokens.
- Target: header stack ≤ **190 px** (from ≈ 235 px) at the reference size.

## 5. P1 work packages

- **WP34 — Table header and scroll.** Header 10 px at ≥ 4.5:1, sticky. `AFFINITÉ`, `CLÉ`, `TEMPO` are all clickable with ▲/▼ and stay **in sync** with the `TRI` dropdown (single source of truth, no duplicate control logic). Brass custom scrollbar: 8 px, track `#0f0b09`, thumb gradient `#8c6d3f → #b98a42`, `scrollbar-gutter:stable`; a 24 px bottom fade (opacity) when more rows exist.
- **WP35 — States still to design and verify** (send captures, §7): coloured key chips with a reference deck; `SUR PLATINE A/B` badge and "classed at the bottom" behaviour; `COMPATIBLE A/B` and `★ DUOS` active; pre-listen with the gold scrubber and headphone volume (`.vz-key` slider tokens); inline double-click edit; the *Venezia 1889* edit modal (focus trap, Esc closes, `÷2 / ×2` as keys, labels ≥ 10 px); delete confirmation.
- **WP36 — Consistency with the main briefs.** Carousel dots (WP6), clock pill alignment (WP9), palette discipline (WP28 of pass 2). Same fixes, no new work here.

## 6. P2

- Side deck columns: balance their end with the centre (e.g. distribute vertical space so both columns end level with the crossfader block) — only if it can be done without moving controls the user relies on.
- Micro-details: subtle row separators (`1px rgba(237,191,122,.06)`), engraved column dividers, gentle fade-in when filters change (opacity, 120 ms, none under `prefers-reduced-motion`).

## 7. Acceptance criteria

1. Every row action ≥ **32×32 px**, gaps ≥ 8 px, delete separated ≥ 16 px and confirmed in two steps; edit is not the brightest control of the row.
2. All row titles start at the **same x** (±1 px) with or without cover; placeholder uses the same brass frame.
3. Genre chips never wrap; fixed width 104 px; missing genre/artist shown as a bare dash.
4. Without a reference deck the affinity column is collapsed and the sort control explains why; with one, values are shown as numbers + bar.
5. Header stack ≤ 190 px at the reference size; no banner on the Library tab; no duplicated count; hint is dismissible.
6. Contrast: archive card labels ≥ 3:1 disabled / ≥ 4.5:1 enabled; placeholder ≥ 4.5:1; table header ≥ 4.5:1 at ≥ 10 px; chips ≥ 4.5:1.
7. Filter chips: selected vs unselected distinguishable in a **grayscale** screenshot; disabled chips give a reason.
8. `AFFINITÉ`, `CLÉ`, `TEMPO` headers sort and stay in sync with the dropdown; scrollbar visible; fade appears only when more rows exist.
9. Native `title` tooltips are gone; `VzTip` shows after 400 ms and is never clipped.
10. No scroll outside the list, no overflow at **1920×1080** and **1366×768**; no layout shift when filtering or opening a hint.
11. `npm run check` 0 errors / 0 warnings; `node --test tests/` passes; per-row styles stay cheap (no per-row blur or large shadows).

## 8. Constraints — do NOT

Touch `library.rs`, SQL, IPC, store actions or event-handler names (a new confirmation UI may **wrap** the existing delete handler); change filtering/matching logic or affinity calculations; add a UI library or font; use red outside destructive/REC contexts (the delete confirmation may use the existing alert tone, not salmon); duplicate tokens; rewrite whole files when a targeted edit is enough.

## 9. Order and report

**Order:** Step 0 → WP32 (grid + alignment) → WP30 (actions) → WP31 (affinity) → WP33 (header zone) → **stop and send P0 evidence** → WP34 → WP35 → WP36 → P2.

**Evidence to send:** screenshots at 1920×1080, 1366×768 and the reference size, in these states: (a) both decks empty, (b) Deck A loaded (affinity + coloured key chips), (c) `COMPATIBLE A` and `★ DUOS` active, (d) a track on deck (`SUR PLATINE`), (e) pre-listen running, (f) a row hovered and focused, an action key pressed, (g) delete confirmation, (h) edit modal and inline edit, (i) list scrolled to the bottom.
Plus: a table of measured action sizes and gaps, a title-x alignment check (rows with and without cover), a contrast table (archive cards, placeholder, header, chips), the §7 checklist with **validated / to fix**, the Step 0 answers, any deviation with its reason, and the changed files.
The critic agent will answer **validated / to correct** per criterion.
