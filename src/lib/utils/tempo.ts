// ALC-211 : normalisation d'octave BPM (double / demi-tempo) — module PUR, testable sous `node --test`.
// Lorsque deux pistes sont à une octave musicale l'une de l'autre (ex. Julia ≈ 166 BPM vs
// Crying in the Rain ≈ 86 BPM), un calage de tempo naïf produirait un playbackRate ~2× (artefacts).
// On normalise le candidat sur l'octave du référent AVANT de calculer le playbackRate.

/** Ratio où l'on considère que le candidat est au double-tempo du référent (bpm ≈ ref × 2). */
export const OCTAVE_HALF_MIN = 1.75;
export const OCTAVE_HALF_MAX = 2.25;
/** Ratio où l'on considère que le candidat est au demi-tempo du référent (bpm ≈ ref / 2). */
export const OCTAVE_DOUBLE_MIN = 0.44;
export const OCTAVE_DOUBLE_MAX = 0.57;

/**
 * Normalise un tempo candidat sur l'octave du tempo de référence.
 * - bpm/ref ∈ [1.75 ; 2.25]  → renvoie bpm/2 (le candidat est à l'octave supérieure).
 * - bpm/ref ∈ [0.44 ; 0.57]  → renvoie bpm×2 (le candidat est à l'octave inférieure).
 * - sinon → renvoie bpm inchangé.
 * Valeurs non positives → bpm inchangé (aucun calcul).
 */
export function normalizeOctaveBpm(referenceBpm: number, candidateBpm: number): number {
  if (!(referenceBpm > 0) || !(candidateBpm > 0)) return candidateBpm;
  const ratio = candidateBpm / referenceBpm;
  if (ratio >= OCTAVE_HALF_MIN && ratio <= OCTAVE_HALF_MAX) return candidateBpm / 2;
  if (ratio >= OCTAVE_DOUBLE_MIN && ratio <= OCTAVE_DOUBLE_MAX) return candidateBpm * 2;
  return candidateBpm;
}

/** Résultat de la normalisation d'octave : le tempo source effectif et le ratio tempo cible / source effectif. */
export interface NormalizedTempoRatio {
  /** BPM source ajusté à la métrique octave la plus proche du BPM cible (×2 / ÷2). */
  effectiveSourceBpm: number;
  /** `targetBpm / effectiveSourceBpm` — le `playbackRate` à appliquer pour caler la source sur la cible. */
  ratio: number;
}

function round(v: number, d: number): number {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

/**
 * ALC-212 : helper UNIQUE de normalisation d'octave BPM (source → cible).
 * Ajuste `effectiveSourceBpm` par facteurs ×2 / ÷2 tant que `target/eff > √2` (≈1.414)
 * ou `< 1/√2` (≈0.707), afin de toujours choisir l'octave métrique la plus proche de la cible.
 * Ex. Julia 166.1 BPM (source) face à Crying in the Rain 86.3 BPM (cible) :
 *   → effectiveSourceBpm = 83.05, ratio = 86.3 / 83.05 = 1.0391 (et JAMAIS 0.519).
 */
export function computeNormalizedTempoRatio(sourceBpm: number, targetBpm: number): NormalizedTempoRatio {
  if (!(sourceBpm > 0) || !(targetBpm > 0)) {
    return { effectiveSourceBpm: sourceBpm, ratio: sourceBpm > 0 ? round(targetBpm / sourceBpm, 4) : 1 };
  }
  let eff = sourceBpm;
  let ratio = targetBpm / eff;
  let iter = 8;
  while (ratio > Math.SQRT2 && iter-- > 0) {
    eff *= 2;
    ratio = targetBpm / eff;
  }
  iter = 8;
  while (ratio < 1 / Math.SQRT2 && iter-- > 0) {
    eff /= 2;
    ratio = targetBpm / eff;
  }
  return { effectiveSourceBpm: round(eff, 2), ratio: round(ratio, 4) };
}

/**
 * ALC-222 : écart de BPM EFFECTIF entre Deck B et Deck A, normalisé à l'octave (×2 / ÷2).
 * `effectiveSourceBpm` = A ramené sur l'octave métrique la plus proche de B, puis on soustrait.
 * ex. A=166,1 & B=86,3 (demi-tempo) → bpmDelta ≈ +3,2 (et non -80) : octave-compatibles, résidu faible.
 */
export function effectiveBpmDelta(effA: number, effB: number): number {
  if (!(effA > 0) || !(effB > 0)) return 0;
  const { effectiveSourceBpm } = computeNormalizedTempoRatio(effA, effB);
  return Number((effB - effectiveSourceBpm).toFixed(2));
}

/** Bornes du garde-fou dur de vitesse de lecture (hors scratch/brake explicite). */
export const PLAYBACK_RATE_MIN = 0.75;
export const PLAYBACK_RATE_MAX = 1.35;

/**
 * ALC-212 : garde-fou dur du playbackRate.
 * - un ratio ~0.5 (< 0.65) ou ~2.0 (> 1.55) est d'abord normalisé ×2 / ÷2 (réjecte les calages d'octave fautifs) ;
 * - le résultat est ensuite borné à [0.75 ; 1.35] pour ne jamais dénaturer la voix (−48 % / +95 % interdits).
 */
export function normalizePlaybackRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  let r = rate;
  if (r < 0.65) r *= 2;
  else if (r > 1.55) r /= 2;
  return Math.max(PLAYBACK_RATE_MIN, Math.min(PLAYBACK_RATE_MAX, r));
}