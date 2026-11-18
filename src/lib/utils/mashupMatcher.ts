// ALC-165-2 : moteur de scoring et matching MASHUP (onglet LIBRAIRIE).
// Notes ponderees : harmonique 50 %, rythmique 35 %, creatif/duos 15 %.
// Module pur (aucun import Svelte) : utilisable dans LibraryView.svelte et node --test.
// Cles Camelot gerees via harmony.ts (source unique, ALC-143).

import { parseCamelot, relationFrom } from '$lib/audio/harmony';

export const HARMONY_WEIGHT = 0.5;
export const RHYTHM_WEIGHT = 0.35;
export const CREATIVE_WEIGHT = 0.15;

export const DIRECT_TEMPO_TOLERANCE_PCT = 6;
export const RATIO_TEMPO_TOLERANCE_PCT = 3;

export type KeyLabel =
  | 'SAME KEY'
  | 'RELATIVE MAJ'
  | 'RELATIVE MIN'
  | '+1 FIFTH'
  | '-1 FIFTH'
  | 'ENERGY JUMP'
  | 'FAR KEY';

export type TempoMode = 'direct' | 'ratio' | 'false';

export interface KeyMatch {
  refKey: string;
  candKey: string;
  delta: number;
  rel: boolean;
  label: KeyLabel;
  score: number;
}

export interface TempoMatch {
  mode: TempoMode;
  displayBpm: number;
  ratio: number;
  deltaPct: number;
  keyLocked: boolean;
  label: string;
  score: number;
}

export interface MashupScore {
  trackId: number;
  affinity: number;
  duo: boolean;
  harmony: KeyMatch;
  tempo: TempoMatch;
  sendTo: 'A' | 'B';
}

export interface MatchableTrack {
  id?: number;
  camelotKey?: string;
  camelot_key?: string;
  bpm?: number;
  genre?: string;
}

function readKey(t: MatchableTrack): string {
  return (t.camelotKey ?? t.camelot_key ?? '').trim();
}
function readBpm(t: MatchableTrack): number {
  return Number(t.bpm ?? 0);
}
function readGenre(t: MatchableTrack): string {
  return (t.genre ?? '').trim().toLowerCase();
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function fmtPct(p: number): string {
  return (p >= 0 ? '+' : '') + p.toFixed(1) + '%';
}

// ALC-168-1 : correspondance robuste entre une piste de la librairie et une piste chargée sur platine.
export interface TrackIdentity {
  filePath?: string | null;
  title?: string | null;
  artist?: string | null;
}

/** Normalise un chemin : antifèches → '/', minuscules, espaces retirés. */
const normPath = (p?: string | null): string => (p || '').replace(/\\/g, '/').toLowerCase().trim();
/** Normalise un texte simple (titre / artiste). */
const normTxt = (s?: string | null): string => (s || '').toLowerCase().trim();

/**
 * Vrai si `lib` (entrée de la Librairie) et `deck` (piste chargée) désignent le même morceau :
 * 1) `filePath` normalisé (antislashs → '/', casse, espaces) ; 2) en repli, titre ET artiste normalisés.
 */
export function isSameTrack(lib: TrackIdentity, deck: TrackIdentity): boolean {
  const lp = normPath(lib.filePath);
  const dp = normPath(deck.filePath);
  if (lp && dp && lp === dp) return true;
  const lt = normTxt(lib.title);
  const la = normTxt(lib.artist);
  const dt = normTxt(deck.title);
  const da = normTxt(deck.artist);
  return !!(lt && la && dt && da && lt === dt && la === da);
}

export function quintCircleDelta(refKey: string, candKey: string): number {
  const a = parseCamelot(refKey);
  const b = parseCamelot(candKey);
  return ((((b.num - a.num + 6) % 12) + 12) % 12) - 6;
}

export function keyMatch(refKey: string, candKey: string): KeyMatch {
  if (!refKey || !candKey) {
    return { refKey, candKey, delta: 0, rel: false, label: 'FAR KEY', score: 0 };
  }
  const rel = relationFrom(parseCamelot(refKey), parseCamelot(candKey))!;
  const delta = quintCircleDelta(refKey, candKey);
  const base = { refKey, candKey, delta };
  if (rel.rel) {
    return {
      ...base,
      rel: true,
      label: refKey.toUpperCase().endsWith('B') ? 'RELATIVE MAJ' : 'RELATIVE MIN',
      score: 95,
    };
  }
  const ring = rel.ring;
  if (ring === 0) return { ...base, rel: false, label: 'SAME KEY', score: 100 };
  if (ring === 1) return { ...base, rel: false, label: delta > 0 ? '+1 FIFTH' : '-1 FIFTH', score: 94 };
  if (ring === 2) return { ...base, rel: false, label: 'ENERGY JUMP', score: 84 };
  if (ring <= 5) return { ...base, rel: false, label: 'FAR KEY', score: 50 };
  return { ...base, rel: false, label: 'FAR KEY', score: 26 };
}

const TEMPO_RATIOS: { ratio: number; label: string }[] = [
  { ratio: 2, label: 'x2' },
  { ratio: 0.5, label: '/2' },
  { ratio: 1.5, label: 'x1.5' },
  { ratio: 1 / 1.5, label: '/1.5' },
];

export function tempoMatch(refBpm: number, candBpm: number, sameKey = false): TempoMatch {
  const none: TempoMatch = {
    mode: 'false', displayBpm: candBpm, ratio: 1, deltaPct: 0, keyLocked: false, label: '', score: 0,
  };
  if (!Number.isFinite(refBpm) || !Number.isFinite(candBpm) || refBpm <= 0 || candBpm <= 0) return none;

  const directPct = ((candBpm - refBpm) / refBpm) * 100;
  if (Math.abs(directPct) <= DIRECT_TEMPO_TOLERANCE_PCT) {
    return {
      mode: 'direct', displayBpm: round1(candBpm), ratio: 1, deltaPct: round1(directPct),
      keyLocked: false, label: fmtPct(directPct), score: Math.max(60, 100 - Math.abs(directPct) * 4),
    };
  }

  let best: { ratio: number; label: string; pct: number } | null = null;
  for (const r of TEMPO_RATIOS) {
    const pct = ((candBpm * r.ratio - refBpm) / refBpm) * 100;
    if (Math.abs(pct) <= RATIO_TEMPO_TOLERANCE_PCT && (!best || Math.abs(pct) < Math.abs(best.pct))) {
      best = { ratio: r.ratio, label: r.label, pct };
    }
  }
  if (!best) return none;

const prefix = sameKey ? 'MÊME CLÉ • ' : '';
  return {
    mode: 'ratio', displayBpm: round1(refBpm), ratio: best.ratio, deltaPct: round1(best.pct),
    keyLocked: sameKey, label: `${prefix}${best.label} (${fmtPct(best.pct)})`,
    score: Math.max(55, 90 - Math.abs(best.pct) * 8),
  };
}

export function scoreMatch(ref: MatchableTrack, cand: MatchableTrack, duo = false): MashupScore {
  const harmony = keyMatch(readKey(ref), readKey(cand));
  const sameKey = harmony.delta === 0 && !harmony.rel;
  const tempo = tempoMatch(readBpm(ref), readBpm(cand), sameKey);
  const gRef = readGenre(ref);
  const gCand = readGenre(cand);
  const contrast = gRef !== '' && gCand !== '' && gRef !== gCand;
  const creativeScore = duo ? 100 : contrast ? Math.round(50 + harmony.score / 2) : 50;
  const raw = HARMONY_WEIGHT * harmony.score + RHYTHM_WEIGHT * tempo.score + CREATIVE_WEIGHT * creativeScore;
  return {
    trackId: cand.id ?? -1,
    affinity: Math.max(0, Math.min(100, Math.round(raw))),
    duo,
    harmony,
    tempo,
    sendTo: 'B',
  };
}

export function compareScores(a: MashupScore, b: MashupScore): number {
  if (a.duo !== b.duo) return a.duo ? -1 : 1;
  if (b.affinity !== a.affinity) return b.affinity - a.affinity;
  return a.trackId - b.trackId;
}

// ── ALC-170 : Harmonic Bridge Finder local — pistes ponts dans la Librairie SQLite ──
export interface BridgeDeckRef extends MatchableTrack {
  filePath?: string | null;
  title?: string | null;
  artist?: string | null;
}

export interface LocalBridgeResult {
  track: MatchableTrack & TrackIdentity;
  score: number;
  pivot: string;
  bpm: number;
  duoA: boolean;
  duoB: boolean;
}

const ringBetween = (aKey: string, bKey: string): number =>
  relationFrom(parseCamelot(aKey), parseCamelot(bKey))?.ring ?? 99;
const tempoGapPct = (a: number, b: number): number =>
  a > 0 && b > 0 ? (Math.abs(a - b) / Math.max(a, b)) * 100 : 0;

const duoKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Recherche les meilleures pistes PONT (Harmonic Bridge Finder) dans la Librairie locale.
 * S'active dès que les deux platines sont chargées et que leur écart Camelot ≥ 2 quintes
 * OU que leur écart de tempo dépasse ± 8 %.
 */
export function findLocalBridgeTracks(
  deckA: BridgeDeckRef,
  deckB: BridgeDeckRef,
  libraryTracks: (MatchableTrack & TrackIdentity)[],
  maxResults = 3,
  duos?: Set<string>
): LocalBridgeResult[] {
  const aKey = readKey(deckA);
  const bKey = readKey(deckB);
  const aBpm = readBpm(deckA);
  const bBpm = readBpm(deckB);
  if (!aKey || !bKey) return [];

  // Activation : écart harmonique ≥ 2 quintes OU écart de tempo > 8 %.
  const conflict = ringBetween(aKey, bKey) >= 2 || tempoGapPct(aBpm, bBpm) > 8;
  if (!conflict) return [];

  const lo = Math.min(aBpm, bBpm);
  const hi = Math.max(aBpm, bBpm);
  // Clé pivot à mi-chemin sur l'anneau Camelot entre A et B.
  const aTrim = parseCamelot(aKey);
  const bTrim = parseCamelot(bKey);
  const delta = ((bTrim.num - aTrim.num + 6) % 12) - 6;
  const pivotKey = `${(((aTrim.num + Math.round(delta / 2) - 1 + 24) % 12) + 1)}${aTrim.mode}`;

  // IDs des lignes bibliothèque correspondant aux platines A/B (pour le bonus duo).
  let deckARowId: number | undefined;
  let deckBRowId: number | undefined;
  for (const t of libraryTracks) {
    if (deckARowId === undefined && isSameTrack(t, deckA)) deckARowId = t.id;
    if (deckBRowId === undefined && isSameTrack(t, deckB)) deckBRowId = t.id;
    if (deckARowId !== undefined && deckBRowId !== undefined) break;
  }

  const results: LocalBridgeResult[] = [];
  for (const t of libraryTracks) {
    // Exclut les deux pistes déjà chargées sur A et B.
    if (isSameTrack(t, deckA) || isSameTrack(t, deckB)) continue;
    const cKey = readKey(t);
    const cBpm = readBpm(t);
    if (!cKey || t.id == null) continue;

    // Pivot harmonique (55 %) : compatible avec A ET B, ou à mi-chemin.
    const ha = keyMatch(aKey, cKey).score;
    const hb = keyMatch(bKey, cKey).score;
    const compat = Math.min(ha, hb); // 0..100
    const har = Math.min(
      55,
      (compat / 100) * 50 + (cKey === pivotKey ? 5 : 0) + (compat >= 82 ? 3 : 0)
    );

    // Palier de tempo (35 %) : dans l'intervalle [A,B] ou compatible double/demi-tempo.
    let tempo = 0;
    if (cBpm > 0) {
      const inRange = cBpm >= lo - 1 && cBpm <= hi + 1;
      const halfDouble = [aBpm / 2, aBpm * 2, bBpm / 2, bBpm * 2].some(
        (x) => x > 0 && Math.abs((cBpm - x) / x) <= 0.08
      );
      const middle = 35 - Math.abs(cBpm - (lo + hi) / 2) / (Math.max(1, hi - lo)) * 8;
      tempo = inRange ? 35 : halfDouble ? 30 : Math.max(0, Math.round(middle));
      tempo = Math.min(35, Math.max(0, tempo));
    }

    // Bonus Duo validé (10 %).
    const duoA = !!duos && deckARowId !== undefined && duos.has(duoKey(deckARowId, t.id));
    const duoB = !!duos && deckBRowId !== undefined && duos.has(duoKey(deckBRowId, t.id));
    const duoPts = duoA || duoB ? 10 : 0;

    results.push({
      track: t,
      score: Math.round(har + tempo + duoPts),
      pivot: cKey,
      bpm: cBpm,
      duoA: !!duoA,
      duoB: !!duoB,
    });
  }
  results.sort((x, y) => y.score - x.score || (x.track.id ?? 0) - (y.track.id ?? 0));
  return results.slice(0, maxResults);
}