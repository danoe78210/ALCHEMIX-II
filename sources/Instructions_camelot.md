# ADDENDUM TO THE DEVELOPMENT BRIEF — Loaded decks, Stems drawers, ID3 rack

> Written by the art-direction / UX critic agent (does not code). It **amends and extends**
> `brief-agent-dev-interface-principale.md` (WP1–WP11) and `brief-agent-dev-pupitre-beatgrid.md`.
> Where this addendum contradicts an earlier brief, **this addendum wins**. Everything else still applies.
> Same rules as before: change markup and CSS only; never touch audio logic, store actions, IPC or Rust;
> `h-screen overflow-hidden`, no layout shift; report with evidence (see §6).

---

## 1. New evidence (three captures reviewed)

States reviewed: (1) both decks loaded, drawers closed; (2) both **Stems IA** drawers open; (3) both Stems open + **ID3 / metadata** rack open on Deck B.
Still **not seen**: Oracle open, hover/pressed, stems after extraction, extraction in progress, AUTO-MIX running.
None of the P0 items of the previous briefs appear to be applied yet (flat drawer strips, ≈ 275 px dead space, red carousel dots).

### 1.1 Corrections to earlier assumptions (read first)

| Earlier claim | Corrected by the new captures |
|---|---|
| "Deck A and Deck B rows are misaligned" (WP3, P0) | **Only when one deck is empty.** With both decks loaded every row is aligned to ±1 px. WP3 is **downgraded to P1** and limited to the empty-deck case (reserve the rows, drop-zone inside the cassette area). |
| "Isolated lit segment in the LUFS gauge is a possible bug" | It is the **zero marker** of a divergent gauge (blue segments to the left = "descente", brown marker at centre). Do **not** remove it; label it (WP18). |
| "Dashed gold arc 4B→8B: meaning unknown" | It is **identical** with keys 11B (A only) and 6A/9B (A+B), so it is independent of the loaded keys: likely static/decorative. A **separate thick gold arc** (6B→9B on the outer ring) does show the A→B path (`Δ = 3 QUINTES`). The two overlap between 6B and 8B (WP17). |

### 1.2 New findings

| # | Finding | Evidence |
|---|---|---|
| A | The app asks the user to act but hides the answer | Banner `⚠ ÉCART HARMONIQUE IMPORTANT — UTILISER UN PONT` while the Oracle (which holds the 3 bridge tracks) is a closed 28 px strip with ≈ 275 px of empty space below it. |
| B | The Stems drawer **pushes the layout** | Opening it adds ≈ **145 px** to each deck column (EQ, transport, volume, telemetry, metadata all move down), about three quarters of the ≈ 195 px free height under the decks. On a shorter window the bottom of the decks would clip (`overflow-hidden`). |
| C | The ID3 rack **replaces the telemetry block** of its deck | On Deck B (ID3 open) BPM `85.2`, key `9B` and `G major` are not visible; the panel occupies exactly the telemetry slot. BPM and key are the most useful numbers while mixing. |
| D | Colour code contradicts the channel code | Stems panels: on A, row 1 is all green but `INST` in row 2 is blue; on B, `VOIX` is green inside a blue deck, `BATT/BASSE/INST` blue. Green/blue mean channel A/B everywhere else. In the ID3 rack of the **blue** deck, `1411 kbps` is **green** and `44.1 kHz` blue. |
| E | Stems controls are small and weak | Keys ≈ **22 px** high (minimum 32 px), 9–10 px text; blue labels measure **3.2–3.4:1** (`BATT`, `BASSE`, `INST`); green `VOIX` 4.4:1. `EXTRAIRE STEMS` (≈ 24 px, the heavy action: HTDemucs) is a flat dark strip that looks like an input field, although its text is 9.2:1. Enabled/disabled state of the stem keys before extraction is not readable. |
| F | Native browser tooltips | `Ouvrir le tiroir` / `Refermer le tiroir` appear as a **white box with black system text**, off-brand, and cover neighbouring text (e.g. `LOW 120 HZ · HIGH 3.2 KHZ`). |
| G | Data credibility | The ID3 rack shows `MP3` with `44.1 kHz / 16-bit` and **`1411 kbps`**. 1411 kbps is the bitrate of CD-quality PCM; an MP3 tops out at 320 kbps. The value looks computed from decoded PCM, not read from the file. |
| H | ID3 rack finishing | Cover ≈ **62 px**, with an `OPUS 92` badge covering the lower part of the artwork; spec captions `FORMAT / ÉCHANTILLON / DÉBIT` 4.2–4.6:1 at ≈ 8 px. |
| I | Palette sprawl | Warm accents: brass `#edbf7a` (`58%`) **and** salmon `#ffb59d` (`-2.4 LUFS`, master-clock LED), orange bolt; plus red, emerald, and **two blues** (`#00A3FF` channel, `#3b82f6` in Stems/specs). |
| J | Gauge details | Caption `ÉCART DE 3 QUINTES` sits ≈ 3 px under the bar. Blue (= channel B colour) is used for "descente" in the LUFS gauge. No scale on the divergent gauge. |

**Strengths to preserve:** the wheel with the thick A→B arc, emerald/blue needles and the centre read-out `Δ = 3 QUINTES · A 6A · B 9B`;
the exact alignment of loaded decks; the `58 %` gauge (8 of 14 segments = coherent); the façade pills (`MP3 • 44.1 KHZ`);
the channel-coloured frame around an open drawer; the clear ID3 layout (cover · title · 3 spec columns); text contrasts of the ID3 body (≈ 10:1) and `EXTRAIRE STEMS` (9.2:1).

## 2. Step 0 additions (answer in your report; read the code, do not guess)

1. What do the Stems panel colours encode in code (channel? vocal vs instrumental? mashup source)? Why is `INST` green in row 1 and blue in row 2 on Deck A?
2. Are the stem keys disabled before extraction? Is there any progress/event for extraction that the UI can show (do not invent a fake progress)?
3. What is the dashed gold arc (4B→8B)? What are the white and gold dots that appear at different positions between captures (animated marker?)
4. What is the `OPUS 92` badge on the cover? Where does `1411 kbps` come from (tag, decoder, computed)?
5. What does the master-clock LED colour mean (salmon today)?
6. Are the `title` attributes on the drawer façades the source of the native tooltips? Is there an existing tooltip component?

## 3. Amendments to earlier work packages

- **WP1 (drawer anatomy) — amended.** Keep the façade, handle, chevron, keyboard and ARIA rules. **Replace** the rule "in-flow drawers must not push siblings" by the contract below:
  - **Stems (in-flow, `mode="inflow"`)**: it covers nothing and the free budget exists, so it may push siblings **only if** the panel height ≤ **150 px**
    (see WP14) and the free height under the column ≥ panel height + 16 px. Animate with `grid-template-rows: 0fr → 1fr` plus inner `opacity`
    (documented exception to "transform/opacity only": small subtree, nothing covered). If the free height is insufficient (small window),
    automatically switch to `mode="overlay"` and report it. Measure frame time while opening; if any frame exceeds 16 ms, use overlay mode.
  - **Metadata / ID3 (overlay, `data-direction="up"`)**: allowed to cover the telemetry block **only if BPM and key stay visible** (WP13).
  - **Oracle**: unchanged (`closed / peek / open`, WP1).
- **WP3 — downgraded to P1** (empty-deck case only, see §1.1).
- **WP7 — extended** by WP17 below.
- **Tokens (add):** `--vz-ch-a-text:#34d399; --vz-ch-b-text:#6cc4ff` (≈ 6.9:1 on the dark tints used for tinted keys). Use them for any **text** in channel colours.
  Keep `#10b981` / `#00A3FF` for rims, LEDs and glows. **Stop using `#3b82f6`.**

## 4. New work packages

### WP12 (P0) — Make the advice reachable
- When the banner state is `ÉCART HARMONIQUE IMPORTANT` (or any state where the Oracle has bridge tracks), the Oracle goes to **`peek`** automatically.
- Add a `ghost` key in the banner: `VOIR LES PONTS (3)` that sets the Oracle UI state to `open` (existing state only; no new logic). The count comes from the existing `3 PISTES` value.
- Banner text stays; do not shrink the wheel to make room (WP2 already reallocates the dead space).

### WP13 (P0) — Never hide BPM and key
- In the metadata façade, show two pills while the drawer is closed **and** open: `[ 85.2 BPM ]` and `[ 9B ]` in the deck's text colour token (`--vz-ch-*-text`), next to the existing `MP3 • 44.1 KHZ` pill. Tabular digits.
- When the ID3 rack is open and covers the telemetry block, dim nothing else; the façade pills are the guaranteed readout.
- Acceptance: at all times, each deck shows its BPM and Camelot key somewhere on screen.

### WP14 (P0) — Stems panel redesign (≤ 150 px)
- Layout (inside the open drawer, padding 12 px, gap 8 px): `EXTRAIRE STEMS` key (full width) → one row of 4 stem toggles → one row of 2 presets (`ACAPELLA`, `INST`) as a 2-segment latching rail. Remove the inner `STEMS IA` title row if height requires it (the façade already carries the title); keep `HTDEMUCS • LOCAL` as a 10 px caption on the façade pill.
- `EXTRAIRE STEMS`: `secondary` tier, height `--vz-key-h` (36 px), icon `bolt`, text ≥ 4.5:1. States: default / hover / pressed / disabled (reason) / **loading** (latched look + a real progress bar only if a real progress event exists; otherwise an indeterminate slow LED pulse, never a fake percentage) / done (label `STEMS PRÊTS`, key becomes `ghost`).
- Stem toggles: `ghost` tier, **height 32 px**, 11–12 px text, latching (`aria-pressed`) with LED. **Disabled until extraction**, with the reason `Extraire d'abord` (`title` via WP15 + caption).
- **One colour rule**: the panel's accent is the **deck channel** (rim, LEDs). Roles (`VOIX`, `BATT`, `BASSE`, `INST`, `ACAPELLA`) are distinguished by **label + icon** (`mic`, `graphic_eq`, `music_note`…), not by green/blue. If Step 0 shows the colours encode a deliberate meaning (e.g. mashup source), keep that meaning but express it with icon + brass LED, and add a one-line legend.
- Acceptance: no green control on Deck B and no blue control on Deck A inside the Stems panel; stem labels ≥ 4.5:1 using the text tokens.

### WP15 (P0) — Brand tooltip `VzTip` (replaces native `title` tooltips)
- Remove `title` from drawer façades and keys that currently trigger native tooltips; keep `aria-label` / `aria-expanded`; use `aria-describedby` for reasons (disabled keys).
- Style: bg `#0f0b09`, `1px solid var(--vz-key-edge)`, radius 4 px, padding 6×10 px, text `--vz-text-hi`, 11 px mono, shadow `0 6px 16px rgba(0,0,0,.5)`.
- Behaviour: show after **400 ms** hover or on keyboard focus, hide immediately; `role="tooltip"`; Esc hides; fade 120 ms (opacity only); collision-aware (flip above/below; never cover the control's own label or the neighbouring caption when avoidable); no tooltip on touch.
- Acceptance: no native white tooltip remains on drawers or keys; tooltip never clipped by the window.

### WP16 (P1) — ID3 rack finishing
- Cover **88×88 px**, radius 4, `1px` brass frame, inner shadow; the badge (Step 0: what is `OPUS 92`?) moves to a 10 px corner chip that does **not** cover the artwork's lower third; remove it if it is decorative.
- Spec values neutral: values `--vz-text-hi`, units `--vz-text-mid`; **no green/blue values** (the channel colour appears only as the panel rim). Captions ≥ 10 px and ≥ 4.5:1.
- **Data check (do not ignore):** `1411 kbps` on an MP3. If the value is computed from sample rate × bit depth × channels, replace it with the file's real bitrate from the tags/decoder, or show `—` (the spec forbids test values). Label bit depth as decoded PCM (`PCM 16-bit`) or hide it for lossy formats. Report what you found.

### WP17 (P1) — Wheel arcs and markers
- Keep the **thick A→B arc**. Add a small ebony plate at its midpoint: `3 QUINTES` (10 px, brass), value from the existing interval.
- The dashed arc (Step 0): if decorative or redundant, **remove it**; otherwise add a one-line legend. Never leave two overlapping gold arcs between 6B and 8B.
- White/gold moving dots: if they animate the A→B direction, add a legend or an `aria-label`; if not, remove them. Respect `prefers-reduced-motion`.

### WP18 (P1) — Gauges
- Caption gap under the bar ≥ **6 px** (today ≈ 3 px).
- LUFS gauge: add ticks `−6 · 0 · +6` (or the real range from the code) and a 10 px label at the zero marker. Do **not** use channel blue for polarity: lit segments in brass, zero marker in a distinct tone.
- Values `58 %` and `-2.4 LUFS` use the **same** accent (brass); remove salmon.

### WP19 (P1) — Palette discipline
- Accents: **channel colours (A/B) + one brass accent**. Red only for REC, alerts, peak, VU needle. Replace salmon (`#ffb59d`) with brass or neutral. Master-clock LED colour by meaning (green = locked, brass = master present; Step 0).
- One blue family: `#00A3FF` for rims/LEDs/glows, `--vz-ch-b-text` for text.

### WP20 (P1) — Empty-deck alignment (formerly WP3)
- Reserve every deck row (Stems façade always rendered, disabled with reason; drop-zone caption inside the cassette area) so that A and B stay aligned when one deck is empty. Acceptance in §5.

## 5. Acceptance criteria (additions and changes)

1. Banner state `ÉCART HARMONIQUE IMPORTANT` → Oracle in `peek` automatically and `VOIR LES PONTS (n)` opens it.
2. Each deck always shows BPM and Camelot key (telemetry block **or** façade pills), including while the ID3 rack is open.
3. Stems panel height ≤ **150 px**; stem keys ≥ **32 px** high; all Stems text ≥ **4.5:1**; no green control on Deck B / no blue control on Deck A inside the panel.
4. With **both** Stems drawers and **both** ID3 racks open: no clipping, no scroll at **1920×1080** and **1366×768**; if the free height is insufficient the Stems drawer falls back to overlay mode.
5. Opening/closing a drawer causes **no jank** (frame ≤ 16 ms measured) and no content jump other than the intended push of the Stems panel.
6. No native white tooltip remains; `VzTip` delay 400 ms, `role="tooltip"`, never clipped.
7. ID3 rack: cover ≥ 88 px, no badge over the artwork's lower third, no green/blue spec values, captions ≥ 10 px and ≥ 4.5:1; bitrate is real or `—`.
8. Empty-deck state: for every deck row `|A.top − B.top| ≤ 1 px` and same bottom edge (loaded state already passes; keep it passing).
9. Gauge captions ≥ 6 px under the bar; LUFS gauge has a labelled zero and scale.
10. Only the brass accent plus channel colours in the main screen; no salmon; a single blue family.
11. `npm run check` 0 errors / 0 warnings; `node --test tests/` passes.

## 6. Order and report

Order: Step 0 additions → WP12 → WP13 → WP15 → WP14 → (stop, send P0 evidence) → WP16 → WP17 → WP18 → WP19 → WP20.
Combine with the earlier P0 items WP1–WP5 as already ordered in `brief-agent-dev-interface-principale.md` §8.

Evidence to send: screenshots at 1920×1080, 1366×768 and the reference size of: both decks loaded; Oracle `closed / peek / open`; Stems open (before and after extraction, and **during** extraction if reachable); ID3 open on both decks; a façade hovered with `VzTip` visible; a stem key pressed and latched; AUTO-MIX disabled / enabled / running.
Plus: row-alignment table, contrast table (Stems keys, ID3 captions, gauges), Step 0 answers, the §5 checklist with **validated / to fix**, changed files.
The critic agent will answer **validated / to correct** per criterion.
