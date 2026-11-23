// ALC-218 : propreté spectrale du stem « vocals » — nettoyage PUR, testable sous `node --test`.
// Coupe-bas < 90 Hz, contrôle doux des sibilantes / fuites aiguës (> ~7 kHz) et atténuation douce
// des silences sans chant (gate). N'altère pas la longueur ni la structure temporelle de la voix.

export interface VocalCleanOptions {
  /** Fréquence de coupure du passe-haut (Hz) — coupe le sub-vocal / la réverb. */
  highpassHz?: number;
  /** Fréquence de coupure du passe-bas doux (Hz) — de-ess / contrôle des aigus. */
  deessHz?: number;
  /** Seuil RMS en dessous duquel on considère un bloc comme du « silence sans chant ». */
  gateRms?: number;
  /** Gain résiduel (0..1) appliqué aux silences (jamais un silence total abrupt). */
  gateFloor?: number;
}

export function cleanVocalsSamples(
  input: Float32Array,
  sampleRate: number,
  opts: VocalCleanOptions = {}
): Float32Array {
  const sr = sampleRate > 0 && Number.isFinite(sampleRate) ? sampleRate : 44100;
  const { highpassHz = 85, deessHz = 7500, gateRms = 0.0012, gateFloor = 0.15 } = opts;
  const n = input.length;
  const out = new Float32Array(n);

  // Passe-haut du premier ordre (supprime le DC ET le sub < ~90 Hz).
  const fc = Math.max(20, Math.min(sr / 2 - 1, highpassHz));
  const hpA = Math.exp((-2 * Math.PI * fc) / sr);
  let xPrev = 0;
  let yHp = 0;

  // Passe-bas doux en cascade (3 pôles) — de-ess : contrôle net des sibilantes / fuites aiguës
  // au‑delà de ~7 kHz sans ternir le médium vocal.
  const deess = Math.max(100, Math.min(sr / 2 - 1, deessHz));
  const lpA = Math.exp((-2 * Math.PI * deess) / sr);
  let yLp1 = 0;
  let yLp2 = 0;
  let yLp3 = 0;

  // Gate douce par blocs : atténuation des silences (RMS < seuil) sans couper la voix.
  const block = 2048;
  const gains = new Float32Array(n);
  let i = 0;
  while (i < n) {
    const end = Math.min(n, i + block);
    let sum = 0;
    for (let j = i; j < end; j++) {
      const s = input[j];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / (end - i));
    const g = rms < gateRms ? Math.max(gateFloor, rms / gateRms) : 1;
    for (let j = i; j < end; j++) gains[j] = g;
    i = end;
  }

  for (let k = 0; k < n; k++) {
    const x = input[k];
    // ALC-220 : passe-haut DC-blocker NORMALISÉ à gain unitaire — `y = a*(y + x - xPrev)` (et
    // NON `a*y + (1-a)*(x-xPrev)` dont le gain de passe-bande ~2(1-a)/(1+a) ≈ 0.022 (-33 dB) à
    // 85 Hz/48 kHz écrase TOUT le stem vocals). La voix redevient audible à ~unitaire.
    yHp = hpA * (yHp + (x - xPrev));
    xPrev = x;
    yLp1 = lpA * yLp1 + (1 - lpA) * yHp;
    yLp2 = lpA * yLp2 + (1 - lpA) * yLp1;
    yLp3 = lpA * yLp3 + (1 - lpA) * yLp2;
    out[k] = yLp3 * gains[k];
  }
  return out;
}