// ALC-143 : logique harmonique Camelot partagée (source unique de vérité).
// Réutilisée par MixerCenter (Roue de Camelot), BeatgridView et BridgeSuggester,
// afin d'éviter toute duplication des formules d'affinité / verdict / pivot.

export interface CamelotKey {
  num: number; // 1..12
  mode: 'A' | 'B';
}

export interface HarmonyRelation {
  ring: number; // écart en quintes via le chemin court (0..6)
  rel: boolean; // couple relatif (mêmes numéro, modes opposés)
}

export interface Verdict {
  icon: string;
  text: string;
  cls: string;
}

export interface BridgePivot {
  pivotKey: string;
  targetBpm: number;
  query: string;
}

/**
 * ALC-234 : table officielle des 24 clés Camelot → libellé tonal lisible (source unique).
 * Table officielle du projet (ALC-125, traduite en français). Ex. `8A` → « La mineur », `9B` → « Sol majeur ».
 */
export const CAMELOT_LABELS: Record<string, string> = {
  '1A': 'Sol♯ mineur', '2A': 'Ré♯ mineur', '3A': 'La♯ mineur', '4A': 'Fa mineur',
  '5A': 'Do mineur', '6A': 'Sol mineur', '7A': 'Ré mineur', '8A': 'La mineur',
  '9A': 'Mi mineur', '10A': 'Si mineur', '11A': 'Fa♯ mineur', '12A': 'Do♯ mineur',
  '1B': 'Si majeur', '2B': 'Fa♯ majeur', '3B': 'Ré♭ majeur', '4B': 'La♭ majeur',
  '5B': 'Mi♭ majeur', '6B': 'Si♭ majeur', '7B': 'Fa majeur', '8B': 'Do majeur',
  '9B': 'Sol majeur', '10B': 'Ré majeur', '11B': 'La majeur', '12B': 'Mi majeur',
};

/** ALC-234 : libellé lisible d'une clé Camelot — ex. « 8A (La mineur) », repli si inconnue. */
export function camelotLabelFromKey(code: string): string {
  const c = (code || '').trim().toUpperCase();
  const name = CAMELOT_LABELS[c];
  return name ? `${c} (${name})` : c;
}

/** Parse une clé Camelot ("8B" → { num: 8, mode: 'B' }). */
export function parseCamelot(code: string): CamelotKey {
  const m = (code || '').toUpperCase().match(/(\d{1,2})([AB])/);
  const num = m ? Math.min(12, Math.max(1, parseInt(m[1], 10) || 1)) : 1;
  return { num, mode: m && m[2] === 'A' ? 'A' : 'B' };
}

/** Relation harmonique entre deux clés (null si l'une des deux est absente). */
export function relationFrom(a: CamelotKey | null, b: CamelotKey | null): HarmonyRelation | null {
  if (!a || !b) return null;
  const ring = Math.min(Math.abs(a.num - b.num), 12 - Math.abs(a.num - b.num));
  const rel = a.num === b.num && a.mode !== b.mode;
  return { ring, rel };
}

/** Affinité % (0..100) déduite de la relation. */
export function affinityFrom(h: HarmonyRelation | null): number {
  if (!h) return 0;
  if (h.rel) return 95;
  if (h.ring === 0) return 100;
  if (h.ring === 1) return 95;
  if (h.ring === 2) return 82;
  return Math.max(30, 100 - h.ring * 14);
}

/** Verdict de mixage humanisé. */
export function verdictFrom(h: HarmonyRelation | null): Verdict | null {
  if (!h) return null;
  if (h.rel) return { icon: '✓', text: 'MIX HARMONIQUE OPTIMAL (RELATIF)', cls: 'text-emerald-400' };
  if (h.ring === 0) return { icon: '✓', text: 'MIX HARMONIQUE OPTIMAL (MÊME CLÉ)', cls: 'text-emerald-400' };
  if (h.ring === 1) return { icon: '✓', text: 'MIX HARMONIQUE OPTIMAL (QUINTE VOISINE)', cls: 'text-emerald-400' };
  if (h.ring === 2) return { icon: '⚡', text: 'TRANSITION ÉNERGÉTIQUE (+2 QUINTES)', cls: 'text-[#edbf7a]' };
  return { icon: '⚠', text: 'ÉCART HARMONIQUE IMPORTANT — UTILISER UN PONT', cls: 'text-[#ffb4ab]' };
}

/** Libellé normalisé de l'intervalle harmonique réel. */
export function intervalFrom(h: HarmonyRelation | null): { label: string; hub: string } | null {
  if (!h) return null;
  if (h.rel) return { label: 'RELATIF (A↔B)', hub: 'RELATIF' };
  if (h.ring === 0) return { label: 'MÊME CLÉ (0)', hub: 'MÊME CLÉ' };
  if (h.ring === 1) return { label: 'QUINTE VOISINE (+1)', hub: 'Δ = +1 QUINTE' };
  if (h.ring === 2) return { label: 'SAUT ÉNERGÉTIQUE (+2)', hub: 'Δ = +2 QUINTES' };
  return { label: `ÉCART DE ${h.ring} QUINTES`, hub: `Δ = ${h.ring} QUINTES` };
}

/** Vraie si la superposition de clés est dissonante (écart ≥ 3 quintes, hors relatif). */
export function isDissonant(h: HarmonyRelation | null): boolean {
  return !!h && !h.rel && h.ring >= 3;
}

/** Clé pivot (tampon) au milieu du chemin harmonique, mobilisable quand l'écart ≥ 3 quintes. */
export function pivotFrom(
  a: CamelotKey | null,
  b: CamelotKey | null,
  h: HarmonyRelation | null,
  bothLoaded: boolean,
  bpmA: number,
  bpmB: number,
  query: string
): BridgePivot | null {
  if (!bothLoaded || !a || !b || !h) return null;
  if (h.rel || h.ring < 3) return null;
  const delta = ((b.num - a.num + 6) % 12) - 6; // écart signé court (heures) ∈ [-6,6]
  let mid = a.num + delta / 2;
  mid = ((mid - 1 + 24) % 12) + 1;
  const pivot = Math.round(mid);
  const p = ((pivot - 1 + 24) % 12) + 1;
  return {
    pivotKey: `${p}${a.mode}`,
    targetBpm: Number(((bpmA + bpmB) / 2).toFixed(1)),
    query,
  };
}