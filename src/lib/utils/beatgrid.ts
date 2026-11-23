// ALC-202-1/2 : génération des repères de mesures / temps du Ruban Beatgrid, en module pur
// testable sous `node --test` (hors Svelte / DOM).
// Garanties :
//  - aucune mesure invalide (< 1) n'est émise (M-1 / M0 interdits) — index exact :
//    measureIndex = Math.floor(t / (4 * beatSec)) + 1 ;
//  - clés STRICTEMENT UNIQUES intégrant le deck, la boucle `k` et la valeur dérivée,
//    même au tout début du morceau (elapsedSeconds = 0).

const SECTION = ['INTRO', 'COUPLET', 'REFRAIN'];

const SAFE_BEAT = 0.5;

function safe(v: number, fallback: number): number {
  return v && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Numéro de mesure (>=1) pour un temps en secondes : M = 4 * beatSec. */
export function measureIndexForTime(tSeconds: number, beatSec: number): number {
  const M = safe(beatSec, SAFE_BEAT) * 4;
  return Math.floor(tSeconds / Math.max(1, M)) + 1;
}

export interface MeasureMark {
  x: number;
  m: string;
  label: string;
  key: string;
}
export interface BeatMark {
  x: number;
  beat: number;
  key: string;
}

/** Repères de mesures visibles : liste triée, uniquement des mesures >= 1, clés uniques. */
export function measuresFor(
  deckId: string,
  elapsedSeconds: number,
  beatSec: number,
  stride: number,
  waveW = 640,
): MeasureMark[] {
  const bs = safe(beatSec, SAFE_BEAT);
  const ph = elapsedSeconds && Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
  const s = safe(stride, waveW);
  const M = bs * 4;
  const k0 = Math.floor(ph / Math.max(1, M));
  const out: MeasureMark[] = [];
  for (let k = -14; k <= 14; k++) {
    const t = (k0 + k) * M;
    const measureIndex = measureIndexForTime(t, bs);
    if (measureIndex < 1) continue; // ALC-202-1 : ignore les mesures < 1 (début du morceau)
    const px = (t - ph) * s + waveW / 2;
    if (!Number.isFinite(px) || px < -6 || px > waveW + 6) continue;
    out.push({
      x: px,
      m: `M${measureIndex}`,
      label: SECTION[(((k0 + k) % 4) + 4) % 4] ?? '',
      key: `${deckId}-M-${k}-${measureIndex}`,
    });
  }
  return out;
}

/** Pulsation 1-2-3-4 (tempo) visible : clés uniques, mesures >= 1 uniquement. */
export function beatsFor(
  deckId: string,
  elapsedSeconds: number,
  beatSec: number,
  stride: number,
  waveW = 640,
): BeatMark[] {
  const bs = safe(beatSec, SAFE_BEAT);
  const ph = elapsedSeconds && Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
  const s = safe(stride, waveW);
  const M = bs * 4;
  const k0 = Math.floor(ph / Math.max(1, M));
  const out: BeatMark[] = [];
  for (let k = -7; k <= 7; k++) {
    const measureIndex = measureIndexForTime((k0 + k) * M, bs);
    if (measureIndex < 1) continue; // ALC-202-1 : ignore les mesures < 1
    for (let b = 0; b < 4; b++) {
      const t = (k0 + k) * M + b * bs;
      const px = (t - ph) * s + waveW / 2;
      if (!Number.isFinite(px) || px < -4 || px > waveW + 4) continue;
      out.push({ x: px, beat: b + 1, key: `${deckId}-B-${k}-${b}` });
    }
  }
  return out;
}