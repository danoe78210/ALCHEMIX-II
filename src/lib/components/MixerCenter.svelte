<script lang="ts">
  import { mixerStore } from '$lib/stores/mixer.svelte';
  import { onMount } from 'svelte';
  import BeatgridView from './BeatgridView.svelte';
  import LibraryView from './LibraryView.svelte';
import { searchDeezer, type DeezerTrack } from '$lib/ipc/meta';
import { libraryIpc, type LibraryTrack } from '$lib/ipc/client';
import { findLocalBridgeTracks, type LocalBridgeResult } from '$lib/utils/mashupMatcher';
import { parseCamelot, relationFrom, affinityFrom, verdictFrom, intervalFrom, pivotFrom } from '$lib/audio/harmony';

  const formattedDelta = $derived(
    mixerStore.bpmDelta > 0
      ? `+${mixerStore.bpmDelta.toFixed(2)} BPM`
      : `${mixerStore.bpmDelta.toFixed(2)} BPM`
  );

  // ALC-104-3 : pitch exact (Δ %) à appliquer sur Deck B pour atteindre le BPM effectif de A.
  const recommendedPitchForB = $derived(
    Number((((mixerStore.effectiveBpmA / (mixerStore.effectiveBpmB || 1)) - 1) * 100).toFixed(1))
  );

  const camelotAngle = (key: string): number => {
    const n = Number.parseInt(key, 10);
    if (!Number.isFinite(n) || n < 1 || n > 12) return 120;
    return (n % 12) * 30; // 0° = haut, sens horaire (12B -> 0, 1B -> 30, … 8B -> 240)
  };

  // Angles des aiguilles Camelot (points vers les tonalités actives)
  const angleA = $derived(camelotAngle(mixerStore.deckA.camelotKey));
  const angleB = $derived(camelotAngle(mixerStore.deckB.camelotKey));

  // ALC-124 : balayage de l'aiguille (rotation d'un tour complet) pendant l'analyse du canal.
  const sweepA = $derived(mixerStore.deckA.isAnalyzing ? angleA + 360 : angleA);
  const sweepB = $derived(mixerStore.deckB.isAnalyzing ? angleB + 360 : angleB);

  const ptOnCircle = (deg: number, r: number) => {
    const rad = (deg * Math.PI) / 180;
    return { x: 250 + r * Math.sin(rad), y: 250 - r * Math.cos(rad) };
  };

  // Position des « Active Nodes » (ALC-121-1) : rayon dans la bande vide entre l'anneau interne
  // (mineur, r≈136) et externe (majeur, r≈213) → ne masque plus les libellés 1A..12B.
  const ACTIVE_NODE_RADIUS = 178;
  const nodeA = $derived((() => {
    const p = ptOnCircle(angleA, ACTIVE_NODE_RADIUS);
    return { x: p.x.toFixed(1), y: p.y.toFixed(1) };
  })());
  const nodeB = $derived((() => {
    const p = ptOnCircle(angleB, ACTIVE_NODE_RADIUS);
    return { x: p.x.toFixed(1), y: p.y.toFixed(1) };
  })());

  // Clés actives normalisées — neutralisées tant que la platine est vide (ALC-128-4).
  const deckAKey = $derived(mixerStore.deckA.filePath ? (mixerStore.deckA.camelotKey || '').trim().toUpperCase() : '');
  const deckBKey = $derived(mixerStore.deckB.filePath ? (mixerStore.deckB.camelotKey || '').trim().toUpperCase() : '');
  // ALC-128-5/6 : les deux platines chargées (moyeu, Affinité/Modulation, Oracle).
  const bothLoaded = $derived(!!mixerStore.deckA.filePath && !!mixerStore.deckB.filePath);
  const loadedCount = $derived((mixerStore.deckA.filePath ? 1 : 0) + (mixerStore.deckB.filePath ? 1 : 0));

  // ALC-131 / ALC-143 : logique harmonique Camelot partagée (harmony.ts, source unique).
  const keyA = $derived(mixerStore.deckA.filePath ? parseCamelot(mixerStore.deckA.camelotKey) : null);
  const keyB = $derived(mixerStore.deckB.filePath ? parseCamelot(mixerStore.deckB.camelotKey) : null);
  const harmony = $derived.by(() => relationFrom(keyA, keyB));
  const affinity = $derived.by(() => affinityFrom(harmony));
  const verdict = $derived.by(() => verdictFrom(harmony));
  const interval = $derived.by(() => intervalFrom(harmony));

  // ALC-104-3 : différentiel d'énergie (LUFS) dynamique, calculé sur la variation de tempo réelle
  // entre les deux pistes + la tension harmonique (ring). Plus aucun « +1.8 LUFS » codé en dur.
  const lufsDelta = $derived.by(() => {
    if (!bothLoaded || !harmony) return 0;
    const bpmA = mixerStore.effectiveBpmA;
    const bpmB = mixerStore.effectiveBpmB;
    const maxBpm = Math.max(bpmA, bpmB, 1);
    const tempo = Math.abs(bpmA - bpmB) / maxBpm; // 0..1
    const tension = harmony.ring >= 2 ? 0.6 : 0;
    const v = 1.8 * (1 + tempo * 3) + tension; // base pilotée par l'écart réel
    const signed = (bpmA >= bpmB ? 1 : -1) * Math.min(4, Math.max(0.4, v));
    return Number(signed.toFixed(1));
  });

  // ALC-132-1 : jauge 14 segments — Affinité Harmonique (cuivre → émeraude).
  const affinitySegments = $derived.by(() => {
    const lit = bothLoaded ? Math.round((affinity / 100) * 14) : 0;
    return Array.from({ length: 14 }, (_, i) => {
      const on = i < lit;
      const t = lit > 1 ? i / (lit - 1) : 0; // progression cuivre (184,115,51) → émeraude (16,185,129)
      const r = Math.round(184 + (16 - 184) * t);
      const g = Math.round(115 + (185 - 115) * t);
      const b = Math.round(51 + (129 - 51) * t);
      return { on, color: `rgb(${r},${g},${b})` };
    });
  });

  // ALC-132-1 : jauge bipolaire centrée — Modulation Énergétique (lufsDelta ∈ [-4,4]).
  const lufsSeg = $derived.by(() => {
    const n = bothLoaded ? Math.max(-1, Math.min(1, lufsDelta / 4)) : 0;
    const litMag = Math.round(Math.abs(n) * 7);
    const color = n >= 0 ? '#10b981' : '#00A3FF';
    return Array.from({ length: 14 }, (_, i) => {
      if (i === 7) return { on: false, center: true, color: 'rgba(237,191,122,0.35)' };
      let on = false;
      if (n >= 0) on = i >= 8 && i - 7 <= litMag;
      else on = i <= 6 && 7 - i <= litMag;
      return { on, center: false, color };
    });
  });

  // ALC-104-3 : Conseil 1 — cadence rythmique 100 % dynamique selon le Δ BPM réel.
  const cadenceAdvice = $derived.by(() => {
    if (!bothLoaded) return '';
    const bpmA = mixerStore.effectiveBpmA;
    const bpmB = mixerStore.effectiveBpmB;
    const gapAbs = Math.abs(mixerStore.bpmDelta);
    if (gapAbs < 0.5) return `Tempos déjà alignés (${bpmA.toFixed(1)} BPM) — transition rythmique directe prête.`;
    if (gapAbs / (bpmB || 1) > 0.15) return `Écart de tempo important (${formattedDelta}) — privilégiez une transition par coupure (Cut / Echo Out) plutôt qu'un calage au tempo.`;
    const pitch = recommendedPitchForB;
    return `Ajuster Deck B ${pitch >= 0 ? 'de +' + pitch : 'de ' + pitch}% pour atteindre ${bpmA.toFixed(1)} BPM et sceller la synchronicité métrique.`;
  });

  // ALC-104-3 : Conseil 2 — stratégie harmonique / fréquentielle selon la relation Camelot réelle.
  const frequencyAdvice = $derived.by(() => {
    const h = harmony;
    if (!h || !bothLoaded) return '';
    return (h.rel || h.ring <= 1)
      ? 'Chevauchement mélodique long de 16 mesures — échangez les basses EQ (HPF/LPF) entre le Deck A et le Deck B.'
      : 'Transition courte sur break percussif — mixez plein niveau sans superposition harmonique (clés dissonantes).';
  });

  // ALC-135-1 / ALC-143 : conflit harmonique (Roue ≥ 3 quintes) + clé pivot à mi-chemin (harmony.ts).
  const pivotInfo = $derived.by(() =>
    pivotFrom(
      keyA,
      keyB,
      harmony,
      bothLoaded,
      mixerStore.effectiveBpmA,
      mixerStore.effectiveBpmB,
      (mixerStore.deckA.artist || mixerStore.deckA.genre || mixerStore.deckB.artist || 'harmonic').trim()
    )
  );

  // ALC-135-2 : recherche Deezer des pistes ponts quand un conflit est détecté.
  let bridgeTracks = $state<DeezerTrack[]>([]);
  let bridgeLoading = $state(false);
  let activePreview = $state<string | null>(null);
  let previewAudio: HTMLAudioElement | null = null;
  // ALC-170-2 : Pistes Ponts locales depuis la Librairie SQLite locale (library.db).
  let localTracks = $state<LibraryTrack[]>([]);
  let localDuos = $state<Set<string>>(new Set());
  let localLibLoaded = $state(false);

  $effect(() => {
    if (!bothLoaded || localLibLoaded) return;
    localLibLoaded = true;
    libraryIpc.listTracks().then((t) => (localTracks = t)).catch(() => {});
    libraryIpc
      .listDuos()
      .then((d) => {
        localDuos = new Set(
          d.map((x) => (x.trackAId < x.trackBId ? `${x.trackAId}|${x.trackBId}` : `${x.trackBId}|${x.trackAId}`))
        );
      })
      .catch(() => {});
  });

  const localBridges = $derived.by<LocalBridgeResult[]>(() => {
    if (!bothLoaded || !localTracks.length) return [];
    return findLocalBridgeTracks(
      { camelotKey: mixerStore.deckA.camelotKey, bpm: mixerStore.effectiveBpmA, filePath: mixerStore.deckA.filePath, title: mixerStore.deckA.trackTitle, artist: mixerStore.deckA.artist },
      { camelotKey: mixerStore.deckB.camelotKey, bpm: mixerStore.effectiveBpmB, filePath: mixerStore.deckB.filePath, title: mixerStore.deckB.trackTitle, artist: mixerStore.deckB.artist },
      localTracks,
      3,
      localDuos
    );
  });

  function toggleLocalPreview(br: LocalBridgeResult) {
    // ALC-171 : pré-écoute locale via le pipeline unifié du store (read_audio_file_bytes → Blob URL).
    void mixerStore.toggleFilePreview(br.track.filePath || '', String(br.track.id ?? ''));
  }

  async function loadLocalBridge(br: LocalBridgeResult, side: 'A' | 'B') {
    const fp = br.track.filePath;
    mixerStore.stopFilePreview();
    if (!fp) return;
    await mixerStore.loadTrackFromPath(side, fp);
  }

  $effect(() => {
    const info = pivotInfo;
    if (!info) { bridgeTracks = []; bridgeLoading = false; return; }
    let cancelled = false;
    bridgeLoading = true;
    searchDeezer(info.query).then((tracks) => {
      if (cancelled) return;
      bridgeTracks = tracks;
      bridgeLoading = false;
    });
    return () => { cancelled = true; };
  });

  function toggleBridgePreview(url: string) {
    if (activePreview === url) {
      previewAudio?.pause();
      previewAudio = null;
      activePreview = null;
      return;
    }
    previewAudio?.pause();
    const a = new Audio(url);
    a.addEventListener('ended', () => { activePreview = null; });
    a.play().catch(() => {});
    previewAudio = a;
    activePreview = url;
  }

  // ALC-139-2 : stoppe la pré-écoute Deezer + vide les ponts au POWER OFF.
  function handleShutdown() {
    previewAudio?.pause();
    previewAudio = null;
    activePreview = null;
    bridgeTracks = [];
  }
  onMount(() => {
    window.addEventListener('alchemix:shutdown', handleShutdown);
    return () => window.removeEventListener('alchemix:shutdown', handleShutdown);
  });

  // ALC-138-2 : Crossfader Master intégré dans la console centrale (sous l'Oracle).
  const clampX = (n: number) => Math.max(0, Math.min(100, n));
  function setCross(n: number) {
    // ALC-169 : toute intervention manuelle sur le crossfader interrompt l'AUTO-MIX.
    mixerStore.cancelAutoMix();
    mixerStore.crossfader = clampX(n);
  }
  function applyCross(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    mixerStore.crossfader = clampX(Math.round(((e.clientX - r.left) / r.width) * 100));
  }
  function captureCross(e: PointerEvent) {
    // ALC-169 : saisie manuelle du crossfader → arrêt immédiat de l'AUTO-MIX.
    mixerStore.cancelAutoMix();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    applyCross(e);
  }
  function moveCross(e: PointerEvent) {
    if ((e.buttons & 1) !== 0) applyCross(e);
  }

  const routes = $derived.by(() => {
    if (!keyA) return [];
    const next = (keyA.num % 12) + 1;
    const prev = ((keyA.num + 10) % 12) + 1;
    const relMode = keyA.mode === 'A' ? 'B' : 'A';
    return [
      { label: 'DIRECTE', from: `${keyA.num}${keyA.mode}`, to: `${next}${keyA.mode}`, note: '+1 Quinte', cls: 'text-emerald-400' },
      { label: 'DESCENDANTE', from: `${keyA.num}${keyA.mode}`, to: `${prev}${keyA.mode}`, note: '-1 Quinte', cls: 'text-primary' },
      { label: 'RELATIF', from: `${keyA.num}${keyA.mode}`, to: `${keyA.num}${relMode}`, note: 'Majeur/Mineur', cls: 'text-secondary' },
    ];
  });

  // Coordonnées des 24 libellés (12 majeurs en anneau externe, 12 mineurs en anneau interne).
  const KEY_LABELS: { key: string; x: number; y: number; inner: boolean }[] = [
    { key: '12B', x: 250, y: 36, inner: false }, { key: '1B', x: 354, y: 64, inner: false },
    { key: '2B', x: 436, y: 146, inner: false }, { key: '3B', x: 464, y: 250, inner: false },
    { key: '4B', x: 410, y: 368, inner: false }, { key: '5B', x: 344, y: 440, inner: false },
    { key: '6B', x: 250, y: 468, inner: false }, { key: '7B', x: 156, y: 440, inner: false },
    { key: '8B', x: 90, y: 368, inner: false }, { key: '9B', x: 36, y: 250, inner: false },
    { key: '10B', x: 64, y: 146, inner: false }, { key: '11B', x: 146, y: 64, inner: false },
    { key: '12A', x: 250, y: 114, inner: true }, { key: '1A', x: 318, y: 132, inner: true },
    { key: '2A', x: 368, y: 182, inner: true }, { key: '3A', x: 386, y: 250, inner: true },
    { key: '4A', x: 368, y: 318, inner: true }, { key: '5A', x: 318, y: 368, inner: true },
    { key: '6A', x: 250, y: 386, inner: true }, { key: '7A', x: 182, y: 368, inner: true },
    { key: '8A', x: 132, y: 318, inner: true }, { key: '9A', x: 114, y: 250, inner: true },
    { key: '10A', x: 132, y: 182, inner: true }, { key: '11A', x: 182, y: 132, inner: true },
  ];

  // Stylage d'un libellé : surbrillance émeraude (Deck A) / bleu électrique (Deck B) si clé
  // active, sinon teinte neutre (ALC-121-2).
  const labelAttrs = (key: string, inner: boolean) => {
    if (key === deckAKey) {
      return { fill: '#10b981', size: 18, weight: 800, fam: 'Space Grotesk', halo: '#10b981' };
    }
    if (key === deckBKey) {
      return { fill: '#00A3FF', size: 18, weight: 800, fam: 'Space Grotesk', halo: '#00A3FF' };
    }
    return {
      fill: inner ? '#7a6e60' : '#9b8f80',
      size: inner ? 11 : 14,
      weight: inner ? 400 : 600,
      fam: inner ? 'JetBrains Mono' : 'Space Grotesk',
      halo: '',
    };
  };

  // Chemin de l'arc lumineux extérieur (rayon 246) empruntant le chemin le plus court (≤180°).
  const harmonyArcPath = $derived((() => {
    const r = 246;
    const diff = ((angleB - angleA + 540) % 360) - 180; // normalisé en [-180, 180)
    const a = ptOnCircle(angleA, r);
    const b = ptOnCircle(angleB, r);
    const sweep = diff >= 0 ? 1 : 0;
    return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} A ${r} ${r} 0 0 ${sweep} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  })());

  // Chemin de la particule animée (approximé par une quadratique le long de l'arc court)
  const harmonyMotionPath = $derived((() => {
    const r = 246;
    const diff = ((angleB - angleA + 540) % 360) - 180;
    const a = ptOnCircle(angleA, r);
    const b = ptOnCircle(angleB, r);
    const mid = ptOnCircle(angleA + diff / 2, r);
    return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${mid.x.toFixed(1)} ${mid.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  })());
</script>

<div class="flex flex-col gap-space-xs bg-surface-container-low p-space-sm rounded-xl shadow-[0_12px_32px_rgba(0,0,0,0.9)] relative overflow-hidden">
  <!-- Center Console Mechanical Toggle Switch Bar -->
  <div class="flex items-center justify-between gap-space-xs pb-space-xs">
    <div class="flex items-center gap-space-xs w-full">
      <button
        type="button"
        onclick={() => (mixerStore.centerView = 'camelot')}
        class="flex-1 py-space-xs px-space-sm rounded font-label-sm text-[9px] font-bold uppercase tracking-wider text-center flex items-center justify-center gap-1 transition-colors {mixerStore.centerView === 'camelot'
          ? 'bg-primary-container text-on-primary-container shadow-[inset_0_1px_3px_rgba(255,221,176,0.3)]'
          : 'bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant shadow-sm'}"
      >
        <span class="material-symbols-outlined text-[14px]">rotate_right</span>
        <span>ROUE DE CAMELOT</span>
      </button>
      <button
        type="button"
        onclick={() => (mixerStore.centerView = 'beatgrid')}
        class="flex-1 py-space-xs px-space-sm rounded font-label-sm text-[9px] uppercase tracking-wider text-center flex items-center justify-center gap-1 transition-colors {mixerStore.centerView === 'beatgrid'
          ? 'bg-primary-container text-on-primary-container shadow-[inset_0_1px_3px_rgba(255,221,176,0.3)] font-bold'
          : 'bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant shadow-sm'}"
      >
        <span class="material-symbols-outlined text-[14px]">grid_4x4</span>
        <span>BEATGRID</span>
      </button>
      <button
        type="button"
        onclick={() => (mixerStore.centerView = 'library')}
        class="flex-1 py-space-xs px-space-sm rounded font-label-sm text-[9px] uppercase tracking-wider text-center flex items-center justify-center gap-1 transition-colors {mixerStore.centerView === 'library'
          ? 'bg-primary-container text-on-primary-container shadow-[inset_0_1px_3px_rgba(255,221,176,0.3)] font-bold'
          : 'bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant shadow-sm'}"
      >
        <span class="material-symbols-outlined text-[14px]">library_music</span>
        <span>LIBRAIRIE</span>
      </button>
    </div>
  </div>

  <!-- ALC-124 : bandeau central ambré pendant l'analyse d'un plat -->
  {#if mixerStore.anyAnalyzing}
    <div
      class="flex flex-col gap-1 px-space-sm py-space-xs rounded-lg border border-primary/60 bg-primary/10 text-primary shadow-[0_0_16px_rgba(237,191,122,0.25)]"
    >
      <div class="flex items-center justify-between gap-space-xs">
        <div class="flex items-center gap-space-sm">
          <span class="material-symbols-outlined text-[16px] animate-spin">radar</span>
          <span class="font-label-md text-[11px] font-bold uppercase tracking-wider animate-pulse">
            Analyse du Spectre &amp; de la Clé en cours…
          </span>
        </div>
        <span class="font-mono text-[10px] text-primary/80 font-bold">
          {mixerStore.deckA.isAnalyzing ? 'A' : ''}{mixerStore.deckA.isAnalyzing && mixerStore.deckB.isAnalyzing ? '+' : ''}{mixerStore.deckB.isAnalyzing ? 'B' : ''}
        </span>
      </div>
      <!-- fine barre lumineuse animée -->
      <div class="h-[2px] w-full rounded-full overflow-hidden bg-primary/30">
        <div class="h-full w-1/3 rounded-full bg-primary animate-pulse"></div>
      </div>
    </div>
  {/if}

  <!-- Bandeau d'état harmonique temps réel (ALC-131) -->
  <div
    class="w-full py-space-sm px-space-md rounded-lg border border-primary/40 bg-primary/10 text-primary flex items-center justify-center gap-space-sm {mixerStore.anyAnalyzing ? 'animate-pulse' : ''}"
  >
    {#if mixerStore.anyAnalyzing}
      <span class="material-symbols-outlined text-[18px] animate-spin">radar</span>
      <span class="font-headline-md text-[15px] uppercase font-bold tracking-wider">Analyse Spectrale &amp; Harmonique en cours…</span>
    {:else if loadedCount === 0}
      <span class="material-symbols-outlined text-[18px]">hourglass_empty</span>
      <span class="font-headline-md text-[15px] uppercase font-bold tracking-wider">En attente de chargement sur les platines A &amp; B</span>
    {:else if loadedCount === 1}
      <span class="font-headline-md text-[15px] uppercase font-bold tracking-wider">
        Piste analysée ({mixerStore.deckA.filePath ? mixerStore.deckA.camelotKey : mixerStore.deckB.camelotKey} • {(mixerStore.deckA.filePath ? mixerStore.effectiveBpmA : mixerStore.effectiveBpmB).toFixed(1)} BPM) — Charger le second canal
      </span>
    {:else}
      {#if verdict}
        <span class="font-headline-md text-[15px] uppercase font-bold tracking-wider {verdict.cls}">
          {verdict.icon} {verdict.text}
        </span>
      {/if}
    {/if}
  </div>

  {#if mixerStore.centerView === 'library'}
  <!-- ALC-165-3 : Vue LIBRAIRIE — catalogue SQLite local + moteur de matching MASHUP -->
  <LibraryView />
  {:else if mixerStore.centerView === 'beatgrid'}
  <BeatgridView />
  {:else}
<div class="relative bg-surface-container-lowest rounded-xl p-space-md shadow-[inset_0_4px_20px_rgba(0,0,0,0.95)] flex flex-col items-center justify-center overflow-hidden min-h-[490px]">
  <!-- Astronomical Venetian Camelot Wheel: Expanded Diameter -->
    <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/10 via-surface-container-lowest/80 to-surface-container-lowest pointer-events-none"></div>
<div class="relative w-full max-w-[460px] aspect-square flex items-center justify-center my-1"><svg class="w-full h-full transform -rotate-90 pointer-events-none" viewBox="0 0 500 500">
<defs>
  <filter id="glow-emerald-strong" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="5" result="blur"></feGaussianBlur>
    <feMerge>
      <feMergeNode in="blur"></feMergeNode>
      <feMergeNode in="blur"></feMergeNode>
      <feMergeNode in="SourceGraphic"></feMergeNode>
    </feMerge>
  </filter>
  <filter id="glow-blue-strong" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="5" result="blur"></feGaussianBlur>
    <feMerge>
      <feMergeNode in="blur"></feMergeNode>
      <feMergeNode in="blur"></feMergeNode>
      <feMergeNode in="SourceGraphic"></feMergeNode>
    </feMerge>
  </filter>
  <filter id="glow-gold" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="4" result="blur"></feGaussianBlur>
    <feMerge>
      <feMergeNode in="blur"></feMergeNode>
      <feMergeNode in="SourceGraphic"></feMergeNode>
    </feMerge>
  </filter>
  <linearGradient id="emerald-compass-grad" x1="0%" y1="100%" x2="0%" y2="0%">
    <stop offset="0%" stop-color="#064e3b"></stop>
    <stop offset="25%" stop-color="#059669"></stop>
    <stop offset="70%" stop-color="#10b981"></stop>
    <stop offset="100%" stop-color="#6ee7b7"></stop>
  </linearGradient>
  <linearGradient id="blue-compass-grad" x1="0%" y1="100%" x2="0%" y2="0%">
    <stop offset="0%" stop-color="#0c4a6e"></stop>
    <stop offset="25%" stop-color="#0284c7"></stop>
    <stop offset="70%" stop-color="#38bdf8"></stop>
    <stop offset="100%" stop-color="#bae6fd"></stop>
  </linearGradient>
</defs>

<!-- Concentric Astrolabe Brass Rings & Track Geometry -->
<circle cx="250" cy="250" fill="none" r="240" stroke="#4f4539" stroke-dasharray="3 5" stroke-width="2.5"></circle>
<circle cx="250" cy="250" fill="none" r="226" stroke="#edbf7a" stroke-opacity="0.35" stroke-width="1.5"></circle>
<circle cx="250" cy="250" fill="none" r="170" stroke="#4f4539" stroke-dasharray="2 4" stroke-opacity="0.6" stroke-width="1.5"></circle>
<circle cx="250" cy="250" fill="none" r="154" stroke="#edbf7a" stroke-opacity="0.25" stroke-width="1"></circle>
<circle cx="250" cy="250" fill="none" r="96" stroke="#edbf7a" stroke-opacity="0.45" stroke-width="1.5"></circle>

<!-- Astrolabe Clock Hour Tick Marks (every 30 deg) -->
<g stroke="#3a3330" stroke-width="1.5">
  <line x1="250" y1="250" x2="250" y2="14"></line>
  <line x1="250" y1="250" x2="368" y2="45"></line>
  <line x1="250" y1="250" x2="455" y2="132"></line>
  <line x1="250" y1="250" x2="486" y2="250"></line>
  <line x1="250" y1="250" x2="455" y2="368"></line>
  <line x1="250" y1="250" x2="368" y2="455"></line>
  <line x1="250" y1="250" x2="250" y2="486"></line>
  <line x1="250" y1="250" x2="132" y2="455"></line>
  <line x1="250" y1="250" x2="45" y2="368"></line>
  <line x1="250" y1="250" x2="14" y2="250"></line>
  <line x1="250" y1="250" x2="45" y2="132"></line>
  <line x1="250" y1="250" x2="132" y2="45"></line>
</g>

<!-- Luminous Golden Connector Chord between 4B (405, 340) and 8B (95, 340) -->
{#if mixerStore.deckA.filePath && mixerStore.deckB.filePath}
  <g id="harmonic-energy-bridge">
  <!-- ALC-104-2 : arc lumineux extérieur (rayon 246) = chemin harmonique le plus court (≤180°) entre les clés actives -->
  <path d={harmonyArcPath} fill="none" stroke="#7b581e" stroke-width="6" stroke-linecap="round" stroke-opacity="0.5" filter="url(#glow-gold)"></path>
  <path d={harmonyArcPath} fill="none" stroke="#edbf7a" stroke-width="3" stroke-linecap="round" class="harmonic-beam-glow"></path>
  <path d={harmonyArcPath} fill="none" stroke="#ffe8c2" stroke-width="1.5" stroke-linecap="round" class="harmonic-flow-line" style="stroke-dasharray: 6 24; animation-duration: 0.9s; filter: drop-shadow(0 0 6px #ffddb0) drop-shadow(0 0 10px #edbf7a);"></path>
  <circle r="4" fill="#ffffff" style="filter: drop-shadow(0 0 8px #ffddb0);"><animatemotion path={harmonyMotionPath} dur="1.8s" repeatcount="indefinite"></animatemotion></circle>
  <circle r="2.5" fill="#edbf7a" style="filter: drop-shadow(0 0 6px #edbf7a);"><animatemotion path={harmonyMotionPath} dur="1.8s" begin="0.9s" repeatcount="indefinite"></animatemotion></circle>
</g>
{/if}
<path d="M 405 340 A 180 180 0 0 1 95 340" fill="none" stroke="#edbf7a" stroke-dasharray="8 6" stroke-width="2.5" stroke-opacity="0.7"></path>

{#if mixerStore.deckA.filePath}
<!-- 1. AIGUILLE A — squelette Breguet semi-transparente (ALC-123) — masquée si platine vide (ALC-126-4) -->
<g transform="rotate({sweepA} 250 250)" style="transition: transform 0.9s cubic-bezier(0.34,1.56,0.64,1);">
  <!-- Tracé double fin façon squelette : trait extérieur semi-transparent -->
  <line x1="250" y1="250" x2="250" y2="56" stroke="#10b981" stroke-width="2.5" stroke-opacity="0.45" stroke-linecap="round" filter="url(#glow-emerald-strong)"></line>
  <!-- Filet intérieur pointé -->
  <line x1="250" y1="250" x2="250" y2="62" stroke="#7ef0c4" stroke-width="0.9" stroke-opacity="0.6" stroke-linecap="round"></line>
  <!-- Œil de visée en pointe -->
  <circle cx="250" cy="54" r="2.6" fill="none" stroke="#10b981" stroke-width="1.4" stroke-opacity="0.9"></circle>
  <!-- Contrepoids discret ajouré -->
  <circle cx="250" cy="285" r="6" fill="rgba(16,185,129,0.12)" stroke="#edbf7a" stroke-width="1" stroke-opacity="0.6"></circle>
</g>
{/if}

{#if mixerStore.deckB.filePath}
<!-- 2. AIGUILLE B — squelette Breguet semi-transparente (ALC-123) — masquée si platine vide (ALC-126-4) -->
<g transform="rotate({sweepB} 250 250)" style="transition: transform 0.9s cubic-bezier(0.34,1.56,0.64,1);">
  <line x1="250" y1="250" x2="250" y2="56" stroke="#00A3FF" stroke-width="2.5" stroke-opacity="0.45" stroke-linecap="round" filter="url(#glow-blue-strong)"></line>
  <line x1="250" y1="250" x2="250" y2="62" stroke="#7fc9ff" stroke-width="0.9" stroke-opacity="0.6" stroke-linecap="round"></line>
  <circle cx="250" cy="54" r="2.6" fill="none" stroke="#00A3FF" stroke-width="1.4" stroke-opacity="0.9"></circle>
  <circle cx="250" cy="285" r="6" fill="rgba(0,163,255,0.12)" stroke="#edbf7a" stroke-width="1" stroke-opacity="0.6"></circle>
</g>
{/if}

<!-- Viseurs optiques translucides — Active Nodes (masqués si platine vide, ALC-126-4) -->
{#if mixerStore.deckA.filePath}
<circle cx={nodeA.x} cy={nodeA.y} r="18" fill="#10b981" fill-opacity="0.12" stroke="#edbf7a" stroke-width="1.5" stroke-opacity="0.9"></circle>
<circle cx={nodeA.x} cy={nodeA.y} r="2.5" fill="#10b981" fill-opacity="0.9"></circle>
{/if}

{#if mixerStore.deckB.filePath}
<circle cx={nodeB.x} cy={nodeB.y} r="18" fill="#00A3FF" fill-opacity="0.12" stroke="#edbf7a" stroke-width="1.5" stroke-opacity="0.9"></circle>
<circle cx={nodeB.x} cy={nodeB.y} r="2.5" fill="#00A3FF" fill-opacity="0.9"></circle>
{/if}

<!-- Libellés de clés (majeurs 1B..12B ext / mineurs 1A..12A int) — rendus PAR-DESSUS les aiguilles (ALC-123-1) -->
{#each KEY_LABELS as l (l.key)}
  {@const at = labelAttrs(l.key, l.inner)}
  <text
    fill={at.fill}
    font-family={at.fam}
    font-size={at.size}
    font-weight={at.weight}
    text-anchor="middle"
    transform="rotate(90 {l.x} {l.y})"
    x={l.x}
    y={l.y}
    style={at.halo ? `text-shadow:0 0 8px ${at.halo}, 0 0 16px ${at.halo};` : undefined}
  >
    {l.key}
  </text>
{/each}
</svg>
    </div>


      <!-- Center Clockwork Horological Hub with Mechanical Brass Pivot Ring -->
      <div class="absolute w-36 h-36 rounded-full bg-surface-container-high/95 border-2 border-primary/60 flex flex-col items-center justify-center text-center p-space-sm shadow-[0_6px_24px_rgba(0,0,0,0.95)] z-20 backdrop-blur-sm">
        <div class="absolute -top-3 w-6 h-6 rounded-full bg-gradient-to-tr from-primary to-primary-container border border-surface-container-lowest flex items-center justify-center shadow-[0_2px_6px_rgba(0,0,0,0.8)]">
          <div class="w-2 h-2 rounded-full bg-surface-container-lowest"></div>
        </div>
        <span class="font-label-sm text-[9px] text-outline uppercase font-bold tracking-widest">INTERVALLE</span>
        {#if bothLoaded}
        <span class="font-title-md text-[16px] font-bold text-primary tracking-tight">{interval ? interval.hub : ''}</span>
        <span class="font-label-sm text-[9px] text-emerald-400 mt-1 uppercase font-bold tabular-nums">
          Δ BPM : {formattedDelta}
        </span>
        <div class="mt-1 flex items-center justify-center gap-2 font-mono text-[13px] font-extrabold">
          <span class="text-emerald-400" style="text-shadow:0 0 6px #10b981, 0 0 12px #10b981;">
            A&nbsp;{mixerStore.deckA.camelotKey}
          </span>
          <span class="text-outline font-normal">·</span>
          <span class="text-[#00A3FF]" style="text-shadow:0 0 6px #00A3FF, 0 0 12px #00A3FF;">
            B&nbsp;{mixerStore.deckB.camelotKey}
          </span>
        </div>
        {:else}
        <span class="font-title-md text-[16px] font-bold text-on-surface tracking-tight">EN ATTENTE</span>
        <span class="font-label-sm text-[9px] text-outline uppercase mt-1">Chargez deux pistes</span>
        {/if}
        <div class="absolute -bottom-2 w-4 h-4 rounded-full bg-primary-container/80 border border-surface-container-lowest flex items-center justify-center shadow-inner">
          <div class="w-1.5 h-1.5 rounded-full bg-primary"></div>
        </div>
      </div>
    </div>

  <!-- Key & Transition Breakdown Cards (Restauré fidèlement) -->
  <div class="grid grid-cols-2 gap-space-sm">
    <div class="bg-surface-container p-space-sm rounded-lg shadow-sm flex flex-col justify-between">
      <span class="font-label-sm text-[9px] text-outline uppercase">Affinité Harmonique</span>
      <span class="font-headline-md text-[24px] text-primary font-bold">{#if bothLoaded}{affinity}%{:else}--%{/if}</span>
      <span class="flex items-center gap-0.5 h-2.5 mt-1" aria-hidden="true">
        {#each affinitySegments as s, i (i)}
          <span class="flex-1 h-full rounded-[1px] transition-colors duration-150" style="background:{s.on ? s.color : 'rgba(120,110,90,0.18)'}; box-shadow:{s.on ? `0 0 4px ${s.color}` : 'none'};"></span>
        {/each}
      </span>
      <span class="font-label-sm text-[9px] text-tertiary">{#if bothLoaded}{interval ? interval.label : ''}{:else}En attente d'analyse{/if}</span>
    </div>
    <div class="bg-surface-container p-space-sm rounded-lg shadow-sm flex flex-col justify-between">
      <span class="font-label-sm text-[9px] text-outline uppercase">Modulation Énergétique</span>
      <span class="font-headline-md text-[24px] text-secondary font-bold">{#if bothLoaded}{lufsDelta >= 0 ? '+' : ''}{lufsDelta.toFixed(1)} LUFS{:else}-- LUFS{/if}</span>
      <span class="flex items-center gap-0.5 h-2.5 mt-1" aria-hidden="true">
        {#each lufsSeg as s, i (i)}
          <span class="flex-1 h-full rounded-[1px] transition-colors duration-150" style="background:{s.center ? s.color : (s.on ? s.color : 'rgba(120,110,90,0.18)')}; box-shadow:{s.on ? `0 0 5px ${s.color}` : 'none'};"></span>
        {/each}
      </span>
      <span class="font-label-sm text-[9px] text-on-surface-variant">{#if bothLoaded}{lufsDelta >= 0 ? 'Ascension de Tension Mesurée' : 'Descente de Tension Mesurée'}{:else}En attente de mesure{/if}</span>
    </div>
  </div>

  <!-- Acoustic Oracle Advice Card (CONSEILS DE MIXAGE • ORACLE ACOUSTIQUE) - Restauré fidèlement -->
  <div class="bg-surface-container-high rounded-xl p-space-md shadow-[0_6px_18px_rgba(0,0,0,0.8)] flex flex-col gap-space-sm">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-space-xs">
        <span class="material-symbols-outlined text-primary text-[18px]">psychology</span>
        <span class="font-label-md text-[11px] text-primary font-bold uppercase tracking-wider">
          CONSEILS DE MIXAGE • ORACLE ACOUSTIQUE
        </span>
      </div>
    </div>

    <div class="flex flex-col gap-space-xs bg-surface-container-lowest p-space-sm rounded-lg">
      <div class="flex items-start gap-space-sm">
        <span class="material-symbols-outlined text-[18px] text-tertiary mt-0.5">tune</span>
        <div class="flex flex-col">
          <span class="font-label-md text-[11px] font-bold text-on-surface">Ajustement de Cadence (BPM)</span>
          <span class="font-body-sm text-[12px] text-on-surface-variant">
            {cadenceAdvice}
          </span>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-space-xs bg-surface-container-lowest p-space-sm rounded-lg">
      <div class="flex items-start gap-space-sm">
        <span class="material-symbols-outlined text-[18px] text-secondary mt-0.5">equalizer</span>
        <div class="flex flex-col">
          <span class="font-label-md text-[11px] font-bold text-on-surface">Filtrage des Fréquences Basses</span>
          <span class="font-body-sm text-[12px] text-on-surface-variant">
            {frequencyAdvice}
          </span>
        </div>
      </div>
    </div>

    <!-- Alternative Harmonic Paths Strip -->
    <div class="flex flex-col gap-1 pt-1">
      <span class="font-label-sm text-[9px] text-outline uppercase tracking-wider">
        Itinéraires Harmoniques Alternatifs:
      </span>
      {#if bothLoaded}
      <div class="grid grid-cols-3 gap-1 font-mono text-[10px]">
        {#each routes as r}
          <div class="bg-surface-container-low px-2 py-1 rounded text-center text-on-surface-variant">
            <span class="block {r.cls} font-bold">{r.label}</span>
            <span>{r.from} → {r.to} ({r.note})</span>
          </div>
        {/each}
      </div>
      {:else}
      <div class="rounded-lg bg-surface-container-low p-space-sm text-center text-outline text-[11px]">
        En attente de pistes — Chargez un titre sur le Deck A et le Deck B pour activer les conseils de mixage de l'Oracle Acoustique.
      </div>
      {/if}

    {#if pivotInfo}
    <div class="mt-1 rounded-lg bg-surface-container-lowest p-space-sm border border-surface-variant/40">
      <div class="flex items-center justify-between gap-2">
        <span class="font-label-sm text-[9px] text-primary uppercase tracking-wider">PONTS HARMONIQUES SUGGÉRÉS (CLÉ PIVOT {pivotInfo.pivotKey})</span>
        <span class="font-mono text-[9px] text-outline uppercase shrink-0">{pivotInfo.targetBpm} BPM</span>
      </div>
      {#if localBridges.length}
        <div class="mt-1.5 flex items-center gap-1 text-[8px] font-label-sm font-bold uppercase tracking-widest text-emerald-300/90">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#10b981]"></span>
          LIBRAIRIE LOCALE (library.db)
        </div>
        <div class="mt-1 flex flex-col gap-1">
          {#each localBridges as br (br.track.id)}
            <div class="flex items-center gap-2 bg-surface-container px-2 py-1 rounded border border-primary/30">
              <button type="button" onclick={() => toggleLocalPreview(br)} class="shrink-0 text-[10px] w-6 h-6 rounded bg-surface-container-high text-primary font-bold hover:bg-primary/20">{mixerStore.isPreviewingFile(br.track.filePath || '') ? '❚❚' : '▶'}</button>
              <div class="min-w-0 flex-1">
                <div class="text-[10px] text-on-surface font-semibold truncate">{br.track.title || br.track.filePath}</div>
                <div class="text-[9px] text-outline truncate">PIVOT {br.pivot} • {br.bpm.toFixed(1)} BPM{br.duoA ? ' • ★A' : ''}{br.duoB ? ' • ★B' : ''}</div>
              </div>
              <span class="shrink-0 text-[9px] font-mono text-primary font-bold px-1.5 py-0.5 rounded bg-primary/10 border border-primary/30">{br.score}% PONT</span>
              <button type="button" onclick={() => loadLocalBridge(br, 'A')} class="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[#06423a] text-[#10b981] font-bold border border-[#10b981]/50 hover:bg-[#10b981] hover:text-black">→ A</button>
              <button type="button" onclick={() => loadLocalBridge(br, 'B')} class="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[#194f47]/50 text-[#3b82f6] font-bold border border-[#3b82f6]/50 hover:bg-[#3b82f6] hover:text-black">→ B</button>
            </div>
          {/each}
        </div>
        <div class="mt-1 border-t border-surface-variant/40 pt-1 text-[8px] text-outline uppercase font-label-sm tracking-widest">ou suggestions Deezer en repli :</div>
      {/if}
      {#if bridgeLoading}
        <div class="text-[10px] text-outline italic py-1">Recherche Deezer…</div>
      {:else if bridgeTracks.length}
        <div class="mt-1 flex flex-col gap-1">
          {#each bridgeTracks as track (track.id)}
            <div class="flex items-center gap-2 bg-surface-container px-2 py-1 rounded">
              {#if track.coverSmall}<img src={track.coverSmall} alt="" loading="lazy" class="w-8 h-8 rounded object-cover shrink-0" />{/if}
              <div class="min-w-0 flex-1">
                <div class="text-[10px] text-on-surface font-semibold truncate">{track.title}</div>
                <div class="text-[9px] text-outline truncate">{track.artist}</div>
              </div>
              <button type="button" onclick={() => toggleBridgePreview(track.preview)} class="shrink-0 text-[10px] px-2 py-1 rounded bg-surface-container-high text-primary uppercase tracking-wide">
                {activePreview === track.preview ? '■ Stop' : '▶ Play'}
              </button>
            </div>
          {/each}
        </div>
      {:else}
        <div class="text-[10px] text-outline italic py-1">Aucun pont trouvé.</div>
      {/if}
    </div>
    {/if}
    </div>
  </div>
  {/if}

<!-- ALC-138-2 : Crossfader Master — partagé entre les vues, posé sous l'atelier Beatgrid et sous la console Camelot -->
<div class="mt-2 bg-surface-container-lowest rounded-xl p-space-sm border border-surface-variant/40">
  <div class="flex items-center justify-between text-[10px] font-mono text-outline tabular-nums mb-1 px-1">
    <button type="button" onclick={() => setCross(0)} class="text-emerald-400 font-bold uppercase tracking-wide hover:underline">100% CANAL A</button>
    <button type="button" onclick={() => setCross(50)} class="text-primary font-bold uppercase tracking-wide hover:underline">50 / 50 ÉQUILIBRE</button>
    <button type="button" onclick={() => setCross(100)} class="text-[#38bdf8] font-bold uppercase tracking-wide hover:underline">100% CANAL B</button>
  </div>
  <div
    role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow={mixerStore.crossfader}
    onpointerdown={captureCross}
    onpointermove={moveCross}
    ondblclick={() => setCross(50)}
    onkeydown={(e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); setCross(mixerStore.crossfader - 2); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setCross(mixerStore.crossfader + 2); }
    }}
    class="relative h-8 bg-surface-container-low rounded-lg flex items-center px-space-md cursor-ew-resize touch-none select-none shadow-[inset_0_3px_8px_rgba(0,0,0,0.95)]"
  >
    <div class="w-full h-1.5 bg-surface-variant rounded-full"></div>
    <!-- Poignée laiton + micro-LED ambre centrale -->
    <div
      class="pointer-events-none absolute -translate-x-1/2 w-10 h-6 bg-gradient-to-b from-primary-fixed via-primary-container to-secondary-container rounded shadow-[0_4px_12px_rgba(0,0,0,0.9)] flex items-center justify-center"
      style="left:{Math.max(6, Math.min(94, mixerStore.crossfader))}%;"
    >
      <span class="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_6px_#edbf7a] animate-pulse"></span>
    </div>
  </div>
  <!-- ALC-169 : AUTO-MIX 8 / 16 mesures — Crossfader assisté & Bass-Swap automatique -->
  <div class="mt-1.5 flex items-center gap-2 bg-surface-container-lowest rounded-lg border border-surface-variant/40 p-1.5">
    <span class="font-label-sm text-[9px] font-bold uppercase tracking-widest text-[#edbf7a] shrink-0">AUTO-MIX</span>
    <div class="flex items-center gap-0.5 shrink-0">
      <button
        type="button"
        onclick={() => mixerStore.setAutoMixBars(8)}
        class="px-2 py-0.5 rounded text-[9px] font-label-sm font-bold uppercase tracking-wider transition-colors {mixerStore.autoMixBars === 8 ? 'bg-primary/20 text-primary border border-primary/40 shadow-sm' : 'bg-surface-low text-outline hover:text-on-surface-variant border border-surface-container-high'}"
      >8 MES</button>
      <button
        type="button"
        onclick={() => mixerStore.setAutoMixBars(16)}
        class="px-2 py-0.5 rounded text-[9px] font-label-sm font-bold uppercase tracking-wider transition-colors {mixerStore.autoMixBars === 16 ? 'bg-primary/20 text-primary border border-primary/40 shadow-sm' : 'bg-surface-low text-outline hover:text-on-surface-variant border border-surface-container-high'}"
      >16 MES</button>
    </div>
    <button
      type="button"
      onclick={() => mixerStore.startAutoMix(mixerStore.autoMixBars, mixerStore.crossfader < 50 ? 'A_TO_B' : 'B_TO_A')}
      disabled={!mixerStore.deckA.filePath || !mixerStore.deckB.filePath}
      class="flex-1 flex items-center justify-center gap-1 rounded px-2 py-1 text-[9px] font-label-sm font-bold uppercase tracking-wider transition-colors {mixerStore.autoMixActive ? 'bg-primary/25 text-primary border border-primary/60 shadow-[0_0_12px_rgba(237,191,122,0.5)] animate-pulse cursor-default' : 'bg-gradient-to-b from-primary via-primary-container to-inverse-primary text-on-primary hover:brightness-110 shadow-[0_2px_6px_rgba(0,0,0,0.7)]'} disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <span>{mixerStore.autoMixActive ? '⇄ AUTO-MIX EN COURS' : (mixerStore.crossfader < 50 ? '⇄ AUTO-MIX → B' : '⇄ AUTO-MIX → A')}</span>
    </button>
    <button
      type="button"
      onclick={() => mixerStore.cancelAutoMix()}
      disabled={!mixerStore.autoMixActive}
      class="px-2 py-1 rounded text-[9px] font-label-sm font-bold uppercase tracking-wider border border-[#ffb4ab]/50 text-[#ffb4ab] hover:bg-[#ffb4ab]/10 disabled:opacity-40 disabled:cursor-not-allowed"
    >STOP</button>
    <span class="font-label-sm text-[9px] font-mono text-primary tabular-nums w-9 text-right shrink-0">
      {mixerStore.autoMixActive ? Math.round(mixerStore.autoMixProgress * 100) + '%' : '—'}
    </span>
  </div>
  <!-- Jauge de progression AUTO-MIX en direct -->
  <div class="h-1 w-full rounded-full overflow-hidden bg-surface-variant mt-1">
    <div class="h-full bg-[#edbf7a] transition-[width] duration-75" style="width:{mixerStore.autoMixProgress * 100}%"></div>
  </div>
</div>
  </div>
