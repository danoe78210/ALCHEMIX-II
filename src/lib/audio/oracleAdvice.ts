// ALC-221 : APPLIQUER LES CONSEILS de l'Oracle Acoustique — logique PUR testable sous `node --test`.
// Calcule, en un clic, les réglages recommandés : ajustement de cadence Pitch B (normalisé octave),
// préparation des basses LOW EQ 120 Hz et calibrage de la durée Auto-Mix 8/16 mesures.

import { computeNormalizedTempoRatio } from '$lib/utils/tempo';

export interface OracleDeckInfo {
  /** BPM de base (détecté) du Deck secondaire B. */
  baseBpmB: number;
  /** BPM effectif (pitch inclus) du Deck maître A — cible de cadence. */
  masterBpmA: number;
  /** Écart harmonique Camelot en quintes (cercle) entre A et B. */
  ring: number;
  /** Vrai si les deux clés sont en relation relative majeure/mineure (A↔B). */
  rel: boolean;
}

export interface OracleAdvice {
  targetPitchB: number; // % de pitch à appliquer sur B pour caler sur A
  lowEqA: number; // dB grave (120 Hz) Deck A
  lowEqB: number; // dB grave (120 Hz) Deck B
  autoMixBars: 8 | 16;
}

/** Judgement : harmoniquement compatible = relatif majeur/mineur OU écart ≤ 1 quinte (même clé/adjacente). */
export function isHarmonicallyCompatible(ring: number, rel: boolean): boolean {
  return rel || ring <= 1;
}

export function computeOracleAdvice(info: OracleDeckInfo): OracleAdvice {
  const source = info.baseBpmB > 0 ? info.baseBpmB : 120;
  const target = info.masterBpmA > 0 ? info.masterBpmA : source;
  const norm = computeNormalizedTempoRatio(source, target);
  const targetPitchB = Number(((norm.ratio - 1) * 100).toFixed(2));
  if (isHarmonicallyCompatible(info.ring, info.rel)) {
    return { targetPitchB, lowEqA: 0, lowEqB: -12, autoMixBars: 16 };
  }
  return { targetPitchB, lowEqA: 0, lowEqB: -18, autoMixBars: 8 };
}

/** Résumé lisible (ex. « Pitch B -0.6% • Low EQ B -12 dB • 16 Mes »). */
export function oracleAdviceSummary(a: OracleAdvice): string {
  const p = a.targetPitchB >= 0 ? `+${a.targetPitchB.toFixed(1)}` : a.targetPitchB.toFixed(1);
  return `Pitch B ${p}% • Low EQ B ${a.lowEqB} dB • ${a.autoMixBars} Mes`;
}

export interface OracleSnapshot {
  pitchB: number;
  lowEqA: number;
  lowEqB: number;
  autoMixBars: 8 | 16;
}

/** Capture l'état audio précédent (avant application) pour un revert exact. */
export function captureOracleSnapshot(
  pitchB: number,
  lowEqA: number,
  lowEqB: number,
  autoMixBars: 8 | 16
): OracleSnapshot {
  return { pitchB, lowEqA, lowEqB, autoMixBars };
}

/** Restaure EXACTEMENT les valeurs du snapshot (contrat de `revertOracleAdvice`). */
export function oracleRevertValues(snapshot: OracleSnapshot): OracleSnapshot {
  return {
    pitchB: snapshot.pitchB,
    lowEqA: snapshot.lowEqA,
    lowEqB: snapshot.lowEqB,
    autoMixBars: snapshot.autoMixBars,
  };
}