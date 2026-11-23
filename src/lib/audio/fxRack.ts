// ALC-213 : Rack FX — types, état, logique PUR (subdivision BPM, dry/wet, export vers Pad Live).
// Module testable sous `node --test` (aucun WebAudio / Svelte).

export type FxDeckTarget = 'A' | 'B' | 'MASTER';
export type FxStemTarget = 'vocals' | 'drums' | 'bass' | 'other' | 'all';
export type FxSlot1Mode = 'LPF' | 'BPF' | 'HPF';
export type FxSlot2Mode = 'LAMPE CHAUDE' | 'FLANGER';
export type FxDelayDivision = '1/4' | '1/2' | '3/4' | '1 T';

export interface FxSlot1State {
  active: boolean;
  mode: FxSlot1Mode;
  cutoff: number; // Hz (40 – 16 000)
  resonance: number; // Q 0.2 – 12
  dryWet: number; // 0..1
}
export interface FxSlot2State {
  active: boolean;
  mode: FxSlot2Mode;
  drive: number; // 0..1
  modulate: number; // 0..1 (profondeur LFO flanger)
  dryWet: number;
}
export interface FxSlot3State {
  active: boolean;
  division: FxDelayDivision;
  feedback: number; // 0..1
  dampen: number; // Hz (filtre passe-bas d'écho)
  tailHold: boolean;
  reverbMix: number; // 0..1 (mix reverb dans le bloc Écho/Reverb)
  dryWet: number;
}
export interface FxRackState {
  deck: FxDeckTarget;
  stemTarget: FxStemTarget;
  slot1: FxSlot1State;
  slot2: FxSlot2State;
  slot3: FxSlot3State;
  isRecordingFx: boolean;
  fxRecordingDurationSec: number;
  lastRecordedFxBlobUrl: string | null;
  lastRecordedFxName: string | null;
  livePadIndex: number | null;
}

export const FX_DELAY_DIVISIONS: FxDelayDivision[] = ['1/4', '1/2', '3/4', '1 T'];
export const STEM_TARGETS: FxStemTarget[] = ['vocals', 'drums', 'bass', 'other', 'all'];
export const DECK_TARGETS: FxDeckTarget[] = ['A', 'B', 'MASTER'];

/**
 * ALC-217 : règle d'auto-activation — régler un paramètre d'un slot inactif doit l'enclencher.
 * Retourne `true` dès qu'un paramètre (autre que `active` lui-même) est fourni.
 */
export function autoActivatesOnAdjust(partial: Record<string, number | string | boolean>): boolean {
  return Object.keys(partial).some((k) => k !== 'active');
}

/** ALC-215 : modes du SLOT 01 avec symbole parlant + libellé débutant. */
export const SLOT1_MODE_UI: ReadonlyArray<{ mode: FxSlot1Mode; symbol: string; label: string }> = [
  { mode: 'LPF', symbol: '↘', label: 'LPF · Graves' },
  { mode: 'BPF', symbol: '∧', label: 'BPF · Centre' },
  { mode: 'HPF', symbol: '↗', label: 'HPF · Aigus' },
];

/** ALC-215 : modes du SLOT 02 avec symbole parlant + libellé débutant. */
export const SLOT2_MODE_UI: ReadonlyArray<{ mode: FxSlot2Mode; symbol: string; label: string }> = [
  { mode: 'LAMPE CHAUDE', symbol: '🔥', label: 'Lampe chaude' },
  { mode: 'FLANGER', symbol: '〰', label: 'Flanger' },
];

export function defaultFxRackState(): FxRackState {
  return {
    deck: 'A',
    stemTarget: 'all',
    slot1: { active: false, mode: 'LPF', cutoff: 1200, resonance: 1, dryWet: 0.35 },
    slot2: { active: false, mode: 'LAMPE CHAUDE', drive: 0.4, modulate: 0.5, dryWet: 0.3 },
    slot3: { active: false, division: '1/4', feedback: 0.35, dampen: 4000, tailHold: false, reverbMix: 0.3, dryWet: 0.3 },
    isRecordingFx: false,
    fxRecordingDurationSec: 0,
    lastRecordedFxBlobUrl: null,
    lastRecordedFxName: null,
    livePadIndex: null,
  };
}

// ── Subdivision BPM (durée de délai en secondes) ──────────────────────────────────────────────
/** Multiplicateur de temps (en beats) pour chaque subdivision : 1/4=1 beat, 1/2=2, 3/4=3, 1 T=2/3 (triplet). */
export const DELAY_BEATS: Record<FxDelayDivision, number> = { '1/4': 1, '1/2': 2, '3/4': 3, '1 T': 2 / 3 };

export function clampBpm(bpm: number): number {
  if (!(bpm > 0) || !Number.isFinite(bpm)) return 120;
  return Math.max(40, Math.min(220, bpm));
}

/** Durée (s) d'une subdivision d'écho pour un BPM donné : `beats * 60 / bpm`. */
export function fxDelaySeconds(division: FxDelayDivision, bpm: number): number {
  const beat = 60 / clampBpm(bpm);
  return Number((DELAY_BEATS[division] * beat).toFixed(4));
}

// ── Plancher anti-slapback (ALC-218) ─────────────────────────────────────────────────────────
/** Durée minimale d'écho (s) : en deçà, le délai se lit comme une « deuxième voix » métallique. */
export const FX_ECHO_MIN_SECONDS = 0.11;

/**
 * Durée d'écho finalisée : plancher `FX_ECHO_MIN_SECONDS` (>= 110 ms) quand le SLOT 03 est actif,
 * sinon un quasi-instant ~0.001 s (aucun slapback appliqué au signal). Évite le dédoublement vocal.
 */
export function fxEchoDelayClipped(division: FxDelayDivision, bpm: number, active: boolean): number {
  if (!active) return 0.001;
  return Math.max(fxDelaySeconds(division, bpm), FX_ECHO_MIN_SECONDS);
}

// ── Mélange dry/wet COMPLÉMENTAIRE STRICT (ALC-218) ───────────────────────────────────────
/**
 * Balance stricte `dry + wet === 1` (« dryGain = 1 - mix`, `wetGain = mix`). Contrairement à
 * l'equal-power (`sqrt`), aucun signal direct ne transite à 100 % en parallèle du signal traité :
 * c'est ce qui supprimait le dédoublement / la phase sur la voix avec l'écho court.
 */
export function fxComplementaryBalance(mix: number): { wet: number; dry: number } {
  const m = Math.max(0, Math.min(1, mix || 0));
  return { wet: m, dry: 1 - m };
}

/** ALC-213 (conservé) : variante à puissance égale — documentée, non utilisée par le moteur. */
export function fxEqualPower(mix: number): { wet: number; dry: number } {
  const m = Math.max(0, Math.min(1, mix || 0));
  return { wet: Math.sqrt(m), dry: Math.sqrt(1 - m) };
}

// ── Export / Pad Live ────────────────────────────────────────────────────────────────────────
export function clampLivePadIndex(padIndex: number): number {
  return Math.max(0, Math.min(7, Math.trunc(padIndex) || 0));
}
/** Nom de fichier de l'enregistrement FX, horodaté, identifiant le deck cible. */
export function fxRecordingFileName(deck: FxDeckTarget, padIndex: number | null): string {
  const d = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const st = padIndex == null ? '' : `_P${clampLivePadIndex(padIndex)}`;
  return `RACKFX_${deck}_${d}${st}.wav`;
}