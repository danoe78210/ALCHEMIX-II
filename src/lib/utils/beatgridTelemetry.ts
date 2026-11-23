// ALC-224 : télémétrie du Beatgrid — helpers PURS testables sous `node --test`.
// Courbe d'évolution du tempo et courbe d'évolution de la clé Camelot locale au fil du morceau.

import { parseCamelot } from '$lib/audio/harmony';

export interface TeleSegment {
  startSec: number;
  endSec: number;
  localBpm?: number;
  localCamelot?: string;
}

/**
 * Normalise un BPM de segment dans l'octave du BPM global (`0.75*global <= b <= 1.35*global`,
 * via ×2 / ÷2) puis applique le `playbackRate` (pitch) pour obtenir le BPM effectif affiché.
 */
export function getEffectiveSegmentBpm(
  segmentLocalBpm: number,
  globalBpm: number,
  playbackRate: number
): number {
  if (!(globalBpm > 0)) return segmentLocalBpm;
  let b = Number.isFinite(segmentLocalBpm) && segmentLocalBpm > 0 ? segmentLocalBpm : globalBpm;
  let guard = 0;
  while ((b < 0.75 * globalBpm || b > 1.35 * globalBpm) && guard++ < 8) {
    if (b > 1.35 * globalBpm) b /= 2; // trop haut → demi-tempo
    else b *= 2; // trop bas → double-tempo
  }
  const r = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  return Number((b * r).toFixed(1));
}

export interface KeyPoint {
  key: string;
  num: number | null; // 1..12 (rang Camelot)
  mode: 'A' | 'B' | null;
  rank: number; // rang vertical normalisé 0..1 ((num-1)/11)
}

/** Clé Camelot locale active à l'instant `elapsedSeconds` + rang vertical pour tracer la courbe. */
export function getActiveKeyPointAtTime(
  segments: TeleSegment[] | null | undefined,
  elapsedSeconds: number,
  fallbackCamelot: string
): KeyPoint {
  const t = Math.max(0, elapsedSeconds || 0);
  let seg: TeleSegment | null = null;
  for (const s of segments || []) {
    if (t >= (s.startSec ?? 0) && t < (s.endSec ?? Number.POSITIVE_INFINITY)) {
      seg = s;
      break;
    }
  }
  const raw = (seg?.localCamelot || fallbackCamelot || '').trim().toUpperCase();
  const parsed = parseCamelot(raw);
  const num = parsed?.num ?? null;
  const mode = parsed?.mode ?? null;
  const rank = num != null ? (num - 1) / 11 : 0;
  return {
    key: parsed ? `${parsed.num}${parsed.mode}` : raw,
    num,
    mode,
    rank,
  };
}