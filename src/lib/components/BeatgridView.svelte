<script lang="ts">
  import { mixerStore, formatTime, type DeckId } from '$lib/stores/mixer.svelte';
  import {
  vocalPhraseEnvelope,
  composeSelectedStemsEnvelope,
  stemActive,
  bothVocalsActive,
  detectActiveVocalZoneAt,
  resolveMashupRoles,
  computeOstVocalMashupPlan,
  computeContinuousOstMashupPlan,
} from '$lib/audio/stemMix';
  // ALC-202-1/2 : module pur des repères de mesures / temps (clés strictement uniques, mesures >= 1).
  import { measuresFor as gridMeasuresFor, beatsFor as gridBeatsFor } from '$lib/utils/beatgrid';
import { getEffectiveSegmentBpm, getActiveKeyPointAtTime } from '$lib/utils/beatgridTelemetry'; // ALC-224
import { formatMixClock } from '$lib/utils/wavEncoder'; // ALC-226 : Timer global + REC mashup
import VzKey from './VzKey.svelte'; // ALC-230 : primitive mécanique du pupitre

  // ALC-197 : « Ruban d'Arrangement Musical » — partition visuelle 2 rubans empilés (Venezia 1889).
  const WAVE_W = 640;
  const CUES = ['INTRO', 'DROP', 'ACAP', 'OUTRO'];
  const LOOPS = [0.5, 1, 4, 8, 16];

  let target = $state<DeckId>('A');
  let zoom = $state<number>(16);
  const ZOOMS = [4, 8, 16] as const;
  let startPosA = $state(0);
  let startPosB = $state(0);
  let startSaved = $state(false);

  // ALC-219 : confirmations visuelles temporaires (reset stems / alignement tempo-phase).
  let resetFlash = $state(false);
  let alignedFlash = $state(false);
  let _flashA = 0;
  let _flashB = 0;
  function flashReset() {
    resetFlash = true;
    const n = ++_flashA;
    window.setTimeout(() => { if (n === _flashA) resetFlash = false; }, 1600);
  }
  function flashConfirm() {
    alignedFlash = true;
    const n = ++_flashB;
    window.setTimeout(() => { if (n === _flashB) alignedFlash = false; }, 1600);
  }

  const deckOf = (id: DeckId) => mixerStore.getDeck(id);
  const effBpmOf = (id: DeckId) => (id === 'A' ? mixerStore.effectiveBpmA : mixerStore.effectiveBpmB) || 120;

  // ALC-200-1 : toutes les valeurs temps/grille sont protégées (NaN/Infinity/≤0 → repli sûr).
  const SAFEBEAT = 0.5;
  const beatOf = (id: DeckId) => {
    try {
      const b = effBpmOf(id) || 120;
      const g = deckOf(id).gridOctave || 1;
      const v = 60 / ((b * g) || b || 1);
      return v > 0 && Number.isFinite(v) ? v : SAFEBEAT;
    } catch { return SAFEBEAT; }
  };
  const beatSecA = $derived.by(() => beatOf('A'));
  const beatSecB = $derived.by(() => beatOf('B'));
  const strideOf = (id: DeckId) => {
    try {
      const s = WAVE_W / ((zoom * 4 * beatOf(id)) || 1);
      return s > 0 && Number.isFinite(s) ? s : WAVE_W;
    } catch { return WAVE_W; }
  };
  const strideA = $derived.by(() => strideOf('A'));
  const strideB = $derived.by(() => strideOf('B'));
  const playheadOf = (id: DeckId) => {
    try {
      const v = deckOf(id).elapsedSeconds - (deckOf(id).gridOffsetMs || 0) / 1000;
      return Number.isFinite(v) ? v : 0;
    } catch { return 0; }
  };
  const playheadA = $derived.by(() => playheadOf('A'));
  const playheadB = $derived.by(() => playheadOf('B'));

  const anyPlaying = $derived(
    mixerStore.deckA.transport === 'playing' || mixerStore.deckB.transport === 'playing'
  );

  // ALC-222 : collision vocale — les deux platines ont leurs stems prêts ET VOIX actif partout, en lecture.
  const anyVocalActive = $derived(
    anyPlaying &&
      bothVocalsActive(
        mixerStore.deckA.stemsStatus,
        mixerStore.deckB.stemsStatus,
        mixerStore.deckA.stemMutes,
        mixerStore.deckB.stemMutes
      )
  );

  // ALC-222 : tête de lecture fluide — rAF 60 fps dès que `anyPlaying` (démarrage immédiat à t=0,
  // plus aucune latence du ticker 200 ms ; la boucle est coupée dès que plus rien ne joue).
  $effect(() => {
    if (!anyPlaying) return;
    let raf = 0;
    const tick = () => {
      if (mixerStore.deckA.transport === 'playing') {
        const p = mixerStore.getPlayer('A');
        if (p) mixerStore.syncPlayback('A', p.position, 0);
      }
      if (mixerStore.deckB.transport === 'playing') {
        const p = mixerStore.getPlayer('B');
        if (p) mixerStore.syncPlayback('B', p.position, 0);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  // ALC-222 : AUTO VOIX — coupe la VOIX de B pendant une phrase chantée de A, la rétablit en instrumental.
  let autoBMuted = $state(false);
  $effect(() => {
    const armed = mixerStore.mashupLaunchState.mode === 'auto-vocal-wait';
    if (!armed || mixerStore.deckA.transport !== 'playing') {
      if (autoBMuted) {
        autoBMuted = false;
        if (mixerStore.deckB.stemMutes.vocals) mixerStore.toggleStemMute('B', 'vocals');
      }
      return;
    }
    const env = vocalEnv('A');
    const d = deckOf('A');
    const at = mixerStore.deckA.elapsedSeconds; // re-déclenchement réactif à la lecture
    if (!env || !d || !(d.durationSeconds > 0)) return;
    const active = detectActiveVocalZoneAt(env, d.durationSeconds, Math.max(0, at));
    if (active && !mixerStore.deckB.stemMutes.vocals) {
      autoBMuted = true;
      mixerStore.toggleStemMute('B', 'vocals');
    } else if (!active && autoBMuted && mixerStore.deckB.stemMutes.vocals) {
      autoBMuted = false;
      mixerStore.toggleStemMute('B', 'vocals');
    }
  });

  // ALC-224 : télémétrie (COURBE TEMPO / CLÉ) — données dérivées des segments sonores + position.
  const segsOf = (id: DeckId) =>
    (id === 'A' ? mixerStore.deckSegmentsA : mixerStore.deckSegmentsB) || [];
  const effPlaybackOf = (id: DeckId) => {
    const d = deckOf(id);
    return Number((1 + (d?.pitchPercent || 0) / 100).toFixed(4)) || 1;
  };
  const pxTimeOf = (id: DeckId, px: number) => {
    const ph = id === 'A' ? playheadA : playheadB;
    const stride = id === 'A' ? strideA : strideB || WAVE_W;
    return ph + (px - WAVE_W / 2) / (stride || 1);
  };
  const segAtTime = (id: DeckId, t: number) => {
    const segs = segsOf(id);
    if (!segs.length) return null;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (t >= s.startSec && t < s.endSec) return s;
    }
    return segs[segs.length - 1] || null;
  };
  const refMeanBpm = (id: DeckId): number => {
    const segs = segsOf(id);
    const g = effBpmOf(id);
    const pr = effPlaybackOf(id);
    if (!segs.length) return g;
    let sum = 0;
    for (const s of segs) sum += getEffectiveSegmentBpm(s.localBpm, g, pr);
    return sum / segs.length;
  };
  const currentBpmTele = (id: DeckId): number => {
    const s = segAtTime(id, id === 'A' ? playheadA : playheadB);
    const g = effBpmOf(id);
    return s ? getEffectiveSegmentBpm(s.localBpm, g, effPlaybackOf(id)) : g;
  };
  const currentKeyTele = (id: DeckId) =>
    getActiveKeyPointAtTime(segsOf(id), id === 'A' ? playheadA : playheadB, deckOf(id).camelotKey);
  const keyConflictReal = $derived.by(() => {
    if (!mixerStore.deckA.filePath || !mixerStore.deckB.filePath) return false;
    const a = currentKeyTele('A');
    const b = currentKeyTele('B');
    if (!a.num || !b.num) return false;
    const ring = Math.min(Math.abs(a.num - b.num), 12 - Math.abs(a.num - b.num));
    return a.num === b.num ? 1 > 1 : ring > 1; // dissonant (> 1 quinte) à l'instant joué
  });
  const telPoly = (id: DeckId): string => {
    const segs = segsOf(id);
    const g = effBpmOf(id);
    const pr = effPlaybackOf(id);
    const pts: string[] = [];
    if (mixerStore.beatgridTelemetryMode === 'tempo') {
      const ref = refMeanBpm(id);
      for (let px = 0; px <= WAVE_W; px += 6) {
        const s = segAtTime(id, pxTimeOf(id, px));
        const bpm = s ? getEffectiveSegmentBpm(s.localBpm, g, pr) : ref;
        const y = 23 - Math.max(-22, Math.min(22, (bpm - ref) * 5)); // ±4 BPM ≈ ±20 px
        pts.push(`${px},${Math.round(y)}`);
      }
    } else {
      for (let px = 0; px <= WAVE_W; px += 6) {
        const k = getActiveKeyPointAtTime(segs, pxTimeOf(id, px), deckOf(id).camelotKey);
        const y = 23 - (k.num != null ? (k.num - 1) * 3.6 : 0);
        pts.push(`${px},${Math.round(Math.max(0, Math.min(46, y)))}`);
      }
    }
    return pts.join(' ');
  };
  const telModeLabel = $derived(
    mixerStore.beatgridTelemetryMode === 'tempo' ? 'COURBE TEMPO' : 'COURBE CLÉ'
  );
  const bandDim = (id: DeckId): number => {
    const d = deckOf(id);
    const playing = d?.transport === 'playing';
    const cf = (mixerStore.crossfader ?? 50) / 100;
    const dim = id === 'A' ? cf : 1 - cf;
    return playing ? Math.max(0.35, 0.55 + dim * 0.45) : 0.45;
  };
  // ALC-228 : mode du pilote automatique AUTO-MASHUP STUDIO.
  let autoMashupMode: 'instA_vocB' | 'vocA_instB' = $state('instA_vocB');
  // ALC-227 : libellé dynamique du bouton relais bidirectionnel.
  const relayButtonLabel = $derived.by(() => {
    const r = mixerStore.vocalRelayState;
    if (r.pendingTarget != null) {
      return `⏳ VOIX ${r.pendingTarget} À ${formatTime(r.triggerAtSeconds ?? 0)}`;
    }
    const aVoc = !mixerStore.deckA.stemMutes.vocals && mixerStore.deckA.stemsStatus === 'ready';
    return aVoc ? '⇄ RELAIS → B' : '⇄ RELAIS → A';
  });

  // ── ALC-230 : état du pupitre — touches, verrouillage, disabled + raisons ────────────────
  const bothLoaded = $derived(!!mixerStore.deckA.filePath && !!mixerStore.deckB.filePath);
  const needAB = $derived(!bothLoaded);
  const mashRunning = $derived(mixerStore.autoMashupPipelineState.running);
  const mashProgress = $derived(
    mixerStore.autoMashupPipelineState.totalSteps > 0
      ? Math.min(1, mixerStore.autoMashupPipelineState.stepIndex / mixerStore.autoMashupPipelineState.totalSteps)
      : 0
  );
  // LANCER A + B ⇄ PAUSE A + B : une seule touche à verrouillage (spec ALC-161), LED or en lecture.
  const launchPressed = $derived(anyPlaying);
  // AUTO VOIX / INST → VOIX partagent mashupLaunchState.mode (mutuellement exclusifs) ; RELAIS est
  // orthogonal (vocalRelayState) → touche ghost latchee quand armé.
  const autoVoxPressed = $derived(
    (mixerStore.mashupLaunchState.mode === 'auto-vocal-wait' ||
      mixerStore.mashupLaunchState.mode === 'playing') &&
      mixerStore.mashupLaunchState.vocalStartSeconds != null
  );
  const instVoixPressed = $derived(mixerStore.mashupLaunchState.mode === 'manual-vocal-wait');
  const relayPressed = $derived(mixerStore.vocalRelayState.pendingTarget != null);
  // Cue « recallé / en lecture » : platine en lecture à moins de 0,5 s de la position du repère.
  const cuePlaying = (id: DeckId, i: number) => {
    const d = mixerStore.getDeck(id);
    const t = d.hotCues[i];
    return t >= 0 && d.transport === 'playing' && d.durationSeconds > 0 && Math.abs(d.elapsedSeconds - t) < 0.5;
  };
  const cueTime = (id: DeckId, i: number): string => {
    const v = mixerStore.getDeck(id).hotCues[i];
    return v >= 0 ? formatTime(v) : '';
  };
  // Ancres « REQUIERT A + B » stables référencées par aria-describedby des touches désactivées.
  const reqAbPreparer = 'vz-req-01';
  const reqAbJouer = 'vz-req-02';
  const reqAbMashup = 'vz-req-03';

  // ALC-231 : repères visuels OST — entrée voix + climax + montée orchestrale (waveform platinne inst).
  const EMPTY_VEC = new Float32Array(0);
  const ostClimaxMarker = $derived.by(() => {
    if (mixerStore.mashupStyleProfile !== 'ost-cinema') return null;
    const roles = resolveMashupRoles(mixerStore.deckA, mixerStore.deckB);
    const ostId = roles.instDeck;
    const ost = mixerStore.getDeck(ostId);
    const pOst = mixerStore.getPlayer(ostId);
    const pVoc = mixerStore.getPlayer(roles.vocalDeck);
    const oEnv = pOst?.getStemEnvelopes();
    const vEnv = pVoc?.getStemEnvelopes()?.vocals;
    if (!oEnv || !vEnv || !vEnv.length || !(ost.durationSeconds > 0)) return null;
    const bpm = ostId === 'A' ? mixerStore.effectiveBpmA : mixerStore.effectiveBpmB;
    const vocDeck = mixerStore.getDeck(roles.vocalDeck);
    const plan = computeOstVocalMashupPlan(
      {
        other: oEnv.other ?? EMPTY_VEC,
        drums: oEnv.drums ?? EMPTY_VEC,
        vocals: oEnv.vocals ?? EMPTY_VEC,
        durationSeconds: ost.durationSeconds,
        bpm,
        gridOffsetMs: ost.gridOffsetMs,
      },
      {
        vocals: vEnv,
        durationSeconds: vocDeck.durationSeconds,
        bpm,
        gridOffsetMs: vocDeck.gridOffsetMs,
      }
    );
    return { ostId, climaxSeconds: plan.climaxSeconds, ostEntrySeconds: plan.ostEntrySeconds, vocalChorusSeconds: plan.vocalChorusSeconds, vocalVerseSeconds: plan.vocalVerseSeconds };
  });
  const ostMarkersVisible = (id: DeckId) => !!ostClimaxMarker && ostClimaxMarker.ostId === id;
  const ostDuckingActive = $derived(
    mixerStore.mashupStyleProfile === 'ost-cinema' &&
      (mixerStore.deckA.transport === 'playing' || mixerStore.deckB.transport === 'playing')
  );
  const markerXA = $derived.by(() => {
    if (!ostClimaxMarker || ostClimaxMarker.ostId !== 'A') return null;
    const entry = WAVE_W / 2 + (ostClimaxMarker.ostEntrySeconds - playheadA) * strideA;
    const climax = WAVE_W / 2 + (ostClimaxMarker.climaxSeconds - playheadA) * strideA;
    const lo = Math.max(0, Math.min(entry, climax));
    const hi = Math.min(WAVE_W, Math.max(entry, climax));
    return { entry, climax, zoneLeft: lo, zoneWidth: Math.max(0, hi - lo) };
  });
  const markerXB = $derived.by(() => {
    if (!ostClimaxMarker || ostClimaxMarker.ostId !== 'B') return null;
    const entry = WAVE_W / 2 + (ostClimaxMarker.ostEntrySeconds - playheadB) * strideB;
    const climax = WAVE_W / 2 + (ostClimaxMarker.climaxSeconds - playheadB) * strideB;
    const lo = Math.max(0, Math.min(entry, climax));
    const hi = Math.min(WAVE_W, Math.max(entry, climax));
    return { entry, climax, zoneLeft: lo, zoneWidth: Math.max(0, hi - lo) };
  });
// ALC-238-3 : plan Phrase-Synced du vocal — tranches fines (PHRASE N) + Orchestral Breathing Windows.
  // ALC-246-3 : repères MACRO uniquement — computeContinuousOstMashupPlan (Beatmatch verrouillé +
  // fenêtres de respiration ≥ 8 mesures) ; AUCUNE micro-cartouche PHRASE N / repère vertical haché.
  const ostContinuousPlan = $derived.by(() => {
    if (!ostClimaxMarker) return null;
    const roles = resolveMashupRoles(mixerStore.deckA, mixerStore.deckB);
    const ostId = roles.instDeck;
    const vocId = roles.vocalDeck;
    const ost = mixerStore.getDeck(ostId);
    const vocDeck = mixerStore.getDeck(vocId);
    const pOst = mixerStore.getPlayer(ostId);
    const pVoc = mixerStore.getPlayer(vocId);
    const oEnv = pOst?.getStemEnvelopes();
    const vEnv = pVoc?.getStemEnvelopes()?.vocals;
    if (!oEnv || !vEnv || !vEnv.length || !(ost.durationSeconds > 0) || !(vocDeck.durationSeconds > 0)) return null;
    const bpm = ostId === 'A' ? mixerStore.effectiveBpmA : mixerStore.effectiveBpmB;
    const plan = computeContinuousOstMashupPlan({
      ostBpm: bpm,
      vocalBpm: bpm,
      gridOffsetMs: ost.gridOffsetMs,
      ostEntryHintSeconds: ostClimaxMarker.ostEntrySeconds,
      vocalStartHintSeconds: ostClimaxMarker.vocalVerseSeconds,
      ostDurationSeconds: ost.durationSeconds,
      vocalDurationSeconds: vocDeck.durationSeconds,
      ostVocals: oEnv.vocals && oEnv.vocals.length ? oEnv.vocals : undefined,
      ostOther: oEnv.other && oEnv.other.length ? oEnv.other : undefined,
      ostDrums: oEnv.drums && oEnv.drums.length ? oEnv.drums : undefined,
      vocals: vEnv && vEnv.length ? vEnv : undefined,
      ostFirstDownbeatSeconds: ost.firstDownbeatSeconds ?? undefined, // ALC-253-1/2
      vocalFirstDownbeatSeconds: vocDeck.firstDownbeatSeconds ?? undefined, // ALC-253-1/2
      chorusEndSeconds: ostClimaxMarker.vocalChorusSeconds > 0 ? ostClimaxMarker.vocalChorusSeconds + 8 * 4 * (60 / (bpm || 120)) : 0,
    });
    return { ostId, entrySeconds: plan.ostEntrySeconds, breathingWindows: plan.breathingWindows };
  });
  // Zones ambrées hachurées des macro-fenêtres THÈME OST SOLO / DIALOGUE / INTRO (continu).
  const breathSlotsA = $derived.by(() => {
    if (!ostContinuousPlan || ostContinuousPlan.ostId !== 'A') return [];
    const ph = playheadA;
    const stride = strideA;
    return ostContinuousPlan.breathingWindows
      .filter((w) => w.startSeconds < w.endSeconds)
      .map((w, i) => {
        const x0 = WAVE_W / 2 + (w.startSeconds - ph) * stride;
        const x1 = WAVE_W / 2 + (w.endSeconds - ph) * stride;
        return { key: `brA-${i}`, x0, width: Math.max(0, x1 - x0), label: w.label };
      })
      .filter((b) => b.width > 0 && b.x0 < WAVE_W + 4 && b.x0 + b.width > -4);
  });
  const breathSlotsB = $derived.by(() => {
    if (!ostContinuousPlan || ostContinuousPlan.ostId !== 'B') return [];
    const ph = playheadB;
    const stride = strideB;
    return ostContinuousPlan.breathingWindows
      .filter((w) => w.startSeconds < w.endSeconds)
      .map((w, i) => {
        const x0 = WAVE_W / 2 + (w.startSeconds - ph) * stride;
        const x1 = WAVE_W / 2 + (w.endSeconds - ph) * stride;
        return { key: `brB-${i}`, x0, width: Math.max(0, x1 - x0), label: w.label };
      })
      .filter((b) => b.width > 0 && b.x0 < WAVE_W + 4 && b.x0 + b.width > -4);
  });
// ── Modèle du Ruban ─────────────────────────────────────────────────────────────
  // Briques de phrase (voix/mélodie) : runs soutenus de l'enveloppe au-dessus du seuil.
  // ALC-198-2 : on privilégie le STEM VOCAL réel (pondéré, 0 si voix coupée) ; repli waveformPeaks sinon.
  function vocalEnv(id: DeckId): Float32Array | null {
    try {
      const d = deckOf(id);
      if (!d || d.stemsStatus !== 'ready') return null;
      const env = mixerStore.getPlayer(id)?.getStemEnvelopes()?.vocals;
      if (!env || !env.length) return null;
      return vocalPhraseEnvelope(env, d.stemMutes || {}, d.stemGains || {});
    } catch (err) { console.error('[BEATGRID-ERR] vocalEnv', err); return null; }
  }
  function phraseBlocks(id: DeckId): { s: number; e: number }[] {
    try {
      const d = deckOf(id);
      const src: Float32Array | number[] = vocalEnv(id) ?? (d?.waveformPeaks || []);
      const peaks = src;
      const dur = d?.durationSeconds;
      if (!peaks || !peaks.length || !(dur > 0) || !Number.isFinite(dur)) return [];
      const thr = 0.14;
      const out: { s: number; e: number }[] = [];
      let run = -1;
      for (let i = 0; i <= peaks.length; i++) {
        const on = i < peaks.length && peaks[i] > thr;
        if (on && run < 0) run = i;
        else if (!on && run >= 0) {
          if (i - run >= 3) out.push({ s: (run / peaks.length) * dur, e: (i / peaks.length) * dur });
          run = -1;
        }
      }
      return out;
    } catch (err) { console.error('[BEATGRID-ERR] phraseBlocks', err); return []; }
  }
  function measureInfo(id: DeckId) {
    try {
      const bs = (id === 'A' ? beatSecA : beatSecB) || SAFEBEAT;
      const ph = (id === 'A' ? playheadA : playheadB) || 0;
      const M = bs * 4;
      const m = Math.max(1, Math.floor(ph / Math.max(1, M)) + 1);
      const beatIn = Math.max(1, Math.min(4, Math.floor((ph % Math.max(1, M)) / Math.max(1, bs)) + 1));
      return { measure: String(m).padStart(2, '0'), beatIn };
    } catch (err) { console.error('[BEATGRID-ERR] measureInfo', err); return { measure: '01', beatIn: 1 }; }
  }
  // ALC-202-1 : délègue au module pur (clés strictement uniques, mesures >= 1 ignorées).
  function measuresFor(id: DeckId): { x: number; m: string; label: string; key: string }[] {
    try {
      const bs = (id === 'A' ? beatSecA : beatSecB) || SAFEBEAT;
      const ph = (id === 'A' ? playheadA : playheadB) || 0;
      const stride = (id === 'A' ? strideA : strideB) || WAVE_W;
      return gridMeasuresFor(id, ph, bs, stride, WAVE_W);
    } catch (err) { console.error('[BEATGRID-ERR] measuresFor', err); return []; }
  }
  function beatsFor(id: DeckId): { x: number; beat: number; key: string }[] {
    try {
      const bs = (id === 'A' ? beatSecA : beatSecB) || SAFEBEAT;
      const ph = (id === 'A' ? playheadA : playheadB) || 0;
      const stride = (id === 'A' ? strideA : strideB) || WAVE_W;
      return gridBeatsFor(id, ph, bs, stride, WAVE_W);
    } catch (err) { console.error('[BEATGRID-ERR] beatsFor', err); return []; }
  }
  // ALC-204-1 : repères de mesure lisibles — étiquette toutes les 4 mesures (2 M en ZOOM 4 M),
  // espacement >= 48 px entre étiquettes, sans répéter INTRO/COUPLET/REFRAIN sur chaque mesure.
  function measureTicks(id: DeckId): { x: number; m: string; key: string; showLabel: boolean }[] {
    const marks = measuresFor(id);
    const step = zoom === 4 ? 2 : 4;
    const out: { x: number; m: string; key: string; showLabel: boolean }[] = [];
    let prev = -Infinity;
    for (const mm of marks) {
      const num = Number.parseInt(mm.m.slice(1), 10);
      const showLabel = Number.isFinite(num) && num % step === 1 && mm.x - prev >= 48;
      if (showLabel) prev = mm.x;
      out.push({ x: mm.x, m: mm.m, key: mm.key, showLabel });
    }
    return out;
  }
  // ALC-204-1 : libellé du mode / stems réellement actifs (badge en tête du ruban).
  function deckVoicesLabel(id: DeckId): string {
    const d = deckOf(id);
    const mutes = d?.stemMutes || {};
    const gains = d?.stemGains || {};
    const voc = stemActive(mutes, gains, 'vocals');
    const ins = ['drums', 'bass', 'other'].some((n) => stemActive(mutes, gains, n));
    if (voc && !ins) return 'VOIX SEULE';
    if (!voc && ins) return 'INSTRUMENTAL';
    return 'MIXTE';
  }
  // ALC-204-2 : enveloppe des SEULS stems réellement audibles (composeSelectedStemsEnvelope) :
  // drums+bass+other en mode INST, vocals en mode ACAPELLA → de vraies variations musicales.
  function audibleEnvelope(id: DeckId): Float32Array | null {
    try {
      const d = deckOf(id);
      if (!d || d.stemsStatus !== 'ready') return null;
      const envs = mixerStore.getPlayer(id)?.getStemEnvelopes();
      if (!envs) return null;
      return composeSelectedStemsEnvelope(envs, d.stemGains || {}, d.stemMutes || {}, d.waveformPeaks || []);
    } catch (err) { console.error('[BEATGRID-ERR] audibleEnvelope', err); return null; }
  }
  // ALC-204-2 : silhouette d'enveloppe musicale sculptée — barres rapprochées de hauteur
  // proportionnelle à l'énergie réelle, réparties sur la largeur du ruban (respirations = creux).
  function envelopeBars(id: DeckId): { x: number; h: number; key: string }[] {
    const env = audibleEnvelope(id);
    const d = deckOf(id);
    if (!env || !env.length || !d || !(d.durationSeconds > 0)) return [];
    const stride = id === 'A' ? strideA : strideB;
    const ph = id === 'A' ? playheadA : playheadB;
    const bins = env.length;
    const dur = d.durationSeconds;
    const maxH = 46;
    const BAR_W = 2;
    const out: { x: number; h: number; key: string }[] = [];
    for (let px = 0; px < WAVE_W; px += BAR_W) {
      const t = ph + (px - WAVE_W / 2) / (stride || 1);
      const bi = Math.max(0, Math.min(bins - 1, Math.round((t / Math.max(1, dur)) * bins)));
      const v = env[bi];
      if (!(v > 0)) continue; // silence → creux de respiration
      out.push({ x: px, h: Math.max(2, Math.round(Math.min(1, v) * maxH)), key: `${id}-${px}` });
    }
    return out;
  }
  // Diagnostic de fusion : conflit si deux blocs de voix se chevauchent sous l'aiguille (deck cible).
  function conflictAt(tid: DeckId): 'fusion' | 'conflict' {
    const a = phraseBlocks('A');
    const b = phraseBlocks('B');
    const ph = tid === 'A' ? playheadA : playheadB;
    const on = (blocks: { s: number; e: number }[]) => blocks.some((bl) => ph >= bl.s && ph <= bl.e);
    return on(a) && on(b) ? 'conflict' : 'fusion';
  }
  const conflict = $derived.by(() => {
    try { return conflictAt(target); } catch (err) { console.error('[BEATGRID-ERR] conflictAt', err); return 'fusion'; }
  });
  const measureCart = $derived.by(() => {
    try { return measureInfo(target); } catch (err) { console.error('[BEATGRID-ERR] measureCart', err); return { measure: '01', beatIn: 1 }; }
  });

  // ── Lancement / transport (ALC-196) ─────────────────────────────────────────────
  function launchBoth() {
    const deckA = mixerStore.getDeck('A');
    const deckB = mixerStore.getDeck('B');
    const bpmDelta = Math.abs((mixerStore.effectiveBpmB || 0) - (mixerStore.effectiveBpmA || 0)) || 0;
    const phaseGap = Math.abs(deckA.elapsedSeconds - deckB.elapsedSeconds);
    if (bpmDelta > 0.2 || phaseGap > 0.05) mixerStore.alignTempoAndPhase();
    startPosA = deckA.elapsedSeconds;
    startPosB = deckB.elapsedSeconds;
    startSaved = true;
    void mixerStore.launchSimultaneous();
  }
  function manualHandler() {
    if (mixerStore.mashupLaunchState.mode === 'manual-vocal-wait') void mixerStore.triggerManualVocalNow();
    else void mixerStore.launchInstWaitManualVocal();
  }
  function returnToCue() {
    const deckA = mixerStore.getDeck('A');
    const deckB = mixerStore.getDeck('B');
    mixerStore.setTransport('A', 'stopped');
    mixerStore.setTransport('B', 'stopped');
    deckA.elapsedSeconds = startPosA;
    deckB.elapsedSeconds = startPosB;
    mixerStore.getPlayer('A')?.seek(startPosA);
    mixerStore.getPlayer('B')?.seek(startPosB);
  }

  // ALC-230 : une touche toggle ▶ LANCER A + B ⇄ ⏸ PAUSE A + B (aucune logique store modifiée).
  function toggleLaunchPause() {
    if (anyPlaying) mixerStore.pauseMashupLaunch();
    else launchBoth();
  }

  // ALC-198-1 : plus aucune boucle requestAnimationFrame à vide — les positions (playheadA/B) et les
// briques sont pilotées par la réactivité Svelte (mise à jour de elapsedSeconds via syncPlayback).
</script>
<div class="flex flex-col gap-space-xs flex-1 min-h-0 overflow-hidden">
  <!-- ALC-244-2 : bandeau statique « Mix Harmonique Optimal / Roue Verrouillée » RETIRÉ d'ici —
     il chevauchait la légende BASSES/VOIX/AIGUS sous le rail ZOOM ; le diagnostic harmonique
     est déjà affiché dans le grand bandeau supérieur de MixerCenter. -->
  <!-- ALC-229 : barre supérieure en 2 lignes alignées (rail Venezia) -->
  <div class="flex flex-col gap-1.5 px-space-sm">
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <div class="flex items-center gap-2 min-w-0">
        <span class="vz-rail-caption">Zoom</span>
        <div class="venezia-switch-rail">
          {#each ZOOMS as z (z)}
            <button type="button" class={zoom === z ? 'on' : ''} onclick={() => (zoom = z)}>{z} M</button>
          {/each}
        </div>
        <span class="vz-rail-caption">Cible</span>
        <div class="venezia-switch-rail">
          <button type="button" class={target === 'A' ? 'on' : ''} title="Grille cible : Platine A" onclick={() => (target = 'A')}><span class="vz-led-rail" style="--vz-led: var(--vz-ch-a);"></span>Platine A</button>
          <button type="button" class={target === 'B' ? 'on' : ''} onclick={() => (target = 'B')}><span class="vz-led-rail" style="--vz-led: var(--vz-ch-b);"></span>Platine B</button>
        </div>
        <button type="button" class="venezia-key h-7 px-2 text-[9px] font-bold uppercase tracking-wider text-[#e0a860]" onclick={() => mixerStore.anchorGrid(target)}>Caler 1</button>
        <button type="button" class="venezia-key h-7 w-6 text-[10px] text-outline" onclick={() => mixerStore.nudgeGrid(target, -15)}>◄</button>
        <button type="button" class="venezia-key h-7 w-6 text-[10px] text-outline" onclick={() => mixerStore.nudgeGrid(target, 15)}>►</button>
        <span class="vz-rail-caption">Courbe</span>
        <div class="venezia-switch-rail">
          <button type="button" class={mixerStore.beatgridTelemetryMode === 'tempo' ? 'on' : ''} onclick={() => mixerStore.setBeatgridTelemetryMode('tempo')}><span class="material-symbols-outlined vz-rail-icon" aria-hidden="true">show_chart</span>TEMPO</button>
          <button type="button" class={mixerStore.beatgridTelemetryMode === 'key' ? 'on' : ''} onclick={() => mixerStore.setBeatgridTelemetryMode('key')}><span class="material-symbols-outlined vz-rail-icon" aria-hidden="true">music_note</span>CLÉ</button>
        </div>
      </div>
    </div>
    <div class="flex items-center justify-between gap-2">
      <span class="font-mono text-[7px] uppercase tracking-widest text-outline/80 whitespace-nowrap"><span class="vz-legend-dot" style="background:#d97706;"></span> Basses • <span class="text-emerald-400">● Voix</span> • <span class="vz-legend-dot" style="background:#eab308;"></span> Aigus • <span class="text-emerald-300 flex items-center gap-1"><span class="venezia-led emerald inline-block"></span> Rythme Verrouillé ✓</span></span>
      <div class="flex items-center gap-1.5">
        <span title={mixerStore.lastMashupRecordingName ?? 'Durée cumulée de la session de mix'} class="venezia-key h-7 px-2 text-[10px] tabular-nums text-[#e0a860]">⏱ MIX {formatMixClock(mixerStore.globalMixElapsedSeconds)}<button type="button" onclick={() => mixerStore.resetGlobalMixClock()} class="text-[11px] leading-none hover:text-[#ffddb0]">↺</button></span>
        <button type="button" onclick={() => mixerStore.isRecordingMashup ? void mixerStore.stopAndSaveMashupRecording() : mixerStore.startMashupRecording()} title={mixerStore.lastMashupRecordingName ?? 'Enregistrer le mix Master (WAV 16-bit stéréo)'} class={`venezia-key h-7 px-2 text-[10px] font-bold uppercase tracking-widest ${mixerStore.isRecordingMashup ? 'text-[#ffb4ab] animate-pulse' : 'text-[#ffb4ab]'}`}>{mixerStore.isRecordingMashup ? '■ STOP & SAUVER' : '● REC MASHUP'}<span class={`venezia-led ${mixerStore.isRecordingMashup ? 'ruby' : ''} ml-1 inline-block`}></span></button>
      </div>
    </div>
  </div>

  <!-- Ruban A -->
  <div class="relative h-[115px] rounded-lg bg-[#120d0a] border border-[#10b981]/25 overflow-hidden" style="width:{WAVE_W}px;">
    <span class="absolute left-2 top-1 z-20 rounded border border-[#10b981]/50 bg-[#10b981]/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-widest text-[#34d399] pointer-events-none">PLATINE A • {deckVoicesLabel('A')}</span>
    {#if ostMarkersVisible('A')}
      <span class="absolute right-2 top-1 z-20 flex items-center gap-1 rounded border border-[#b87333]/60 bg-[#b87333]/20 px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-widest text-[#e0a860] pointer-events-none whitespace-nowrap"><span class="material-symbols-outlined text-[10px]" aria-hidden="true">movie</span>Profil Ost • Ancrage Climax</span>
      {#if ostDuckingActive}
        <span class="absolute right-2 top-4 z-20 rounded border border-[#b87333]/40 bg-[#120d0a]/90 px-1.5 py-0.5 font-mono text-[7px] font-bold tracking-widest text-[#ffddb0] pointer-events-none whitespace-nowrap">Ducking Orchestral 1.8 kHz Actif</span>
      {/if}
    {/if}
    <div class="absolute inset-y-0 left-1/2 w-[2px] bg-[#edbf7a] shadow-[0_0_6px_#edbf7a] z-30 pointer-events-none"></div>
    {#if target === 'A'}
      <div class="absolute top-0.5 left-1/2 -translate-x-1/2 z-40 font-mono text-[8px] font-bold text-[#edbf7a] bg-[#120d0a]/95 border border-[#edbf7a]/50 rounded px-1.5 py-0.5 pointer-events-none">MESURE {measureCart.measure}.{measureCart.beatIn}</div>
    {/if}
    {#if ostMarkersVisible('A') && markerXA}
      {#if markerXA.zoneWidth > 0}
        <div class="absolute inset-y-0 z-10 pointer-events-none bg-[#b87333]/10 border-y border-[#b87333]/25" style="left:{markerXA.zoneLeft}px;width:{markerXA.zoneWidth}px;"></div>
      {/if}
      {#if markerXA.entry >= -4 && markerXA.entry <= WAVE_W + 4}
        <div class="absolute top-0 z-30 pointer-events-none" style="left:{markerXA.entry}px;"><span class="vz-ost-marker vz-ost-entry">▼ Entrée Voix</span></div>
      {/if}
      {#if markerXA.climax >= -4 && markerXA.climax <= WAVE_W + 4}
        <div class="absolute top-0 z-30 pointer-events-none" style="left:{markerXA.climax}px;"><span class="vz-ost-marker">★ Climax Ost</span></div>
      {/if}
    {/if}
    <!-- ALC-246-3 : macro-respiration THÈME OST SOLO uniquement (plus aucun micro-repère PHRASE N) -->
    {#if ostMarkersVisible('A')}
      {#each breathSlotsA as bz (bz.key)}
        <div class="absolute inset-y-0 z-10 pointer-events-none" style="left:{bz.x0}px;width:{bz.width}px;"><div class="vz-breath-zone">{bz.label}</div></div>
      {/each}
    {/if}
    {#each measureTicks('A') as mm (mm.key)}
      <div class="absolute inset-y-0 w-px bg-[#edbf7a]/15 z-10 pointer-events-none" style="left:{mm.x / WAVE_W * 100}%;"></div>
      {#if mm.showLabel}
        <span class="absolute top-7 -translate-x-1/2 z-10 font-mono text-[11px] font-semibold leading-none text-[#ecd9ad]" style="left:{mm.x / WAVE_W * 100}%;">{mm.m}</span>
      {/if}
    {/each}
    {#each envelopeBars('A') as bar (bar.key)}
      <div class="absolute w-[2px] z-20 pointer-events-none" style="left:{bar.x}px;bottom:28px;height:{bar.h}px;background:linear-gradient(to bottom,#34d399 0%,rgba(16,185,129,0.12) 100%);border-top:1px solid rgba(52,211,153,0.85);"></div>
    {/each}
    <div class="absolute bottom-1 inset-x-1 h-6 z-20">
      {#each beatsFor('A') as bt (bt.key)}
        <span class="absolute rounded-full pointer-events-none {bt.beat === 1 ? 'w-2.5 h-2.5 bg-[#edbf7a] shadow-[0_0_6px_#edbf7a]' : 'w-1.5 h-1.5 bg-[#10b981]/70'}" style="left:{bt.x / WAVE_W * 100}%;bottom:{bt.beat === 1 ? '-2px' : '1px'};"></span>
      {/each}
    </div>
    <span class="absolute bottom-0.5 left-1 font-mono text-[6px] uppercase tracking-widest text-outline/60 pointer-events-none">1 2 3 4</span>
  </div>
<!-- ALC-224 : espace télémétrique Deck A (émeraude) -->
  <div class="relative h-11 rounded-lg bg-[#120d0a] border border-[#10b981]/20 overflow-hidden" style="width:{WAVE_W}px;opacity:{bandDim('A')};" title="Télémétrie Deck A • {telModeLabel}">
    <span class="absolute left-1.5 top-0.5 z-10 font-mono text-[7px] uppercase tracking-widest text-[#34d399] whitespace-nowrap pointer-events-none select-none">{telModeLabel} • A</span>
    <div class="absolute inset-x-1 z-0" style="top:22.5px;border-top:1px dashed rgba(150,170,180,0.25);"></div>
    <svg class="absolute inset-0 w-full h-full z-10 pointer-events-none" width={WAVE_W} height="48" viewBox={`0 0 ${WAVE_W} 48`} preserveAspectRatio="none"><polyline points={telPoly('A')} fill="none" stroke="rgba(16,185,129,0.9)" stroke-width="1.5" opacity="0.9" /></svg>
    {#if mixerStore.beatgridTelemetryMode === 'tempo'}
      {#if Math.abs(currentBpmTele('A') - refMeanBpm('A')) > 0.5}
        <span class="absolute left-1/2 -translate-x-1/2 top-0 z-20 font-mono text-[7px] text-[#ffb4ab] whitespace-nowrap pointer-events-none select-none">⚠</span>
      {/if}
      <span class="absolute left-1/2 -translate-x-[52px] bottom-1 z-20 rounded-lg border border-[#10b981]/50 bg-[#120d0a]/95 px-1.5 py-0.5 font-mono text-[9px] font-bold tabular-nums text-[#34d399] whitespace-nowrap pointer-events-none select-none">{currentBpmTele('A').toFixed(1)} BPM</span>
    {:else}
      {#if keyConflictReal}<span class="absolute left-1/2 -translate-x-1/2 top-0 z-20 font-mono text-[8px] text-[#b87333] whitespace-nowrap pointer-events-none select-none">⚠ Δ</span>{/if}
      <span class="absolute left-1/2 -translate-x-[44px] bottom-1 z-20 rounded-lg border border-[#10b981]/50 bg-[#120d0a]/95 px-1.5 py-0.5 font-mono text-[9px] font-bold text-[#34d399] whitespace-nowrap pointer-events-none select-none">{currentKeyTele('A').key}</span>
    {/if}
    <div class="absolute inset-y-0 left-1/2 w-[2px] bg-[#edbf7a] shadow-[0_0_6px_#edbf7a] z-30 pointer-events-none"></div>
  </div>
<!-- Ligne centrale de détection de conflit -->
  {#if conflict === 'fusion'}
    <div class="flex items-center justify-center gap-2 px-space-sm py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
      <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#10b981] shrink-0"></span>
      <span class="font-label-sm text-[8px] font-bold uppercase tracking-widest">✓ Fusion Parfaite • A (Instrumental) + B (Voix) — Zéro Conflit</span>
      {#if mixerStore.mashupStyleProfile === 'ost-cinema'}
        <span class="ml-1 inline-flex items-center gap-1 rounded border border-[#b87333]/50 bg-[#b87333]/15 px-1 py-0.5 font-label-sm text-[8px] font-bold tracking-widest text-[#e0a860] uppercase shrink-0 whitespace-nowrap"><span class="material-symbols-outlined text-[10px]" aria-hidden="true">movie</span>Profil Ost</span>
      {/if}
      {#if mixerStore.deckA.stemsCalibrated || mixerStore.deckB.stemsCalibrated}
        <span class="ml-1 inline-flex items-center gap-1 rounded border border-[#e0a860]/40 bg-[#e0a860]/10 px-1 py-0.5 font-label-sm text-[8px] font-bold tracking-widest text-[#f0cf8d] uppercase shrink-0 whitespace-nowrap" title="BPM (drums) & clé Camelot (other+bass) recalibrés par HTDemucs">✦ Calibré Stems</span>
      {/if}
    </div>
  {:else}
    <div class="flex items-center justify-center gap-2 px-space-sm py-0.5 rounded border border-[#b87333]/50 bg-[#b87333]/15 text-[#e0a860] animate-pulse">
      <span class="material-symbols-outlined text-[11px]">warning</span>
      <span class="font-label-sm text-[8px] font-bold uppercase tracking-widest">⚠ Conflit Voix Détecté</span>
    </div>
  {/if}

  <!-- ALC-243-1 : bandeau d'erreur de lecture remonté depuis deck.lastError (zéro échec silencieux) -->
  {#if mixerStore.deckA.lastError || mixerStore.deckB.lastError}
    <div class="flex items-center justify-between gap-2 px-space-sm py-1 rounded border border-red-500/40 bg-red-500/10">
      <span class="font-label-sm text-[8px] font-bold uppercase tracking-widest text-[#ffb4ab] whitespace-nowrap truncate">
        ⚠ {mixerStore.deckA.lastError ?? mixerStore.deckB.lastError}
      </span>
      <button type="button" onclick={() => { mixerStore.deckA.lastError = null; mixerStore.deckB.lastError = null; }} class="px-1.5 py-0.5 rounded border border-red-500/40 text-[8px] font-bold uppercase tracking-widest text-[#ffb4ab] hover:bg-red-500/10 shrink-0">✕</button>
    </div>
  {/if}

  <!-- ALC-222 : bandeau anti-collision vocale — deux voix actives en lecture → action rapide -->
  {#if anyVocalActive}
    <div class="flex items-center justify-between gap-2 px-space-sm py-1 rounded border border-[#b87333]/50 bg-[#b87333]/15">
      <span class="font-label-sm text-[8px] font-bold uppercase tracking-widest text-[#e0a860] whitespace-nowrap">⚠ Deux voix actives en même temps</span>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" onclick={() => mixerStore.toggleStemMute('A', 'vocals')} class="px-2 py-0.5 rounded border border-[#10b981]/50 text-[#10b981] text-[8px] font-bold uppercase tracking-widest whitespace-nowrap hover:bg-emerald-500/10">Couper Voix A</button>
        <button type="button" onclick={() => mixerStore.toggleStemMute('B', 'vocals')} class="px-2 py-0.5 rounded border border-[#38bdf8]/50 text-[#7dd3fc] text-[8px] font-bold uppercase tracking-widest whitespace-nowrap hover:bg-sky-500/10">Couper Voix B</button>
      </div>
    </div>
  {/if}

  <div class="flex justify-center py-0.5">
    <button type="button" onclick={() => void mixerStore.swapDecks()} disabled={!mixerStore.deckA.filePath && !mixerStore.deckB.filePath} title="Échanger les morceaux et réglages entre la Platine A et la Platine B" class="h-8 px-4 rounded bg-gradient-to-b from-[#edbf7a] to-[#9a6f2f] text-[#120d0a] text-[10px] font-bold uppercase tracking-widest whitespace-nowrap shadow-[0_2px_6px_rgba(0,0,0,0.7)] hover:brightness-110 disabled:opacity-40">⇄ INVERSER A ↔ B</button>
  </div>

  <!-- Ruban B -->
  <div class="relative h-[115px] rounded-lg bg-[#120d0a] border border-[#3b82f6]/25 overflow-hidden" style="width:{WAVE_W}px;">
    <span class="absolute left-2 top-1 z-20 rounded border border-[#38bdf8]/50 bg-[#38bdf8]/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-widest text-[#7dd3fc] pointer-events-none">PLATINE B • {deckVoicesLabel('B')}</span>
    {#if ostMarkersVisible('B')}
      <span class="absolute right-2 top-1 z-20 flex items-center gap-1 rounded border border-[#b87333]/60 bg-[#b87333]/20 px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-widest text-[#e0a860] pointer-events-none whitespace-nowrap"><span class="material-symbols-outlined text-[10px]" aria-hidden="true">movie</span>Profil Ost • Ancrage Climax</span>
      {#if ostDuckingActive}
        <span class="absolute right-2 top-4 z-20 rounded border border-[#b87333]/40 bg-[#120d0a]/90 px-1.5 py-0.5 font-mono text-[7px] font-bold tracking-widest text-[#ffddb0] pointer-events-none whitespace-nowrap">Ducking Orchestral 1.8 kHz Actif</span>
      {/if}
    {/if}
    <div class="absolute inset-y-0 left-1/2 w-[2px] bg-[#edbf7a] shadow-[0_0_6px_#edbf7a] z-30 pointer-events-none"></div>
    {#if target === 'B'}
      <div class="absolute top-0.5 left-1/2 -translate-x-1/2 z-40 font-mono text-[8px] font-bold text-[#edbf7a] bg-[#120d0a]/95 border border-[#edbf7a]/50 rounded px-1.5 py-0.5 pointer-events-none">MESURE {measureCart.measure}.{measureCart.beatIn}</div>
    {/if}
    {#if ostMarkersVisible('B') && markerXB}
      {#if markerXB.zoneWidth > 0}
        <div class="absolute inset-y-0 z-10 pointer-events-none bg-[#b87333]/10 border-y border-[#b87333]/25" style="left:{markerXB.zoneLeft}px;width:{markerXB.zoneWidth}px;"></div>
      {/if}
      {#if markerXB.entry >= -4 && markerXB.entry <= WAVE_W + 4}
        <div class="absolute top-0 z-30 pointer-events-none" style="left:{markerXB.entry}px;"><span class="vz-ost-marker vz-ost-entry">▼ Entrée Voix</span></div>
      {/if}
      {#if markerXB.climax >= -4 && markerXB.climax <= WAVE_W + 4}
        <div class="absolute top-0 z-30 pointer-events-none" style="left:{markerXB.climax}px;"><span class="vz-ost-marker">★ Climax Ost</span></div>
      {/if}
    {/if}
    <!-- ALC-246-3 : macro-respiration THÈME OST SOLO uniquement (plus aucun micro-repère PHRASE N) -->
    {#if ostMarkersVisible('B')}
      {#each breathSlotsB as bz (bz.key)}
        <div class="absolute inset-y-0 z-10 pointer-events-none" style="left:{bz.x0}px;width:{bz.width}px;"><div class="vz-breath-zone">{bz.label}</div></div>
      {/each}
    {/if}
    {#each measureTicks('B') as mm (mm.key)}
      <div class="absolute inset-y-0 w-px bg-[#edbf7a]/15 z-10 pointer-events-none" style="left:{mm.x / WAVE_W * 100}%;"></div>
      {#if mm.showLabel}
        <span class="absolute top-7 -translate-x-1/2 z-10 font-mono text-[11px] font-semibold leading-none text-[#ecd9ad]" style="left:{mm.x / WAVE_W * 100}%;">{mm.m}</span>
      {/if}
    {/each}
    {#each envelopeBars('B') as bar (bar.key)}
      <div class="absolute w-[2px] z-20 pointer-events-none" style="left:{bar.x}px;bottom:28px;height:{bar.h}px;background:linear-gradient(to bottom,#38bdf8 0%,rgba(56,189,248,0.12) 100%);border-top:1px solid rgba(56,189,248,0.85);"></div>
    {/each}
    <div class="absolute bottom-1 inset-x-1 h-6 z-20">
      {#each beatsFor('B') as bt (bt.key)}
        <span class="absolute rounded-full pointer-events-none {bt.beat === 1 ? 'w-2.5 h-2.5 bg-[#edbf7a] shadow-[0_0_6px_#edbf7a]' : 'w-1.5 h-1.5 bg-[#3b82f6]/70'}" style="left:{bt.x / WAVE_W * 100}%;bottom:{bt.beat === 1 ? '-2px' : '1px'};"></span>
      {/each}
    </div>
    <span class="absolute bottom-0.5 left-1 font-mono text-[6px] uppercase tracking-widest text-outline/60 pointer-events-none">1 2 3 4</span>
  </div>
<!-- ALC-224 : espace télémétrique Deck B (bleu électrique) -->
  <div class="relative h-11 rounded-lg bg-[#120d0a] border border-[#3b82f6]/20 overflow-hidden" style="width:{WAVE_W}px;opacity:{bandDim('B')};" title="Télémétrie Deck B • {telModeLabel}">
    <span class="absolute left-1.5 top-0.5 z-10 font-mono text-[7px] uppercase tracking-widest text-[#7dd3fc] whitespace-nowrap pointer-events-none select-none">{telModeLabel} • B</span>
    <div class="absolute inset-x-1 z-0" style="top:22.5px;border-top:1px dashed rgba(150,170,180,0.25);"></div>
    <svg class="absolute inset-0 w-full h-full z-10 pointer-events-none" width={WAVE_W} height="48" viewBox={`0 0 ${WAVE_W} 48`} preserveAspectRatio="none"><polyline points={telPoly('B')} fill="none" stroke="rgba(59,130,246,0.9)" stroke-width="1.5" opacity="0.9" /></svg>
    {#if mixerStore.beatgridTelemetryMode === 'tempo'}
      {#if Math.abs(currentBpmTele('B') - refMeanBpm('B')) > 0.5}
        <span class="absolute left-1/2 -translate-x-1/2 top-0 z-20 font-mono text-[7px] text-[#ffb4ab] whitespace-nowrap pointer-events-none select-none">⚠</span>
      {/if}
      <span class="absolute left-1/2 -translate-x-[52px] bottom-1 z-20 rounded-lg border border-[#3b82f6]/50 bg-[#120d0a]/95 px-1.5 py-0.5 font-mono text-[9px] font-bold tabular-nums text-[#7dd3fc] whitespace-nowrap pointer-events-none select-none">{currentBpmTele('B').toFixed(1)} BPM</span>
    {:else}
      {#if keyConflictReal}<span class="absolute left-1/2 -translate-x-1/2 top-0 z-20 font-mono text-[8px] text-[#b87333] whitespace-nowrap pointer-events-none select-none">⚠ Δ</span>{/if}
      <span class="absolute left-1/2 -translate-x-[44px] bottom-1 z-20 rounded-lg border border-[#3b82f6]/50 bg-[#120d0a]/95 px-1.5 py-0.5 font-mono text-[9px] font-bold text-[#7dd3fc] whitespace-nowrap pointer-events-none select-none">{currentKeyTele('B').key}</span>
    {/if}
    <div class="absolute inset-y-0 left-1/2 w-[2px] bg-[#edbf7a] shadow-[0_0_6px_#edbf7a] z-30 pointer-events-none"></div>
  </div>
<!-- Zone basse : PUPITRE horloger Venezia 1889 — ALC-230 -->
  <div class="venezia-chassis vz-pupitre flex flex-col">
    <!-- ROW 1 / ROW 2 : HOT CUES A|B puis LOOP A/B·TEMPS — 12 colonnes partagées + diviseur gravé -->
    <div class="relative grid grid-cols-12 gap-x-2 gap-y-1.5 min-w-0">
      <div class="vz-divider-v" aria-hidden="true"></div>

      <!-- HOT CUES A (cols 1-6, émeraude) -->
      <div class="col-span-6 flex flex-col gap-1 min-w-0" style="--vz-cue: var(--vz-ch-a);">
        <span class="vz-group-caption" style="color: var(--vz-cue);">Hot Cues A</span>
        <div class="grid grid-cols-2 gap-1 min-w-0">
          {#each CUES as label, i (label)}
            <div class="vz-cuepad">
              <button
                type="button"
                class="vz-cue-set"
                data-set={mixerStore.deckA.hotCues[i] >= 0 || undefined}
                data-live={cuePlaying('A', i) || undefined}
                aria-disabled={!mixerStore.deckA.filePath || undefined}
                title={mixerStore.deckA.hotCues[i] >= 0 ? `Re-poser ${label} à ${cueTime('A', i)}` : `Poser ${label}`}
                onclick={() => { if (mixerStore.deckA.filePath) mixerStore.setHotCue('A', i); }}
              >
                <span class="vz-led-cue" data-on={mixerStore.deckA.hotCues[i] >= 0 || undefined}></span>
                <span class="vz-cue-name">{i + 1}-{label}</span>
                {#if mixerStore.deckA.hotCues[i] >= 0}<span class="vz-cue-time">{cueTime('A', i)}</span>{/if}
              </button>
              <button
                type="button"
                class="vz-cue-play"
                aria-label={`Rappeler ${label}`}
                title={`Rappeler ${label}${mixerStore.deckA.hotCues[i] >= 0 ? ' à ' + cueTime('A', i) : ''}`}
                aria-disabled={mixerStore.deckA.hotCues[i] < 0 || !mixerStore.deckA.filePath || undefined}
                onclick={() => mixerStore.recallHotCue('A', i)}
              ><span class="material-symbols-outlined vz-cue-play-ico" aria-hidden="true">play_arrow</span></button>
            </div>
          {/each}
        </div>
      </div>

      <!-- HOT CUES B (cols 7-12, bleu électrique) -->
      <div class="col-span-6 flex flex-col gap-1 min-w-0" style="--vz-cue: var(--vz-ch-b);">
        <span class="vz-group-caption" style="color: var(--vz-cue);">Hot Cues B</span>
        <div class="grid grid-cols-2 gap-1 min-w-0">
          {#each CUES as label, i (label)}
            <div class="vz-cuepad">
              <button
                type="button"
                class="vz-cue-set"
                data-set={mixerStore.deckB.hotCues[i] >= 0 || undefined}
                data-live={cuePlaying('B', i) || undefined}
                aria-disabled={!mixerStore.deckB.filePath || undefined}
                title={mixerStore.deckB.hotCues[i] >= 0 ? `Re-poser ${label} à ${cueTime('B', i)}` : `Poser ${label}`}
                onclick={() => { if (mixerStore.deckB.filePath) mixerStore.setHotCue('B', i); }}
              >
                <span class="vz-led-cue" data-on={mixerStore.deckB.hotCues[i] >= 0 || undefined}></span>
                <span class="vz-cue-name">{i + 1}-{label}</span>
                {#if mixerStore.deckB.hotCues[i] >= 0}<span class="vz-cue-time">{cueTime('B', i)}</span>{/if}
              </button>
              <button
                type="button"
                class="vz-cue-play"
                aria-label={`Rappeler ${label}`}
                title={`Rappeler ${label}${mixerStore.deckB.hotCues[i] >= 0 ? ' à ' + cueTime('B', i) : ''}`}
                aria-disabled={mixerStore.deckB.hotCues[i] < 0 || !mixerStore.deckB.filePath || undefined}
                onclick={() => mixerStore.recallHotCue('B', i)}
              ><span class="material-symbols-outlined vz-cue-play-ico" aria-hidden="true">play_arrow</span></button>
            </div>
          {/each}
        </div>
      </div>

      <!-- LOOP A · TEMPS (cols 1-6) -->
      <div class="col-span-6 flex flex-col gap-1 min-w-0">
        <span class="vz-group-caption">Loop A · Temps</span>
        <div class="flex items-stretch gap-1 min-w-0">
          {#each LOOPS as l (l)}
            <VzKey size="sm" tier="ghost" pressed={mixerStore.deckA.loopBeats === l} ledColor="var(--vz-ch-a)" disabled={!mixerStore.deckA.filePath} reason="Charger la platine A" onclick={() => mixerStore.setLoop('A', l)}>{l === 0.5 ? '½' : l}</VzKey>
          {/each}
          <VzKey size="sm" tier="ghost" icon="close" ariaLabel="Sortir de la boucle" disabled={mixerStore.deckA.loopBeats === null} reason="Aucune boucle active" onclick={() => mixerStore.setLoop('A', null)}></VzKey>
        </div>
      </div>

      <!-- LOOP B · TEMPS (cols 7-12) -->
      <div class="col-span-6 flex flex-col gap-1 min-w-0">
        <span class="vz-group-caption">Loop B · Temps</span>
        <div class="flex items-stretch gap-1 min-w-0">
          {#each LOOPS as l (l)}
            <VzKey size="sm" tier="ghost" pressed={mixerStore.deckB.loopBeats === l} ledColor="var(--vz-ch-b)" disabled={!mixerStore.deckB.filePath} reason="Charger la platine B" onclick={() => mixerStore.setLoop('B', l)}>{l === 0.5 ? '½' : l}</VzKey>
          {/each}
          <VzKey size="sm" tier="ghost" icon="close" ariaLabel="Sortir de la boucle" disabled={mixerStore.deckB.loopBeats === null} reason="Aucune boucle active" onclick={() => mixerStore.setLoop('B', null)}></VzKey>
        </div>
      </div>
    </div>
    <!-- Règle gravée -->
    <div class="vz-rule"></div>

    <!-- 01 · PRÉPARER -->
    <div class="flex flex-col gap-1.5 min-w-0">
      <div class="vz-group-head">
        <span class="vz-group-caption">01 · Préparer</span>
        <span class="vz-rule flex-1"></span>
        {#if needAB}<span id={reqAbPreparer} class="vz-required">Requiert A + B</span>{/if}
      </div>
      <div class="grid grid-cols-[2fr_0.7fr_0.7fr_1fr_1fr] gap-2 min-w-0">
        <VzKey tier="secondary" icon="straighten" disabled={needAB} reason="Charger les platines A et B" reasonId={reqAbPreparer} onclick={() => { mixerStore.alignTempoAndPhase(); flashConfirm(); }}>Aligner Tempo &amp; Phase</VzKey>
        <!-- ALC-253-3 : Beat Nudge ±1 temps — recalage vocal instantané sans couper le son -->
        <VzKey tier="ghost" icon="fast_rewind" disabled={needAB} reason="Recalage vocal −1 temps (Beat Nudge)" reasonId={reqAbPreparer} onclick={() => { mixerStore.nudgeVocalPhaseBeats(-1); flashConfirm(); }}>◄ −1T</VzKey>
        <VzKey tier="ghost" icon="fast_forward" disabled={needAB} reason="Recalage vocal +1 temps (Beat Nudge)" reasonId={reqAbPreparer} onclick={() => { mixerStore.nudgeVocalPhaseBeats(1); flashConfirm(); }}>+1T ►</VzKey>
        <VzKey tier="ghost" icon="replay" disabled={!startSaved} reason="Lancer A + B d'abord" onclick={returnToCue}>Retour Calage</VzKey>
        <VzKey tier="ghost" icon="restart_alt" disabled={!mixerStore.deckA.filePath && !mixerStore.deckB.filePath} reason="Charger au moins une platine" reasonId={needAB ? reqAbPreparer : undefined} onclick={() => { mixerStore.resetDeckStems('BOTH'); flashReset(); }}>Reset Stems</VzKey>
      </div>
      {#if alignedFlash}<span class="vz-flash">✓ Tempo &amp; phase alignés</span>{/if}
      {#if resetFlash}<span class="vz-flash">✓ Stems réinitialisés</span>{/if}
    </div>
    <!-- 02 · JOUER -->
    <div class="flex flex-col gap-1.5 min-w-0">
      <div class="vz-group-head">
        <span class="vz-group-caption">02 · Jouer</span>
        <span class="vz-rule flex-1"></span>
        {#if needAB}<span id={reqAbJouer} class="vz-required">Requiert A + B</span>{/if}
      </div>
      <div class="grid grid-cols-[2fr_1fr_1fr_1fr] gap-2 min-w-0">
        <VzKey tier="secondary" icon={launchPressed ? 'pause' : 'play_arrow'} ledColor="var(--vz-brass-text)" pressed={launchPressed} disabled={needAB} reason="Charger les platines A et B" reasonId={reqAbJouer} onclick={toggleLaunchPause}>{launchPressed ? 'Pause A + B' : 'Lancer A + B'}</VzKey>
        <VzKey tier="ghost" icon="record_voice_over" pressed={autoVoxPressed} disabled={needAB} reason="Charger les platines A et B" reasonId={reqAbJouer} onclick={() => mixerStore.launchAutoVocalSync()}>Auto Voix</VzKey>
        <VzKey tier="ghost" icon="mic" pressed={instVoixPressed} disabled={needAB} reason="Charger les platines A et B" reasonId={reqAbJouer} onclick={manualHandler}>Inst → Voix</VzKey>
        <VzKey tier="ghost" icon="sync_alt" pressed={relayPressed} disabled={mixerStore.deckA.stemsStatus !== 'ready' || mixerStore.deckB.stemsStatus !== 'ready'} reason="Préparer les stems (extraction IA) sur A et B" onclick={() => mixerStore.toggleVocalRelayStep()}>{relayButtonLabel.replace(/^[⇄⏳] */, '')}</VzKey>
      </div>
    </div>
    <!-- 03 · MASHUP 1-CLIC -->
    <div class="flex flex-col gap-1.5 min-w-0">
      <div class="vz-group-head">
        <span class="vz-group-caption">03 · Mashup 1‑Clic</span>
        <span class="vz-rule flex-1"></span>
        {#if needAB}<span id={reqAbMashup} class="vz-required">Requiert A + B</span>{/if}
      </div>
      <div class="grid grid-cols-[2fr_1fr] gap-2 min-w-0 items-stretch">
        <div class="flex items-stretch gap-2 min-w-0">
          <div class="flex-1 min-w-0">
            <VzKey
              expand
              tier="hero"
              icon="auto_awesome"
              ledColor="var(--vz-brass-hi)"
              disabled={needAB || mashRunning}
              loading={mashRunning}
              loadingValue={mashProgress}
              ready={bothLoaded && !mashRunning}
              reason={mashRunning ? 'Mashup en cours — Annuler pour reprendre la main' : 'Charger les platines A et B'}
              reasonId={needAB ? reqAbMashup : undefined}
              onclick={() => void mixerStore.runFullAutoMashup(autoMashupMode, false)}
            >{mashRunning ? `Étape ${mixerStore.autoMashupPipelineState.stepIndex}/5 · Auto-Mashup 1‑Clic` : 'Auto-Mashup 1‑Clic'}</VzKey>
          </div>
          {#if mashRunning || mixerStore.autoMashupPipelineState.readyToSaveDuo}
            <VzKey tier="ghost" icon={mashRunning ? 'close' : 'star'} ariaLabel={mashRunning ? 'Annuler le mashup en cours' : 'Sauvegarder le duo'} onclick={mashRunning ? () => mixerStore.cancelFullAutoMashup() : () => mixerStore.saveCurrentAutoMashupDuo()}>{mashRunning ? 'Annuler' : 'Sauvegarder Duo'}</VzKey>
          {/if}
        </div>
        <div class="flex flex-col gap-1 min-w-0">
          <div class="flex items-center justify-between gap-1 min-w-0">
            <span class="vz-group-caption">Recette</span>
            <div class="venezia-switch-rail vz-profile-rail" role="group" aria-label="Profil mashup">
              <button type="button" class={mixerStore.mashupStyleProfile === 'standard' ? 'on' : ''} title={mixerStore.ostProfileManual ? 'Profil club standard (choix manuel)' : 'Profil club standard'} onclick={() => mixerStore.setMashupStyleProfile('standard')}>Club</button>
              <button type="button" class={mixerStore.mashupStyleProfile === 'ost-cinema' ? 'on' : ''} title={mixerStore.ostProfileManual ? 'Profil OST / Cinéma — ducking orchestral + ancrage de climax (choix manuel)' : 'Profil OST / Cinéma — ducking orchestral + ancrage de climax (détecté automatiquement par le genre de la piste)'} onclick={() => mixerStore.setMashupStyleProfile('ost-cinema')}><span class="material-symbols-outlined vz-rail-icon" aria-hidden="true">movie</span>Ost</button>
            </div>
          </div>
          <div class="venezia-switch-rail flex-1" title={mixerStore.mashupRecipeReason || 'Recette Mashup — la télémétrie HTDemucs recommande automatiquement le meilleur contraste vocal/instrumental'}>
            <button type="button" class={autoMashupMode === 'instA_vocB' ? 'on' : ''} onclick={() => { mixerStore.mashupRecipeManual = true; autoMashupMode = 'instA_vocB'; }} title="Forcer : Instrumentale A + Voix B (recette verrouillée manuellement)">A:INST + B:VOIX</button>
            <button type="button" class={autoMashupMode === 'vocA_instB' ? 'on' : ''} onclick={() => { mixerStore.mashupRecipeManual = true; autoMashupMode = 'vocA_instB'; }} title="Forcer : Voix A + Instrumentale B (recette verrouillée manuellement)">A:VOIX + B:INST</button>
          </div>
        </div>
      </div>
    </div>

    {#if !mashRunning && mixerStore.autoMashupPipelineState.stepLabel !== 'INACTIF'}
      <div class="flex items-center gap-2 px-space-sm py-1 rounded-lg border border-[#edbf7a]/30 bg-[#edbf7a]/10">
        <span class="font-mono text-[9px] font-bold uppercase tracking-widest text-[#e0a860] whitespace-nowrap tabular-nums">{mixerStore.autoMashupPipelineState.stepLabel}</span>
      </div>
    {/if}

    <!-- ALC-227 : relais bidirectionnel armé (attente de la prochaine strophe) -->
    {#if mixerStore.vocalRelayState.pendingTarget !== null}
      <div class="flex items-center justify-between gap-2 px-space-sm py-1 rounded-lg border border-[#edbf7a]/40 bg-[#edbf7a]/10">
        <span class="font-mono text-[10px] font-bold uppercase tracking-widest text-[#e0a860] whitespace-nowrap tabular-nums">VOIX {mixerStore.vocalRelayState.pendingTarget} À {formatTime(mixerStore.vocalRelayState.triggerAtSeconds ?? 0)}</span>
        <button type="button" onclick={() => mixerStore.toggleVocalRelayStep()} title={`Voix de ${mixerStore.vocalRelayState.pendingTarget} coupée — reprise à la prochaine strophe (re-cliquer pour forcer maintenant)`} class="px-2 py-1 rounded bg-gradient-to-b from-[#edbf7a] to-[#9a6f2f] text-[#120d0a] text-[10px] font-bold uppercase tracking-widest whitespace-nowrap animate-pulse shadow-[0_2px_6px_rgba(0,0,0,0.7)] hover:brightness-110">Forcer maintenant</button>
      </div>
    {/if}
    <!-- ALC-219 : repère temporel vocal A → B lisible en direct (mode ⚡ Auto Voix sync BPM) -->
    {#if mixerStore.mashupLaunchState.mode === 'auto-vocal-wait'}
      <div class="flex items-center gap-2 font-mono text-[9px] tabular-nums whitespace-nowrap">
        <span class="text-emerald-300">Entrée Voix A · {formatTime(mixerStore.mashupLaunchState.targetEntrySeconds ?? 0)}</span>
        <span class="text-outline">→</span>
        <span class="text-[#7dd3fc]">Départ Voix B · {formatTime(mixerStore.mashupLaunchState.vocalStartSeconds ?? 0)}</span>
        <span class="ml-1 inline-flex items-center gap-0.5 rounded border border-[#10b981]/40 bg-[#10b981]/10 px-1 text-emerald-300"><span class="material-symbols-outlined vz-bolt" aria-hidden="true">bolt</span>ALIGNÉ</span>
      </div>
    {/if}
  </div>
</div>

<style>
  /* ALC-229 : primitives horlogères Venezia 1889 — zéro bouton web plat. */
  .venezia-chassis {
    position: relative;
    background: linear-gradient(180deg, #16110e 0%, #100c09 100%);
    border: 1px solid #544738;
    border-radius: 4px;
    box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.85), 0 1px 0 rgba(237, 191, 122, 0.08);
    padding: 8px;
  }
  /* micro-rivets laiton dans les angles supérieurs */
  .venezia-chassis::before,
  .venezia-chassis::after {
    content: '';
    position: absolute;
    top: 4px;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 35%, #a88a4f, #5c4a2c);
    box-shadow: 0 0 2px rgba(237, 191, 122, 0.5);
  }
  .venezia-chassis::before { left: 5px; }
  .venezia-chassis::after { right: 5px; }

  .venezia-key {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 2rem;
    border-radius: 3px;
    background: linear-gradient(180deg, #2b231d 0%, #17120e 100%);
    border: 1px solid #665643;
    box-shadow: inset 0 1px 0 rgba(237, 191, 122, 0.32), 0 2px 4px rgba(0, 0, 0, 0.75);
    transition: transform 0.05s ease, filter 0.1s ease, box-shadow 0.1s ease;
    cursor: pointer;
  }
  .venezia-key:active {
    transform: translateY(1px);
    box-shadow: inset 0 1px 0 rgba(237, 191, 122, 0.32), 0 1px 2px rgba(0, 0, 0, 0.6);
  }
  .venezia-key:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    filter: saturate(0.4);
  }
  /* cabochon LED serti */
  .venezia-led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1px solid #3d3328;
    box-shadow: inset 0 0 2px rgba(0, 0, 0, 0.8);
  }
  .venezia-led.on {
    border-color: #edbf7a;
    background: radial-gradient(circle at 35% 30%, #ffddb0, #b8862f);
    box-shadow: 0 0 6px rgba(237, 191, 122, 0.75);
  }
  .venezia-led.emerald { background: radial-gradient(circle at 35% 30%, #4ff0b0, #0e7a4e); border-color: #10b981; box-shadow: 0 0 6px rgba(16, 185, 129, 0.7); }
  .venezia-led.ruby { background: radial-gradient(circle at 35% 30%, #ff8b76, #a21c10); border-color: #ef4444; box-shadow: 0 0 6px rgba(239, 68, 68, 0.7); }

  .venezia-switch-rail {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    background: #0f0b09;
    border: 1px solid #4a3e31;
    border-radius: 4px;
    box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.85);
  }
  .venezia-switch-rail button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 1.4rem;
    padding: 0 6px;
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    white-space: nowrap;
    color: #6f6452;
    border: 1px solid transparent;
    cursor: pointer;
    transition: all 0.12s ease;
  }
  .venezia-switch-rail button.on {
    color: #120d0a;
    background: linear-gradient(180deg, #f0cc88 0%, #9a6f2f 100%); /* curseur laiton doré gravé */
    border-color: #edbf7a;
    box-shadow: 0 0 6px rgba(237, 191, 122, 0.45), inset 0 1px 0 rgba(255, 240, 200, 0.7);
  }

  /* ═══════════ ALC-230 : pupitre horloger & primitives Venezia 1889 ═══════════ */
  .vz-pupitre { padding: 10px 12px 8px; gap: 8px; }
  .vz-divider-v {
    position: absolute;
    left: 50%;
    top: -2px;
    bottom: -2px;
    width: 1px;
    transform: translateX(-50%);
    background: #0f0b09;
    box-shadow: 1px 0 0 rgba(237, 191, 122, 0.08);
  }
  .vz-group-caption {
    font-family: var(--font-label-sm, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.14em;
    line-height: 1.2;
    white-space: nowrap;
    text-transform: uppercase;
    color: var(--vz-text-caption);
  }
  .vz-group-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .vz-rule { display: block; height: 1px; background: #0f0b09; box-shadow: 0 1px 0 rgba(237, 191, 122, 0.08); }
  .vz-required {
    font-family: var(--font-label-sm, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.1em;
    white-space: nowrap;
    text-transform: uppercase;
    color: var(--vz-text-caption);
  }
  .vz-flash {
    font-family: var(--font-label-sm, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--vz-ch-a);
  }

  /* Rails supérieurs : captions lisibles + LED sur le segment CIBLE + icônes Material */
  .vz-rail-caption {
    font-family: var(--font-label-sm, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.14em;
    white-space: nowrap;
    text-transform: uppercase;
    color: var(--vz-text-caption);
  }
  .vz-rail-icon { font-size: 13px; margin-right: 2px; }
  .vz-led-rail {
    display: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--vz-led, var(--vz-brass-text));
    box-shadow: 0 0 6px var(--vz-led, var(--vz-brass-text));
    margin-right: 4px;
  }
  .venezia-switch-rail button.on .vz-led-rail { display: inline-block; }
  .vz-legend-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; vertical-align: -1px; box-shadow: 0 0 4px currentColor; }
  .vz-bolt { font-size: 11px; }

  /* ALC-231 : micro-bascule « CLUB | OST » (profil mashup) — compacte, même ligne que la légende Recette */
  .vz-profile-rail { height: 22px; }
  .vz-profile-rail button { height: 18px; font-size: 8px; letter-spacing: 0.08em; padding: 0 6px; }

  /* ALC-231 : repère doré « CLIMAX OST » posé sur la waveform de la platine instrumentale */
  .vz-ost-marker {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 6px;
    font-family: var(--font-label-sm, ui-monospace, monospace);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--vz-ink-on-brass);
    background: linear-gradient(180deg, var(--vz-brass-hi) 0%, var(--vz-brass-lo) 100%);
    border: 1px solid #8c6d3f;
    border-radius: 4px;
    box-shadow: 0 0 8px rgba(237, 191, 122, 0.55), inset 0 1px 0 rgba(255, 240, 200, 0.6);
  }
  /* ALC-231 : variante marqueur d'entrée voix (ambre plus clair que le climax doré) */
  .vz-ost-marker.vz-ost-entry {
    background: linear-gradient(180deg, #f0d9a8 0%, #c8a05c 100%);
    border-color: #9c7a45;
  }
  /* ALC-238-2 : cartouche doré compact des strophes vocal recalées sur la grille OST 1.0x */
  .vz-stanza-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 5px;
    font-family: var(--font-label-sm, ui-monospace, monospace);
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    color: #120d0a;
    background: linear-gradient(180deg, #f5deac 0%, #c89a4e 100%);
    border: 1px solid #8c6d3f;
    border-radius: 3px;
    box-shadow: 0 0 6px rgba(237, 191, 122, 0.5), inset 0 1px 0 rgba(255, 240, 200, 0.65);
  }
  /* ALC-238-3 : fenêtre de respiration orchestrale (zone ambrée hachurée, voix coupée) */
  .vz-breath-zone {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
    font-family: var(--font-label-sm, ui-monospace, monospace);
    font-size: 7px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
    color: rgba(224, 168, 96, 0.95);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
    background:
      repeating-linear-gradient(135deg, rgba(237, 191, 122, 0.1) 0px, rgba(237, 191, 122, 0.1) 4px, rgba(24, 16, 10, 0) 4px, rgba(24, 16, 10, 0) 8px),
      rgba(184, 115, 51, 0.14);
    border-left: 1px solid rgba(184, 115, 51, 0.4);
    border-right: 1px solid rgba(184, 115, 51, 0.4);
    box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.35);
  }

  /* Pads Hot Cue composés : segment [LED + nom + mm:ss] | [▶ 32 px couleur canal] */
  .vz-cuepad {
    display: grid;
    grid-template-columns: 1fr 32px;
    height: var(--vz-key-h);
    border: 1px solid var(--vz-key-edge);
    border-radius: var(--vz-radius);
    overflow: hidden;
    min-width: 0;
    box-shadow: var(--vz-sh-raised);
    isolation: isolate;
  }
  .vz-cue-set {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 0 8px;
    border: 0;
    border-right: 1px solid #3a3027;
    border-radius: 0;
    background: linear-gradient(180deg, var(--vz-key-top), var(--vz-key-bottom));
    color: var(--vz-text-mid);
    font-family: var(--font-label-sm, ui-monospace, monospace);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    cursor: pointer;
    transition: filter var(--vz-t-hover) var(--vz-ease), background-color var(--vz-t-led) var(--vz-ease);
  }
  .vz-cue-set:hover { filter: brightness(1.08); }
  .vz-cue-set[data-set='true'] { color: var(--vz-cue, var(--vz-text-hi)); }
  .vz-cue-set[data-live='true'] { background: linear-gradient(180deg, #120d0a, #1d1611); }
  .vz-cue-set[aria-disabled='true'] { cursor: not-allowed; color: var(--vz-text-disabled); background: var(--vz-disabled-bg); filter: saturate(0.5); }
  .vz-cue-name { overflow: hidden; text-overflow: ellipsis; }
  .vz-cue-time { font-size: 9px; font-variant-numeric: tabular-nums; opacity: 0.85; margin-left: auto; white-space: nowrap; }
  .vz-cue-play {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    min-width: 32px;
    border: 0;
    border-radius: 0;
    background: linear-gradient(180deg, var(--vz-key-top), var(--vz-key-bottom));
    color: var(--vz-cue, var(--vz-brass-text));
    cursor: pointer;
    transition: filter var(--vz-t-hover) var(--vz-ease);
  }
  .vz-cue-play:hover { filter: brightness(1.15); }
  .vz-cue-play[aria-disabled='true'] { cursor: not-allowed; color: var(--vz-text-disabled); filter: saturate(0.3); }
  .vz-cue-play-ico { font-size: 13px; }
  .vz-led-cue {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
    background: #241d17;
    border: 1px solid #3d3328;
    box-shadow: inset 0 0 2px rgba(0, 0, 0, 0.9);
    transition: background-color var(--vz-t-led) var(--vz-ease), opacity var(--vz-t-led) var(--vz-ease);
  }
  .vz-led-cue[data-on='true'] {
    background: var(--vz-cue, var(--vz-brass-text));
    border-color: var(--vz-cue, var(--vz-brass-text));
    box-shadow: 0 0 6px var(--vz-cue, var(--vz-brass-text));
  }

  /* Mode compact (hauteurs d'écran réduites) : pupitre resserré, rubans ≥ 110 px conservés */
  @media (max-height: 900px) {
    .vz-pupitre { padding: 10px; gap: 8px; }
    .venezia-chassis { padding: 6px; }
  }
</style>