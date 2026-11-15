<script lang="ts">
  import { audioIpc } from '$lib/ipc/client';
  import {
    computeEffectiveBpm,
    formatTime,
    mixerStore,
    type DeckState,
  } from '$lib/stores/mixer.svelte';

  interface Props {
    deck: DeckState;
  }

  let { deck = $bindable() }: Props = $props();

  let showRemaining = $state(false);

  const effectiveBpm = $derived(computeEffectiveBpm(deck.baseBpm, deck.pitchPercent));
  const remainingSeconds = $derived(Math.max(0, deck.durationSeconds - deck.elapsedSeconds));
  const displayedTime = $derived(
    showRemaining ? `-${formatTime(remainingSeconds)}` : formatTime(deck.elapsedSeconds)
  );
  const volumePercent = $derived(Math.round(((deck.volumeDb + 24) / 30) * 100));
  const volumeNormalized = $derived(((deck.volumeDb + 24) / 30) * 100);
  const pitchNormalized = $derived(((deck.pitchPercent + 8) / 16) * 100);
  const needleAngle = $derived(
    deck.transport === 'playing'
      ? Math.max(-35, Math.min(24, -12 + (deck.volumeDb + 12) * 1.4))
      : -38
  );

  async function handleBrowseTrack() {
    // Sélecteur de fichiers audio via la commande Rust Tauri v2 `open_audio_file`
    const selected = await audioIpc.openAudioFile();
    if (selected) {
      await mixerStore.loadTrackFromPath(deck.id, selected);
    }
  }

  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
  const pctFromEvent = (e: PointerEvent, el: HTMLElement) =>
    clamp01((e.clientX - el.getBoundingClientRect().left) / el.getBoundingClientRect().width);
  function captureVol(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    applyVol(e, el);
  }
  function applyVol(e: PointerEvent, el: HTMLElement) {
    deck.volumeDb = Number((-24 + pctFromEvent(e, el) * 30).toFixed(1)); // -24..+6 dB
  }
  function moveVol(e: PointerEvent) {
    if ((e.buttons & 1) !== 0) applyVol(e, e.currentTarget as HTMLElement);
  }
  function capturePitch(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    applyPitch(e, el);
  }
  function applyPitch(e: PointerEvent, el: HTMLElement) {
    deck.pitchPercent = Number((-8 + pctFromEvent(e, el) * 16).toFixed(2)); // -8..+8 %
  }
  function movePitch(e: PointerEvent) {
    if ((e.buttons & 1) !== 0) applyPitch(e, e.currentTarget as HTMLElement);
  }

</script>

<div class="flex flex-col gap-space-md bg-surface-container-low p-space-md rounded-xl shadow-[0_12px_32px_rgba(0,0,0,0.9)] relative overflow-hidden" style="grid-column: span 3 / span 3;">
<!-- Deck Header Plate -->
<div class="flex items-center justify-between pb-space-sm bg-surface-container-high/60 px-space-sm py-space-xs rounded shadow-sm">
<div class="flex items-center gap-space-sm">
<div class="w-3 h-3 rounded-full bg-[#00A3FF] shadow-[0_0_10px_#00A3FF]" style="box-shadow: rgb(0, 163, 255) 0px 0px 10px, rgb(0, 163, 255) 0px 0px 20px, rgba(0, 163, 255, 0.85) 0px 0px 35px;"></div>
<span class="font-label-md text-label-md tracking-wider font-bold text-on-surface uppercase">{deck.channelTitle}</span>
</div>
</div>
<!-- Smoked Amber Cassette Bay with Electric Blue Glow Border -->
<div class="relative bg-[#0d0907] rounded-xl p-space-sm border border-cyan-400/40 shadow-[inset_0_4px_20px_rgba(0,0,0,0.98)] shadow-[0_0_24px_rgba(0,163,255,0.35)] flex flex-col gap-2" style="box-shadow: rgba(14, 165, 233, 0.9) 0px 0px 20px, rgba(14, 165, 233, 0.6) 0px 0px 45px, rgba(14, 165, 233, 0.35) 0px 0px 70px, rgba(14, 165, 233, 0.45) 0px 0px 20px inset, rgba(0, 0, 0, 0.98) 0px 4px 20px inset; border-color: rgba(56, 189, 248, 0.9);">
  <!-- Deck B Top Header & Counter Bar -->
  <div class="flex items-center justify-between px-space-xs z-10 relative">
    <div class="flex items-center gap-space-xs">
      <div class="w-2.5 h-2.5 rounded-full bg-[#00A3FF] shadow-[0_0_8px_#00A3FF] animate-pulse"></div>
      <span class="font-label-sm text-label-sm text-cyan-300 uppercase font-bold tracking-widest">{deck.channelSub}</span>
    </div>
    <div class="flex items-center gap-2">
      <span class="px-1.5 py-0.5 rounded bg-sky-950/80 border border-cyan-400/40 font-mono text-[10px] text-cyan-300 font-bold tracking-wider whitespace-nowrap shrink-0">8B • 126.0 BPM</span>
      <div class="flex items-center gap-[2px] bg-surface-container-highest px-space-sm py-0.5 rounded shadow-[inset_1px_1px_4px_rgba(0,0,0,0.9)] border border-surface-variant/40">
        <span class="font-label-sm text-[9px] text-outline uppercase tracking-wider mr-1">ROLL</span>
        <span class="font-label-md text-label-md font-bold text-cyan-300 tracking-widest font-mono">{displayedTime}</span>
      </div>
    </div>
  </div>

  <!-- Hyper-Realistic Audiophile Cassette Body (Type II Serenissima) -->
  <div class="relative w-full rounded-lg bg-gradient-to-b from-[#251e18] via-[#1a1410] to-[#130f0c] p-2.5 border border-[#4a3b2c]/60 shadow-[0_8px_20px_rgba(0,0,0,0.95)] overflow-hidden">
    <!-- Cassette Shell Glass Gloss & Texture Reflection -->
    <div class="absolute inset-0 bg-gradient-to-tr from-white/5 via-transparent to-white/10 pointer-events-none rounded-lg z-20"></div>
    
    <!-- Corner Screws (4 brass/metal screws) -->
    <div class="absolute top-1.5 left-1.5 w-2 h-2 rounded-full bg-[#8c7853] border border-[#2e261a] flex items-center justify-center shadow-inner z-20">
      <div class="w-1.5 h-[0.5px] bg-[#1a150e] rotate-12"></div>
    </div>
    <div class="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#8c7853] border border-[#2e261a] flex items-center justify-center shadow-inner z-20">
      <div class="w-1.5 h-[0.5px] bg-[#1a150e] -rotate-45"></div>
    </div>
    <div class="absolute bottom-1.5 left-1.5 w-2 h-2 rounded-full bg-[#8c7853] border border-[#2e261a] flex items-center justify-center shadow-inner z-20">
      <div class="w-1.5 h-[0.5px] bg-[#1a150e] rotate-90"></div>
    </div>
    <div class="absolute bottom-1.5 right-1.5 w-2 h-2 rounded-full bg-[#8c7853] border border-[#2e261a] flex items-center justify-center shadow-inner z-20">
      <div class="w-1.5 h-[0.5px] bg-[#1a150e] rotate-60"></div>
    </div>

    <!-- Realistic Vintage Ivory / Beige Label Card -->
    <div class="relative bg-[#efe5cf] text-[#1c1611] rounded p-2 shadow-[inset_0_1px_3px_rgba(0,0,0,0.4)] border border-[#c5b597] z-10 flex flex-col gap-1">
      <!-- Top Label Specifications -->
      <div class="flex items-center justify-between border-b border-[#c8b99d] pb-1">
        <div class="flex items-center gap-1.5">
          <span class="font-label-sm text-[10px] font-bold tracking-widest text-[#0c4a6e] uppercase font-mono">B</span>
          <span class="font-serif font-bold text-[11px] tracking-wide text-[#2b2219]">SERENISSIMA</span>
          
        </div>
        <div class="flex items-center gap-2 text-[9px] font-mono text-[#544535]">
          
          
        </div>
      </div>

      <!-- Hand-inscribed Track Title Area -->
      <div class="flex items-center justify-between pt-0.5 px-0.5">
        <div class="flex flex-col">
          <span class="text-[8px] font-mono uppercase text-[#73624f] leading-none">TITRE / OEUVRE</span>
          <span class="font-serif font-bold text-[13px] text-[#1a140e] leading-tight tracking-tight">{deck.trackTitle}</span>
        </div>
        <div class="text-right">
          
          
        </div>
      </div>

      <!-- Transparent Center Spool Window & Rotating Magnetic Tape -->
      <div class="relative mt-1 mx-auto w-full h-20 bg-[#16120e] rounded border border-[#2b221a] shadow-[inset_0_3px_10px_rgba(0,0,0,0.9)] overflow-hidden flex items-center justify-around px-3">
        <!-- Glass glare line -->
        <div class="absolute inset-0 bg-gradient-to-b from-white/10 via-transparent to-black/40 pointer-events-none"></div>
        <!-- Scale markers on the glass window -->
        <div class="absolute top-1 inset-x-12 flex justify-between text-[7px] font-mono text-[#a89678]/50 pointer-events-none">
          <span>100</span>
          <span>50</span>
          <span>0</span>
          <span>50</span>
          <span>100</span>
        </div>

        <!-- Left Spool with 3-Prong Cog & Coiled Magnetic Tape Ribbon (Less tape on supply) -->
        <div class="relative flex items-center justify-center">
          <div class="w-11 h-11 rounded-full bg-[#3d2211] border-2 border-[#5c351c] shadow-[inset_0_0_8px_rgba(0,0,0,0.8)] flex items-center justify-center">
            <!-- White Ivory 3-Prong Toothed Hub (Rotating) -->
            <div class="w-9 h-9 rounded-full bg-[#e8ded0] border border-[#8c7d68] flex items-center justify-center animate-spin [animation-duration:9s] shadow-md">
              <div class="relative w-full h-full flex items-center justify-center">
                <div class="absolute w-1.5 h-7 bg-[#d4c7b2] rounded-xs"></div>
                <div class="absolute w-1.5 h-7 bg-[#d4c7b2] rounded-xs rotate-60"></div>
                <div class="absolute w-1.5 h-7 bg-[#d4c7b2] rounded-xs -rotate-60"></div>
                <div class="w-4 h-4 rounded-full bg-[#16120e] border border-[#786b59] flex items-center justify-center z-10">
                  <div class="w-2 h-2 rounded-full bg-[#d4c7b2]"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Center Magnetic Tape Bridge & Visual Guide Window -->
        <div class="flex flex-col items-center justify-center w-12 z-10">
          <div class="w-10 h-3 bg-[#0a0705] rounded-xs border border-[#382b20] flex items-center justify-center p-0.5 shadow-inner">
            <!-- Dark Ferric Brown Tape Ribbon -->
            <div class="w-full h-1.5 bg-gradient-to-r from-[#3e2111] via-[#522d17] to-[#3e2111] rounded-xs"></div>
          </div>
          
        </div>

        <!-- Right Spool with 3-Prong Cog & Coiled Tape (More tape on take-up spool) -->
        <div class="relative flex items-center justify-center">
          <div class="w-14 h-14 rounded-full bg-[#3d2211] border-2 border-[#5c351c] shadow-[inset_0_0_8px_rgba(0,0,0,0.8)] flex items-center justify-center">
            <!-- White Ivory 3-Prong Toothed Hub (Rotating) -->
            <div class="w-9 h-9 rounded-full bg-[#e8ded0] border border-[#8c7d68] flex items-center justify-center animate-spin [animation-duration:9s] shadow-md">
              <div class="relative w-full h-full flex items-center justify-center">
                <div class="absolute w-1.5 h-7 bg-[#d4c7b2] rounded-xs"></div>
                <div class="absolute w-1.5 h-7 bg-[#d4c7b2] rounded-xs rotate-60"></div>
                <div class="absolute w-1.5 h-7 bg-[#d4c7b2] rounded-xs -rotate-60"></div>
                <div class="w-4 h-4 rounded-full bg-[#16120e] border border-[#786b59] flex items-center justify-center z-10">
                  <div class="w-2 h-2 rounded-full bg-[#d4c7b2]"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Bottom Trapezoidal Cassette Head Cavity & Guide Rollers -->
      <div class="flex items-center justify-between px-3 pt-1 border-t border-[#c8b99d]">
        <span class="font-mono text-[7px] text-[#786955]">COMPACT CASSETTE</span>
        <div class="flex items-center gap-3">
          <div class="w-2 h-2 rounded-full bg-[#3d2f21] border border-[#7a6449] shadow-inner"></div>
          <div class="w-6 h-2 rounded-xs bg-[#241c14] border border-[#63503b]"></div>
          <div class="w-2 h-2 rounded-full bg-[#3d2f21] border border-[#7a6449] shadow-inner"></div>
        </div>
        <span class="font-mono text-[7px] text-[#786955]">MASTER POSITION</span>
      </div>
    </div>
  </div>
</div>
<!-- Realistic Ballistic Galvanometer VU Meter -->
<div class="bg-surface-container-high rounded-xl p-space-sm shadow-[0_6px_16px_rgba(0,0,0,0.85)] flex flex-col gap-space-xs relative overflow-hidden">
<div class="flex items-center justify-between px-space-xs">
<span class="font-label-sm text-label-sm text-outline uppercase tracking-wider">Acoustic Galvanometer • Deck B</span>
<div class="flex items-center gap-space-xs">
<span class="font-label-sm text-label-sm text-error uppercase">PEAK</span>
<div class="w-2 h-2 rounded-full bg-error"></div>
</div>
</div>
<!-- Gauge Parchment Faceplate with Glass Reflection -->
<div class="relative h-28 bg-[#f5ebd7] rounded-lg p-space-sm flex flex-col justify-between overflow-hidden shadow-[inset_0_2px_8px_rgba(0,0,0,0.7)] text-inverse-on-surface">
<!-- Glass Curvature Highlight -->
<div class="absolute inset-0 bg-gradient-to-b from-white/30 to-transparent pointer-events-none"></div>
<!-- Scale Ticks & Decibel Markings -->
<div class="relative z-10 flex justify-between font-label-sm text-label-sm font-bold text-stone-800 px-2 pt-1 font-mono">
<span>-20</span>
<span>-10</span>
<span>-7</span>
<span>-5</span>
<span>-3</span>
<span>-1</span>
<span class="text-amber-800">0</span>
<span class="text-red-700">+1</span>
<span class="text-red-700">+3</span>
<span class="text-red-800">+5 dB</span>
</div>
<!-- Curved Scale Arc (SVG) -->
<svg class="absolute inset-x-0 top-6 w-full h-12 text-stone-700" fill="none" viewBox="0 0 280 40">
<path d="M 20 38 Q 140 10 260 38" stroke="currentColor" stroke-dasharray="2 3" stroke-width="1.5"></path>
<path d="M 190 28 Q 225 22 260 38" stroke="#b91c1c" stroke-width="2.5"></path>
</svg>
<!-- Ballistic Galvanometer Needle Swing -->
<div class="absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-24 origin-bottom transition-transform duration-150 ease-out z-20 pointer-events-none" style="transform: rotate({needleAngle}deg);">
<div class="w-0.5 h-full bg-red-700 mx-auto shadow-sm"></div>
</div>
<!-- Needle Pivot Coil Hub -->
<div class="absolute bottom-[-10px] left-1/2 -translate-x-1/2 w-9 h-9 rounded-full bg-stone-900 flex items-center justify-center z-30 shadow-[0_-2px_6px_rgba(0,0,0,0.6)]">
<div class="w-4 h-4 rounded-full bg-primary-container"></div>
</div>
<!-- Dial Subtext -->
<div class="relative z-10 flex justify-between font-label-sm text-label-sm text-stone-600 font-serif pt-6">
<span>VU GALVANOMETRE</span>
<span>100% MODULATION</span>
</div>
</div>
</div>
<!-- Mechanical Spring-Loaded Playback Controls -->
<div class="bg-surface-container rounded-xl p-space-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.8)]">
<div class="grid grid-cols-7 gap-space-xs">
<button class="flex flex-col items-center justify-center py-space-sm bg-surface-container-high hover:bg-surface-container-highest active:translate-y-0.5 transition-all rounded shadow-[0_2px_4px_rgba(0,0,0,0.7)] group">
<span class="material-symbols-outlined text-[16px] text-error">fiber_manual_record</span>
<span class="font-label-sm text-label-sm text-outline-variant group-hover:text-on-surface">REC</span>
</button>
<button class="flex flex-col items-center justify-center py-space-sm bg-surface-container-high hover:bg-surface-container-highest active:translate-y-0.5 transition-all rounded shadow-[0_2px_4px_rgba(0,0,0,0.7)] group">
<span class="material-symbols-outlined text-[16px] text-on-surface-variant">fast_rewind</span>
<span class="font-label-sm text-label-sm text-outline-variant group-hover:text-on-surface">REW</span>
</button>
<button class="flex flex-col items-center justify-center py-space-sm bg-surface-container-high hover:bg-surface-container-highest active:translate-y-0.5 transition-all rounded shadow-[0_2px_4px_rgba(0,0,0,0.7)] group">
<span class="material-symbols-outlined text-[16px] text-on-surface-variant">fast_forward</span>
<span class="font-label-sm text-label-sm text-outline-variant group-hover:text-on-surface">FFWD</span>
</button>
<!-- Active Illuminated Play Button -->
<button class="flex flex-col items-center justify-center py-space-sm bg-sky-950/80 rounded shadow-[inset_0_2px_6px_rgba(0,0,0,0.9)] translate-y-0.5 group">
<span class="material-symbols-outlined text-[18px] text-sky-400 drop-shadow-[0_0_8px_#00A3FF]">play_arrow</span>
<span class="font-label-sm text-label-sm text-sky-300 font-bold">PLAY</span>
</button>
<button class="flex flex-col items-center justify-center py-space-sm bg-surface-container-high hover:bg-surface-container-highest active:translate-y-0.5 transition-all rounded shadow-[0_2px_4px_rgba(0,0,0,0.7)] group">
<span class="material-symbols-outlined text-[16px] text-on-surface-variant">pause</span>
<span class="font-label-sm text-label-sm text-outline-variant group-hover:text-on-surface">PAUSE</span>
</button>
<button class="flex flex-col items-center justify-center py-space-sm bg-surface-container-high hover:bg-surface-container-highest active:translate-y-0.5 transition-all rounded shadow-[0_2px_4px_rgba(0,0,0,0.7)] group">
<span class="material-symbols-outlined text-[16px] text-primary">hearing</span>
<span class="font-label-sm text-label-sm text-outline-variant group-hover:text-on-surface">CUE</span>
</button>
<button onclick={handleBrowseTrack} class="flex flex-col items-center justify-center py-space-sm bg-surface-container-high hover:bg-surface-container-highest active:translate-y-0.5 transition-all rounded shadow-[0_2px_4px_rgba(0,0,0,0.7)] group">
<span class="material-symbols-outlined text-[16px] text-secondary">eject</span>
<span class="font-label-sm text-label-sm text-outline-variant group-hover:text-on-surface">EJECT</span>
</button>
</div>
</div>
<!-- Dual Precision Gold Slider Potentiometers (Stacked) -->
<div class="bg-surface-container-high rounded-xl p-space-md shadow-[0_4px_16px_rgba(0,0,0,0.75)] flex flex-col gap-space-md">
<!-- Volume Slider -->
<div class="flex flex-col gap-space-xs">
<div class="flex items-center justify-between">
<span class="font-label-sm text-label-sm text-primary uppercase font-bold tracking-wider">POTENTIOMÈTRE VOLUME DECK {deck.sideLetter}</span>
<span class="font-label-md text-label-md text-cyan-300 font-mono font-bold">{deck.volumeDb.toFixed(1)} dB ({volumePercent}%)</span>
</div>
<!-- Slider Track -->
<div class="relative h-8 bg-surface-container-lowest rounded flex items-center px-space-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.95)] cursor-ew-resize touch-none select-none" role="slider" tabindex={0} aria-valuemin={-24} aria-valuemax={6} aria-valuenow={deck.volumeDb} aria-label="Volume" onpointerdown={captureVol} onpointermove={moveVol} ondblclick={() => (deck.volumeDb = 0.0)}>
<!-- Engraved Decibel Graduation -->
<div class="absolute inset-x-4 flex justify-between text-[8px] font-mono text-outline/60 pointer-events-none">
<span>-INF</span>
<span>-18</span>
<span>-12</span>
<span>-6</span>
<span>0 dB</span>
<span>+3</span>
<span>+6</span>
</div>
<div class="w-full h-1 bg-surface-variant rounded-full"></div>
<!-- Gold Heavy Slider Thumb -->
<div class="absolute -translate-x-1/2 w-8 h-6 bg-gradient-to-b from-primary-fixed to-primary-container rounded shadow-[0_4px_8px_rgba(0,0,0,0.8)] flex items-center justify-center pointer-events-none" style="left: {volumeNormalized}%;">
<!-- Micro-LED bleue du curseur Volume (Deck B) -->
<span class="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_#00A3FF]"></span>
</div>
</div>
</div>
<!-- Pitch Slider -->
<div class="flex flex-col gap-space-xs">
<div class="flex items-center justify-between">
<span class="font-label-sm text-label-sm text-primary uppercase font-bold tracking-wider">RÉGULATEUR CADENCE (PITCH)</span>
<span class="font-label-md text-label-md text-secondary font-mono font-bold">{deck.pitchPercent >= 0 ? '+' : ''}{deck.pitchPercent}% ({effectiveBpm.toFixed(1)} BPM)</span>
</div>
<!-- Slider Track -->
<div class="relative h-8 bg-surface-container-lowest rounded flex items-center px-space-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.95)] cursor-ew-resize touch-none select-none" role="slider" tabindex={0} aria-valuemin={-8} aria-valuemax={8} aria-valuenow={deck.pitchPercent} aria-label="Pitch" onpointerdown={capturePitch} onpointermove={movePitch} ondblclick={() => (deck.pitchPercent = 0.0)}>
<div class="absolute inset-x-4 flex justify-between text-[8px] font-mono text-outline/60 pointer-events-none">
<span>-8%</span>
<span>-4%</span>
<span>-2%</span>
<span>0%</span>
<span>+2%</span>
<span>+4%</span>
<span>+8%</span>
</div>
<div class="w-full h-1 bg-surface-variant rounded-full"></div>
<!-- Gold Heavy Slider Thumb -->
<div class="absolute -translate-x-1/2 w-8 h-6 bg-gradient-to-b from-primary-fixed to-primary-container rounded shadow-[0_4px_8px_rgba(0,0,0,0.8)] flex items-center justify-center pointer-events-none" style="left: {pitchNormalized}%;">
<!-- Micro-LED bleue du curseur Pitch (Deck B) -->
<span class="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_#00A3FF]"></span>
</div>
</div>
</div>
</div>
<!-- Album Artwork Card & Technical Specification Plate -->
<div class="grid grid-cols-1 sm:grid-cols-12 gap-space-sm bg-surface-container-high/40 p-space-sm rounded-xl">
<!-- Album Thumbnail Placeholder -->
<div class="sm:col-span-4 aspect-square rounded-lg overflow-hidden shadow-md relative">
<img class="w-full h-full object-cover" alt={deck.coverAlt} src={deck.coverUrl}>
<div class="absolute top-1 left-1 bg-surface-container-lowest/80 px-1 py-0.5 rounded text-[8px] font-label-sm text-cyan-300">{deck.opusLabel}</div>
</div>
<!-- Track & Mechanical Metadata -->
<div class="sm:col-span-8 flex flex-col justify-between">
<div>
<span class="font-label-sm text-label-sm text-outline uppercase tracking-wider block">INFORMATIONS</span>
<span class="font-title-md text-title-md text-on-surface font-bold leading-tight block">{deck.trackTitle}</span>
<span class="font-body-sm text-body-sm text-on-surface-variant block">Genre: {deck.genre}</span>
</div>
<!-- Technical Specs Monospace Tag Matrix -->

</div>
</div><div class="bg-surface-container-lowest/90 border border-surface-variant/40 rounded-xl p-space-sm shadow-[inset_0_2px_8px_rgba(0,0,0,0.7)] flex flex-col gap-space-xs"><div class="flex items-center justify-between pb-1 border-b border-surface-variant/40"><div class="flex items-center gap-space-xs"><span class="material-symbols-outlined text-[14px] text-[#38bdf8]">settings_ethernet</span><span class="font-label-sm text-label-sm font-bold uppercase tracking-wider text-[#38bdf8]">SPÉCIFICATIONS TECHNIQUES • AUDIO</span></div></div><div class="grid grid-cols-2 gap-space-xs pt-1"><div class="bg-surface-container-low px-space-xs py-1 rounded flex flex-col"><span class="font-label-sm text-[8px] text-outline uppercase">Format / Codec</span><span class="font-label-md text-label-md text-primary font-mono font-bold">{deck.codec}</span></div><div class="bg-surface-container-low px-space-xs py-1 rounded flex flex-col"><span class="font-label-sm text-[8px] text-outline uppercase">Échantillonnage</span><span class="font-label-md text-label-md text-tertiary font-mono font-bold">{deck.sampleRate}</span></div><div class="bg-surface-container-low px-space-xs py-1 rounded flex flex-col"><span class="font-label-sm text-[8px] text-outline uppercase">Débit Binaire</span><span class="font-label-md text-label-md text-on-surface font-mono font-bold">{deck.bitrate}</span></div></div></div>
</div>