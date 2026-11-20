<script lang="ts">
  import { audioIpc } from '$lib/ipc/client';
  import RhythmKeyTelemetry from '$lib/components/RhythmKeyTelemetry.svelte';
  import { Player, mimeFromPath } from '$lib/audio/player';
  import MarqueeText from '$lib/components/MarqueeText.svelte';
  import { onMount, onDestroy } from 'svelte';
  import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
  import {
    computeEffectiveBpm,
    dbToLinear,
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
  const lowEqNormalized = $derived(((deck.lowEqDb + 6) / 12) * 100);
  const highEqNormalized = $derived(((deck.highEqDb + 6) / 12) * 100);
  const pitchNormalized = $derived(((deck.pitchPercent + 8) / 16) * 100);
  // ALC-102 : galvanomètre balistique — aiguille pilotée à 60 fps (attaque ~30 ms / relâchement ~300 ms).
  let displayDb = $state(-20); // niveau adouci (inertie balistique) pilotant l'aiguille
  let holdPeakDb = $state(-20); // maintien de crête du témoin PEAK (~1,2 s)
  let peakLit = $state(false);
  let reelAngleL = $state(0);
  let reelAngleR = $state(0);
  const needleAngle = $derived(-38 + (displayDb + 20) * (62 / 25));

  let player = $state<Player | null>(null);
  let meterRaf = 0;
  let needleRaf = 0;

  function readMeterFrame() {
    if (!player) return;
    const { rms, peak } = player.read();
    mixerStore.setLevels('B', rms, peak);
    meterRaf = requestAnimationFrame(readMeterFrame);
  }

  async function startPlayer() {
    if (!player) {
      player = new Player('B');
      player.onTime = (c) => mixerStore.syncPlayback('B', c, 0);
      player.onDuration = (d) => mixerStore.syncPlayback('B', 0, d);
      mixerStore.registerPlayer('B', player);
    }
    await player.resume();
    // ALC-178 : rattache les stems CACHÉS au Player réel (créé lazyment) sinon PLAY joue le mono complet.
    await mixerStore.ensureStemsLoaded('B');
    if (deck.filePath && player.sourcePath !== deck.filePath) {
      try {
        const bytes = await audioIpc.readAudioFileBytes(deck.filePath);
        player.setSource(bytes, mimeFromPath(deck.filePath), deck.filePath);
      } catch (err) {
        deck.lastError = err instanceof Error ? err.message : 'Échec lecture fichier audio';
        console.error('[Player] chargement de la source échoué', err);
      }
    }
    player.setPlaybackRate(deck.pitchPercent);
    player.seek(deck.elapsedSeconds);
    cancelAnimationFrame(meterRaf);
    meterRaf = requestAnimationFrame(readMeterFrame);
    try {
      await player.play();
    } catch (err) {
      deck.lastError = err instanceof Error ? err.message : 'Échec audio.play()';
      console.error('[Player] audio.play a échoué', err);
    }
  }

  // ALC-184 : coupure gérée directement dans les branches EXPLICITES du $effect(deck.transport).
  // L'unique Player est créé dans startPlayer(), enregistré dans le store (registerPlayer) puis
  // réutilisé via getPlayer(id) — aucune instance locale orpheline ne tourne en parallèle.

  function seekDeck(delta: number) {
    const ne = mixerStore.seek(deck.id, delta);
    if (deck.transport === 'playing' && player) player.seek(ne);
  }

  // ALC-139-2 : fermeture propre AudioContext + révocation blob au POWER OFF.
  function handleShutdown() {
    player?.dispose();
  }

  function easeGalvanometer() {
    const dt = 1000 / 60 / 1000; // ~16 ms / frame
    const playing = deck.transport === 'playing';
    const target = playing ? Math.max(-20, mixerStore.rmsDbB) : -20;
    const tau = target > displayDb ? 0.03 : 0.3;
    displayDb += (target - displayDb) * (1 - Math.exp(-dt / tau));

    // Maintien de crête PEAK : rouge incandescent tant que le signal dépasse 0 dB (~1,2 s de maintien).
    const peakNow = playing ? mixerStore.peakDbB : -20;
    if (peakNow > holdPeakDb) holdPeakDb = peakNow;
    else holdPeakDb = Math.max(-20, holdPeakDb - 18.75 * dt);
    peakLit = holdPeakDb >= 0;

    // Bobines : rotation rAF différentielle (débitrice accélère, réceptrice ralentit).
    if (playing) {
      const ratio = deck.durationSeconds > 0 ? Math.max(0, Math.min(1, deck.elapsedSeconds / deck.durationSeconds)) : 0;
      const base = 6;
      reelAngleL = (reelAngleL + base * (1 + 0.6 * (ratio - 0.5))) % 360;
      reelAngleR = (reelAngleR + base * (1 - 0.6 * (ratio - 0.5))) % 360;
    }

    needleRaf = requestAnimationFrame(easeGalvanometer);
  }

  // ALC-136 / ALC-184 : démarre/arrête la lecture selon le transport — branches explicites et réactives.
  $effect(() => {
    if (deck.transport === 'playing') {
      void startPlayer();
    } else if (deck.transport === 'paused') {
      cancelAnimationFrame(meterRaf);
      mixerStore.resetLevels('B');
      player?.pause();
    } else if (deck.transport === 'stopped') {
      cancelAnimationFrame(meterRaf);
      mixerStore.resetLevels('B');
      player?.stop();
    }
  });
  // ALC-132-4 / ALC-143 : LOW EQ (filtre grave lowshelf 120 Hz) + atténuation auto Smart Filter.
  $effect(() => {
    if (player) player.setLowShelf(deck.lowEqDb + mixerStore.smartFilterDb + mixerStore.autoBassB);
  });
  // ALC-143 : bande médium (peaking 900 Hz) — Smart Filter (0 dB hors conflit).
  $effect(() => {
    if (player) player.setMidBand(mixerStore.smartFilterDb);
  });
  // ALC-105-2/137-1 : gain maître = crossfader × volume (0 strict en butée min, τ 0.015 s).
  $effect(() => {
    if (!player) return;
    const volLin = deck.volumeDb <= -24 ? 0 : dbToLinear(deck.volumeDb);
    const g = (deck.id === 'A' ? mixerStore.gainCrossA : mixerStore.gainCrossB) * volLin;
    player.setOutputGain(g);
  });
  // ALC-137-4 : égaliseur aigu (highshelf 3.2 kHz) en temps réel.
  $effect(() => {
    if (player) player.setHighShelf(deck.highEqDb);
  });
  // ALC-136 : pitch/tonalité — playbackRate = 1 + pitchPercent/100, preservesPitch = true.
  $effect(() => {
    if (player && deck.transport === 'playing') player.setPlaybackRate(deck.pitchPercent);
  });

  async function handleBrowseTrack() {
    // Sélecteur de fichiers audio via la commande Rust Tauri v2 `open_audio_file`
    const selected = await audioIpc.openAudioFile();
    if (selected) {
      await mixerStore.loadTrackFromPath(deck.id, selected);
    }
  }

  let unlistenDrag: (() => void) | undefined;

  // ALC-129-2 : glisser-déposer Tauri (tauri://drag-drop) pour charger une piste sur ce platine.
  onMount(() => {
    getCurrentWebviewWindow()
      .onDragDropEvent(async (event) => {
        if (event.payload.type === 'drop') {
          const path = event.payload.paths?.[0];
          if (path) await mixerStore.loadTrackFromPath(deck.id, path);
        }
      })
      .then((u) => (unlistenDrag = u))
      .catch(() => {});
    // ALC-102-2 : lance la boucle d'animation de l'aiguille (cancelAnim au démontage, sans fuite mémoire).
    needleRaf = requestAnimationFrame(easeGalvanometer);
    window.addEventListener('alchemix:shutdown', handleShutdown);
  });
  onDestroy(() => {
    unlistenDrag?.();
    cancelAnimationFrame(needleRaf);
    cancelAnimationFrame(meterRaf);
    window.removeEventListener('alchemix:shutdown', handleShutdown);
    mixerStore.registerPlayer('B', null);
    player?.dispose();
  });

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
  // ALC-139-1 : faders horizontaux EQ (LOW / HIGH) — drag + molette + double-clic reset.
  function applyLowEq(e: PointerEvent, el: HTMLElement) {
    deck.lowEqDb = Number((-6 + clamp01((e.clientX - el.getBoundingClientRect().left) / el.getBoundingClientRect().width) * 12).toFixed(1));
  }
  function captureLowEq(e: PointerEvent) {
    // ALC-169 : toute saisie manuelle du LOW EQ interrompt l'AUTO-MIX immédiatement.
    mixerStore.cancelAutoMix();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    applyLowEq(e, el);
  }
  function moveLowEq(e: PointerEvent) {
    if ((e.buttons & 1) !== 0) applyLowEq(e, e.currentTarget as HTMLElement);
  }
  function onLowEqWheel(e: WheelEvent) {
    e.preventDefault();
    mixerStore.cancelAutoMix();
    deck.lowEqDb = Number(Math.max(-6, Math.min(6, deck.lowEqDb + (e.deltaY < 0 ? 0.5 : -0.5))).toFixed(1));
  }
  function captureHighEq(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    applyHighEq(e, el);
  }
  function applyHighEq(e: PointerEvent, el: HTMLElement) {
    deck.highEqDb = Number((-6 + clamp01((e.clientX - el.getBoundingClientRect().left) / el.getBoundingClientRect().width) * 12).toFixed(1));
  }
  function moveHighEq(e: PointerEvent) {
    if ((e.buttons & 1) !== 0) applyHighEq(e, e.currentTarget as HTMLElement);
  }
  function onHighEqWheel(e: WheelEvent) {
    e.preventDefault();
    deck.highEqDb = Number(Math.max(-6, Math.min(6, deck.highEqDb + (e.deltaY < 0 ? 0.5 : -0.5))).toFixed(1));
  }

</script>

<style>
  .tape-bridge { background-size: 200% 100%; }
  .tape-bridge.running { animation: tapeScroll 1.6s linear infinite; }
  @keyframes tapeScroll { from { background-position: 0 0; } to { background-position: 200% 0; } }
</style>

<div class="flex flex-col gap-space-xs bg-surface-container-low p-space-sm rounded-xl shadow-[0_12px_32px_rgba(0,0,0,0.9)] relative overflow-hidden" style="grid-column: span 3 / span 3;">
<!-- Deck Header Plate -->
<div class="flex items-center justify-between pb-space-sm bg-surface-container-high/60 px-space-sm py-space-xs rounded shadow-sm">
<div class="flex items-center gap-space-sm">
<div class="w-3 h-3 rounded-full bg-[#00A3FF] shadow-[0_0_10px_#00A3FF]" style="box-shadow: rgb(0, 163, 255) 0px 0px 10px, rgb(0, 163, 255) 0px 0px 20px, rgba(0, 163, 255, 0.85) 0px 0px 35px;"></div>
<span class="font-label-md text-label-md tracking-wider font-bold text-on-surface uppercase">{deck.channelTitle}</span>
</div>
</div>
<!-- Smoked Amber Cassette Bay with Electric Blue Glow Border -->
<div role="button" tabindex="0" onclick={() => handleBrowseTrack()} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleBrowseTrack(); } }} class="cursor-pointer relative bg-[#0d0907] rounded-xl p-space-sm border border-cyan-400/40 shadow-[inset_0_4px_20px_rgba(0,0,0,0.98)] shadow-[0_0_24px_rgba(0,163,255,0.35)] flex flex-col gap-2 hover:shadow-[0_0_0_2px_#edbf7a]" style="box-shadow: rgba(14, 165, 233, 0.9) 0px 0px 20px, rgba(14, 165, 233, 0.6) 0px 0px 45px, rgba(14, 165, 233, 0.35) 0px 0px 70px, rgba(14, 165, 233, 0.45) 0px 0px 20px inset, rgba(0, 0, 0, 0.98) 0px 4px 20px inset; border-color: rgba(56, 189, 248, 0.9);">
{#if !deck.filePath}
<div class="font-label-sm text-[9px] uppercase tracking-widest text-[#38bdf8]/70 text-center animate-pulse py-1 pointer-events-none">CLIQUER OU GLISSER UN FICHIER AUDIO</div>
{/if}
  <!-- Deck B Top Header & Counter Bar -->
  <div class="flex items-center justify-between px-space-xs z-10 relative">
    <div class="flex items-center gap-space-xs">
      <div class="w-2.5 h-2.5 rounded-full bg-[#00A3FF] shadow-[0_0_8px_#00A3FF] animate-pulse"></div>
      <span class="font-label-sm text-label-sm text-cyan-300 uppercase font-bold tracking-widest">{deck.channelSub}</span>
    </div>
    <div class="flex items-center gap-2">
      <span class="px-1.5 py-0.5 rounded bg-sky-950/80 border border-cyan-400/40 font-mono text-[10px] text-cyan-300 font-bold tracking-wider whitespace-nowrap shrink-0">{#if deck.filePath}{deck.camelotKey} • {effectiveBpm} BPM{:else}— • —.– BPM{/if}</span>
      <div class="flex items-center gap-[2px] bg-surface-container-highest px-space-sm py-0.5 rounded shadow-[inset_1px_1px_4px_rgba(0,0,0,0.9)] border border-surface-variant/40">
        <button onclick={() => (showRemaining = !showRemaining)} title="Basculer écoulé / restant"
          class="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-primary/60 bg-surface-container-lowest shadow-[inset_0_2px_6px_rgba(0,0,0,0.9),0_0_10px_rgba(237,191,122,0.25)] hover:border-primary/80 transition-colors">
          <span class="font-label-sm text-[10px] text-primary uppercase tracking-widest">ROLL</span>
          <span class="font-mono font-bold text-base text-cyan-300 tracking-[0.15em] tabular-nums">{displayedTime}</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Hyper-Realistic Audiophile Cassette Body (Type II Serenissima) -->
  <div class="relative w-full rounded-lg bg-gradient-to-b from-[#251e18] via-[#1a1410] to-[#130f0c] p-2.5 border border-[#4a3b2c]/60 shadow-[0_8px_20px_rgba(0,0,0,0.95)] overflow-hidden">
    <!-- Cassette Shell Glass Gloss & Texture Reflection -->
    <div class="absolute inset-0 bg-gradient-to-tr from-white/5 via-transparent to-white/10 pointer-events-none rounded-lg z-20"></div>
    <!-- ALC-172 : coque photographique HD (transparente sur fenêtre/bobines) superposée -->
    <img src="/assets/cassette-shell.png" alt="" class="pointer-events-none absolute inset-0 w-full h-full object-cover z-30" />
    
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
    <div class="relative bg-[#efe5cf] text-[#1c1611] rounded p-2 shadow-[inset_0_1px_3px_rgba(0,0,0,0.4)] border-2 border-[#3b82f6]/70 z-40 flex flex-col gap-1">
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
        <div class="min-w-0 flex-1 flex flex-col">
          <span class="text-[8px] font-mono uppercase text-[#73624f] leading-none">TITRE / OEUVRE</span>
          <MarqueeText text={deck.trackTitle || '—'} innerClass="font-serif font-bold text-[13px] text-[#1a140e] leading-tight tracking-tight" />
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
            <!-- White Ivory 3-Prong Toothed Hub (Rotating, pilote par rAF différentielle) -->
            <div class="w-9 h-9 rounded-full bg-[#e8ded0] border border-[#8c7d68] flex items-center justify-center shadow-md" style="transform: rotate({reelAngleL}deg)">
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

        <!-- Center Magnetic Tape Bridge (défilement) + Tête de lecture (lueur) -->
        <div class="flex flex-col items-center justify-center w-16 z-10">
          <div class="w-12 h-3 bg-[#0a0705] rounded-xs border border-[#382b20] flex items-center p-0.5 shadow-inner overflow-hidden">
            <div class="tape-bridge h-1.5 w-full bg-gradient-to-r from-[#3e2111] via-[#522d17] to-[#3e2111] rounded-xs" class:running={deck.transport === 'playing'}></div>
          </div>
          <div class="mt-1.5 w-2 h-2 rounded-full {deck.transport === 'playing' ? 'bg-[#00A3FF] shadow-[0_0_8px_#00A3FF] animate-pulse' : 'bg-[#5b4a3a]'}" title="Tête de lecture"></div>
        </div>

        <!-- Right Spool with 3-Prong Cog & Coiled Tape (More tape on take-up spool) -->
        <div class="relative flex items-center justify-center">
          <div class="w-14 h-14 rounded-full bg-[#3d2211] border-2 border-[#5c351c] shadow-[inset_0_0_8px_rgba(0,0,0,0.8)] flex items-center justify-center">
            <!-- White Ivory 3-Prong Toothed Hub (Rotating, pilote par rAF différentielle) -->
            <div class="w-9 h-9 rounded-full bg-[#e8ded0] border border-[#8c7d68] flex items-center justify-center shadow-md" style="transform: rotate({reelAngleR}deg)">
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
<span class="font-label-sm text-label-sm uppercase {peakLit ? 'text-error' : 'text-outline'}">PEAK</span>
<div class="w-2 h-2 rounded-full {peakLit ? 'bg-error shadow-[0_0_8px_#38bdf8,0_0_16px_rgba(248,113,113,0.7)] animate-ping' : 'bg-error/25 opacity-70'}"></div>
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
<div class="absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-24 origin-bottom z-20 pointer-events-none" style="transform: rotate({needleAngle}deg);">
<div class="w-0.5 h-full bg-red-700 mx-auto shadow-sm"></div>
</div>
<!-- Needle Pivot Coil Hub -->
<div class="absolute bottom-[-10px] left-1/2 -translate-x-1/2 w-9 h-9 rounded-full bg-stone-900 flex items-center justify-center z-30 shadow-[0_-2px_6px_rgba(0,0,0,0.6)]">
<div class="w-4 h-4 rounded-full bg-primary-container"></div>
</div>
<!-- Dial Subtext -->
<div class="relative z-10 flex justify-between font-label-sm text-label-sm text-stone-600 font-serif pt-6">
<span>NIVEAU ANALOGIQUE</span>
<span>100% MODULATION</span>
</div>
</div>
</div>
{#if deck.filePath}
  <!-- ALC-174-4 : Mini-rack horloger STEMS IA (HTDemucs / ONNX local) -->
  <div class="bg-surface-container-high rounded-xl p-space-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.8)]">
    <div class="flex items-center justify-between pb-1 border-b border-surface-variant/40 mb-1 px-space-xs">
      <span class="font-label-sm text-[9px] text-[#edbf7a] uppercase tracking-widest">STEMS IA</span>
      <span class="font-mono text-[8px] text-outline uppercase">HTDemucs • local</span>
    </div>
    <div class="flex flex-col gap-1.5 pt-1 px-space-xs">
      {#if deck.stemsStatus === 'ready'}
        <div class="flex items-center justify-between gap-2">
          <span class="text-[8px] text-[#3b82f6] font-label-sm font-bold uppercase tracking-wider">✓ 4 stems prêts</span>
          <button type="button" onclick={() => mixerStore.exportDeckStems(deck.id)}
            class="px-1.5 py-0.5 rounded border border-[#4a3b2c]/70 bg-gradient-to-b from-[#3a2f24] to-[#201a12] text-[#edbf7a] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:brightness-125 flex items-center gap-1">
            <span class="material-symbols-outlined text-[10px]">{deck.stemsExported ? 'check' : 'download'}</span>
            <span>{deck.stemsExported ? '✓ EXPORTÉS' : '↓ EXPORTER WAV'}</span>
          </button>
        </div>
      {:else if deck.stemsStatus === 'separating'}
        <div class="flex items-center gap-2">
          <div class="flex-1 h-1.5 bg-surface-container-lowest rounded-full overflow-hidden">
            <div class="h-full bg-[#edbf7a]" style="width:{deck.stemsProgress}%"></div>
          </div>
          <span class="text-[9px] font-mono text-[#edbf7a] tabular-nums">{deck.stemsProgress}%</span>
        </div>
      {:else if deck.stemsStatus === 'error'}
        <span class="text-[8px] text-[#ffb4ab] font-label-sm uppercase tracking-wider">⚠ échec extraction</span>
      {/if}
      <button type="button" onclick={() => mixerStore.extractDeckStems(deck.id)}
        disabled={!deck.filePath || deck.stemsStatus === 'separating' || deck.stemsStatus === 'ready'}
        class="w-full text-left px-2 py-1 rounded bg-gradient-to-b from-[#2f2925] to-[#1a1410] border border-[#4a3b2c]/70 text-[#edbf7a] font-label-sm text-[10px] font-bold uppercase tracking-wider hover:brightness-125 disabled:opacity-40 transition-all">
        {deck.stemsStatus === 'ready' ? '✓ STEMS PRÊTS' : '⚡ EXTRAIRE STEMS'}
      </button>
      <div class="grid grid-cols-4 gap-1">
        {#each [['vocals','VOIX'],['drums','BATT'],['bass','BASSE'],['other','INST']] as [k, label] (k)}
          {@const stem = k as 'vocals' | 'drums' | 'bass' | 'other'}
          <button type="button" onclick={() => mixerStore.toggleStemMute(deck.id, stem)}
            oncontextmenu={(e) => { e.preventDefault(); mixerStore.soloStem(deck.id, stem); }}
            class="px-1 py-1 rounded border font-label-sm text-[8px] font-bold uppercase tracking-wider transition-colors {deck.stemMutes[stem] ? 'bg-surface-container-lowest text-outline border-transparent opacity-50' : (stem === 'vocals' ? 'bg-[#10b981]/15 text-[#10b981] border-[#10b981]/40' : 'bg-[#3b82f6]/15 text-[#3b82f6] border-[#3b82f6]/40')}"
            title="Clic = Mute • Clic droit / Alt+Clic = Solo">{label}</button>
        {/each}
      </div>
      <div class="flex items-center gap-1">
        <button type="button" onclick={() => mixerStore.setStemPreset(deck.id, 'acapella')} class="flex-1 px-1.5 py-1 rounded bg-[#10b981]/10 border border-[#10b981]/40 text-[#10b981] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:bg-[#10b981]/20">ACAPELLA</button>
        <button type="button" onclick={() => mixerStore.setStemPreset(deck.id, 'instrumental')} class="flex-1 px-1.5 py-1 rounded bg-[#194f47]/30 border border-[#3b82f6]/40 text-[#3b82f6] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:brightness-125">INST</button>
      </div>
    </div>
  </div>
{/if}
<!-- ALC-137-4 : ÉGALISEUR ANALOGIQUE 2 bandes (LOW EQ / HIGH EQ) pleine largeur -->
<div class="bg-surface-container-high rounded-xl p-space-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.8)]">
  <div class="flex items-center justify-between pb-1 border-b border-surface-variant/40 mb-1 px-space-xs">
    <span class="font-label-sm text-[9px] text-[#edbf7a] uppercase tracking-widest">ÉGALISEUR ANALOGIQUE</span>
    <span class="font-mono text-[8px] text-outline uppercase">LOW 120 Hz · HIGH 3.2 kHz</span>
  </div>
  <div class="flex flex-col gap-space-xs pt-1 px-space-xs">
    <div>
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="font-label-sm text-[9px] text-primary uppercase font-bold tracking-wider">FILTRE GRAVE • LOW EQ 120 Hz</span>
          {#if mixerStore.autoMixActive && mixerStore.autoBassB !== 0}
            <span class="flex items-center gap-1 text-[#edbf7a] font-label-sm text-[8px] font-bold tracking-widest uppercase animate-pulse shrink-0">✦ AUTO-EQ</span>
          {/if}
        </div>
        <span class="font-label-md text-[10px] text-primary font-mono font-bold">{deck.lowEqDb >= 0 ? '+' : ''}{deck.lowEqDb.toFixed(1)} dB</span>
      </div>
      <div class="relative h-7 bg-surface-container-lowest rounded flex items-center px-space-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.95)] cursor-ew-resize touch-none select-none" role="slider" tabindex={0} aria-valuemin={-6} aria-valuemax={6} aria-valuenow={deck.lowEqDb} aria-label="Low EQ" onpointerdown={captureLowEq} onpointermove={moveLowEq} onwheel={onLowEqWheel} ondblclick={() => (deck.lowEqDb = 0.0)}>
        <div class="absolute inset-x-4 flex justify-between text-[8px] font-mono text-outline/60 pointer-events-none"><span>-6</span><span>-3</span><span>0 dB</span><span>+3</span><span>+6</span></div>
        <div class="w-full h-1 bg-surface-variant rounded-full"></div>
        <div class="absolute -translate-x-1/2 w-7 h-5 bg-gradient-to-b from-primary-fixed to-primary-container rounded shadow-[0_4px_8px_rgba(0,0,0,0.8)] flex items-center justify-center pointer-events-none" style="left:{lowEqNormalized}%;"><span class="w-1.5 h-1.5 rounded-full bg-[#00A3FF] shadow-[0_0_6px_#00A3FF]"></span></div>
      </div>
    </div>
    <div>
      <div class="flex items-center justify-between">
        <span class="font-label-sm text-[9px] text-tertiary uppercase font-bold tracking-wider">FILTRE AIGU • HIGH EQ 3.2 kHz</span>
        <span class="font-label-md text-[10px] text-tertiary font-mono font-bold">{deck.highEqDb >= 0 ? '+' : ''}{deck.highEqDb.toFixed(1)} dB</span>
      </div>
      <div class="relative h-7 bg-surface-container-lowest rounded flex items-center px-space-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.95)] cursor-ew-resize touch-none select-none" role="slider" tabindex={0} aria-valuemin={-6} aria-valuemax={6} aria-valuenow={deck.highEqDb} aria-label="High EQ" onpointerdown={captureHighEq} onpointermove={moveHighEq} onwheel={onHighEqWheel} ondblclick={() => (deck.highEqDb = 0.0)}>
        <div class="absolute inset-x-4 flex justify-between text-[8px] font-mono text-outline/60 pointer-events-none"><span>-6</span><span>-3</span><span>0 dB</span><span>+3</span><span>+6</span></div>
        <div class="w-full h-1 bg-surface-variant rounded-full"></div>
        <div class="absolute -translate-x-1/2 w-7 h-5 bg-gradient-to-b from-primary-fixed to-primary-container rounded shadow-[0_4px_8px_rgba(0,0,0,0.8)] flex items-center justify-center pointer-events-none" style="left:{highEqNormalized}%;"><span class="w-1.5 h-1.5 rounded-full bg-[#00A3FF] shadow-[0_0_6px_#00A3FF]"></span></div>
      </div>
    </div>
  </div>
</div>
<!-- Mechanical Spring-Loaded Playback Controls -->
<div class="bg-surface-container rounded-xl p-space-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.8)]">
<div class="grid grid-cols-6 gap-space-xs">
<!-- REW : retour rapide -20 s (ALC-122-3) -->
<button onclick={() => seekDeck(-20)} disabled={!deck.filePath} class="flex flex-col items-center justify-center py-space-sm bg-surface-container-high hover:bg-surface-container-highest active:translate-y-0.5 transition-all rounded shadow-[0_2px_4px_rgba(0,0,0,0.7)] disabled:opacity-40 disabled:pointer-events-none group">
<span class="material-symbols-outlined text-[18px] text-on-surface-variant">fast_rewind</span>
<span class="font-label-sm text-label-sm text-outline-variant group-hover:text-on-surface">REW</span>
</button>
<!-- FFWD : avance rapide +20 s (ALC-122-3) -->
<button onclick={() => seekDeck(20)} disabled={!deck.filePath} class="flex flex-col items-center justify-center py-space-sm bg-surface-container-high hover:bg-surface-container-highest active:translate-y-0.5 transition-all rounded shadow-[0_2px_4px_rgba(0,0,0,0.7)] disabled:opacity-40 disabled:pointer-events-none group">
<span class="material-symbols-outlined text-[18px] text-on-surface-variant">fast_forward</span>
<span class="font-label-sm text-label-sm text-outline-variant group-hover:text-on-surface">FFWD</span>
</button>
<!-- PLAY : actif (enfoncé + illuminé) uniquement pendant la lecture -->
<button onclick={() => mixerStore.setTransport(deck.id, 'playing')} disabled={!deck.filePath} class="flex flex-col items-center justify-center py-space-sm rounded transition-all group shadow-[0_2px_4px_rgba(0,0,0,0.7)] {deck.transport === 'playing' ? 'bg-[#063f6b]/90 translate-y-0.5 shadow-[inset_0_2px_6px_rgba(0,0,0,0.9)]' : 'bg-surface-container-high hover:bg-surface-container-highest disabled:opacity-40 disabled:pointer-events-none'}">
<span class="material-symbols-outlined text-[18px] {deck.transport === 'playing' ? 'text-sky-400 drop-shadow-[0_0_8px_#00A3FF]' : 'text-sky-300'}">play_arrow</span>
<span class="font-label-sm text-label-sm {deck.transport === 'playing' ? 'text-sky-300 font-bold' : 'text-outline-variant group-hover:text-on-surface'}">PLAY</span>
</button>
<!-- STOP -->
<button onclick={() => { player?.stop(); mixerStore.stopDeck(deck.id); }} disabled={!deck.filePath} class="flex flex-col items-center justify-center py-space-sm bg-surface-container-high hover:bg-surface-container-highest active:translate-y-0.5 transition-all rounded shadow-[0_2px_4px_rgba(0,0,0,0.7)] disabled:opacity-40 disabled:pointer-events-none group">
<span class="material-symbols-outlined text-[18px] text-primary">stop</span>
<span class="font-label-sm text-label-sm text-outline-variant group-hover:text-on-surface">STOP</span>
</button>
<!-- EJECT : ouvre le sélecteur de piste -->
<!-- LOAD : charger une piste (ALC-129) — mis en valeur quand la platine est vide -->
<button onclick={handleBrowseTrack} class="flex flex-col items-center justify-center py-space-sm rounded transition-all group shadow-[0_2px_4px_rgba(0,0,0,0.7)] {!deck.filePath ? 'bg-[#063f6b]/80' : 'bg-surface-container-high hover:bg-surface-container-highest'}">
<span class="material-symbols-outlined text-[18px] {!deck.filePath ? 'text-sky-400 drop-shadow-[0_0_6px_#00A3FF]' : 'text-on-surface-variant'}">folder_open</span>
<span class="font-label-sm text-label-sm {!deck.filePath ? 'text-sky-300' : 'text-outline-variant group-hover:text-on-surface'}">LOAD</span>
</button>
<!-- EJECT : décharge la piste (ALC-129) — désactivé tant que vide -->
<button onclick={() => mixerStore.eject(deck.id)} disabled={!deck.filePath} class="flex flex-col items-center justify-center py-space-sm bg-surface-container-high hover:bg-surface-container-highest active:translate-y-0.5 transition-all rounded shadow-[0_2px_4px_rgba(0,0,0,0.7)] disabled:opacity-40 disabled:pointer-events-none group">
<span class="material-symbols-outlined text-[18px] text-secondary">eject</span>
<span class="font-label-sm text-label-sm text-outline-variant group-hover:text-on-surface">EJECT</span>
</button>
</div>
</div>
<!-- Dual Precision Gold Slider Potentiometers (Stacked) -->
<div class="bg-surface-container-high rounded-xl p-space-md shadow-[0_4px_16px_rgba(0,0,0,0.75)] flex flex-col gap-space-md">
<!-- Volume Slider -->
<div class="flex flex-col gap-space-xs">
<div class="flex items-center justify-between">
<span class="font-label-sm text-label-sm text-primary uppercase font-bold tracking-wider">VOLUME CANAL</span>
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
<span class="font-label-sm text-label-sm text-primary uppercase font-bold tracking-wider">CADENCE (PITCH)</span>
<span class="font-label-md text-label-md text-secondary font-mono font-bold">{deck.pitchPercent >= 0 ? '+' : ''}{deck.pitchPercent}%{#if deck.filePath} ({effectiveBpm.toFixed(1)} BPM){/if}</span>
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
<!-- Télémétrie Rythme & Clef (ALC-128) : placée sous les 2 sliders, avant Info/Pochette -->
<RhythmKeyTelemetry deck={deck} />

<!-- Album Artwork Card & Technical Specification Plate -->
<div class="grid grid-cols-1 sm:grid-cols-12 gap-space-sm bg-surface-container-high/40 p-space-sm rounded-xl">
<!-- Album Thumbnail Placeholder -->
<div class="sm:col-span-4 aspect-square rounded-lg overflow-hidden shadow-md relative">
{#if deck.coverUrl}
<img class="w-full h-full object-cover" alt={deck.coverAlt} src={deck.coverUrl}>
{:else}
<div class="w-full h-full flex items-center justify-center bg-surface-container-low"><span class="material-symbols-outlined text-[28px] text-outline">album</span></div>
{/if}
{#if deck.coverUrl}<div class="absolute top-1 left-1 bg-surface-container-lowest/80 px-1 py-0.5 rounded text-[8px] font-label-sm text-cyan-300">{deck.opusLabel}</div>{/if}
</div>
<!-- Track & Mechanical Metadata -->
<div class="sm:col-span-8 flex flex-col justify-between">
<div>
<span class="font-label-sm text-label-sm text-outline uppercase tracking-wider block">INFORMATIONS</span>
<span class="font-title-md text-title-md text-on-surface font-bold leading-tight block">{deck.trackTitle}</span>
<span class="font-body-sm text-body-sm text-on-surface-variant block">Artiste: {deck.artist || '—'}</span>
<span class="font-body-sm text-body-sm text-on-surface-variant block">Album: {deck.album || '—'}</span>
<span class="font-body-sm text-body-sm text-on-surface-variant block">Genre: {deck.genre || '—'}</span>
<span class="font-body-sm text-body-sm text-on-surface-variant block">Année: {deck.year || '—'}</span>
</div>
<!-- Technical Specs Monospace Tag Matrix -->

</div>
</div><div class="bg-surface-container-lowest/90 border border-surface-variant/40 rounded-xl p-space-sm shadow-[inset_0_2px_8px_rgba(0,0,0,0.7)] flex flex-col gap-space-xs"><div class="flex items-center justify-between pb-1 border-b border-surface-variant/40"><div class="flex items-center gap-space-xs"><span class="material-symbols-outlined text-[14px] text-[#38bdf8]">settings_ethernet</span><span class="font-label-sm text-label-sm font-bold uppercase tracking-wider text-[#38bdf8]">SPÉCIFICATIONS TECHNIQUES • AUDIO</span></div></div><div class="grid grid-cols-2 gap-space-xs pt-1"><div class="bg-surface-container-low px-space-xs py-1 rounded flex flex-col"><span class="font-label-sm text-[8px] text-outline uppercase">Format / Codec</span><span class="font-label-md text-label-md text-primary font-mono font-bold">{deck.codec}</span></div><div class="bg-surface-container-low px-space-xs py-1 rounded flex flex-col"><span class="font-label-sm text-[8px] text-outline uppercase">Échantillonnage</span><span class="font-label-md text-label-md text-tertiary font-mono font-bold">{deck.sampleRate}</span></div><div class="bg-surface-container-low px-space-xs py-1 rounded flex flex-col"><span class="font-label-sm text-[8px] text-outline uppercase">Débit Binaire</span><span class="font-label-md text-label-md text-on-surface font-mono font-bold">{deck.bitrate}</span></div></div></div>
</div>