// ALC-187-1 : logique PURE du mix 4 Stems (source unique, testable sous `node --test`).
//
// Le store (`mixer.svelte.ts`) utilise des runes Svelte 5 et n'est pas importable sous Node
// (même constat que `tests/stemsStop.test.ts`). Toutes les lois de calcul sont donc
// centralisées ici, puis DÉLÉGUÉES par les actions du store : platines latérales et console
// centrale lisent les mêmes champs (`stemGains`, `stemMutes`) → la cohérence est garantie par
// construction (un seul objet de vérité par deck).

export type StemMixPreset = 'all' | 'acapella' | 'instrumental' | 'theme';

/** Volumes utilisateur par défaut des 4 stems (100 % partout). */
export const STEM_DEFAULT_GAINS: Record<string, number> = {
  vocals: 1,
  drums: 1,
  bass: 1,
  other: 1,
};

/** Borne un volume utilisateur dans [0, 1] (valeurs non finies → 1). */
export function clampStemVolume(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
}

/** ALC-222 : détecte une collision vocale — les deux platines ont leurs stems prêts ET VOIX actif partout. */
export function bothVocalsActive(
  aStatus: string,
  bStatus: string,
  aMutes: Record<string, boolean>,
  bMutes: Record<string, boolean>
): boolean {
  return aStatus === 'ready' && bStatus === 'ready' && !aMutes.vocals && !bMutes.vocals;
}

/** ALC-222 : décision d'arbitrage AUTO VOIX — couper la voix B pendant une phrase chantée de A. */
export function autoVocalMuteDecision(aVocalActive: boolean, bMuted: boolean): 'mute' | 'none' {
  return aVocalActive && !bMuted ? 'mute' : 'none';
}

/** ALC-219 : message de retour UI affiché après un reset des stems (badge temporaire). */
export const STEMS_RESET_MESSAGE = 'STEMS RÉINITIALISÉS';
/** ALC-219 : message de confirmation après Aligner Tempo & Phase. */
export const TEMPO_PHASE_MESSAGE = 'TEMPO & PHASE ALIGNÉS';

/** ALC-214 : état « mixture complète » des mutes (aucun stem coupé). */
export function freshStemMutes(): Record<string, boolean> {
  return { vocals: false, drums: false, bass: false, other: false };
}

/** ALC-214 : gains unitaires (100 %) pour les 4 stems. */
export function unitStemGains(): Record<string, number> {
  return { vocals: 1, drums: 1, bass: 1, other: 1 };
}

/**
 * Gain effectif d'un stem : muet → 0, sinon le volume utilisateur.
 * `effectiveGain = muted ? 0 : volume` (ALC-187-1).
 */
export function effectiveStemGain(
  mutes: Record<string, boolean>,
  gains: Record<string, number>,
  stem: string
): number {
  return mutes[stem] ? 0 : clampStemVolume(gains[stem] ?? 1);
}

/**
 * Applique un preset aux mutes sans toucher aux volumes : TOUT (aucun mute),
 * ACAPELLA (uniquement la voix), INST (tout sauf la voix). Retourne un nouveau
 * record (immutabilité fonctionnelle).
 */
export function applyStemPreset(
  mutes: Record<string, boolean>,
  preset: StemMixPreset
): Record<string, boolean> {
  const next: Record<string, boolean> = { ...mutes };
  const stems = Object.keys(next).length > 0 ? Object.keys(next) : ['vocals', 'drums', 'bass', 'other'];
  if (preset === 'all') {
    for (const k of stems) next[k] = false;
  } else if (preset === 'acapella') {
    for (const k of stems) next[k] = k !== 'vocals';
  } else if (preset === 'theme') {
    // Crossover OST × OST — Platine Thème : seul `other` (cordes/cuivres/thème), drums+bass+vocals coupés.
    for (const k of stems) next[k] = k !== 'other';
  } else {
    // instrumental (Platine Rythmique d'un crossover : drums + bass + other actifs, vocals muté)
    for (const k of stems) next[k] = k === 'vocals';
  }
  return next;
}

/**
 * ALC-188-2 : un stem est AUDIBLE si non muet ET volume effectif > 0.02 (source unique de la
 * synchro latérale ⟷ centrale — les boutons des tiroirs utilisent CETTE définition).
 */
export function stemActive(
  mutes: Record<string, boolean>,
  gains: Record<string, number>,
  stem: string
): boolean {
  return !mutes[stem] && clampStemVolume(gains[stem] ?? 1) > 0.02;
}

/** ALC-251-2 : garde-fou BPM d'une télémétrie stems (`applyStemsTelemetry`) — seuls le tempo
 * analysé de la piste (`knownBpm`) ou ses OCTAVES binaires (×2 / ÷2, tolérance ±8 %) sont
 * acceptés ; les ratios biaisés ~1,25 / ~0,80 (`×5/4`, ex. 163,4 vs 130,3 — vieux caches
 * `stems_meta.json`) sont REJETÉS → purge + recalcul (auto-guérison universelle, n'importe quel
 * morceau). Sans référence exploitable, la télémétrie n'est pas bloquée. */
export function isStemsTelemetryBpmAcceptable(telemetryBpm: number, knownBpm: number): boolean {
  if (
    !Number.isFinite(telemetryBpm) ||
    telemetryBpm <= 0 ||
    !Number.isFinite(knownBpm) ||
    knownBpm <= 0
  ) {
    return true; // pas de référence exploitable → on laisse passer (validé au prochain run)
  }
  const r = telemetryBpm / knownBpm;
  if (Math.abs(r - 1.25) <= 0.08 || Math.abs(r - 0.8) <= 0.08) return false; // ×5/4 biaisé
  return Math.abs(r - 1) <= 0.08 || Math.abs(r - 2) <= 0.08 || Math.abs(r - 0.5) <= 0.08;
}

/**
 * ALC-188-2 : réaction au clic d'un bouton de stem sous un lecteur latéral.
 * - stem audible → MUTE ;
 * - stem inactif (muet OU fader central à 0 %) → lève le mute ET restaure le volume à 1.0
 *   (100 %) pour que le son revienne immédiatement et que le fader central remonte en miroir.
 */
export function resolveStemHit(
  mutes: Record<string, boolean>,
  gains: Record<string, number>,
  stem: string
): { muted: boolean; volume: number } {
  const active = stemActive(mutes, gains, stem);
  return {
    muted: active,
    volume: active ? clampStemVolume(gains[stem] ?? 1) : 1,
  };
}

function toFloat32(src: number[] | Float32Array | ArrayLike<number>): Float32Array {
  return new Float32Array(Array.from(src));
}

/**
 * ALC-190-1 : compose l'enveloppe de BEATGRID à partir des SEULS stems actifs
 * (`!muted && gain > 0.02`), pondérés par leur volume. Chaque bin = max des stems
 * actifs à cet endroit (une voix seule n'affiche plus les silences instrumentaux).
 * - tous les stems présents actifs / aucun actif / pas d'enveloppes → `fallbackGlobal`
 *   (l'enveloppe globale habituelle du morceau).
 */
export function composeSelectedStemsEnvelope(
  envelopes: Record<string, Float32Array>,
  gains: Record<string, number>,
  mutes: Record<string, boolean>,
  fallbackGlobal: number[] | Float32Array
): Float32Array {
  const names = Object.keys(envelopes);
  if (!names.length) return toFloat32(fallbackGlobal);
  const active = names.filter((n) => stemActive(mutes, gains, n));
  // Tous les stems actifs ou aucun → enveloppe globale (jamais d'onde vide / tronquée).
  if (active.length === names.length || active.length === 0) return toFloat32(fallbackGlobal);
  const bins = Math.max(1, envelopes[active[0]] ? envelopes[active[0]].length : 512);
  const out = new Float32Array(bins);
  for (const n of active) {
    const env = envelopes[n];
    if (!env) continue;
    const g = clampStemVolume(gains[n] ?? 1);
    for (let b = 0; b < bins; b++) {
      const v = env[b] * g;
      if (v > out[b]) out[b] = v;
    }
  }
  return out;
}

/**
 * ALC-190-1 : DÉTECTION du mashup complémentaire entre les deux platines.
 * Vrai quand les deux ont des stems `ready` ET que l'une porte la voix seule
 * (vocals active, instruments coupés) pendant que l'autre joue l'instrumentale
 * (voix coupée, au moins un instrument actif) — cible de l'Auto-Mix « 50/50 ».
 */
export function isComplementaryMashup(
  a: { stemsStatus: string; stemMutes: Record<string, boolean>; stemGains: Record<string, number> },
  b: { stemsStatus: string; stemMutes: Record<string, boolean>; stemGains: Record<string, number> }
): boolean {
  if (a.stemsStatus !== 'ready' || b.stemsStatus !== 'ready') return false;
  const aVocals = stemActive(a.stemMutes, a.stemGains, 'vocals');
  const bVocals = stemActive(b.stemMutes, b.stemGains, 'vocals');
  const aInstr = ['drums', 'bass', 'other'].some((n) => stemActive(a.stemMutes, a.stemGains, n));
  const bInstr = ['drums', 'bass', 'other'].some((n) => stemActive(b.stemMutes, b.stemGains, n));
  return (aVocals && !bVocals && bInstr) || (bVocals && !aVocals && aInstr);
}

/**
 * ALC-190-3 : cible du Crossfader Master pour l'AUTO-MIX.
 * En mashup complémentaire → équilibre 50/50 (fusion des stems complémentaires).
 * Sinon → transition DJ standard vers la platine entrante (0 si B_TO_A, 100 si A_TO_B).
 */
export function resolveAutoMixTarget(
  isMashup: boolean,
  direction: 'A_TO_B' | 'B_TO_A'
): number {
  if (isMashup) return 50;
  return direction === 'A_TO_B' ? 100 : 0;
}

/**
 * Cible du Pont Mashup (ALC-187-1) : la platine porteuse de la voix passe en ACAPELLA,
 * l'autre platine en INSTRUMENTAL — en un seul appel.
 */
export function resolveCrossDeckMashup(
  vocalDeck: 'A' | 'B'
): Record<'A' | 'B', StemMixPreset> {
  return vocalDeck === 'A'
    ? { A: 'acapella', B: 'instrumental' }
    : { A: 'instrumental', B: 'acapella' };
}

/**
 * Crossover OST × OST : routage complémentaire des 4 stems.
 *  - Platine Rythmique (`rhythm`) : preset `instrumental` → drums + bass + other actifs (vocals muté) ;
 *  - Platine Thème (`theme`) : preset `theme` → seul `other` (cordes / cuivres), drums + bass + vocals coupés.
 */
export function resolveCrossoverStems(rhythm: 'A' | 'B'): Record<'A' | 'B', StemMixPreset> {
  return rhythm === 'A' ? { A: 'instrumental', B: 'theme' } : { A: 'theme', B: 'instrumental' };
}

/**
 * ALC-196-1 / ALC-203-1 / ALC-226 : détecte l'instant (s) où le stem `vocals` commence à chanter.
 * DÉTECTION ADAPTATIVE — le seuil est proportionnel au PIC vocal réel (`max(0.08, peak*0.25)`) sur
 * ≥ 3 bins consécutifs, afin que les voix douces / réverbérées (Something About Us, I Ran)
 * déclenchent toujours la Platine B. Si le stem est quasi plat, repli garanti à la 8ᵉ mesure.
 * Le résultat est QUANTIFIÉ sur le temps fort (beat) le plus proche (offset `gridOffsetMs`).
 */
export function detectFirstVocalEntrySeconds(
  vocalEnvelope: Float32Array,
  durationSeconds: number,
  bpm: number,
  gridOffsetMs: number
): number {
  const bins = vocalEnvelope.length;
  if (!bins || bins < 3 || !(durationSeconds > 0)) return 0;
  const beat = 60 / (bpm > 0 ? bpm : 120);
  const offset = (gridOffsetMs || 0) / 1000;
  // Seuil adaptatif = max(0.08, pic * 0.25).
  let peak = 0;
  for (const v of vocalEnvelope) if (v > peak) peak = v;
  const THRESHOLD = Math.max(0.08, peak * 0.25);
  const MIN_RUN = 3; // ALC-226 : créneau soutenu d'au moins 3 bins
  let start = -1;
  let run = 0;
  for (let i = 0; i < bins && start < 0; i++) {
    if (vocalEnvelope[i] > THRESHOLD) {
      run++;
      if (run >= MIN_RUN) start = i - (MIN_RUN - 1);
    } else {
      run = 0;
    }
  }
  // Repli garanti à la 8ᵉ mesure si le stem est quasi plat (aucune voix soutenue détectée).
  if (start < 0) return Math.min(durationSeconds, offset + 8 * 4 * beat);
  const t = (start / bins) * durationSeconds;
  const k = Math.round((t - offset) / beat);
  return Math.max(0, offset + k * beat);
}

/**
 * ALC-196-1 : identifie le rôle des platines pour un déclenchement mashup selon les stems
 * sélectionnés : `instDeck` = platine instrumentale (voix coupée, instruments actifs),
 * `vocalDeck` = platine vocale (voix active). Par défaut (decks identiques / cas ambigus) :
 * `instDeck='A'`, `vocalDeck='B'`.
 */
export function resolveMashupRoles(
  a: { stemMutes: Record<string, boolean>; stemGains: Record<string, number> },
  b: { stemMutes: Record<string, boolean>; stemGains: Record<string, number> }
): { instDeck: 'A' | 'B'; vocalDeck: 'A' | 'B' } {
  const aVoc = stemActive(a.stemMutes, a.stemGains, 'vocals');
  const bVoc = stemActive(b.stemMutes, b.stemGains, 'vocals');
  const aIns = ['drums', 'bass', 'other'].some((n) => stemActive(a.stemMutes, a.stemGains, n));
  const bIns = ['drums', 'bass', 'other'].some((n) => stemActive(b.stemMutes, b.stemGains, n));
  if (!aVoc && bVoc && aIns) return { instDeck: 'A', vocalDeck: 'B' };
  if (!bVoc && aVoc && bIns) return { instDeck: 'B', vocalDeck: 'A' };
  return { instDeck: 'A', vocalDeck: 'B' }; // défaut (decks identiques)
}

/** ALC-196-2 : la platine vocale doit démarrer dès que l'instrumentale franchit l'entrée vocale cible. */
export function vocalTriggerDue(instElapsedSeconds: number, targetEntrySeconds: number): boolean {
  return instElapsedSeconds >= targetEntrySeconds;
}

/**
 * ALC-203-1 : le curseur utilisateur du vocal est-il déjà posé dans une zone vocale ACTIVE
 * (amplitude > 0.18 de façon soutenue) ? Si oui, on respecte son placement manuel au lieu de
 * re-pré-cuer sur l'entrée vocale détectée (`entryB`).
 */
export function detectActiveVocalZoneAt(
  vocalEnvelope: Float32Array,
  durationSeconds: number,
  tSeconds: number,
  threshold = 0.18
): boolean {
  const bins = vocalEnvelope.length;
  if (!bins || !(durationSeconds > 0) || !(tSeconds >= 0)) return false;
  const idx = Math.max(0, Math.min(bins - 1, Math.floor((tSeconds / durationSeconds) * bins)));
  let run = 0;
  let best = 0;
  const lo = Math.max(0, idx - 4);
  const hi = Math.min(bins, idx + 6);
  for (let i = lo; i < hi; i++) {
    run = vocalEnvelope[i] > threshold ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best >= 4;
}

/**
 * ALC-223 : fin de la PREMIÈRE phrase vocale — premier bloc soutenu (amplitude > 0.18 sur ≥ 4 bins)
 * suivi d'une pause vocale ≥ 3 bins ; renvoie l'instant (s) de fin quantifié sur le temps fort (beat)
 * suivant. Repli : durée du morceau si aucune phrase vocale ne se termine.
 */
export function detectFirstVocalPhraseEndSeconds(
  vocalEnvelope: Float32Array,
  durationSeconds: number,
  bpm: number,
  gridOffsetMs: number
): number {
  const bins = vocalEnvelope.length;
  if (!bins || bins < 8 || !(durationSeconds > 0)) return durationSeconds;
  const beat = 60 / (bpm > 0 ? bpm : 120);
  const THRESHOLD = 0.18;
  const MIN_RUN = 4;
  const MIN_PAUSE = 3;
  let start = -1;
  let run = 0;
  for (let i = 0; i < bins && start < 0; i++) {
    if (vocalEnvelope[i] > THRESHOLD) {
      run++;
      if (run >= MIN_RUN) start = i - (MIN_RUN - 1);
    } else {
      run = 0;
    }
  }
  if (start < 0) return durationSeconds; // aucune voix → pas de relais avant la fin
  let end = bins - 1;
  let pause = 0;
  for (let i = start; i < bins; i++) {
    if (vocalEnvelope[i] > THRESHOLD) {
      pause = 0;
      end = i;
    } else {
      pause++;
      if (pause >= MIN_PAUSE) {
        end = i - MIN_PAUSE;
        break;
      }
    }
  }
  if (end < start) end = start;
  const t = ((end + 1) / bins) * durationSeconds;
  const offset = (gridOffsetMs || 0) / 1000;
  const k = Math.ceil((t - offset) / beat - 1e-9);
  const quant = offset + Math.max(0, k) * beat;
  return Math.min(durationSeconds, Math.max(t, quant));
}

/** ALC-227 : segment temporel d'une strophe vocale (début/fin en secondes). */
export interface VocalStanza {
  start: number;
  end: number;
}

/**
 * ALC-227 / ALC-238 : extrait les strophes vocales (seuil adaptatif `max(0.08, pic*0.25)`,
 * créneaux soutenus ≥ 3 bins, séparés par des pauses ≥ `minPauseSeconds` = 0.22 s, repli 1 bin)
 * — pour le relais bidirectionnel et la segmentation fine du Phrase-Synced Vocal Slicing.
 */
export function extractVocalStanzas(
  vocalEnvelope: Float32Array,
  durationSeconds: number,
  bpm: number,
  gridOffsetMs: number,
  minPauseSeconds = 0.22
): VocalStanza[] {
  const bins = vocalEnvelope.length;
  void gridOffsetMs;
  if (!bins || bins < 3 || !(durationSeconds > 0)) return [];
  const binSec = durationSeconds / bins;
  const MIN_PAUSE = Math.max(1, Math.ceil((minPauseSeconds > 0 ? minPauseSeconds : 0.22) / Math.max(0.001, binSec)));
  const MIN_RUN = 3;
  let peak = 0;
  for (const v of vocalEnvelope) if (v > peak) peak = v;
  const THRESHOLD = Math.max(0.08, peak * 0.25);
  const out: VocalStanza[] = [];
  let run = 0;
  let s = -1;
  let e = -1;
  let hole = 0;
  for (let i = 0; i <= bins; i++) {
    const on = i < bins && vocalEnvelope[i] > THRESHOLD;
    if (on) {
      if (run === 0) {
        s = i;
        hole = 0;
      }
      run++;
      e = i;
    } else if (run > 0) {
      hole++;
      if (hole >= MIN_PAUSE) {
        if (run >= MIN_RUN && s >= 0) {
          out.push({ start: (s / bins) * durationSeconds, end: ((e + 1) / bins) * durationSeconds });
        }
        run = 0;
        s = -1;
        e = -1;
        hole = 0;
      }
    }
  }
  if (run >= MIN_RUN && s >= 0) {
    out.push({ start: (s / bins) * durationSeconds, end: ((e + 1) / bins) * durationSeconds });
  }
  return out;
}

/**
 * ALC-227 : début de la PREMIÈRE strophe STRICTEMENT après `currentSeconds + 0.5`, quantifié sur le
 * downbeat ; repli sur le prochain cycle de 8 mesures de la grille si aucune strophe future.
 */
export function findNextStanzaStartAfter(
  vocalEnvelope: Float32Array,
  durationSeconds: number,
  bpm: number,
  gridOffsetMs: number,
  currentSeconds: number
): number {
  const cur = Math.max(0, currentSeconds || 0);
  const beat = 60 / (bpm > 0 ? bpm : 120);
  const offset = (gridOffsetMs || 0) / 1000;
  const stanzas = extractVocalStanzas(vocalEnvelope, durationSeconds, bpm, gridOffsetMs);
  for (const st of stanzas) {
    if (st.start > cur + 0.5) {
      const k = Math.ceil((st.start - offset) / beat - 1e-9);
      return Math.max(cur, offset + Math.max(0, k) * beat);
    }
  }
  // Repli : prochain cycle de 8 mesures de la grille.
  const cycle = 8 * 4 * beat;
  const fallback = offset + Math.max(1, Math.ceil((cur + 0.5 - offset) / cycle)) * cycle;
  return Math.max(fallback, cur);
}

/** ALC-227 : début de la première strophe vocale (entrée active de B, repli 8 mesures). */
export function findFirstVocalStanzaStart(
  vocalEnvelope: Float32Array,
  durationSeconds: number,
  bpm: number,
  gridOffsetMs: number
): number {
  return findNextStanzaStartAfter(vocalEnvelope, durationSeconds, bpm, gridOffsetMs, 0);
}

export interface AutoVocalPlan {
  /** Début de la voix sur l'instrumentale — repère de déclenchement du vocal. */
  entryA: number;
  /** Début de la voix du vocal — pré-cue : B part de CETTE position. */
  entryB: number;
  /** Position de pré-cue effective du vocal B (s). */
  vocalStartSeconds: number;
  /** Position de départ de l'instrumentale (s). */
  instStartSeconds: number;
  /** Seuil inst.elapsedSeconds qui déclenche le vocal (null = vocal immédiat). */
  vocalTriggerTarget: number | null;
  /** L'instrumentale a déjà dépassé entryA → déclencher le vocal immédiatement. */
  triggerVocalImmediately: boolean;
}

/**
 * ALC-203-1 : plan de déclenchement ⚡ AUTO VOIX.
 *  - `entryA` (voix de l'instrumentale) : instant où le déclencheur arme le vocal.
 *  - `entryB` (voix du vocal) : pré-cue — on démarre B directement à sa propre entrée vocale pour
 *    que son chant soit audible IMMÉDIATEMENT dès que A franchit `entryA` (sans subir l'intro de B).
 *  - `vocalStartSeconds` = `entryB` (déjà quantifié sur le downbeat), SAUF si l'utilisateur a déjà
 *    placé le curseur de B dans une zone vocale active (> 0.18) → on respecte son choix manuel.
 *  - inst arrêtée à 00:00 (ou avant entryA) → inst démarre maintenant et le vocal part au moment
 *    exact où inst.elapsedSeconds >= entryA (`vocalTriggerTarget`).
 *  - inst a déjà dépassé entryA au clic → vocal déclenché immédiatement.
 */
export function computeAutoVocalPlan(args: {
  entryA: number;
  entryB: number;
  instNow: number;
  vocNow: number;
  userInActiveVocalZone: boolean;
}): AutoVocalPlan {
  const entryA = Math.max(0, args.entryA || 0);
  const entryB = Math.max(0, args.entryB || 0);
  const instNow = Math.max(0, args.instNow || 0);
  const vocNow = Math.max(0, args.vocNow || 0);
  const vocalStartSeconds = args.userInActiveVocalZone ? vocNow : entryB;
  if (instNow < entryA) {
    // Inst en amont (00:00 ou avant sa voix) : inst part maintenant, vocal au franchissement entryA.
    return {
      entryA,
      entryB,
      vocalStartSeconds,
      instStartSeconds: instNow,
      vocalTriggerTarget: entryA,
      triggerVocalImmediately: false,
    };
  }
  // Inst déjà passée entryA → vocal immédiat (déjà positionné sur son downbeat).
  return {
    entryA,
    entryB,
    vocalStartSeconds,
    instStartSeconds: instNow,
    vocalTriggerTarget: null,
    triggerVocalImmediately: true,
  };
}

/**
 * ALC-198-2 : enveloppe vocale effective pour les briques de phrase — pondérée par le volume du
 * stem `vocals`, et **à zéro si la voix est coupée** (`mutes.vocals`). Aucune brique vocale ne doit
 * apparaître sur un passage instrumental : ce sont les espaces libres « SILENCE / INSTRUMENTAL ».
 */
export function vocalPhraseEnvelope(
  vocalsEnv: Float32Array,
  mutes: Record<string, boolean>,
  gains: Record<string, number>
): Float32Array {
  const g = mutes.vocals ? 0 : clampStemVolume(gains.vocals ?? 1);
  const out = new Float32Array(vocalsEnv.length);
  for (let i = 0; i < vocalsEnv.length; i++) out[i] = vocalsEnv[i] * g;
  return out;
}

/** ALC-231 : plan de mashup « Profil OST / Cinéma » — repères de l'OST + du vocal, tous valides. */
export interface OstVocalMashupPlan {
  /** Début de la zone calme de l'OST (piano/cordes légères) — 1re fenêtre 8 mesures E ∈ [0.15,0.45]. */
  calmStartSeconds: number;
  /** Instant du climax orchestral (percussions épiques / cuivres) — 1re mesure E ≥ 0.75 (repli pic global). */
  climaxSeconds: number;
  /** Début du couplet du vocal (1re entrée chantée soutenue, quantifiée au downbeat). */
  vocalVerseSeconds: number;
  /** Début du refrain du vocal (1re fenêtre 8 mesures de densité vocale ≥ 0.80×pic après le couplet). */
  vocalChorusSeconds: number;
  /** Entrée du vocal sur la grille de l'OST : le refrain tombe exactement sur le climax orchestral. */
  ostEntrySeconds: number;
  /** ALC-235 : risque de dialogue/résidu vocal de l'OST (0..1) — 0 = purement instrumentale. */
  dialogueRisk: number;
}

/**
 * ALC-231 : énergie vocale RELATIVE d'une platine OST.
 * `sum(vocals) / (sum(vocals)+sum(other)+sum(drums))` — sous 5 %, la piste est quasi instrumentale
 * (bande originale) → le profil `'ost-cinema'` est suggéré automatiquement.
 */
export function computeOstVocalEnergyRatio(
  vocalsEnvelope: Float32Array,
  otherEnvelope: Float32Array,
  drumsEnvelope: Float32Array
): number {
  const sumOf = (a: Float32Array | null | undefined): number => {
    if (!a) return 0;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] || 0;
    return s;
  };
  const v = sumOf(vocalsEnvelope);
  const total = v + sumOf(otherEnvelope) + sumOf(drumsEnvelope);
  return total > 0 ? v / total : 0;
}

/** ALC-233/247 : mots-clés de genre déclenchant le profil OST / Cinéma (insensible à la casse et aux
 * accents ; « bande originale » reconnu sous forme réduite). */
export const OST_GENRE_KEYWORDS = ['ost', 'cinema', 'cinéma', 'soundtrack', 'score', 'film', 'bandeoriginale', 'bandesoriginales'] as const;

/** Normalise un genre : minuscules, sans accents (NFD + suppression des diacritiques). */
function normalizeGenre(genre: string): string {
  return genre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * ALC-233 / ALC-247-2 : le genre de la platine porteuse évoque-t-il une bande originale / un film ?
 * Détection « par mot » (tokenisation, insensible à la casse ET aux accents) afin d'éviter les faux
 * positifs (ex. « Ghost » contient « ost » mais ne doit PAS déclencher le profil OST). Ampliée au
 * champ réduit « bandeoriginale » et au mot « film ».
 */
export function genreHintsOstCinema(genre: string | null | undefined): boolean {
  if (!genre) return false;
  const norm = normalizeGenre(genre);
  const tokens = norm.split(/[^a-z0-9]+/).filter(Boolean);
  const collapsed = norm.replace(/[^a-z0-9]+/g, '');
  const kw = OST_GENRE_KEYWORDS as readonly string[];
  return tokens.some((tok) => kw.includes(tok)) || kw.includes(collapsed);
}

/** ALC-231-5 : alias API homogène — le genre d'une piste évoque-t-il une bande originale / un film ? */
export const isOstGenre: typeof genreHintsOstCinema = genreHintsOstCinema;

/**
 * Règle métier Pop vs Rock / Rock vs Pop — détection de genre « mot-clé utile » (insensible à la casse).
 * NB : `rock` doit rester déclencheur (`hard rock`, `alt rock`) — pas de tokenisation stricte ici.
 */
const isPopGenreHint = (genre: string | null | undefined): boolean => {
  const g = (genre || '').toLowerCase();
  return g.includes('pop');
};
const isRockGenreHint = (genre: string | null | undefined): boolean => {
  const g = (genre || '').toLowerCase();
  return g.includes('rock');
};

/** Spécialité de mashup décidée par le routeur unifié des trois règles métier OST/Vocal · OST/OST · Pop/Rock. */
export type MashupSpecialty = 'ost-crossover' | 'ost-vocal' | 'pop-rock' | 'standard';

export interface MashupSpecialtyResult {
  /** Spécialité décidée. */
  specialty: MashupSpecialty;
  /** Fréquence (Hz) du creux médium à appliquer sur le stem `other` de l'instrumental (0 = aucun). */
  midNotchHz: number;
}

/**
 * Routeur unifié des trois spécialités de mashup (règles métier `.clinerules/04 • 05 • 06`) :
 *  - les DEUX platines quasi-instrumentales + au moins une B.O. → `ost-crossover` (creux `1 500 Hz`) ;
 *  - une voix dominante + au moins une B.O.                     → `ost-vocal` (creux `1 800 Hz`) ;
 *  - une piste Pop + une piste Rock (les 2 sens A/B)            → `pop-rock` — creux **Guitar Pocket** :
 *    `2 200 Hz` si l'instrumental est Rock, `1 250 Hz` s'il est Pop ;
 *  - sinon                                                       → `standard` (aucun creux).
 */
export function resolveMashupSpecialty(
  a: MashupStemsMeta | null,
  b: MashupStemsMeta | null
): MashupSpecialtyResult {
  if (!a || !b) return { specialty: 'standard', midNotchHz: 0 };
  const aV = Math.max(0, Math.min(1, a.vocalActivityRatio));
  const bV = Math.max(0, Math.min(1, b.vocalActivityRatio));
  const aOst = genreHintsOstCinema(a.genre);
  const bOst = genreHintsOstCinema(b.genre);
  // ① OST × OST : aucune voix dominante + au moins une bande originale.
  if (aV < VOCAL_QUASI_NULL && bV < VOCAL_QUASI_NULL && (aOst || bOst)) {
    return { specialty: 'ost-crossover', midNotchHz: 1500 };
  }
  // ② OST × Vocal : une voix dominante + au moins une bande originale.
  const oneVocal =
    (aV >= VOCAL_SIGNIFICANT && bV < VOCAL_QUASI_NULL) ||
    (bV >= VOCAL_SIGNIFICANT && aV < VOCAL_QUASI_NULL);
  if (oneVocal && (aOst || bOst)) {
    return { specialty: 'ost-vocal', midNotchHz: 1800 };
  }
  // ③ Pop × Rock : une piste Pop, une piste Rock (les deux sens A/B).
  const aPop = isPopGenreHint(a.genre);
  const aRock = isRockGenreHint(a.genre);
  const bPop = isPopGenreHint(b.genre);
  const bRock = isRockGenreHint(b.genre);
  if ((aPop && bRock) || (aRock && bPop)) {
    // Platine instrumentale = la moins vocale ; son genre détermine la fréquence (Rock → 2 200, Pop → 1 250).
    const inst = bV < aV ? b : a;
    return { specialty: 'pop-rock', midNotchHz: isRockGenreHint(inst.genre) ? 2200 : 1250 };
  }
  return { specialty: 'standard', midNotchHz: 0 };
}

/**
 * Règle métier Medley & Alternance Thématique OST ↔ OST (`.clinerules/07-regle-medley-transitions-ost.md`).
 * Input des deux platines instrumentales — grille quantifiée en blocs de 8 mesures sur le downbeat
 * percussif (`drums.wav`, ALC-253) :
 *   - Intro (0–8 mes) : drums muté, `other` d'amorce ouvert ;
 *   - Exposition Question-Réponse : `other A` ↔ `other B` basculés à chaque frontière de 8 mesures,
 *     `drums + bass` verrouillés sur la Platine Socle ;
 *   - Breakdown Pivot (8 mes à mi-parcours) : `drums` muté sur la Socle ;
 *   - Climax Contrapuntique (tiers final) : `other A` + `other B` ouverts avec LPF 950 Hz (grave) /
 *     HPF 1050 Hz (aigu).
 */
export interface OstMedleyDeckInput {
  bpm: number;
  /** Downbeat percussif (kick) de `drums.wav` — ancre la grille. */
  firstDownbeatSeconds?: number;
  /** Énergie percussive RMS (désigne la Platine Socle). */
  drumsRms?: number;
}

export type MedleyDeckTarget = { vocals: number; drums: number; bass: number; other: number };

export interface OstMedleyPhase {
  index: number;
  label: 'intro' | 'exposure' | 'breakdown' | 'climax';
  startSeconds: number;
  endSeconds: number;
  /** Gains cibles (0 | 1) par stem pour chaque platine. */
  A: MedleyDeckTarget;
  B: MedleyDeckTarget;
  /** Platine « Socle » qui porte la pulsation drums + bass. */
  socle: 'A' | 'B';
  /** Séparation spectrale complémentaire au climax (LPF grave / HPF aigu) — sinon absente. */
  bandSplit?: { lowHz: number; highHz: number; grave: 'A' | 'B'; aigu: 'A' | 'B' };
}

export interface OstMedleyPlan {
  bpm: number;
  measureSeconds: number;
  bar8: number;
  phases: OstMedleyPhase[];
  socle: 'A' | 'B';
}

const MEDLEY_BAND_LOW = 950;
const MEDLEY_BAND_HIGH = 1050;

export function computeOstMedleyPlan(
  deckA: OstMedleyDeckInput,
  deckB: OstMedleyDeckInput,
  durationSeconds = 192,
  gridOffsetMs = 0
): OstMedleyPlan {
  const bpm = (deckA.bpm > 0 ? deckA.bpm : deckB.bpm) || 120;
  const beat = 60 / bpm;
  const measureSeconds = 4 * beat; // 1 mesure = 4 temps
  const bar8 = 8 * measureSeconds; // bloc de 8 mesures
  const dur = Math.max(bar8 * 3, Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 192);
  const fdbA = Number.isFinite(deckA.firstDownbeatSeconds) && deckA.firstDownbeatSeconds! >= 0 ? deckA.firstDownbeatSeconds! : 0;
  const fdbB = Number.isFinite(deckB.firstDownbeatSeconds) && deckB.firstDownbeatSeconds! >= 0 ? deckB.firstDownbeatSeconds! : 0;
  const offset = (gridOffsetMs || 0) / 1000;
  const anchor = Math.max(0, offset, fdbA, fdbB); // downbeat réel de drums.wav
  const socle: 'A' | 'B' = (deckB.drumsRms ?? -1) > (deckA.drumsRms ?? -1) ? 'B' : 'A';
  const totalBlocks = Math.max(3, Math.floor(dur / bar8));
  const midBlock = Math.floor(totalBlocks / 2); // breakdown pivot à mi-parcours
  const climaxStartBlock = Math.max(midBlock + 2, Math.floor((totalBlocks * 2) / 3));
  const zero: MedleyDeckTarget = { vocals: 0, drums: 0, bass: 0, other: 0 };
  const make = (
    i: number,
    label: OstMedleyPhase['label'],
    A: MedleyDeckTarget,
    B: MedleyDeckTarget,
    bandSplit?: OstMedleyPhase['bandSplit']
  ): OstMedleyPhase => ({
    index: i,
    label,
    startSeconds: anchor + i * bar8,
    endSeconds: Math.min(dur, anchor + (i + 1) * bar8),
    A,
    B,
    socle,
    bandSplit,
  });

  const phases: OstMedleyPhase[] = [];
  for (let i = 0; i < totalBlocks; i++) {
    const A: MedleyDeckTarget = { ...zero };
    const B: MedleyDeckTarget = { ...zero };
    // ① Intro minimaliste sans batterie (other d'amorce = Socle).
    if (i === 0) {
      if (socle === 'A') A.other = 1;
      else B.other = 1;
      phases.push(make(i, 'intro', A, B));
      continue;
    }
    // ② Breakdown pivot : 8 mesures sans drums/bass (changement de thème).
    if (i === midBlock) {
      if (i % 2 === 0) A.other = 1;
      else B.other = 1;
      phases.push(make(i, 'breakdown', A, B));
      continue;
    }
    // ③ Climax contrapuntique : les deux thèmes ouverts + séparation grave/aigu (LPF 950 / HPF 1050).
    if (i >= climaxStartBlock) {
      A.other = 1;
      B.other = 1;
      if (socle === 'A') {
        A.drums = 1;
        A.bass = 1;
      } else {
        B.drums = 1;
        B.bass = 1;
      }
      const grave: 'A' | 'B' = socle; // le socle rythmique porte le thème grave
      const aigu: 'A' | 'B' = socle === 'A' ? 'B' : 'A';
      phases.push(make(i, 'climax', A, B, { lowHz: MEDLEY_BAND_LOW, highHz: MEDLEY_BAND_HIGH, grave, aigu }));
      continue;
    }
    // ④ Exposition Question-Réponse : alterner other A / other B par blocs de 8 mesures sur le Socle.
    const turn: 'A' | 'B' = (i - 1) % 2 === 0 ? 'A' : 'B';
    if (socle === 'A') {
      A.drums = 1;
      A.bass = 1;
      if (turn === 'A') A.other = 1;
      else B.other = 1;
    } else {
      B.drums = 1;
      B.bass = 1;
      if (turn === 'B') B.other = 1;
      else A.other = 1;
    }
    phases.push(make(i, 'exposure', A, B));
  }
  return { bpm, measureSeconds, bar8, phases, socle };
}

/**
 * ALC-235 : plan de tempo du mashup « Profil OST / Cinéma » — PROTECTION DU TIMBRE VOCAL.
 * La platine VOCALE ne subit JAMAIS d'étirement : `vocalPlaybackRate = 1.000` (timbre pur, clé
 * intacte). C'est l'OST instrumentale qui glisse vers le BPM cible (nappes orchestrales tolérantes).
 * `targetBpm` = BPM naturel du vocal, ou l'octave la plus proche de l'OST si l'écart dépasse ±10 %.
 */
export interface OstMashupTempoPlan {
  targetBpm: number;
  /** Toujours 1.000 en profil OST — aucun resampling de la voix. */
  vocalPlaybackRate: number;
  /** Taux de lecture de l'OST (ex. 122.6/131.2 ≈ 0.9344 pour un ralentissement léger −6.5 %). */
  ostPlaybackRate: number;
  /** Vraie si la cible a été choisie sur l'octave du vocal (64 ↔ 128 BPM). */
  octaveMatched: boolean;
}

export function computeOstMashupTempo(ostBpm: number, vocalBpm: number): OstMashupTempoPlan {
  const o = Number.isFinite(ostBpm) && ostBpm > 0 ? ostBpm : 120;
  const v = Number.isFinite(vocalBpm) && vocalBpm > 0 ? vocalBpm : 120;
  let target = v;
  let octaveMatched = false;
  if (Math.abs(o - v) / v > 0.1) {
    // L'écart dépasse ±10 % → on prend l'octave du vocal la plus proche de l'OST (64 ↔ 128).
    const candidates = [v / 2, v, v * 2];
    let best = v;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      const gap = Math.abs(o - c) / Math.max(o, c);
      if (gap < bestGap) {
        bestGap = gap;
        best = c;
      }
    }
    if (best !== v) octaveMatched = true;
    target = best;
  }
  // La voix ne s'étire jamais ; l'OST instrumentale se cale sur le vocal.
  const vocalPlaybackRate = 1;
  const ostPlaybackRate = target / o;
  return { targetBpm: target, vocalPlaybackRate, ostPlaybackRate, octaveMatched };
}

/** ALC-235 : garde-fou universel du playbackRate vocal en profil OST (±3 % max). */
export function clampOstVocalPlaybackRate(rate: number): number {
  return Math.min(1.03, Math.max(0.97, Number.isFinite(rate) ? rate : 1));
}

/** ALC-235 : écart de hauteur (cents) induit par un playbackRate (12 × 100 × log2(rate)). */
export function playbackRateToCents(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return 12 * 100 * Math.log2(rate);
}

/** ALC-235 : compensation de hauteur Key Lock — `detune` (cents) à appliquer au BufferSource. */
export function keyLockCompensationCents(rate: number): number {
  const cents = playbackRateToCents(rate);
  return cents === 0 ? 0 : -cents;
}

/** ALC-235 : un key-lock est nécessaire si le pitch shift dépasse ±25 cents. */
export function needsKeyLock(rate: number): boolean {
  return Math.abs(playbackRateToCents(rate)) > 25;
}

/** ALC-237 : slice de vocal « Phrase-Synced » — l'OST ET le vocal jouent à 1.0x. */
export interface PhraseSlice {
  /** Temps réel (1.0x) sur la timeline de l'OST où la strophe doit démarrer (downbeat). */
  airSeconds: number;
  /** Position dans le FICHIER vocal à laquelle le lecteur doit se trouver à cet instant. */
  vocalFileSeconds: number;
  /** ALC-238 : fin ACOUSTIQUE de la sous-tranche (strophe d'origine ou coupe 2–4 mesures). */
  vocalEndSeconds: number;
  /** ALC-238 : tranche MUETTE — respiration orchestrale (intro/dialogue/thème solo) : voix coupée. */
  mutedWindow: boolean;
}

/** ALC-238 : fenêtre de respiration orchestrale — la voix doit rester coupée sur l'OST. */
export interface PhraseSyncedBreathingWindow {
  startSeconds: number;
  endSeconds: number;
  reason: 'intro' | 'dialogue' | 'theme';
}

/** ALC-237 / ALC-238 : plan de découpe du vocal recalé strophe par strophe sur les temps forts de l'OST 1.0x. */
export interface PhraseSyncedVocalPlan {
  /** Toujours 1 (OST jouée à son tempo naturel). */
  ostRate: number;
  /** Toujours 1 (vocal joué à son tempo naturel, timbre/clé 100 % préservés). */
  vocalRate: number;
  /** ALC-238 : dérive rythmique maximale (s) accumulée dans une tranche avant ré-ancrage. */
  maxSliceDriftSeconds: number;
  slices: PhraseSlice[];
  /** ALC-238 : Orchestral Breathing Windows (intro / dialogues résiduels / thèmes cuivres solo). */
  breathingWindows: PhraseSyncedBreathingWindow[];
}

/** ALC-238/239 : seuil du stem `vocals` de l'OST au-delà duquel la voix est coupée (dialogues parlés
 * résiduels — abaissé de 0.22 à 0.12 car les voix Demucs de film ont une amplitude crête plus faible). */
const OST_DIALOGUE_THRESHOLD = 0.12;
/** ALC-238 : ratio du pic global du stem `other` pour identifier les thèmes cuivres/percussions solo. */
const OST_THEME_RATIO = 0.88;
/** ALC-239 : creux rythmique (break cinématographique) — `drums` < 0.20 du pic après entrée du drop > 0.50. */
const OST_DRUM_BREAK_RATIO = 0.2;
const OST_DRUM_ENTRY_RATIO = 0.5;
/** ALC-247-1 : un DROP ACTIF (`drums >= 0.35 × pic`) interdit toute fenêtre THÈME OST SOLO — la
 * grosse caisse/batterie doit TOUJOURS laisser chanter le vocal. */
const OST_DRUM_ACTIVE_RATIO = 0.35;
/** ALC-247-1 : durée maximale d'une fenêtre de respiration + fusion (8 mesures = fin de break garantie). */
const OST_MAX_BREATHING_BARS = 8;
/** ALC-239 : énergie résiduelle `other` requise pendant un creux de batterie pour valider le break. */
const OST_OTHER_BREAK_RATIO = 0.3;
/** ALC-239 : fusion des fenêtres séparées de moins de 4 mesures / marge de sécurité ±1 mesure. */
const OST_BREAK_MERGE_MEASURES = 4;
const OST_BREAK_PADDING_MEASURES = 1;
/** ALC-238 : cible de dérive maximale (s) avant ré-ancrage d'une tranche. */
const SLICE_DRIFT_TARGET_SECONDS = 0.15;

/** ALC-238 : découpe d'une strophe en sous-tranches de 2 ou 4 mesures (max 4), jamais < 2. */
function chunkStanzaByMeasures(
  start: number,
  end: number,
  measureSec: number,
  stepBars: number
): { start: number; end: number }[] {
  const step = Math.min(4, Math.max(2, Math.trunc(stepBars) || 4)) * measureSec;
  const out: { start: number; end: number }[] = [];
  let s = start;
  while (end - s > 1e-6) {
    let e = Math.min(end, s + step);
    const rem = end - e;
    // Reste < 2 mesures → on recule la coupe de 2 mesures pour un dernier morceau de 2..4 mesures.
    if (rem > 1e-6 && rem < 2 * measureSec && e - s >= 4 * measureSec) {
      e -= 2 * measureSec;
    }
    out.push({ start: s, end: e });
    s = e;
  }
  return out;
}

/**
 * ALC-239 : post-traitement des fenêtres de respiration — padding de sécurité ±1 mesure (extensions
 * quantifiées sur le downbeat suivant de l'OST) et fusion des fenêtres séparées de moins de 4 mesures
 * en un bloc continu unique. L'intro orchestrale n'est ni étendue ni fusionnée (elle ne doit jamais
 * couper l'entrée du vocal).
 */
function mergeOstBreathingWindows(
  windows: PhraseSyncedBreathingWindow[],
  measureSec: number,
  beat: number,
  offset: number,
  dur: number
): PhraseSyncedBreathingWindow[] {
  const quantizeUp = (t: number): number => {
    if (!Number.isFinite(t)) return Math.max(0, offset);
    const k = Math.ceil((t - offset) / beat - 1e-9);
    return Math.max(0, offset + Math.max(0, k) * beat);
  };
  const intro = windows.filter((w) => w.reason === 'intro');
  const rest = windows
    .filter((w) => w.reason !== 'intro')
    .map((w) => ({
      startSeconds: Math.max(0, w.startSeconds - OST_BREAK_PADDING_MEASURES * measureSec),
      endSeconds: Math.min(dur, quantizeUp(w.endSeconds + OST_BREAK_PADDING_MEASURES * measureSec)),
      reason: w.reason,
    }))
    .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
  const merged: PhraseSyncedBreathingWindow[] = [];
  for (const w of rest) {
    const last = merged[merged.length - 1];
    if (last && w.startSeconds - last.endSeconds < OST_BREAK_MERGE_MEASURES * measureSec) {
      last.endSeconds = Math.max(last.endSeconds, w.endSeconds);
      if (w.reason === 'theme' || last.reason === 'theme') last.reason = 'theme';
    } else {
      merged.push({ ...w });
    }
  }
  return [...intro, ...merged].sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

/** ALC-238 : Orchestral Breathing Windows — là où la voix du mashup doit s'effacer sur l'OST. */
function detectOstBreathingWindows(args: {
  ostBpm: number;
  baseEntrySeconds: number;
  gridOffsetMs: number;
  ostVocals?: Float32Array;
  ostOther?: Float32Array;
  ostDrums?: Float32Array;
  ostDurationSeconds?: number;
  chorusEndSeconds?: number;
}): PhraseSyncedBreathingWindow[] {
  const out: PhraseSyncedBreathingWindow[] = [];
  const base = Math.max(0, args.baseEntrySeconds || 0);
  const odur = Number.isFinite(args.ostDurationSeconds) && (args.ostDurationSeconds || 0) > 0 ? args.ostDurationSeconds! : null;
  const beat = 60 / (args.ostBpm > 0 ? args.ostBpm : 120);
  const measureSec = 4 * beat;
  const offset = (args.gridOffsetMs || 0) / 1000;

  // ① Intro orchestrale avant l'entrée du vocal.
  if (base > 0.02) out.push({ startSeconds: 0, endSeconds: base, reason: 'intro' });

  // ② Dialogues / voix résiduelle de l'OST : stem vocals > 0.12 (abaissé ALC-239, ≥ 0.5 s, après
  //    l'entrée du vocal — les dialogues parlés Demucs ont une amplitude crête plus faible).
  if (odur != null && args.ostVocals && args.ostVocals.length >= 2) {
    const bins = args.ostVocals.length;
    const binSec = odur / bins;
    let s = -1;
    for (let i = 0; i <= bins; i++) {
      const on = i < bins && args.ostVocals[i] > OST_DIALOGUE_THRESHOLD;
      if (on && s < 0) s = i;
      else if (!on && s >= 0) {
        const ws = s * binSec;
        const we = i * binSec;
        if (we - ws >= 0.5 && ws >= base) out.push({ startSeconds: ws, endSeconds: we, reason: 'dialogue' });
        s = -1;
      }
    }
    if (s >= 0) {
      const ws = s * binSec;
      const we = bins * binSec;
      if (we - ws >= 0.5 && ws >= base) out.push({ startSeconds: ws, endSeconds: we, reason: 'dialogue' });
    }
  }

  // ③ Thèmes cuivres/percussions solo : fenêtres de 4 mesures après le refrain vocal où l'énergie
  //    moyenne du stem `other` dépasse 0.88 × pic global — la nappe orchestrale respire seule.
  if (odur != null && args.ostOther && args.ostOther.length >= 4) {
    const bins = args.ostOther.length;
    const binSec = odur / bins;
    let peak = 0;
    for (let i = 0; i < bins; i++) {
      const v = args.ostOther[i] || 0;
      if (v > peak) peak = v;
    }
    const thr = peak * OST_THEME_RATIO;
    const chorusEnd = Number.isFinite(args.chorusEndSeconds) && (args.chorusEndSeconds || 0) > 0 ? args.chorusEndSeconds! : 0;
    const themeWin = 4 * measureSec; // fenêtre de 4 mesures
    const startAt = Math.max(base, chorusEnd);
    if (odur > startAt + 1e-6) {
      const nWin = Math.max(0, Math.floor((odur - startAt) / themeWin));
      for (let wnd = 0; wnd < nWin; wnd++) {
        const ws = startAt + wnd * themeWin;
        const we = Math.min(odur, ws + themeWin);
        const i0 = Math.max(0, Math.floor((ws / odur) * bins));
        const i1 = Math.min(bins, Math.max(i0 + 1, Math.ceil((we / odur) * bins)));
        let sum = 0;
        for (let i = i0; i < i1; i++) sum += args.ostOther[i] || 0;
        const mean = i1 - i0 > 0 ? sum / (i1 - i0) : 0;
        if (mean > thr) out.push({ startSeconds: ws, endSeconds: we, reason: 'theme' });
      }
    }
  }

  // ④ Breaks cinématographiques (ALC-239) : creux de batterie APRÈS l'entrée du 1er drop — fenêtres
  //    où `drums` chute sous 0.20 de son pic alors que `other` ou `vocals` reste actif (signature d'un
  //    break orchestral ou d'un dialogue de film).
  if (odur != null && args.ostDrums && args.ostDrums.length >= 4) {
    const bins = args.ostDrums.length;
    const binSec = odur / bins;
    let drumPeak = 0;
    for (let i = 0; i < bins; i++) {
      const v = args.ostDrums[i] || 0;
      if (v > drumPeak) drumPeak = v;
    }
    let otherPeak = 0;
    for (let i = 0; args.ostOther && i < args.ostOther.length; i++) {
      const v = args.ostOther[i] || 0;
      if (v > otherPeak) otherPeak = v;
    }
    if (drumPeak > 0) {
      // entrée du premier drop : premier run soutenu de 2 bins au-dessus de 0.50 × pic drums.
      let dropEntry = -1;
      let run = 0;
      for (let i = 0; i <= bins && dropEntry < 0; i++) {
        run = i < bins && (args.ostDrums[i] || 0) > OST_DRUM_ENTRY_RATIO * drumPeak ? run + 1 : 0;
        if (run >= 2) dropEntry = i - run + 1;
      }
      if (dropEntry >= 0) {
        let s = -1;
        for (let i = dropEntry; i <= bins; i++) {
          const low = i < bins && (args.ostDrums[i] || 0) < OST_DRUM_BREAK_RATIO * drumPeak;
          const activeOther = args.ostOther ? (args.ostOther[i] || 0) > OST_OTHER_BREAK_RATIO * otherPeak : false;
          const activeVoc = args.ostVocals ? (args.ostVocals[i] || 0) > OST_DIALOGUE_THRESHOLD : false;
          const inBreak = low && (activeOther || activeVoc);
          if (inBreak && s < 0) s = i;
          else if (!inBreak && s >= 0) {
            const ws = s * binSec;
            const we = i * binSec;
            if (we - ws >= measureSec) out.push({ startSeconds: ws, endSeconds: we, reason: 'theme' });
            s = -1;
          }
        }
        if (s >= 0) {
          const ws = s * binSec;
          const we = bins * binSec;
          if (we - ws >= measureSec) out.push({ startSeconds: ws, endSeconds: we, reason: 'theme' });
        }
      }
    }
  }

  // ALC-239 : padding ±1 mesure (quantifié au downbeat suivant) + fusion des fenêtres < 4 mesures.
  return mergeOstBreathingWindows(out, measureSec, beat, offset, odur ?? Number.MAX_SAFE_INTEGER);
}

/**
 * ALC-237 / ALC-238 : Phrase-Synced Vocal Slicing — remplace l'ancien « ralentissement de l'OST ».
 * L'OST reste à 1.0x (ex. 131.2 BPM) et le vocal à 1.0x (ex. 122.6 BPM) : la dérive rythmique est
 * absorbée en découpant le vocal en sous-tranches fines (2–4 mesures, `maxSliceBars`) recalentées
 * sur les downbeats de l'OST. ALC-238 : seuil de respiration 0.22 s, découpe ≤ 4 mesures (dérive
 * < 150 ms cible, palier 2 mesures sinon), `vocalEndSeconds`, `mutedWindow` et Orchestral
 * Breathing Windows (intro / dialogues résiduels / thèmes solo) — aucun pitch-shift.
 */
export function computePhraseSyncedVocalPlan(args: {
  ostBpm: number;
  vocalBpm: number;
  stanzas: VocalStanza[];
  baseEntrySeconds: number;
  gridOffsetMs?: number;
  durationSeconds: number;
  maxSliceBars?: number;
  minPauseSeconds?: number;
  ostVocals?: Float32Array;
  ostOther?: Float32Array;
  ostDrums?: Float32Array;
  ostDurationSeconds?: number;
  chorusEndSeconds?: number;
}): PhraseSyncedVocalPlan {
  const ostBpm = args.ostBpm > 0 ? args.ostBpm : 120;
  const vBpm = args.vocalBpm > 0 ? args.vocalBpm : ostBpm;
  const beat = 60 / ostBpm;
  const measureSec = 4 * beat; // 1 mesure = 4 temps
  const offset = (args.gridOffsetMs || 0) / 1000;
  const quantizeDownbeat = (t: number): number => {
    if (!Number.isFinite(t)) return Math.max(0, offset);
    const k = Math.round((t - offset) / beat);
    return Math.max(0, offset + k * beat);
  };
  const stanzas = (args.stanzas || []).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start < s.end);
  const dur = args.durationSeconds > 0 ? args.durationSeconds : Number.MAX_SAFE_INTEGER;
  void args.minPauseSeconds; // documentation — extractVocalStanzas applique déjà le seuil 0.22 s

  // Cantonne la dérive : 4 mesures si l'écart tient sous 150 ms, sinon palier bas de 2 mesures.
  const driftPerSec = Math.abs(ostBpm - vBpm) / vBpm;
  const relGap = Math.abs(ostBpm - vBpm) / ostBpm;
  const requested = Math.min(8, Math.max(2, Math.trunc(args.maxSliceBars || 4) || 4));
  // ALC-244-3 : dérive > 2 % → tranches maximales de 2 mesures (élimine le glissement rythmique
  // résiduel sur les phrases longues jouées à 1.0x).
  const maxSliceBars = relGap > 0.02 ? Math.min(requested, 2) : requested;
  const fourMeasDrift = 4 * measureSec * driftPerSec;
  const stepBars = fourMeasDrift > SLICE_DRIFT_TARGET_SECONDS ? Math.min(2, maxSliceBars) : maxSliceBars;

  // Subdivise chaque strophe en sous-tranches de 2–4 mesures (jamais plus de maxSliceBars).
  const raw: { start: number; end: number }[] = [];
  for (const st of stanzas) raw.push(...chunkStanzaByMeasures(st.start, st.end, measureSec, stepBars));

  const windows = detectOstBreathingWindows({
    ostBpm,
    baseEntrySeconds: Math.max(0, args.baseEntrySeconds || 0),
    gridOffsetMs: args.gridOffsetMs || 0,
    ostVocals: args.ostVocals,
    ostOther: args.ostOther,
    ostDrums: args.ostDrums,
    ostDurationSeconds: args.ostDurationSeconds,
    chorusEndSeconds: args.chorusEndSeconds,
  });

  const slices: PhraseSlice[] = [];
  let pending = quantizeDownbeat(Math.max(0, args.baseEntrySeconds || 0));
  let maxDrift = 0;
  // ALC-245-1 : curseur fichier des tranches vocales — STRICTEMENT CROISSANT (jamais de répétition
  // de phrase de 2 mesures en boucle / stutter). Dès que tout le contenu chanté est parcouru, le
  // plan s'arrête et l'OST termine en solo instrumental (aucun recyclage des phrases précédentes).
  let lastVocalCursor = -1.0;
  let lastVocalEndSeconds = stanzas.length > 0 ? stanzas[stanzas.length - 1].end : -1.0;
  for (const rs of raw) {
    const len = Math.max(0, rs.end - rs.start);
    if (len <= 1e-6) continue;
    // Anti-stutter : on avance toujours, jamais en arrière (même défensivement sur une découpe).
    const fileStart = Math.max(rs.start, lastVocalCursor);
    const fileEnd = Math.max(rs.end, fileStart);
    if (fileEnd <= fileStart) continue;
    if (lastVocalEndSeconds > 0 && fileStart >= lastVocalEndSeconds) continue; // fin du chant → OST solo
    lastVocalCursor = fileEnd;
    const air = quantizeDownbeat(pending);
    const airEnd = Math.min(dur, air) + Math.max(0, fileEnd - fileStart);
    maxDrift = Math.max(maxDrift, (fileEnd - fileStart) * driftPerSec);
    const muted = windows.some((w) => air < w.endSeconds && airEnd > w.startSeconds);
    slices.push({
      airSeconds: air,
      vocalFileSeconds: fileStart,
      vocalEndSeconds: fileEnd,
      mutedWindow: muted,
    });
    pending = quantizeDownbeat(air + Math.max(0, fileEnd - fileStart));
  }
  return { ostRate: 1, vocalRate: 1, maxSliceDriftSeconds: maxDrift, slices, breathingWindows: windows };
}

/**
 * ALC-242 : suggestion automatique du profil OST — le genre de la porteuse l'évoque OU son ratio
 * d'énergie vocale est < 5 % (piste quasi purement instrumentale). Le DJ peut forcer manuellement.
 */
export function shouldSuggestOstCinema(carrierGenre: string | null | undefined, carrierVocalEnergyRatio: number): boolean {
  if (genreHintsOstCinema(carrierGenre)) return true;
  return Number.isFinite(carrierVocalEnergyRatio) && carrierVocalEnergyRatio < 0.05;
}

// ── ALC-246 : MASHUP OST CONTINU (Beatmatch verrouillé, zéro découpage haché) ──────────────

/** ALC-246-2 : macro-fenêtre de respiration de l'OST (≥ 8 mesures) — la voix s'efface en douceur. */
export interface ContinuousBreathingWindow {
  startSeconds: number;
  endSeconds: number;
  label: string;
}

/** ALC-246-2 : plan continu (standard DJ) — les deux platines tournent au MÊME BPM effectif,
 * la hauteur est préservée par `preservesPitch` natif ; aucun slice/re-seek. */
export interface ContinuousOstMashupPlan {
  targetBpm: number;
  ostPlaybackRate: number;
  vocalPlaybackRate: number;
  ostEntrySeconds: number;
  vocalStartSeconds: number;
  /** ALC-248-3 : ponts instrumentaux du vocal (vide ≥ 8 mesures) à sauter — le vocal avance au
   * downbeat (4 mesures) du couplet/refrain suivant au lieu de rester muet pendant le pont. */
  vocalBridgeSkips: { triggerOstSeconds: number; jumpToVocalSeconds: number }[];
  breathingWindows: ContinuousBreathingWindow[];
  /** Clause 7 — refrains/climax (blocs complets 8/16 mesures) où `drums+bass` de la platine vocale
   * s'ouvrent avec passe-haut 140 Hz sur l'OST — présent uniquement si le relais hybride est activé
   * (ost.drumsRms bas + voc.drumsRms élevé). */
  hybridGrooveWindows?: { startSeconds: number; endSeconds: number }[];
  /** Clause 10 — début de l'outro symphonique nue (4/8 dernières mesures, alignées sur la grille OST). */
  bareOutroStartSeconds?: number;
}

function detectContinuousBreathingWindows(args: {
  ostBpm: number;
  gridOffsetMs: number;
  ostEntrySeconds: number;
  ostDurationSeconds?: number;
  ostVocals?: Float32Array;
  ostOther?: Float32Array;
  ostDrums?: Float32Array;
  chorusEndSeconds?: number;
}): ContinuousBreathingWindow[] {
  const beat = 60 / (args.ostBpm > 0 ? args.ostBpm : 120);
  const measureSec = 4 * beat;
  const offset = (args.gridOffsetMs || 0) / 1000;
  const quantUp = (t: number): number => {
    if (!Number.isFinite(t)) return Math.max(0, offset);
    const k = Math.ceil((t - offset) / beat - 1e-9);
    return Math.max(0, offset + Math.max(0, k) * beat);
  };
  const base = Math.max(0, args.ostEntrySeconds || 0);
  const odur =
    Number.isFinite(args.ostDurationSeconds) && (args.ostDurationSeconds || 0) > 0 ? args.ostDurationSeconds! : null;
  type Raw = { s: number; e: number; label: string };
  let raw: Raw[] = [];
  // ① Intro orchestrale avant l'entrée du vocal.
  if (base > 0.02) raw.push({ s: 0, e: base, label: 'INTRO' });
  // ② Dialogues parlés résiduels (stem vocals > 0.12, ≥ 0.5 s, après l'entrée).
  if (odur != null && args.ostVocals && args.ostVocals.length >= 2) {
    const bins = args.ostVocals.length;
    const binSec = odur / bins;
    let s = -1;
    for (let i = 0; i <= bins; i++) {
      const on = i < bins && args.ostVocals[i] > OST_DIALOGUE_THRESHOLD;
      if (on && s < 0) s = i;
      else if (!on && s >= 0) {
        if ((i - s) * binSec >= 0.5 && s * binSec >= base) raw.push({ s: s * binSec, e: i * binSec, label: 'DIALOGUE' });
        s = -1;
      }
    }
  }
  // ③ Breaks cinématographiques : creux de batterie après l'entrée du 1er drop (drums < 0.20 × pic).
  if (odur != null && args.ostDrums && args.ostDrums.length >= 4) {
    const bins = args.ostDrums.length;
    const binSec = odur / bins;
    let drumPeak = 0;
    for (let i = 0; i < bins; i++) {
      const v = args.ostDrums[i] || 0;
      if (v > drumPeak) drumPeak = v;
    }
    let otherPeak = 0;
    for (let i = 0; args.ostOther && i < args.ostOther.length; i++) {
      const v = args.ostOther[i] || 0;
      if (v > otherPeak) otherPeak = v;
    }
    if (drumPeak > 0) {
      let dropEntry = -1;
      let run = 0;
      for (let i = 0; i <= bins && dropEntry < 0; i++) {
        run = i < bins && (args.ostDrums[i] || 0) > OST_DRUM_ENTRY_RATIO * drumPeak ? run + 1 : 0;
        if (run >= 2) dropEntry = i - run + 1;
      }
      if (dropEntry >= 0) {
        let s = -1;
        for (let i = dropEntry; i <= bins; i++) {
          const low = i < bins && (args.ostDrums[i] || 0) < OST_DRUM_BREAK_RATIO * drumPeak;
          // ALC-247-1 : un DROP ACTIF (drums ≥ 0.35 × pic) interdit un THÈME OST SOLO — la
          // grosse caisse/batterie doit toujours laisser chanter le vocal (pas de muting pendant le beat).
          const drumsActive = i < bins && (args.ostDrums[i] || 0) >= OST_DRUM_ACTIVE_RATIO * drumPeak;
          const activeOther = args.ostOther ? (args.ostOther[i] || 0) > OST_OTHER_BREAK_RATIO * otherPeak : false;
          const activeVoc = args.ostVocals ? (args.ostVocals[i] || 0) > OST_DIALOGUE_THRESHOLD : false;
          const inBreak = !drumsActive && low && (activeOther || activeVoc);
          if (inBreak && s < 0) s = i;
          else if (!inBreak && s >= 0) {
            if ((i - s) * binSec >= OST_BREAK_MERGE_MEASURES * measureSec) raw.push({ s: s * binSec, e: i * binSec, label: 'THÈME OST SOLO' });
            s = -1;
          }
        }
      }
    }
  }
  if (!raw.length) return [];
  // Marge ±1 mesure + fusion des fenêtres proches, puis minimum 8 mesures (fenêtre macro).
  raw = raw
    .map((w) => ({
      ...w,
      s: Math.max(0, w.s - measureSec),
      e: Math.min(odur ?? Number.MAX_SAFE_INTEGER, quantUp(w.e + measureSec)),
    }))
    .sort((a, b) => a.s - b.s);
  const merged: Raw[] = [];
  const maxBreath = OST_MAX_BREATHING_BARS * measureSec; // ALC-247-1 : 8 mesures max après fusion
  for (const w of raw) {
    const last = merged[merged.length - 1];
    if (last && w.s - last.e < OST_BREAK_MERGE_MEASURES * measureSec) {
      const candidateEnd = Math.max(last.e, w.e);
      // ALC-247-1 : ne fusionne QUE si le résultat reste ≤ 8 mesures — sinon nouvelle fenêtre.
      if (candidateEnd - last.s <= maxBreath + 1e-6) {
        last.e = candidateEnd;
        last.label = last.label === 'THÈME OST SOLO' || w.label === 'THÈME OST SOLO' ? 'THÈME OST SOLO' : 'DIALOGUE';
      } else {
        merged.push({ ...w });
      }
    } else {
      merged.push({ ...w });
    }
  }
  const minMacro = 8 * measureSec; // ≥ 8 mesures : macro-fenêtre (pas de hachage 2/4 mesures)
  return merged
    .filter((w) => w.e - w.s >= minMacro)
    .map((w) => ({
      startSeconds: w.s,
      endSeconds: Math.min(w.e, w.s + maxBreath), // plafond 8 mesures (fin de break garantie)
      label: w.label, // INTRO / DIALOGUE / THÈME OST SOLO préservés (jamais transformés)
    }));
}

/**
 * ALC-246-2 : plan de mashup OST CONTINU (standard DJ studio) — targetBpm aligné (octave
 * [0.75..1.35], deckA.effectiveBpm === deckB.effectiveBpm de bout en bout), ostEntrySeconds après
 * l'intro orchestrale (downbeat de 4 mesures), vocalStartSeconds premier mot chanté (downbeat) et
 * `breathingWindows` macro (≥ 8 mesures). AUCUNE découpe/re-seek — le gain seul est fondu 180 ms.
 */
export function computeContinuousOstMashupPlan(args: {
  ostBpm: number;
  vocalBpm: number;
  gridOffsetMs?: number;
  ostEntryHintSeconds?: number;
  vocalStartHintSeconds?: number;
  ostDurationSeconds?: number;
  vocalDurationSeconds?: number;
  /** Clause 7 — énergie percussive RMS des platines (déclencheur du relais rythmique hybride). */
  ostDrumsRms?: number;
  vocalDrumsRms?: number;
  ostVocals?: Float32Array;
  ostOther?: Float32Array;
  ostDrums?: Float32Array;
  vocals?: Float32Array;
  /** ALC-253-1/2 : downbeats percussifs (kick) des stems drums de A et B — ancrent le calage de phase. */
  ostFirstDownbeatSeconds?: number;
  vocalFirstDownbeatSeconds?: number;
  chorusEndSeconds?: number;
}): ContinuousOstMashupPlan {
  // Règle métier OST+Vocal (.clinerules/04-regle-mashup-ost-vocal.md) — invariants verrouillés ici :
  //  1) Beatmatch continu : octave [0.75..1.35] (1:1 / 2:1 / 1:2), ostPlaybackRate = 1, zéro re-seek
  //     en cours de phrase (ALC-246) — la dérive est absorbée par les breathingWindows + gain seul.
  //  2) Temps 1 réel : grilles ANCRÉES sur fdbA/fdbB (kick drums.wav), intro orchestrale ≤ 8 mesures.
  //  3) THÈME OST SOLO (lyrique `ostStems.vocals` ∪ cuivres `ostStems.other`) & vocalBridgeSkips :
  //     fenêtres macro ≥ 8 mesures (frontière 8/16) quantifiées aux downbeats, fondu 40–60 ms,
  //     vocalBridgeSkips STRICTEMENT croissants (jamais de retour en arrière / répétition de phrase).
  const ostBpm = args.ostBpm > 0 ? args.ostBpm : 120;
  const vocBpm = args.vocalBpm > 0 ? args.vocalBpm : ostBpm;
  // Beatmatch continu : l'OST reste à son tempo naturel, le vocal est plié à l'octave la plus proche
  // (ratio = target/voix ∈ [0.75..1.35]) ; la hauteur est préservée par `preservesPitch` natif.
  let r = ostBpm / vocBpm;
  while (r >= 2) r /= 2;
  while (r < 0.5) r *= 2;
  r = Math.min(1.35, Math.max(0.75, r));
  const targetBpm = Number(ostBpm.toFixed(1));
  const vocalPlaybackRate = Number(r.toFixed(4));
  const beat = 60 / ostBpm;
  const bar4 = 16 * beat; // 4 mesures = 16 temps
  const offset = (args.gridOffsetMs || 0) / 1000;
  const hint = Number.isFinite(args.ostEntryHintSeconds) ? args.ostEntryHintSeconds! : 0;
  // ALC-253-2 : les grilles sont ANCRÉES sur les downbeats percussifs (kick) des stems drums de A
  // et de B (firstDownbeatSeconds) — plus jamais sur 0.0 s. Un chanteur qui attaque en anacrouse
  // (levée avant le temps 1) tombe PILE dans le groove, jamais à contre-temps.
  const fdbA = Math.max(0, Number.isFinite(args.ostFirstDownbeatSeconds) ? args.ostFirstDownbeatSeconds! : 0);
  const fdbB = Math.max(0, Number.isFinite(args.vocalFirstDownbeatSeconds) ? args.vocalFirstDownbeatSeconds! : 0);
  // Entrée OST plafonnée à 8 mesures après le downbeat de A (~14 s à 120 BPM) : le vocal entre dès
  // le premier drop rythmique au lieu d'attendre la minute (ex-M33).
  const qBars = Math.max(0, Math.min(8, Math.round((Math.max(fdbA, hint) - fdbA) / bar4)));
  const ostEntrySeconds = fdbA + qBars * bar4;
  // Vocal calé RELATIVEMENT à son downbeat B, mappé sur la grille 4 mesures de A :
  // (vocalStart − fdbB)·vocalPlaybackRate ∈ ℕ×bar4A → la phrase arrive pile sur le temps 1 du bloc.
  const vsHint = Number.isFinite(args.vocalStartHintSeconds) ? args.vocalStartHintSeconds! : 0;
  const qVoc = Math.max(0, Math.round(((vsHint - fdbB) * vocalPlaybackRate) / bar4));
  const vocalStartSeconds = fdbB + (qVoc * bar4) / vocalPlaybackRate;
  // Clause 7 — Relais rythmique hybride : OST basse énergie percussive + platine vocale avec groove marqué.
  const measureSec = 4 * beat;
  const ba8 = 8 * measureSec; // bloc de 8 mesures
  const ostLowDrums = Number.isFinite(args.ostDrumsRms) && (args.ostDrumsRms ?? 0) < 0.25;
  const vocGroove = Number.isFinite(args.vocalDrumsRms) && (args.vocalDrumsRms ?? 0) >= 0.4;
  let hybridGrooveWindows: { startSeconds: number; endSeconds: number }[] | undefined;
  if (ostLowDrums && vocGroove) {
    const oDurHy =
      Number.isFinite(args.ostDurationSeconds) && (args.ostDurationSeconds || 0) > 0 ? args.ostDurationSeconds! : null;
    // Refrains/climax : du 1er bloc de 8 mesures suivant l'entrée vocale jusqu'à la fin (ou 2 blocs par défaut).
    const hyStart0 = fdbA + Math.ceil((vocalStartSeconds + ba8 - fdbA - 1e-6) / ba8) * ba8;
    const nHy = oDurHy != null ? Math.max(1, Math.floor((oDurHy - hyStart0) / ba8)) : 2;
    hybridGrooveWindows = [];
    for (let k = 0; k < nHy; k++) {
      const s = hyStart0 + k * ba8;
      const e = Math.min(oDurHy ?? Number.MAX_SAFE_INTEGER, s + ba8);
      if (e > s) hybridGrooveWindows.push({ startSeconds: s, endSeconds: e });
    }
  }
  // Clause 10 — Outro symphonique nue : 8 dernières mesures (4 si l'OST est courte), alignées sur la grille.
  let bareOutroStartSeconds: number | undefined;
  if (Number.isFinite(args.ostDurationSeconds) && (args.ostDurationSeconds || 0) > 0) {
    const oDurOut = args.ostDurationSeconds!;
    const outroBars = oDurOut - fdbA <= 16 * measureSec ? 4 : 8;
    const rawOut = oDurOut - outroBars * measureSec;
    const kOut = Math.max(0, Math.floor((rawOut - fdbA) / bar4 + 1e-9));
    bareOutroStartSeconds = fdbA + kOut * bar4;
    if (bareOutroStartSeconds < vocalStartSeconds + bar4) bareOutroStartSeconds = vocalStartSeconds + bar4;
    if (bareOutroStartSeconds >= oDurOut - 1e-6) bareOutroStartSeconds = Math.max(vocalStartSeconds, oDurOut - 8 * measureSec);
  }
  const breathingWindows = detectContinuousBreathingWindows({
    ostBpm,
    gridOffsetMs: args.gridOffsetMs || 0,
    ostEntrySeconds,
    ostDurationSeconds: args.ostDurationSeconds,
    ostVocals: args.ostVocals,
    ostOther: args.ostOther,
    ostDrums: args.ostDrums,
    chorusEndSeconds: args.chorusEndSeconds,
  });
  // ALC-248-3 : sauts de ponts instrumentaux du vocal (vide ≥ 8 mesures après le début du chant),
  // quantifiés aux downbeats (4 mesures OST pour le déclencheur, 4 mesures vocaux pour le sauté).
  const vocalBridgeSkips: { triggerOstSeconds: number; jumpToVocalSeconds: number }[] = [];
  if (args.vocals && args.vocals.length >= 3 && args.vocalDurationSeconds && args.vocalDurationSeconds > 0) {
    const vBeat = 60 / vocBpm;
    const vMeasure = 4 * vBeat;
    const vOffset = (args.gridOffsetMs || 0) / 1000;
    const vBar4 = 16 * vBeat; // 4 mesures vocaux = 16 temps
    const vSt = extractVocalStanzas(args.vocals, args.vocalDurationSeconds, vocBpm, args.gridOffsetMs || 0);
    for (let i = 0; i + 1 < vSt.length; i++) {
      const gap = vSt[i + 1].start - vSt[i].end;
      if (gap >= 8 * vMeasure) {
        // Début du pont en temps vocal → instant OST (lecture à vocalPlaybackRate), quantifié à 4 mesures.
        const rawTrigger = ostEntrySeconds + (vSt[i].end - vocalStartSeconds) / vocalPlaybackRate;
        const kT = Math.ceil((rawTrigger - offset) / bar4 - 1e-9);
        const triggerOstSeconds = Math.max(0, offset + Math.max(0, kT) * bar4);
        const kT2 = Math.ceil((vSt[i + 1].start - vOffset) / vBar4 - 1e-9);
        const jumpToVocalSeconds = Math.max(0, vOffset + Math.max(0, kT2) * vBar4);
        vocalBridgeSkips.push({ triggerOstSeconds, jumpToVocalSeconds });
      }
    }
  }
  // ALC-253-2 : interdiction de tout vocalBridgeSkips qui reculerait ou répéterait une phrase déjà
  // chantée (curseur de saut STRICTEMENT croissant — zéro boucle, zéro retour en arrière).
  let lastJump = vocalStartSeconds - 1e-6;
  let lastTrig = -1e-6;
  const safeSkips = vocalBridgeSkips.filter((s) => {
    if (s.triggerOstSeconds < lastTrig || s.jumpToVocalSeconds <= lastJump) return false;
    lastTrig = s.triggerOstSeconds;
    lastJump = s.jumpToVocalSeconds;
    return true;
  });
  return {
    targetBpm,
    ostPlaybackRate: 1,
    vocalPlaybackRate,
    ostEntrySeconds,
    vocalStartSeconds,
    vocalBridgeSkips: safeSkips,
    breathingWindows,
    hybridGrooveWindows,
    bareOutroStartSeconds,
  };
}

// ── ALC-242 : choix intelligent de la recette Mashup (télémétrie HTDemucs) ────────────────

/** ALC-242 : télémétrie d'une platine exploitée par `recommendMashupRecipe`. */
export interface MashupStemsMeta {
  /** Proportion de trames vocales actives (0..1) — ≥ 0.25 = chant significatif. */
  vocalActivityRatio: number;
  /** Encombrement spectral du stem `other` dans 1–3 kHz (0..1) — élevé = mediums denses. */
  midCongestionScore: number;
  /** Genre de la platine porteuse (détection OST éventuelle). */
  genre?: string | null;
  /** Clé Camelot recalibrée stems (facultatif, informatif). */
  camelotKey?: string | null;
  /** BPM recalibré drums (facultatif, informatif). */
  bpm?: number | null;
  /** Énergie percussive RMS du stem `drums` (0..1) — désigne la Platine Rythmique d'un crossover. */
  drumsRms?: number;
}

/** ALC-242 : recette Mashup recommandée + profil. */
export interface MashupRecipeRecommendation {
  mode: 'instA_vocB' | 'vocA_instB' | 'crossover';
  profile: 'standard' | 'ost-cinema';
  reason: string;
  /** Crossover OST × OST : désignation Platine Rythmique (drums+bass+other) / Platine Thème (other seul). */
  crossover?: { rhythm: 'A' | 'B'; theme: 'A' | 'B' };
}

const VOCAL_SIGNIFICANT = 0.25;
const VOCAL_QUASI_NULL = 0.12;

/**
 * ALC-242 : recommande la recette `INST A + VOIX B` / `VOIX A + INST B` à partir de la télémétrie
 * HTDemucs des deux platines :
 *  - si une seule platine possède un chant significatif (`≥ 0.25` vs `< 0.12`) → recette orientée ;
 *  - sinon (deux voix, ou deux quasi-instrumentaux) → meilleur contraste
 *    `vocal_activity_ratio − 0.4 × mid_congestion_score` (voix la plus présente + instrumental au
 *    plus faible encombrement médium 1–3 kHz) ;
 *  - bascule automatique sur le profil `'ost-cinema'` si l'une des pistes est de genre OST.
 */
export function recommendMashupRecipe(
  a: MashupStemsMeta | null,
  b: MashupStemsMeta | null
): MashupRecipeRecommendation | null {
  if (!a || !b) return null;
  const aV = Math.max(0, Math.min(1, a.vocalActivityRatio));
  const bV = Math.max(0, Math.min(1, b.vocalActivityRatio));
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  // Règle métier Crossover OST × OST : aucune voix dominante SUR LES DEUX platines ET au moins une
  // bande originale → routage complémentaire des stems (Platine Rythmique = drums+bass+other,
  // Platine Thème = other seul) + creux EQ −3 dB @ 1.5 kHz sur le other de la Platine Rythmique.
  if (
    aV < VOCAL_QUASI_NULL &&
    bV < VOCAL_QUASI_NULL &&
    (genreHintsOstCinema(a.genre) || genreHintsOstCinema(b.genre))
  ) {
    const aDr = Number.isFinite(a.drumsRms) ? a.drumsRms! : -1;
    const bDr = Number.isFinite(b.drumsRms) ? b.drumsRms! : -1;
    const rhythm: 'A' | 'B' = bDr > aDr ? 'B' : 'A';
    const theme: 'A' | 'B' = rhythm === 'A' ? 'B' : 'A';
    return {
      mode: 'crossover',
      profile: 'ost-cinema',
      crossover: { rhythm, theme },
      reason:
        `CROSSOVER OST × OST — aucune voix dominante (A ${pct(aV)} · B ${pct(bV)}) + bande originale : ` +
        `Platine ${rhythm} = Rythmique (drums + bass + other), Platine ${theme} = Thème (other seul) ; ` +
        `creux EQ -3 dB @ 1.5 kHz (Q=1.0) sur le other de la Platine ${rhythm}.`,
    };
  }
  let mode: 'instA_vocB' | 'vocA_instB';
  let reason: string;
  if (aV >= VOCAL_SIGNIFICANT && bV < VOCAL_QUASI_NULL) {
    mode = 'vocA_instB';
    reason = `Chant significatif sur A (${pct(aV)}) vs B quasi instrumental (${pct(bV)}) — recommandé : VOIX A + INST B`;
  } else if (bV >= VOCAL_SIGNIFICANT && aV < VOCAL_QUASI_NULL) {
    mode = 'instA_vocB';
    reason = `Chant significatif sur B (${pct(bV)}) vs A quasi instrumental (${pct(aV)}) — recommandé : INST A + VOIX B`;
  } else {
    // Les deux platines chantent (ou les deux sont quasi-instrumentales) → contraste optimal.
    const scoreInstA = aV - 0.4 * a.midCongestionScore; // A en instrumental
    const scoreInstB = bV - 0.4 * b.midCongestionScore; // B en instrumental
    mode = scoreInstB >= scoreInstA ? 'instA_vocB' : 'vocA_instB';
    const instCong = mode === 'instA_vocB' ? a.midCongestionScore : b.midCongestionScore;
    reason =
      `Les deux platines sont chantées — meilleur contraste (voix la plus présente + instrumental ` +
      `1–3 kHz le moins dense, congestion ${((instCong * 100) | 0)} %) — recommandé : ${
        mode === 'instA_vocB' ? 'INST A + VOIX B' : 'VOIX A + INST B'
      }`;
  }
  const profile: 'standard' | 'ost-cinema' =
    genreHintsOstCinema(a.genre) || genreHintsOstCinema(b.genre) ? 'ost-cinema' : 'standard';
  if (profile === 'ost-cinema') {
    reason += ' · Profil OST/Cinéma (bande originale détectée)';
  }
  return { mode, profile, reason };
}

/**
 * ALC-231 : plan de déclenchement du mashup « Profil OST / Cinéma ».
 * Associe une bande originale instrumentale (OST) et un vocal pop/ballade :
 *  1. Profil énergétique de l'OST (other + drums, fenêtres de 4 mesures) → zone calme + climax.
 *  2. Segmentation structurelle du vocal (couplet via detectFirstVocalEntrySeconds, refrain = fenêtre
 *     8 mesures de densité vocale maximale ≥ 0.80×pic).
 *  3. Rétro-calage par ancrage de climax : `ostEntrySeconds = max(calmStart, quantize(climax − ΔT_voc))`
 *     avec `ΔT_voc = max(0, chorus − verse)` — le refrain vocal tombe sur le climax orchestral.
 * Repli GARANTI (jamais null, jamais NaN/Infinity) même pour une OST 100 % instrumentale.
 */
export function computeOstVocalMashupPlan(
  ost: {
    other: Float32Array;
    drums: Float32Array;
    vocals: Float32Array;
    durationSeconds: number;
    bpm: number;
    gridOffsetMs: number;
  },
  vocal: {
    vocals: Float32Array;
    durationSeconds: number;
    bpm: number;
    gridOffsetMs: number;
  }
): OstVocalMashupPlan {
  const dur = Number.isFinite(ost.durationSeconds) && ost.durationSeconds > 0 ? ost.durationSeconds : 120;
  const vDur = Number.isFinite(vocal.durationSeconds) && vocal.durationSeconds > 0 ? vocal.durationSeconds : 120;
  const beat = 60 / (ost.bpm > 0 ? ost.bpm : 120);
  const offset = (ost.gridOffsetMs || 0) / 1000;
  const clampSec = (t: number, d: number) => (Number.isFinite(t) ? Math.min(d, Math.max(0, t)) : 0);

  // Quantification sur le temps fort (downbeat) de la grille OST.
  const quantize = (t: number): number => {
    if (!Number.isFinite(t)) return offset;
    const k = Math.round((t - offset) / beat);
    return Math.max(0, offset + k * beat);
  };

  // ── 1) Profilage énergétique de l'OST (other + drums), fenêtre [from, to) en secondes ──
  const em = (fromSec: number, toSec: number): number => {
    const bins = Math.min(ost.other.length, ost.drums.length);
    if (!bins || !(dur > 0)) return 0;
    const i0 = Math.max(0, Math.floor((fromSec / dur) * bins));
    const i1 = Math.min(bins, Math.max(i0 + 1, Math.ceil((toSec / dur) * bins)));
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += ((ost.other[i] || 0) + (ost.drums[i] || 0)) * 0.5;
    return i1 - i0 > 0 ? sum / (i1 - i0) : 0;
  };

  const win4 = 4 * 4 * beat; // 4 mesures
  const win8 = 2 * win4; // 8 mesures

  // calmStartSeconds : première fenêtre de 8 mesures d'énergie moyenne ∈ [0.15, 0.45].
  let calmStartSeconds = 0;
  const nWin8 = Math.max(0, Math.floor(dur / win8));
  for (let w = 0; w <= nWin8; w++) {
    const s = w * win8;
    const e = em(s, Math.min(dur, s + win8));
    if (e >= 0.15 && e <= 0.45) {
      calmStartSeconds = quantize(s);
      break;
    }
  }

  // climaxSeconds : première fenêtre de 4 mesures Em ≥ 0.75, sinon pic global d'énergie.
  let climaxIdx = -1;
  let peakE = -1;
  let peakIdx = 0;
  const nWin4 = Math.max(0, Math.floor(dur / win4));
  for (let w = 0; w <= nWin4; w++) {
    const s = w * win4;
    const e = em(s, Math.min(dur, s + win4));
    if (e > peakE) {
      peakE = e;
      peakIdx = w;
    }
    if (climaxIdx < 0 && e >= 0.75) climaxIdx = w;
  }
  const climaxSeconds = quantize((climaxIdx >= 0 ? climaxIdx : peakIdx) * win4);

  // ── 2) Segmentation structurelle du Vocal ──
  const vocalVerseSeconds = detectFirstVocalEntrySeconds(
    vocal.vocals,
    vDur,
    vocal.bpm,
    vocal.gridOffsetMs
  );
  let peakV = 0;
  for (let i = 0; i < vocal.vocals.length; i++) if (vocal.vocals[i] > peakV) peakV = vocal.vocals[i];
  const vWin8 = 8 * 4 * (60 / (vocal.bpm > 0 ? vocal.bpm : 120));
  const vMean = (fromSec: number, toSec: number): number => {
    const bins = vocal.vocals.length;
    if (!bins || !(vDur > 0)) return 0;
    const i0 = Math.max(0, Math.floor((fromSec / vDur) * bins));
    const i1 = Math.min(bins, Math.max(i0 + 1, Math.ceil((toSec / vDur) * bins)));
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += vocal.vocals[i] || 0;
    return i1 - i0 > 0 ? sum / (i1 - i0) : 0;
  };
  // Refrain : première fenêtre de 8 mesures de densité vocale ≥ 0.80×pic, après le couplet.
  let vocalChorusSeconds = vocalVerseSeconds;
  let bestChorusMean = -1;
  let bestChorusWindow = -1;
  const nVWin8 = Math.max(0, Math.floor(vDur / vWin8));
  for (let w = 0; w <= nVWin8; w++) {
    const s = w * vWin8;
    if (s < vocalVerseSeconds - 1e-6) continue;
    const m = vMean(s, Math.min(vDur, s + vWin8));
    if (m > bestChorusMean) {
      bestChorusMean = m;
      bestChorusWindow = w;
    }
    if (m >= peakV * 0.8) {
      vocalChorusSeconds = Math.max(0, offset + Math.round((s - offset) / beat) * beat);
      break;
    }
  }
  // Aucune fenêtre n'atteint 0.80×pic → repli sur la fenêtre la plus dense (toujours valide).
  if (bestChorusWindow >= 0 && (vocalChorusSeconds === vocalVerseSeconds || bestChorusMean < peakV * 0.8)) {
    vocalChorusSeconds = Math.max(0, offset + Math.round((bestChorusWindow * vWin8 - offset) / beat) * beat);
  }

  // ── 3) Rétro-calage structurel par ancrage de Climax ──
  const dT = Math.max(0, vocalChorusSeconds - vocalVerseSeconds);
  const ostEntrySeconds = Math.max(calmStartSeconds, quantize(climaxSeconds - dT));

  // ALC-235 : risque de dialogue résiduel de l'OST — énergie vocale résiduelle de la B.O.
  // (voix parlées de film, cuivres portés par le stem vocals) : 0 = purement instrumentale,
  // 1 = le stem vocals de l'OST est aussi présent que le stem « other ».
  const meanOfEnv = (a: Float32Array): number => {
    if (!a || a.length === 0) return 0;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] || 0;
    return s / a.length;
  };
  const vocMean = meanOfEnv(ost.vocals);
  const otherMean = meanOfEnv(ost.other);
  const dialogueRisk = vocMean + otherMean > 0 ? Math.min(1, Math.max(0, vocMean / (vocMean + otherMean))) : 0;

  return {
    calmStartSeconds: clampSec(calmStartSeconds, dur),
    climaxSeconds: clampSec(climaxSeconds, dur),
    vocalVerseSeconds: clampSec(vocalVerseSeconds, vDur),
    vocalChorusSeconds: clampSec(vocalChorusSeconds, vDur),
    ostEntrySeconds: clampSec(ostEntrySeconds, dur),
    dialogueRisk,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ALC-269 : « Mode Chef d'Orchestre » — partitions d'arrangement JSON
// (`MashupArrangementScore`). Logique PURE (testable sous `node --test`) :
// schéma de partition, validation & moteur de résolution à la mesure courante.
// ─────────────────────────────────────────────────────────────────────────────
export type ArrangementStemName = 'vocals' | 'drums' | 'bass' | 'other';

export interface ArrangementTimelineCue {
  bar: number;
  deckA: ArrangementStemName[];
  deckB: ArrangementStemName[];
  crossfader?: number;
  filterA?: { type: 'lpf' | 'hpf'; freqHz: number };
  filterB?: { type: 'lpf' | 'hpf'; freqHz: number };
  label?: string;
}

export interface MashupArrangementScore {
  version: '1.0';
  title: string;
  masterBpm?: number;
  crossfader?: number;
  deckA?: {
    role?: 'ost-instrumental' | 'instrumental' | 'vocal' | 'rhythm' | 'theme';
    startBar?: number;
  };
  deckB?: {
    role?: 'ost-instrumental' | 'instrumental' | 'vocal' | 'rhythm' | 'theme';
    startBar?: number;
    entryBar?: number;
    sourceStartBar?: number;
  };
  eq?: {
    duckTarget?: 'A.other' | 'B.other' | 'none';
    duckFreqHz?: number;
    duckGainDb?: number;
    duckQ?: number;
    hpfHz?: { A?: number; B?: number };
  };
  timeline: ArrangementTimelineCue[];
}

export type ArrangementParseResult =
  | { ok: true; score: MashupArrangementScore }
  | { ok: false; error: string };

const VALID_STEMS: ArrangementStemName[] = ['vocals', 'drums', 'bass', 'other'];
const VALID_VERSIONS = ['1.0'] as const;
const MAX_BAR = 1_000_000;

/** Retire d'éventuelles balises Markdown ```json / ``` entourant le JSON collé. */
function stripMarkdownFences(text: string): string {
  let t = (text || '').trim();
  const fence = /^```json\s*([\s\S]*?)```\s*$/i.exec(t);
  if (fence) return fence[1].trim();
  const fenceAny = /^```\s*([\s\S]*?)```\s*$/.exec(t);
  if (fenceAny) return fenceAny[1].trim();
  return t;
}

function isStemName(v: unknown): v is ArrangementStemName {
  return typeof v === 'string' && (VALID_STEMS as string[]).includes(v);
}

/** Valide la liste de stems d'un repère ; retourne un message d'erreur ou null. */
function validateStemList(v: unknown, field: string): string | null {
  if (!Array.isArray(v)) return `« ${field} » doit être un tableau de stems`;
  for (const s of v) {
    if (!isStemName(s)) return `« ${field} » contient un stem inconnu : ${JSON.stringify(s)}`;
  }
  return null;
}

function clampNum(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.max(min, Math.min(max, n));
}

function hpfObj(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return {};
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof o.A === 'number') out.A = clampNum(o.A, 20, 20, 20000);
  if (typeof o.B === 'number') out.B = clampNum(o.B, 20, 20, 20000);
  return out;
}

/**
 * Parse & valide une partition d'arrangement JSON. Accepte un objet JSON direct,
 * avec ou sans balises Markdown ```json / ``` au collage. Valide la structure
 * (`version: '1.0'`, timeline >= 1 repère, bar >= 1, stems connus), trie la
 * timeline par mesure croissante et retourne `{ ok:true, score }` ou
 * `{ ok:false, error }` avec un message explicite.
 */
export function parseAndValidateArrangementScore(rawText: string): ArrangementParseResult {
  const cleaned = stripMarkdownFences(rawText);
  if (!cleaned) return { ok: false, error: 'Partition vide : collez un objet JSON' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return {
      ok: false,
      error: `JSON invalide : ${err instanceof Error ? err.message : 'erreur de syntaxe'}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'La partition doit être un objet JSON' };
  }
  const raw = parsed as Record<string, unknown>;

  const version = raw.version;
  if (typeof version !== 'string' || (VALID_VERSIONS as readonly string[]).indexOf(version) === -1) {
    return {
      ok: false,
      error: `Version non reconnue : ${JSON.stringify(version)} (attendu '1.0')`,
    };
  }
  const title =
    typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Partition sans titre';

  if (!Array.isArray(raw.timeline)) {
    return { ok: false, error: 'La partition doit contenir un champ « timeline » (tableau)' };
  }
  if (raw.timeline.length < 1) {
    return { ok: false, error: 'La timeline doit contenir au moins 1 repère' };
  }

  const timeline: ArrangementTimelineCue[] = [];
  for (let i = 0; i < raw.timeline.length; i++) {
    const cue = raw.timeline[i] as Record<string, unknown>;
    if (typeof cue !== 'object' || cue === null) {
      return { ok: false, error: `Repère ${i + 1} : doit être un objet` };
    }
    const bar = cue.bar;
    if (typeof bar !== 'number' || !Number.isFinite(bar) || bar < 1) {
      return {
        ok: false,
        error: `Repère ${i + 1} : « bar » doit être une mesure >= 1 (obtenu ${JSON.stringify(bar)})`,
      };
    }
    const barInt = Math.max(1, Math.floor(Math.min(bar, MAX_BAR)));
    const errA = validateStemList(cue.deckA, `repère ${i + 1}.deckA`);
    if (errA) return { ok: false, error: errA };
    const errB = validateStemList(cue.deckB, `repère ${i + 1}.deckB`);
    if (errB) return { ok: false, error: errB };

    const out: ArrangementTimelineCue = {
      bar: barInt,
      deckA: (cue.deckA as unknown[]).filter(isStemName) as ArrangementStemName[],
      deckB: (cue.deckB as unknown[]).filter(isStemName) as ArrangementStemName[],
    };
    if (cue.crossfader !== undefined) out.crossfader = clampNum(cue.crossfader, 0.5, 0, 1);
    const filterFor = (f: unknown): { type: 'lpf' | 'hpf'; freqHz: number } | undefined => {
      if (typeof f !== 'object' || f === null) return undefined;
      const fr = f as Record<string, unknown>;
      const type = fr.type;
      if (type !== 'lpf' && type !== 'hpf') return undefined;
      return { type, freqHz: clampNum(fr.freqHz, 1000, 20, 20000) };
    };
    const fA = filterFor(cue.filterA);
    if (fA) out.filterA = fA;
    const fB = filterFor(cue.filterB);
    if (fB) out.filterB = fB;
    if (typeof cue.label === 'string' && cue.label.trim()) out.label = cue.label.trim();

    timeline.push(out);
  }
  timeline.sort((a, b) => a.bar - b.bar);

  const VALID_ROLES = ['ost-instrumental', 'instrumental', 'vocal', 'rhythm', 'theme'];
  const parseRole = (v: unknown): NonNullable<MashupArrangementScore['deckA']>['role'] | undefined => {
    if (typeof v !== 'string' || VALID_ROLES.indexOf(v) === -1) return undefined;
    return v as NonNullable<MashupArrangementScore['deckA']>['role'];
  };
  const dA = raw.deckA as Record<string, unknown> | undefined;
  const deckA =
    dA && typeof dA === 'object'
      ? {
          ...(parseRole(dA.role) ? { role: parseRole(dA.role) } : {}),
          ...(typeof dA.startBar === 'number' && Number.isFinite(dA.startBar)
            ? { startBar: Math.max(1, Math.floor(dA.startBar)) }
            : {}),
        }
      : undefined;
  const dB = raw.deckB as Record<string, unknown> | undefined;
  const deckB =
    dB && typeof dB === 'object'
      ? {
          ...(parseRole(dB.role) ? { role: parseRole(dB.role) } : {}),
          ...(typeof dB.startBar === 'number' && Number.isFinite(dB.startBar)
            ? { startBar: Math.max(1, Math.floor(dB.startBar)) }
            : {}),
          ...(typeof dB.entryBar === 'number' && Number.isFinite(dB.entryBar)
            ? { entryBar: Math.max(1, Math.floor(dB.entryBar)) }
            : {}),
          ...(typeof dB.sourceStartBar === 'number' && Number.isFinite(dB.sourceStartBar)
            ? { sourceStartBar: Math.max(1, Math.floor(dB.sourceStartBar)) }
            : {}),
        }
      : undefined;

  const eqRaw = raw.eq as Record<string, unknown> | undefined;
  const eq =
    eqRaw && typeof eqRaw === 'object'
      ? {
          ...(typeof eqRaw.duckTarget === 'string' &&
          ['A.other', 'B.other', 'none'].includes(eqRaw.duckTarget)
            ? { duckTarget: eqRaw.duckTarget as 'A.other' | 'B.other' | 'none' }
            : {}),
          ...(typeof eqRaw.duckFreqHz === 'number'
            ? { duckFreqHz: clampNum(eqRaw.duckFreqHz, 1800, 20, 20000) }
            : {}),
          ...(typeof eqRaw.duckGainDb === 'number'
            ? { duckGainDb: clampNum(eqRaw.duckGainDb, -4.5, -6.5, 0) }
            : {}),
          ...(typeof eqRaw.duckQ === 'number'
            ? { duckQ: clampNum(eqRaw.duckQ, 1, 0.1, 12) }
            : {}),
          ...(eqRaw.hpfHz !== undefined ? hpfObj(eqRaw.hpfHz) : {}),
        }
      : undefined;

  const crossfader =
    typeof raw.crossfader === 'number' ? clampNum(raw.crossfader, 0.5, 0, 1) : undefined;
  const masterBpm =
    typeof raw.masterBpm === 'number' && Number.isFinite(raw.masterBpm) && raw.masterBpm > 0
      ? raw.masterBpm
      : undefined;

  const score: MashupArrangementScore = { version: '1.0', title, timeline };
  if (masterBpm !== undefined) score.masterBpm = masterBpm;
  if (crossfader !== undefined) score.crossfader = crossfader;
  if (deckA !== undefined) score.deckA = deckA;
  if (deckB !== undefined) score.deckB = deckB;
  if (eq !== undefined) score.eq = eq;

  return { ok: true, score };
}

export interface ArrangementResolvedState {
  cue: ArrangementTimelineCue | null;
  stemsA: ArrangementStemName[];
  stemsB: ArrangementStemName[];
  crossfader: number;
  nextCueIndex: number;
  nextCue: ArrangementTimelineCue | null;
}

/**
 * Résout l'état de la partition à une mesure donnée (1-indexée sur la grille
 * maître). Le repère actif est le dernier repère dont `bar <= currentBar` ;
 * retourne les stems actifs sur A/B, le crossfader cible et l'indice du
 * prochain repère à venir (`-1` si plus rien de prévu).
 */
export function resolveArrangementStateAtBar(
  score: MashupArrangementScore,
  currentBar: number
): ArrangementResolvedState {
  const bars = score.timeline.map((c) => c.bar);
  const bar = Math.max(1, Math.floor(Number.isFinite(currentBar) ? currentBar : 1));

  let activeIdx = 0;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i] <= bar) activeIdx = i;
  }
  const cue = score.timeline[activeIdx] ?? null;

  let nextIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i] > bar) {
      nextIdx = i;
      break;
    }
  }

  return {
    cue,
    stemsA: cue ? cue.deckA : [],
    stemsB: cue ? cue.deckB : [],
    crossfader: cue && cue.crossfader !== undefined ? cue.crossfader : score.crossfader ?? 0.5,
    nextCueIndex: nextIdx,
    nextCue: nextIdx >= 0 ? score.timeline[nextIdx] : null,
  };
}
