<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { mixerStore, type DeckId } from '$lib/stores/mixer.svelte';
  import BridgeSuggester from './BridgeSuggester.svelte';

  // ALC-142 : atelier Beatgrid (maquette Alchemix2 0.7).
  // Rendu temporel cohérent : chaque barre est placée par son temps réel, la grille hiérarchisée,
  // les repères Hot Cues et les marqueurs de boucle partagent exactement la même échelle (px / s).
  const WAVE_W = 640;
  // ALC-148 / ALC-149 : hauteur des 2 formes d'onde principales (200 px) pour rendre
  // transitoires, sub-basses et repères de grille bien plus lisibles. Source unique
  // (markup + draw) ; le canvas reste recentré sur layout selon devicePixelRatio.
  const WAVE_H = 200;
  // ALC-149 : hauteur des 2 pistes télémétriques dédiées (TEMPO / CLÉS), agrandie (60 px)
  // pour une lecture à distance de la courbe BPM, de la médiane et des blocs Camelot.
  const TELE_H = 60;
  const NBARS = 213; // barres d'enveloppe (2 px de large, ~1 px d'écart → densité HD sur WAVE_W)
  const BAR_W = WAVE_W / NBARS;
  const CUES = ['INTRO', 'DROP', 'ACAP', 'OUTRO'];
  const LOOPS = [0.5, 1, 4, 8, 16];

  let target = $state<DeckId>('A');
  let zoom = $state<number>(16);
  const ZOOMS = [4, 8, 16] as const;
  let scrollA = $state(0);
  let scrollB = $state(0);
  let raf = 0;
  // ALC-161 : lecture synchronisée A+B — positions de départ mémorisées pour le retour au calage.
  let syncedPlaying = $state(false);
  let startPosA = $state(0);
  let startPosB = $state(0);
  let startSaved = $state(false);
  // ALC-146 : canvases waveform 2D haute densité (devicePixelRatio) animés à 60 fps.
  let canvasA: HTMLCanvasElement | null = $state(null);
  let canvasB: HTMLCanvasElement | null = $state(null);
  // ALC-147 : canvases des 2 pistes télémétriques dédiées (TEMPO / CLÉS) sous les ondes principales.
  let teleCanvasA: HTMLCanvasElement | null = $state(null);
  let teleCanvasB: HTMLCanvasElement | null = $state(null);
  // ALC-146 : aide à la recherche du segment (RMS/tempo/clé) couvrant un instant donné.
  const segAt = (id: DeckId, t: number) =>
    (id === 'A' ? mixerStore.deckSegmentsA : mixerStore.deckSegmentsB).find(
      (s) => t >= s.startSec && t <= s.endSec
    ) || null;

  const deckOf = (id: DeckId) => mixerStore.getDeck(id);
  const effBpmOf = (id: DeckId) =>
    (id === 'A' ? mixerStore.effectiveBpmA : mixerStore.effectiveBpmB) || 120;

  // ALC-149 : normalise le tempo local d'un segment dans l'octave du BPM global de la platine.
  // Bornes 0.75×global ≤ local ≤ 1.35×global (division/multiplication par 2) pour éliminer
  // les écarts d'octave (ex. 240.0 BPM affiché au lieu de 117.2 BPM).
  function normOctaveBpm(local: number, globalBpm: number): number {
    let v = local || globalBpm || 120;
    const g = globalBpm || 120;
    let guard = 0;
    while (v < 0.75 * g && guard < 8) { v *= 2; guard++; }
    guard = 0;
    while (v > 1.35 * g && guard < 8) { v /= 2; guard++; }
    return Math.round(v * 10) / 10;
  }

  // Temps d'un temps de grille (tient compte du correcteur d'octave ÷2/×2) et vitesse de défilement.
  const beatSecA = $derived(60 / (effBpmOf('A') * deckOf('A').gridOctave || effBpmOf('A')));
  const beatSecB = $derived(60 / (effBpmOf('B') * deckOf('B').gridOctave || effBpmOf('B')));
  const strideA = $derived(WAVE_W / ((zoom * 4 * beatSecA) || 1));
  const strideB = $derived(WAVE_W / ((zoom * 4 * beatSecB) || 1));

  // Position de lecture sur la grille (soustrait le décalage d'ancrage SET 1.1).
  const playheadA = $derived(deckOf('A').elapsedSeconds - (deckOf('A').gridOffsetMs || 0) / 1000);
  const playheadB = $derived(deckOf('B').elapsedSeconds - (deckOf('B').gridOffsetMs || 0) / 1000);

  interface WaveBar { x: number; h: number; peak: boolean }
  interface GridLine { key: number; x: number; cls: 'gold' | 'bar' | 'beat' }

  // ALC-145 : norme de référence (92e percentile) pour révéler la dynamique réelle
  // sans plafonner les barres à 100 % (le kick, le snare et le break restent distinguables).
  function normRef(peaks: number[]): number {
    if (!peaks.length) return 1;
    const sorted = Array.from(peaks).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.92))] || 1;
  }

  // Barres d'enveloppe réelles, ré-échantillonnées de waveformPeaks sur la fenêtre visible.
  // Compression douce ^(1/1.6) pour donner du contraste aux transitoires sans écrasement.
  function visibleBars(peaks: number[], duration: number, stride: number, scroll: number, norm: number): WaveBar[] {
    if (!peaks.length || duration <= 0 || stride <= 0) return [];
    const t0 = scroll / stride;
    const out: WaveBar[] = [];
    for (let i = 0; i < NBARS; i++) {
      const fracT = t0 + (scroll + (i + 0.5) * BAR_W) / stride - t0;
      const frac = Math.min(1, Math.max(0, fracT / duration));
      const idx = Math.min(peaks.length - 1, Math.max(0, Math.floor(frac * peaks.length)));
      const raw = Math.max(0.03, peaks[idx] || 0.03);
      const scaled = Math.pow(Math.min(1, raw / Math.max(1e-6, norm)), 1 / 1.6);
      out.push({ x: i * BAR_W, h: Math.max(0.06, Math.min(0.92, scaled)), peak: scaled > 0.66 });
    }
    return out;
  }

  // Grille rythmique hiérarchisée : traits dorés toutes les 4 mesures, moyens sur les downbeats, fins sur les temps.
  function gridFor(playhead: number, stride: number, bs: number): GridLine[] {
    if (bs <= 0 || stride <= 0) return [];
    const k0 = Math.floor(playhead / bs);
    const rows: GridLine[] = [];
    for (let k = -20; k <= 20; k++) {
      const t = (k0 + k) * bs;
      const x = (t - playhead) * stride + WAVE_W / 2;
      if (x < -6 || x > WAVE_W + 6) continue;
      const beatIdx = Math.floor(Math.round(t / bs));
      const inBar = ((beatIdx % 4) + 4) % 4;
      const inSuper = ((Math.floor(Math.abs(beatIdx) / 4) % 4) + 4) % 4;
      const cls: GridLine['cls'] = inBar === 0 && inSuper === 0 ? 'gold' : inBar === 0 ? 'bar' : 'beat';
      rows.push({ key: beatIdx, x, cls });
    }
    return rows.sort((a, b) => a.x - b.x);
  }

  const normA = $derived(normRef(mixerStore.deckA.waveformPeaks || []));
  const normB = $derived(normRef(mixerStore.deckB.waveformPeaks || []));
  const barsA = $derived(visibleBars(mixerStore.deckA.waveformPeaks || [], mixerStore.deckA.durationSeconds, strideA, scrollA, normA));
  const barsB = $derived(visibleBars(mixerStore.deckB.waveformPeaks || [], mixerStore.deckB.durationSeconds, strideB, scrollB, normB));
  const gridA = $derived(gridFor(playheadA, strideA, beatSecA));
  const gridB = $derived(gridFor(playheadB, strideB, beatSecB));

  function tick() {
    scrollA = playheadA * strideA - WAVE_W / 2;
    scrollB = playheadB * strideB - WAVE_W / 2;
    drawWaveCanvas('A');
    drawWaveCanvas('B');
    drawTelemetry('A');
    drawTelemetry('B');
    raf = requestAnimationFrame(tick);
  }

  onMount(() => { raf = requestAnimationFrame(tick); });
  onDestroy(() => { cancelAnimationFrame(raf); });

  const phaseMs = $derived(Math.abs((mixerStore.deckA.elapsedSeconds - mixerStore.deckB.elapsedSeconds) * 1000));
  const lock = $derived(phaseMs < 40 ? 96 : phaseMs < 80 ? 82 : phaseMs < 160 ? 60 : phaseMs < 320 ? 32 : 12);
  // ALC-150 : vérité de synchronisation — RYTHME VERROUILLÉ uniquement si les 2 platines sont chargées
  // ET ont le même tempo effectif (|ΔBPM| ≤ 0.2). Sinon : TEMPOS NON ALIGNÉS (amber).
  const bpmDelta = $derived(Math.abs((mixerStore.effectiveBpmB || 0) - (mixerStore.effectiveBpmA || 0)));
  const bothLoaded = $derived(!!mixerStore.deckA.filePath && !!mixerStore.deckB.filePath);
  const bpmAligned = $derived(bpmDelta <= 0.2);
  const lockLabel = $derived(bothLoaded && bpmAligned ? 'RYTHME VERROUILLÉ ✓' : 'TEMPOS NON ALIGNÉS');
  const lockAmber = $derived(!(bothLoaded && bpmAligned));
  const lockTip = $derived(
    (bothLoaded && bpmAligned)
      ? `Tempos alignés · écart ${phaseMs.toFixed(1)} ms`
      : `BPM effectifs : A ${(mixerStore.effectiveBpmA || 0).toFixed(1)} · B ${(mixerStore.effectiveBpmB || 0).toFixed(1)} (Δ ${bpmDelta.toFixed(1)})`
  );

  // ALC-149 : conseil d'action contextuel (1 ligne) guidant le débutant selon l'état des platines.
  const advice = $derived.by(() => {
    const a = mixerStore.deckA.filePath;
    const b = mixerStore.deckB.filePath;
    if (!a && !b) return '1. Chargez une piste sur Platine A • 2. Puis une sur Platine B • 3. Suivez l\'aiguille dorée';
    if (!b) return '1. Chargez une piste sur Platine B • 2. Alignez la phase avec le vernier • 3. Utilisez le Crossfader';
    if (!a) return '1. Chargez une piste sur Platine A • 2. Alignez la phase avec le vernier • 3. Utilisez le Crossfader';
    if (mixerStore.isBpmLocked && lock >= 60)
      return '1. Cliquez sur « Aligner Tempo & Phase » • 2. Coupez les basses (LOW EQ) sur B • 3. Cliquez sur « ▶ Lancer A + B » pour tester le mix';
    return '1. Cliquez sur « Aligner Tempo & Phase » • 2. Utilisez SET → CALER TEMPS 1 pour ancrer • 3. Cliquez sur « ▶ Lancer A + B » pour tester le mix';
  });

  // ALC-161 : les deux platines jouent-elles simultanément (bascule ▶/⏸ du bouton doré) ?
  const bothPlaying = $derived(
    mixerStore.deckA.transport === 'playing' && mixerStore.deckB.transport === 'playing'
  );

  /**
   * ALC-161 — ▶ LANCER A + B : si l'alignement tempo/phase n'est pas encore fait, l'applique,
   * mémorise les positions de départ (startPosA/B), puis démarre simultanément les deux lecteurs
   * dans le même tick (mise à jour synchrone des deux transport) → synchronisation parfaite sans
   * décalage manuel. Bascule en ⏸ PAUSE A + B quand les deux platines jouent.
   */
  function toggleSyncedPlay() {
    if (bothPlaying) {
      // → PAUSE A + B : on met en pause les deux lecteurs, on garde les positions de départ en mémoire.
      mixerStore.setTransport('A', 'paused');
      mixerStore.setTransport('B', 'paused');
      syncedPlaying = false;
      return;
    }
    // → LANCER A + B
    const deckA = mixerStore.getDeck('A');
    const deckB = mixerStore.getDeck('B');
    if (!deckA.filePath || !deckB.filePath) return; // les 2 pistes doivent être chargées

    // 1) Alignement automatique de B sur A si les tempos/phases ne sont pas encore alignés
    //    (ΔBPM > 0.2 ou phase non verrouillée → on ré-aligne toujours au lancement pour être sûr).
    const bpmDelta =
      Math.abs((mixerStore.effectiveBpmB || 0) - (mixerStore.effectiveBpmA || 0)) || 0;
    const phaseGap = Math.abs(deckA.elapsedSeconds - deckB.elapsedSeconds);
    if (bpmDelta > 0.2 || phaseGap > 0.05) mixerStore.alignTempoAndPhase();

    // 2) Mémorise les positions de départ de chaque platine (recalculées après alignement).
    startPosA = deckA.elapsedSeconds;
    startPosB = deckB.elapsedSeconds;
    startSaved = true;

    // 3) Démarrage SIMULTANÉ des deux lecteurs dans le même tick (positions + transports synchrones).
    const pa = mixerStore.getPlayer('A');
    const pb = mixerStore.getPlayer('B');
    // Repositionne les <audio> au point de départ enregistré, puis déclenche la lecture.
    if (pa) pa.seek(startPosA);
    if (pb) pb.seek(startPosB);
    // L'effet $effect des decks (DeckA/DeckB) appelle leur startPlayer() dès transport='playing'.
    mixerStore.setTransport('A', 'playing');
    mixerStore.setTransport('B', 'playing');
    syncedPlaying = true;
  }

  /**
   * ALC-161 — ↺ RETOUR CALAGE : met en pause (ou repositionne à la volée) les deux platines sur
   * (startPosA, startPosB) pour re-tester la transition autant de fois que souhaité en un clic.
   */
  function returnToCue() {
    const deckA = mixerStore.getDeck('A');
    const deckB = mixerStore.getDeck('B');
    mixerStore.setTransport('A', 'stopped');
    mixerStore.setTransport('B', 'stopped');
    // Repositionne à la volée : store + lecteurs <audio> sur les positions de départ mémorisées.
    deckA.elapsedSeconds = startPosA;
    deckB.elapsedSeconds = startPosB;
    const pa = mixerStore.getPlayer('A');
    const pb = mixerStore.getPlayer('B');
    if (pa) pa.seek(startPosA);
    if (pb) pb.seek(startPosB);
    syncedPlaying = false;
  }

  // Marquers Auto-Loop ▲ IN / OUT ▲ matérialisés sur l'onde (source réelle : boucle du Player).
  const loopMarkersA = $derived.by(() => {
    const lp = mixerStore.getPlayer('A')?.loop;
    if (!lp) return null;
    return { inX: (lp[0] - playheadA) * strideA + WAVE_W / 2, outX: (lp[1] - playheadA) * strideA + WAVE_W / 2 };
  });
  const loopMarkersB = $derived.by(() => {
    const lp = mixerStore.getPlayer('B')?.loop;
    if (!lp) return null;
    return { inX: (lp[0] - playheadB) * strideB + WAVE_W / 2, outX: (lp[1] - playheadB) * strideB + WAVE_W / 2 };
  });

  // Mini-barres panoramiques : signature L/R décorative dérivée de l'enveloppe réelle.
  const panFor = (id: DeckId) => {
    const peaks = deckOf(id).waveformPeaks || [];
    if (!peaks.length) return new Array(24).fill(0.22);
    const out: number[] = [];
    for (let i = 0; i < 24; i++) {
      const idx = Math.min(peaks.length - 1, Math.floor((i / 24) * peaks.length));
      out.push(Math.max(0.15, Math.min(1, (peaks[idx] || 0) * 0.7 + Math.abs(Math.sin(i * 1.91)) * 0.3)));
    }
    return out;
  };
  const panA = $derived(panFor('A'));
  const panB = $derived(panFor('B'));

  // Position x (%) d'un repère Hot Cue (temps → écran) pour la platine donnée.
  const cuePct = (id: DeckId, cue: number, playhead: number, stride: number) => {
    const x = cue >= 0 ? (cue - playhead) * stride + WAVE_W / 2 : null;
    return x == null ? null : Math.max(0, Math.min(100, (x / WAVE_W) * 100));
  };

  // Compteur MESURE XX.X • -XX MES AVANT DROP (repère DROP = Hot Cue 2, sinon silencieux).
  const measureText = $derived.by(() => {
    const id = target;
    const d = deckOf(id);
    const bs = id === 'A' ? beatSecA : beatSecB;
    const M = bs * 4;
    const ph = id === 'A' ? playheadA : playheadB;
    const m = ph / (M || 1) + 1;
    const drop = d.hotCues[1];
    let dropStr = '';
    if (drop != null && drop >= 0) {
      const dm = (drop - d.elapsedSeconds) / (M || 1);
      if (dm > 0) dropStr = ` • -${dm.toFixed(1)} MES AVANT DROP`;
      else if (dm > -1) dropStr = ' • DROP';
    }
    return `MESURE ${(m >= 0 ? m : 0).toFixed(1).padStart(5, '0')}${dropStr}`;
  });

  const octaveLabel = $derived(deckOf(target).gridOctave);

  // ALC-162 : offset de grille courant de la platine ciblée (ex. +0 ms / +15 ms), juste à droite de ×2.
  const gridOffsetLabel = $derived(`${(deckOf(target).gridOffsetMs || 0) >= 0 ? '+' : ''}${deckOf(target).gridOffsetMs || 0} ms`);

  // ALC-146 : rendu Canvas 2D 60 fps des deux waveform (sculpture fréquentielle 3 bandes +
  // calque TEMPO / CLÉS) autour de l'aiguille dorée centrale ; haute densité devicePixelRatio.
  // Couleurs par canal : corps émeraude #10b981 (A) / bleu #3b82f6 (B), sub cuivre/ambre,
  // transitoires or clair ; le calque CLÉS affiche une alerte cuivrée en cas de conflit.
  function drawWaveCanvas(id: DeckId) {
    const cv = id === 'A' ? canvasA : canvasB;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const W = WAVE_W;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssH = WAVE_H; // ALC-148 : 160 px (source unique avec le markup)
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(cssH * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, cssH);

    const bars = id === 'A' ? barsA : barsB;
    const stride = id === 'A' ? strideA : strideB;
    const scroll = id === 'A' ? scrollA : scrollB;
    const body = id === 'A' ? '#10b981' : '#3b82f6';
    const bodyBright = id === 'A' ? '#7dfae0' : '#7dd3fc';
    const sub = '#b87333'; // cuivre / ambre
    const aig = '#f0d28a'; // transitoires aigus or clair

    const cy = cssH / 2; // axe horizontal central (miroir haut/bas)

    // ① Waveform miroir haute définition — barres fines (2 px, écart 1 px), contraste dynamique,
    // symétriques autour de l'axe central, 3 couches de l'intérieur vers l'extérieur :
    // Basses (cuivre) au centre → Voix/Mélodie (émeraude A / bleu B) au milieu → Aigus (or) aux pointes.
    for (const b of bars) {
      const t = (scroll + b.x + BAR_W / 2) / Math.max(1e-3, stride);
      const seg = segAt(id, t);
      let lo = 0.18, mid = 0.6, hi = 0.22; // proportion par défaut (enveloppe seule)
      if (seg) {
        const tot = seg.rmsLow + seg.rmsMid + seg.rmsHigh + 1e-6;
        lo = seg.rmsLow / tot;
        mid = seg.rmsMid / tot;
        hi = seg.rmsHigh / tot;
      }
      // Contraste dynamique : Math.pow(val, 1.5) fait ressortir chaque coup de kick / pause.
      const half = Math.max(1, Math.pow(b.h, 1.5) * (cssH / 2 - 6));
      const hLo = half * lo;     // rayon basses (innombrable)
      const hMid = half * mid;   // rayon voix / mélodie
      const hHi = half * hi;     // rayon aigus (pointes)
      const x = b.x;             // 2 px de large, 1 px d'écart (pas de chevauchement)
      const w = 2;
      // Couches de l'extérieur vers l'intérieur (aigus dessinés en premier pour rester visibles).
      ctx.fillStyle = aig;
      ctx.fillRect(x, cy - hLo - hMid - hHi, w, (hLo + hMid + hHi) * 2);
      ctx.fillStyle = body;
      ctx.fillRect(x, cy - hLo - hMid, w, (hLo + hMid) * 2);
      ctx.fillStyle = sub;
      ctx.fillRect(x, cy - hLo, w, hLo * 2);
      // Liseré de pic (kick / snare) — pointe du miroir.
      if (b.peak) {
        ctx.fillStyle = bodyBright;
        ctx.fillRect(x, cy - half - 2, w, 2);
      }
    }

    // ALC-147-1 : les calques TEMPO / CLÉS sont retirés des ondes principales (sculpture 3 bandes seule).
  }

  // ALC-147-2 : rendu Canvas 2D 60 fps des 2 pistes télémétriques dédiées sous les ondes principales.
  // Chaque piste (~36 px) suit le zoom (stride) et elapsedSeconds, traversée par la même aiguille dorée.
  // Branché sur le sélecteur CALQUE [ TEMPO | CLÉS ] :
  //   - TEMPO : courbe locale du local_bpm + valeur BPM instantanée + halo ambré si variation > ±0.5 BPM.
  //   - CLÉS  : blocs segmentés des clés Camelot locales + surlignage d'alerte en cas de clash A vs B.
  function drawTelemetry(id: DeckId) {
    const cv = id === 'A' ? teleCanvasA : teleCanvasB;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const W = WAVE_W;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssH = TELE_H; // ALC-149 : 60 px (source unique avec le markup)
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(cssH * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, cssH);

    const stride = id === 'A' ? strideA : strideB;
    const ph = id === 'A' ? playheadA : playheadB;
    const segs = id === 'A' ? mixerStore.deckSegmentsA : mixerStore.deckSegmentsB;
    const overlay = mixerStore.beatgridOverlayMode;
    const midV = cssH / 2;

    // Ligne de base sous l'onde.
    if (overlay === 'tempo' && segs.length) {
      // ALC-149/150 : tempo local ramené dans l'octave du BPM global de la platine.
      // La courbe est centrée sur le effectiveBpm de la platine (source de vérité affichée dans
      // les cartes) pour éviter toute contradiction de chiffre à l'écran.
      const gbpm = effBpmOf(id);
      const localOf = (lb: number) => normOctaveBpm(lb, gbpm);
      const centerBpm = gbpm; // référence = BPM effectif de la platine
      const band = cssH / 2 - 4;
      // Courbe lumineuse du tempo local.
      ctx.lineWidth = 2;
      ctx.strokeStyle = id === 'A' ? '#7dfae0' : '#7dd3fc';
      ctx.beginPath();
      for (let i = 0; i < segs.length; i++) {
        const g = segs[i];
        const x = (g.startSec - ph) * stride + WAVE_W / 2;
        const dev = localOf(g.localBpm) - centerBpm;
        const y = midV - Math.max(-band, Math.min(band, dev)); // ±2 BPM ≈ pleine bande
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        if (Math.abs(dev) > 0.5) {
          // halo ambré des zones de dérive
          ctx.fillStyle = 'rgba(245,212,144,0.25)';
          const wSeg = Math.max(2, (g.endSec - g.startSec) * stride);
          ctx.fillRect(x, 0, wSeg, cssH);
        }
      }
      ctx.stroke();

      // Valeur BPM instantanée (à l'aiguille dorée = playhead).
      const curSeg = segAt(id, ph);
      if (curSeg) {
        const label = `${centerBpm.toFixed(1)} BPM`;
        ctx.font = 'bold 10px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f5d490';
        const cx = WAVE_W / 2;
        ctx.fillRect(cx - 34, 2, 68, 13);
        ctx.fillStyle = '#1c1200';
        ctx.fillText(label, cx, 12);
      }
    } else if (overlay === 'camelot' && segs.length) {
      const hueOf = (g: string) => (parseInt((g || '1A').replace(/\D+/, ''), 10) || 1) / 12 * 300;
      ctx.font = 'bold 8px ui-monospace, monospace';
      ctx.textAlign = 'left';
      for (const g of segs) {
        const x0 = (g.startSec - ph) * stride + WAVE_W / 2;
        const x1 = (g.endSec - ph) * stride + WAVE_W / 2;
        if (x1 < -4 || x0 > W + 4) continue;
        const wSeg = Math.max(1, x1 - x0);
        // Bloc segmenté de la clé Camelot locale.
        ctx.fillStyle = `hsla(${hueOf(g.localCamelot)}, 55%, 45%, 0.55)`;
        ctx.fillRect(x0, 1, wSeg, cssH - 2);
        if (wSeg > 26) {
          ctx.fillStyle = 'rgba(10,6,2,0.85)';
          ctx.fillText(g.localCamelot.toUpperCase(), x0 + 3, cssH - 8);
        }
      }
      // Alerte de clash harmonique A vs B : surlignage cuivré là où les clés locales diffèrent.
      const other = id === 'A' ? mixerStore.deckSegmentsB : mixerStore.deckSegmentsA;
      for (const g of segs) {
        const tMid = g.startSec + (g.endSec - g.startSec) / 2;
        const otherSeg = other.find((o) => tMid >= o.startSec && tMid <= o.endSec);
        if (otherSeg && otherSeg.localCamelot && otherSeg.localCamelot !== g.localCamelot) {
          const x0 = (g.startSec - ph) * stride + WAVE_W / 2;
          const wSeg = Math.max(2, (g.endSec - g.startSec) * stride);
          ctx.fillStyle = 'rgba(200,120,60,0.55)';
          ctx.fillRect(x0, cssH - 3, wSeg, 3);
        }
      }
    }
  }
</script>

<div class="flex flex-col gap-space-xs">
  <!-- ALC-143 : assistant de transition harmonique (bandeau d'alerte) -->
  <BridgeSuggester />

  <!-- ALC-149 : conseil d'action contextuel (1 ligne) pour guider le débutant -->
  <div class="flex items-center gap-2 bg-surface-container-lowest rounded-lg px-space-md py-1 border border-primary/30 shadow-[inset_0_1px_4px_rgba(0,0,0,0.8)]">
    <span class="font-label-sm text-[8px] text-emerald-300 uppercase tracking-widest shrink-0">Conseil</span>
    <span class="font-mono text-[10px] text-primary/90 leading-tight">{advice}</span>
  </div>

  <!-- Barre d'outils Beatgrid -->
  <div class="flex items-center justify-between gap-space-sm bg-surface-container-high rounded-lg p-space-sm flex-wrap">
    <div class="flex items-center gap-1">
      <span class="font-label-sm text-[8px] text-outline uppercase tracking-widest mr-1">Zoom</span>
      <div class="flex items-center border border-surface-variant/50 rounded overflow-hidden">
        {#each ZOOMS as z (z)}
          <button type="button" onclick={() => (zoom = z)}
            class="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide {zoom === z ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-low hover:bg-surface-container-high'}">
            {z} MES
          </button>
        {/each}
      </div>
    </div>

    <!-- ALC-146 : sélecteur de calque TEMPO / CLÉS -->
    <div class="flex items-center gap-1">
      <span class="font-label-sm text-[8px] text-outline uppercase tracking-widest mr-1">Calque</span>
      <div class="flex items-center border border-surface-variant/50 rounded overflow-hidden">
        {#each (['tempo', 'camelot'] as const) as mode (mode)}
          <button type="button" title={mode === 'tempo' ? 'Dérive de tempo locale' : 'Modulations harmoniques (clés locales)'}
            onclick={() => (mixerStore.beatgridOverlayMode = mode)}
            class="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide {mixerStore.beatgridOverlayMode === mode ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-low hover:bg-surface-container-high'}">
            {mode === 'tempo' ? 'TEMPO' : 'CLÉS'}
          </button>
        {/each}
      </div>
    </div>

    <div class="flex flex-col items-center bg-surface-container-lowest rounded px-space-md py-space-xs border border-primary/40 shadow-[inset_1px_1px_4px_rgba(0,0,0,0.9)]">
      <span class="font-mono text-[11px] font-bold tabular-nums tracking-wider {lockAmber ? 'text-amber-400' : 'text-primary'}" title={lockTip}>{lockLabel}</span>
      <div class="w-28 h-1.5 bg-surface-variant rounded-full overflow-hidden mt-0.5">
        <div class="h-full {lockAmber ? 'bg-amber-400' : 'bg-primary'}" style="width:{lock}%;"></div>
      </div>
    </div>

    <div class="flex items-center gap-1">
      <span class="font-label-sm text-[8px] text-outline uppercase tracking-widest mr-1">Grille cible</span>
      <button type="button" onclick={() => (target = 'A')}
        class="px-2 py-0.5 rounded text-[10px] font-bold uppercase {target === 'A' ? 'bg-emerald-500/25 text-emerald-300 border border-emerald-500/50' : 'bg-surface-container-low'}">Platine A</button>
      <button type="button" onclick={() => (target = 'B')}
        class="px-2 py-0.5 rounded text-[10px] font-bold uppercase {target === 'B' ? 'bg-[#00A3FF]/25 text-[#38bdf8] border border-[#00A3FF]/50' : 'bg-surface-container-low'}">Platine B</button>
      <button type="button" title="Ancrer le temps 1 sous la tête de lecture" onclick={() => mixerStore.anchorGrid(target)}
        class="px-2 py-0.5 rounded bg-surface-container-low hover:bg-surface-container-high text-[10px] font-bold uppercase">Caler Temps 1</button>
      <button type="button" title="Reculer l'offset de grille de 10 ms" onclick={() => mixerStore.nudgeGrid(target, -10)}
        class="px-2 py-0.5 rounded bg-surface-container-low hover:bg-surface-container-high text-[10px]">◄</button>
      <button type="button" title="Avancer l'offset de grille de 10 ms" onclick={() => mixerStore.nudgeGrid(target, 10)}
        class="px-2 py-0.5 rounded bg-surface-container-low hover:bg-surface-container-high text-[10px]">►</button>
      <button type="button" title="Diviser l'octave de grille" onclick={() => mixerStore.octaveGrid(target, 0.5)} class="px-2 py-0.5 rounded bg-surface-container-low hover:bg-surface-container-high text-[9px] font-bold uppercase">÷2</button>
      <button type="button" title="Doubler l'octave de grille" onclick={() => mixerStore.octaveGrid(target, 2)} class="px-2 py-0.5 rounded bg-surface-container-low hover:bg-surface-container-high text-[9px] font-bold uppercase">×2</button>
      <span class="font-mono text-[8px] text-primary/80 tabular-nums">{octaveLabel}×</span>
      <!-- ALC-162 : offset courant (ex. +0 ms / +15 ms) juste à droite de ×2 -->
      <span class="font-mono text-[9px] font-bold tabular-nums text-primary {target === 'A' ? 'text-emerald-300' : 'text-[#38bdf8]'}" title="Offset de grille de la platine ciblée">{gridOffsetLabel}</span>
    </div>
  </div>

  <!-- Double forme d'onde empilée + mini-barres panoramiques + aiguille dorée MESURE -->
  <div class="relative bg-surface-container-lowest rounded-xl p-space-sm border border-primary/40 shadow-[inset_0_2px_10px_rgba(0,0,0,0.9)]">
    <!-- Aiguille dorée centrale continue + compteur de mesures -->
    <div class="absolute inset-y-0 left-1/2 w-px bg-[#edbf7a] shadow-[0_0_8px_#edbf7a] z-30 pointer-events-none"></div>
    <!-- ALC-150 : sens de lecture — passé à gauche, à venir à droite de l'aiguille -->
    <div class="absolute inset-y-0 left-0 z-20 pointer-events-none flex items-center pl-1.5">
      <span class="font-mono text-[8px] text-outline/70 uppercase tracking-widest select-none">◄ Passé</span>
    </div>
    <div class="absolute inset-y-0 right-0 z-20 pointer-events-none flex items-center pr-1.5">
      <span class="font-mono text-[8px] text-outline/70 uppercase tracking-widest select-none">À venir ►</span>
    </div>
    <div class="absolute top-1 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
      <span class="inline-block font-mono text-[9px] font-bold tracking-widest text-[#edbf7a] bg-surface/90 border border-primary/40 px-1.5 py-0.5 rounded tabular-nums shadow-[0_2px_6px_rgba(0,0,0,0.8)]">{measureText}</span>
    </div>
    <div class="absolute bottom-1 right-2 z-30 pointer-events-none font-label-sm text-[8px] text-primary/70 uppercase tracking-widest">Fenêtre zoom {zoom} MES</div>
    <!-- ALC-150 : légende des couleurs d'onde placée en haut du cadre, sous forme claire -->
    <div class="absolute top-1 right-2 z-30 pointer-events-none flex items-center gap-2.5">
      <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-sm inline-block bg-[#b87333]"></span><span class="font-mono text-[8px] text-outline uppercase tracking-widest">Cuivre : Basses</span></span>
      <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-sm inline-block bg-[#10b981]"></span><span class="w-2 h-2 rounded-sm inline-block bg-[#3b82f6]"></span><span class="font-mono text-[8px] text-outline uppercase tracking-widest">Vert/Bleu : Voix &amp; Mélodie</span></span>
      <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-sm inline-block bg-[#f0d28a]"></span><span class="font-mono text-[8px] text-outline uppercase tracking-widest">Or : Aigus</span></span>
    </div>

    <!-- Tape A : mini-barre panoramique (cadre doré + repères Hot Cues) puis onde Émeraude -->
    <div class="relative mb-1 h-2.5 flex items-stretch gap-[1px] px-1 rounded bg-[#03100c] border border-emerald-500/40 overflow-hidden">
      {#each panA as v, i (i)}
        <div class="flex-1 self-stretch rounded-sm" style="background:{v > 0.6 ? '#10b981' : '#065f46'};"></div>
      {/each}
      {#each mixerStore.deckA.hotCues as cue, i (i)}
        {#if cuePct('A', cue, playheadA, strideA) != null}
          <div class="absolute top-0 bottom-0 w-px bg-[#edbf7a] z-10" style="left:{cuePct('A', cue, playheadA, strideA)}%;"></div>
        {/if}
      {/each}
      <div class="absolute inset-y-0 left-1/2 w-px bg-primary/50 z-20 pointer-events-none"></div>
    </div>
    <div class="relative h-[200px] w-full overflow-hidden rounded bg-[#03100c] cursor-pointer {target === 'A' ? 'border-2 border-emerald-400/80 shadow-[0_0_16px_rgba(16,185,129,0.45)]' : 'border border-emerald-500/40 hover:border-emerald-300/60'}"
        onclick={() => (target = 'A')} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); target = 'A'; } }}
        role="button" tabindex="0" aria-label="Sélectionner Platine A comme cible de grille"
        title="Cible de grille : PLATINE A (cliquer pour cibler l'édition)">
      <!-- Grille hiérarchisée dorée Tape A -->
      <!-- ALC-162 : badge discret CIBLE GRILLE sur la platine active -->
      {#if target === 'A'}
        <span class="absolute top-1 left-2 z-30 font-mono text-[8px] font-bold uppercase tracking-widest text-emerald-300 border border-emerald-400/60 bg-emerald-500/15 px-1.5 py-0.5 rounded">Cible grille</span>
      {/if}
      <div class="absolute inset-0 z-10 pointer-events-none">
        {#each gridA as g (g.key)}
          <div class="absolute top-0 bottom-0 {g.cls === 'gold' ? 'w-[2px] bg-[#edbf7a] shadow-[0_0_5px_#edbf7a]' : g.cls === 'bar' ? 'w-px bg-[#edbf7a]/55' : 'w-px bg-[#edbf7a]/20'}" style="left:{g.x / WAVE_W * 100}%;"></div>
          {#if g.cls === 'gold' && Math.floor(g.key / 16) * 4 + 1 > 0}
            <!-- ALC-150 : repère de phrasé M1 / M5 / M9… au sommet des traits dorés de phrase -->
            <span class="absolute top-0.5 -translate-x-1/2 font-mono text-[9px] font-bold text-[#f5d490] tabular-nums" style="left:{g.x / WAVE_W * 100}%;">M{Math.floor(g.key / 16) * 4 + 1}</span>
          {/if}
        {/each}
      </div>
      <!-- Marquers Auto-Loop ▲ IN / OUT ▲ sur l'onde -->
      {#if loopMarkersA}
        <div class="absolute inset-y-0 z-20 pointer-events-none">
          <div class="absolute top-0 bottom-0 w-[2px] bg-[#edbf7a]/80" style="left:{Math.max(0, Math.min(100, loopMarkersA.inX / WAVE_W * 100))}%;"></div>
          <div class="absolute top-0 bottom-0 w-[2px] bg-[#edbf7a]/80" style="left:{Math.max(0, Math.min(100, loopMarkersA.outX / WAVE_W * 100))}%;"></div>
          <span class="absolute top-0.5 -translate-x-1/2 font-mono text-[8px] text-[#edbf7a] font-bold" style="left:{Math.max(0, Math.min(100, loopMarkersA.inX / WAVE_W * 100))}%;">▲ IN</span>
          <span class="absolute top-0.5 -translate-x-1/2 font-mono text-[8px] text-[#edbf7a] font-bold" style="left:{Math.max(0, Math.min(100, loopMarkersA.outX / WAVE_W * 100))}%;">OUT ▲</span>
        </div>
      {/if}
      <!-- ALC-146 : waveform Canvas 2D 60 fps (sculpture fréquentielle 3 bandes + calque TEMPO/CLÉS) -->
      <canvas bind:this={canvasA} class="absolute inset-0 z-[5] pointer-events-none" style="width:{WAVE_W}px;height:{WAVE_H}px;"></canvas>
      {#if !barsA.length}<span class="absolute top-1 left-2 z-10 text-[9px] text-emerald-700/70 uppercase tracking-widest">Tape A • en attente</span>{/if}
    </div>

    <!-- ALC-147 : piste télémétrique dédiée Tape A (TEMPO / CLÉS, CALQUE) sous l'onde principale -->
    <div class="relative mt-1 h-[60px] rounded overflow-hidden border border-emerald-500/25 bg-[#04130e]">
      <span class="absolute top-0.5 left-1.5 z-20 font-mono text-[8px] font-bold uppercase tracking-widest text-emerald-300 pointer-events-none">Platine A • {mixerStore.beatgridOverlayMode === 'tempo' ? 'TEMPO' : 'CLÉS'}</span>
      <canvas bind:this={teleCanvasA} class="absolute inset-0 z-10 pointer-events-none" style="width:{WAVE_W}px;height:{TELE_H}px;"></canvas>
    </div>

    <!-- Tape B : mini-barre panoramique (cadre doré + repères Hot Cues) puis onde Bleu Électrique -->
    <div class="relative my-1 h-2.5 flex items-stretch gap-[1px] px-1 rounded bg-[#00121a] border border-[#00A3FF]/40 overflow-hidden">
      {#each panB as v, i (i)}
        <div class="flex-1 self-stretch rounded-sm" style="background:{v > 0.6 ? '#00A3FF' : '#003a55'};"></div>
      {/each}
      {#each mixerStore.deckB.hotCues as cue, i (i)}
        {#if cuePct('B', cue, playheadB, strideB) != null}
          <div class="absolute top-0 bottom-0 w-px bg-[#edbf7a] z-10" style="left:{cuePct('B', cue, playheadB, strideB)}%;"></div>
        {/if}
      {/each}
      <div class="absolute inset-y-0 left-1/2 w-px bg-[#00A3FF]/50 z-20 pointer-events-none"></div>
    </div>
    <div class="relative h-[200px] w-full overflow-hidden rounded bg-[#00121a] cursor-pointer {target === 'B' ? 'border-2 border-[#38bdf8]/80 shadow-[0_0_16px_rgba(56,189,248,0.45)]' : 'border border-[#00A3FF]/40 hover:border-[#38bdf8]/60'}"
        onclick={() => (target = 'B')} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); target = 'B'; } }}
        role="button" tabindex="0" aria-label="Sélectionner Platine B comme cible de grille"
        title="Cible de grille : PLATINE B (cliquer pour cibler l'édition)">
      <!-- Grille hiérarchisée dorée Tape B -->
      <!-- ALC-162 : badge discret CIBLE GRILLE sur la platine active -->
      {#if target === 'B'}
        <span class="absolute top-1 left-2 z-30 font-mono text-[8px] font-bold uppercase tracking-widest text-[#7dd3fc] border border-[#38bdf8]/60 bg-[#00A3FF]/15 px-1.5 py-0.5 rounded">Cible grille</span>
      {/if}
      <div class="absolute inset-0 z-10 pointer-events-none">
        {#each gridB as g (g.key)}
          <div class="absolute top-0 bottom-0 {g.cls === 'gold' ? 'w-[2px] bg-[#edbf7a] shadow-[0_0_5px_#edbf7a]' : g.cls === 'bar' ? 'w-px bg-[#edbf7a]/55' : 'w-px bg-[#edbf7a]/20'}" style="left:{g.x / WAVE_W * 100}%;"></div>
          {#if g.cls === 'gold' && Math.floor(g.key / 16) * 4 + 1 > 0}
            <!-- ALC-150 : repère de phrasé M1 / M5 / M9… (Tape B) -->
            <span class="absolute top-0.5 -translate-x-1/2 font-mono text-[9px] font-bold text-[#f5d490] tabular-nums" style="left:{g.x / WAVE_W * 100}%;">M{Math.floor(g.key / 16) * 4 + 1}</span>
          {/if}
        {/each}
      </div>
      <!-- Marquers Auto-Loop ▲ IN / OUT ▲ sur l'onde -->
      {#if loopMarkersB}
        <div class="absolute inset-y-0 z-20 pointer-events-none">
          <div class="absolute top-0 bottom-0 w-[2px] bg-[#edbf7a]/80" style="left:{Math.max(0, Math.min(100, loopMarkersB.inX / WAVE_W * 100))}%;"></div>
          <div class="absolute top-0 bottom-0 w-[2px] bg-[#edbf7a]/80" style="left:{Math.max(0, Math.min(100, loopMarkersB.outX / WAVE_W * 100))}%;"></div>
          <span class="absolute top-0.5 -translate-x-1/2 font-mono text-[8px] text-[#edbf7a] font-bold" style="left:{Math.max(0, Math.min(100, loopMarkersB.inX / WAVE_W * 100))}%;">▲ IN</span>
          <span class="absolute top-0.5 -translate-x-1/2 font-mono text-[8px] text-[#edbf7a] font-bold" style="left:{Math.max(0, Math.min(100, loopMarkersB.outX / WAVE_W * 100))}%;">OUT ▲</span>
        </div>
      {/if}
      <!-- ALC-146 : waveform Canvas 2D 60 fps (sculpture fréquentielle 3 bandes + calque TEMPO/CLÉS) -->
      <canvas bind:this={canvasB} class="absolute inset-0 z-[5] pointer-events-none" style="width:{WAVE_W}px;height:{WAVE_H}px;"></canvas>
      {#if !barsB.length}<span class="absolute top-1 left-2 z-10 text-[9px] text-[#003a55] uppercase tracking-widest">Tape B • en attente</span>{/if}
    </div>

    <!-- ALC-147 : piste télémétrique dédiée Tape B (TEMPO / CLÉS, CALQUE) sous l'onde principale -->
    <div class="relative mt-1 h-[60px] rounded overflow-hidden border border-[#00A3FF]/25 bg-[#00151f]">
      <span class="absolute top-0.5 left-1.5 z-20 font-mono text-[8px] font-bold uppercase tracking-widest text-[#7dd3fc] pointer-events-none">Platine B • {mixerStore.beatgridOverlayMode === 'tempo' ? 'TEMPO' : 'CLÉS'}</span>
      <canvas bind:this={teleCanvasB} class="absolute inset-0 z-10 pointer-events-none" style="width:{WAVE_W}px;height:{TELE_H}px;"></canvas>
    </div>
  </div>

  <!-- ALC-149 : séparation symétrique des contrôles — Platine A à gauche, Platine B à droite -->
  <div class="grid grid-cols-2 gap-2 items-start">
    <!-- Platine A -->
    <div class="flex flex-col gap-1 bg-emerald-500/5 border border-emerald-500/20 rounded p-1.5">
      <span class="font-label-sm text-[8px] text-emerald-300 uppercase tracking-widest">Platine A • Hot Cues</span>
      <div class="flex flex-wrap items-center gap-0.5">
        {#each CUES as c, i (c)}
          <button type="button" title="Poser hot cue Platine A" onclick={() => mixerStore.setHotCue('A', i)}
            class="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20 text-[9px] font-bold uppercase tracking-wide">{i + 1}·{c}</button>
          <button type="button" title="Rappeler hot cue Platine A" onclick={() => mixerStore.recallHotCue('A', i)}
            class="px-1.5 py-0.5 rounded bg-surface-container-high hover:bg-surface-container-highest text-[9px] font-mono text-emerald-300/80">{mixerStore.deckA.hotCues[i] >= 0 ? '▶' : '—'}</button>
        {/each}
      </div>
      <div class="flex flex-col gap-0.5">
        <span class="font-label-sm text-[8px] text-emerald-400 uppercase tracking-widest">Auto-Loop A</span>
        <div class="flex items-center gap-1 flex-wrap">
          {#each LOOPS as b (b)}
            <button type="button" onclick={() => mixerStore.setLoop('A', b)} class="px-1.5 py-0.5 rounded bg-surface-container-low hover:bg-surface-container-high text-[9px] font-bold uppercase tracking-wide">{b === 0.5 ? '½' : b}</button>
          {/each}
          <button type="button" onclick={() => mixerStore.setLoop('A', null)} class="px-1.5 py-0.5 rounded bg-error/15 text-[#ffb4ab] text-[9px] font-bold uppercase">Exit</button>
        </div>
        {#if mixerStore.deckA.loopBeats}<span class="font-mono text-[9px] text-[#edbf7a]">▲ IN / OUT ▲</span>{/if}
      </div>
    </div>
    <!-- Platine B -->
    <div class="flex flex-col gap-1 bg-[#00A3FF]/5 border border-[#00A3FF]/20 rounded p-1.5">
      <span class="font-label-sm text-[8px] text-[#38bdf8] uppercase tracking-widest">Platine B • Hot Cues</span>
      <div class="flex flex-wrap items-center gap-0.5">
        {#each CUES as c, i (c)}
          <button type="button" title="Poser hot cue Platine B" onclick={() => mixerStore.setHotCue('B', i)}
            class="px-1.5 py-0.5 rounded bg-[#00A3FF]/10 border border-[#00A3FF]/30 text-[#38bdf8] hover:bg-[#00A3FF]/20 text-[9px] font-bold uppercase tracking-wide">{i + 1}·{c}</button>
          <button type="button" title="Rappeler hot cue Platine B" onclick={() => mixerStore.recallHotCue('B', i)}
            class="px-1.5 py-0.5 rounded bg-surface-container-high hover:bg-surface-container-highest text-[9px] font-mono text-[#38bdf8]/80">{mixerStore.deckB.hotCues[i] >= 0 ? '▶' : '—'}</button>
        {/each}
      </div>
      <div class="flex flex-col gap-0.5">
        <span class="font-label-sm text-[8px] text-[#38bdf8] uppercase tracking-widest">Auto-Loop B</span>
        <div class="flex items-center gap-1 flex-wrap">
          {#each LOOPS as b (b)}
            <button type="button" onclick={() => mixerStore.setLoop('B', b)} class="px-1.5 py-0.5 rounded bg-surface-container-low hover:bg-surface-container-high text-[9px] font-bold uppercase tracking-wide">{b === 0.5 ? '½' : b}</button>
          {/each}
          <button type="button" onclick={() => mixerStore.setLoop('B', null)} class="px-1.5 py-0.5 rounded bg-error/15 text-[#ffb4ab] text-[9px] font-bold uppercase">Exit</button>
        </div>
        {#if mixerStore.deckB.loopBeats}<span class="font-mono text-[9px] text-[#edbf7a]">▲ IN / OUT ▲</span>{/if}
      </div>
    </div>
  </div>

  <!-- ALC-149 : cartes comparatives (Platine A • Maître / Platine B • Synchro) + ALIGNER TEMPO & PHASE -->
  <!-- ALC-161 : ▶ LANCER A + B (doré, bascule ⏸ PAUSE A + B) + ↺ RETOUR CALAGE en un clic. -->
  <div class="flex items-center gap-2 flex-wrap bg-surface-container-low rounded-lg p-1.5">
    <span class="font-mono text-[8px] font-bold uppercase tracking-widest text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-1.5 py-0.5">Platine A • Maître</span>
    <span class="font-mono text-[11px] font-bold text-emerald-300 tabular-nums">{mixerStore.effectiveBpmA.toFixed(1)} BPM · {mixerStore.deckA.camelotKey}</span>
    <button type="button" onclick={() => mixerStore.alignTempoAndPhase()}
      class="px-3 py-1 rounded-lg bg-primary/20 border border-primary/50 text-primary text-[10px] font-bold uppercase tracking-widest hover:bg-primary/30">
      Aligner Tempo &amp; Phase
    </button>
    <!-- ALC-161 : bouton principal doré ▶ LANCER A + B ⇄ ⏸ PAUSE A + B. -->
    <button type="button" onclick={toggleSyncedPlay} aria-label="Lancer ou mettre en pause les deux platines"
      class="px-3 py-1 rounded-lg bg-primary text-on-primary border border-primary/80 text-[10px] font-bold uppercase tracking-widest shadow-[0_0_10px_rgba(237,191,122,0.35)] hover:brightness-110 transition disabled:opacity-40 disabled:cursor-not-allowed"
      disabled={!mixerStore.deckA.filePath || !mixerStore.deckB.filePath}>
      <span class="material-symbols-outlined text-[13px] align-[-2px]">{bothPlaying ? 'pause' : 'play_arrow'}</span>
      {bothPlaying ? 'Pause A + B' : 'Lancer A + B'}
    </button>
    <!-- ALC-161 : rappel vers les positions de départ mémorisées (re-tester la transition en 1 clic). -->
    <button type="button" onclick={returnToCue} aria-label="Retour au point de calage"
      title={startSaved ? 'Retour aux positions de départ (startPosA / startPosB)' : 'Lancez d\'abord « Lancer A + B » pour mémoriser le calage'}
      class="px-2.5 py-1 rounded-lg bg-primary/15 border border-primary/40 text-primary text-[10px] font-bold uppercase tracking-widest hover:bg-primary/25 disabled:opacity-35 disabled:cursor-not-allowed"
      disabled={!startSaved}>
      ↺ Retour Calage
    </button>
    <span class="font-mono text-[8px] font-bold uppercase tracking-widest text-[#38bdf8] bg-[#00A3FF]/10 border border-[#00A3FF]/30 rounded px-1.5 py-0.5">Platine B • Synchro</span>
    <span class="font-mono text-[11px] font-bold text-[#38bdf8] tabular-nums">{mixerStore.effectiveBpmB.toFixed(1)} BPM · {mixerStore.deckB.camelotKey}</span>
  </div>
</div>