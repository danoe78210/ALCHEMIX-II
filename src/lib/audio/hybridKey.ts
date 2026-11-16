// ALC-141-3 : arbitrage harmonique hybride. Croise la clé DSP locale (Rust) avec une référence
// externe (AcousticBrainz/MusicBrainz) et décide de la clé Camelot finale + sa source.

export type HybridSource = 'dsp' | 'consensus' | 'arbitred' | 'dsp-priority';

export interface HybridLocal {
  camelotKey: string;
  confidence: number; // 0..1 (DSP Rust)
}
export interface HybridExternal {
  camelotKey: string;
  strength: number; // 0..1 (AcousticBrainz)
}
export interface HybridResult {
  camelotKey: string;
  source: HybridSource;
  externalKey: string;
}

function parse(code: string): { num: number; mode: 'A' | 'B' } {
  const m = (code || '').toUpperCase().match(/(\d{1,2})([AB])/);
  const num = m ? Math.min(12, Math.max(1, parseInt(m[1], 10) || 1)) : 1;
  return { num, mode: (m && m[2] === 'A' ? 'A' : 'B') as 'A' | 'B' };
}

/**
 * Règles d'arbitrage :
 * - Consensus (local === external) → conserve local, source 'consensus'.
 * - Voisinage (relatif A↔B ou ±1 quinte) → API si confidence < 0.72 ET strength >= 0.65, sinon DSP.
 * - Divergence (≥ 2 quintes) → DSP prioritaire (protection remixes/bootlegs), externe en référence.
 */
export function resolveHybridCamelotKey(local: HybridLocal, external: HybridExternal | null): HybridResult {
  if (!external || !external.camelotKey) {
    return { camelotKey: local.camelotKey, source: 'dsp', externalKey: '' };
  }
  const a = parse(local.camelotKey);
  const b = parse(external.camelotKey);

  if (a.num === b.num && a.mode === b.mode) {
    return { camelotKey: local.camelotKey, source: 'consensus', externalKey: external.camelotKey };
  }

  const ring = Math.min(Math.abs(a.num - b.num), 12 - Math.abs(a.num - b.num));
  const rel = a.num === b.num && a.mode !== b.mode;

  if (rel || ring === 1) {
    if (local.confidence < 0.72 && external.strength >= 0.65) {
      return { camelotKey: external.camelotKey, source: 'arbitred', externalKey: external.camelotKey };
    }
    return { camelotKey: local.camelotKey, source: 'dsp-priority', externalKey: external.camelotKey };
  }

  // Divergence majeure (≥ 2 quintes) : fidélité à l'analyse audio réelle du fichier.
  return { camelotKey: local.camelotKey, source: 'dsp-priority', externalKey: external.camelotKey };
}