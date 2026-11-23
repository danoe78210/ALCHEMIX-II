<script lang="ts">
  import { audioIpc } from '$lib/ipc/client';
  import RhythmKeyTelemetry from '$lib/components/RhythmKeyTelemetry.svelte';
  import { Player, mimeFromPath } from '$lib/audio/player';
  import MarqueeText from '$lib/components/MarqueeText.svelte';
  import HorologicalDrawer from '$lib/components/HorologicalDrawer.svelte'; // ALC-186-2
  import VzSliderRail from '$lib/components/VzSliderRail.svelte'; // ALC-260-2
  import VzTip from '$lib/components/VzTip.svelte'; // ALC-255 WP15
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
  // ALC-260-1 : VOLUME CANAL centré — 0.0 dB exactement à 50 % du rail (gauche ≤ −24 → coupure, droite → +6 dB).
  const volumeNormalized = $derived(
    deck.volumeDb <= 0 ? ((deck.volumeDb + 24) / 24) * 50 : 50 + (deck.volumeDb / 6) * 50
  );
  const volumeDisplay = $derived(deck.volumeDb <= -24 ? '−∞ dB' : `${deck.volumeDb.toFixed(1)} dB`);
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
  // ALC-186-2 : tiroirs horlogers escamotables (fermés par défaut, ouverture auto en extraction).
  let stemsDrawerOpen = $state(false);
  let metaDrawerOpen = $state(false);
  // ALC-260-2 : états de glissement — intensifie la lueur des micro-LEDs (80 ms) pendant le drag.
  let dragVol = $state(false);
  let dragPitch = $state(false);
  let dragLow = $state(false);
  let dragHigh = $state(false);
  const stemsActive = $derived(
    deck.stemsStatus === 'ready' || Object.values(deck.stemMutes).some(Boolean)
  );
  const stemsBadge = $derived(
    deck.stemsStatus === 'ready'
      ? '4 STEMS'
      : deck.stemsStatus === 'separating'
        ? `${deck.stemsProgress}%`
        : deck.stemsStatus === 'error'
          ? 'ERREUR'
          : deck.codec || '—'
  );
  // ALC-255 WP14 : fallback overlay du tiroir Stems si la hauteur sous la colonne est insuffisante.
  let stemsOverflow = $state(false);
  function updateStemsOverflow() {
    stemsOverflow = window.innerHeight < 820;
  }
  const metaBadge = $derived(deck.codec ? `${deck.codec} • ${(deck.sampleRate || '').split(' / ')[0]}` : '—');
  // ALC-255 WP13 : pastilles BPM / Clé permanentes sur la façade du tiroir ID3.
  const metaChips = $derived({
    bpm: deck.filePath ? `${effectiveBpm.toFixed(1)} BPM` : '--.- BPM',
    key: deck.filePath ? (deck.camelotKey || '--') : '--',
  });
  $effect(() => {
    // ALC-186-2 : ouverture AUTOMATIQUE du tiroir STEMS dès que l'extraction démarre.
    if (deck.stemsStatus === 'separating') stemsDrawerOpen = true;
  });

  function readMeterFrame() {
    if (!player) return;
    const { rms, peak } = player.read();
    mixerStore.setLevels('B', rms, peak);
    meterRaf = requestAnimationFrame(readMeterFrame);
  }

  async function startPlayer() {
    // ALC-192-2 : adopter un Player déjà préparé par le store (ex. Beatgrid ▶ LANCER A+B) — pas de doublon.
    if (!player) player = mixerStore.getPlayer('B');
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
    // ALC-255 WP14 : recalcul du mode d'ouverture du tiroir Stems au redimensionnement.
    updateStemsOverflow();
    window.addEventListener('resize', updateStemsOverflow);
  });
  onDestroy(() => {
    unlistenDrag?.();
    cancelAnimationFrame(needleRaf);
    cancelAnimationFrame(meterRaf);
    window.removeEventListener('alchemix:shutdown', handleShutdown);
    window.removeEventListener('resize', updateStemsOverflow);
    mixerStore.registerPlayer('B', null);
    player?.dispose();
  });

  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
  const pctFromEvent = (e: PointerEvent, el: HTMLElement) =>
    clamp01((e.clientX - el.getBoundingClientRect().left) / el.getBoundingClientRect().width);
  function captureVol(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    dragVol = true;
    applyVol(e, el);
  }
  function applyVol(e: PointerEvent, el: HTMLElement) {
    // ALC-260-1 : 0.0 dB = centre (50 %) ; gauche −24 (coupure) → 0, droite 0 → +6 dB.
    const p = pctFromEvent(e, el);
    deck.volumeDb = Number((p < 0.5 ? -24 + (p / 0.5) * 24 : (p - 0.5) * 12).toFixed(1));
  }
  function moveVol(e: PointerEvent) {
    if ((e.buttons & 1) !== 0) applyVol(e, e.currentTarget as HTMLElement);
  }
  function capturePitch(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    dragPitch = true;
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
    dragLow = true;
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
    dragHigh = true;
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
  /* ALC-255 WP14 : tiroir Stems IA ≤150px — couleur de canal via --acc / --chip-txt */
  .vz-stems-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: linear-gradient(180deg, #1a1410, #120d0a);
    border: 1px solid var(--acc, #00A3FF);
    border-radius: 8px;
    box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.7);
  }
  /* ALC-256 WP21 : ligne de statut STEMS PRÊTS (16px) — remplace la barre "bouton désactivé" */
  .vz-stem-status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 16px;
    color: var(--chip-txt, var(--vz-ch-b-text, #6cc4ff));
    font-family: var(--font-label-sm, ui-monospace, monospace);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .vz-stem-status-icon { font-size: 16px; flex: none; }
  .vz-stem-status-txt { line-height: 1; }
  .vz-stem-extract {
    position: relative;
    width: 100%;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid var(--acc, #00A3FF);
    border-radius: var(--vz-radius, 6px);
    background: linear-gradient(180deg, var(--vz-key-top, #2b231d), var(--vz-key-bottom, #17120e));
    color: var(--chip-txt, var(--vz-ch-b-text, #6cc4ff));
    font-family: var(--font-label-sm, ui-monospace, monospace);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
    transition: filter 140ms var(--vz-ease, cubic-bezier(0.22, 1, 0.36, 1)), transform var(--vz-t-press, 80ms);
  }
  .vz-stem-extract:hover:not([aria-disabled='true']) { filter: brightness(1.08); }
  .vz-stem-extract:active:not([aria-disabled='true']) { transform: translateY(1px); }
  .vz-stem-extract[aria-disabled='true'] {
    cursor: not-allowed;
    filter: saturate(0.35);
    opacity: 0.55;
  }
  .vz-stem-extract .vz-icon { font-size: 16px; flex: none; }
  .vz-stem-extract .vz-label { position: relative; z-index: 1; }
  .vz-stem-progress {
    position: absolute;
    left: 1px;
    bottom: 1px;
    height: 3px;
    border-radius: 0 0 var(--vz-radius, 6px) var(--vz-radius, 6px);
    background: linear-gradient(90deg, var(--acc, #00A3FF), var(--chip-txt, #6cc4ff));
    transition: width 120ms ease;
  }
  .vz-stem-loading { animation: vz-stem-breathe 1.6s var(--vz-ease, cubic-bezier(0.22, 1, 0.36, 1)) infinite; }
  @keyframes vz-stem-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.75; } }
  .vz-stem-key {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    height: 36px;
    padding: 4px 2px;
    box-sizing: border-box;
    line-height: 1;
    border: 1px solid var(--vz-key-edge, #665643);
    border-radius: var(--vz-radius, 6px);
    background: transparent;
    color: var(--vz-text-mid, #b8a68a);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    cursor: pointer;
    transition: filter 140ms var(--vz-ease, cubic-bezier(0.22, 1, 0.36, 1)), transform var(--vz-t-press, 80ms);
  }
  .vz-stem-key:hover:not([aria-disabled='true']) { filter: brightness(1.08); }
  .vz-stem-key:active:not([aria-disabled='true']) { transform: translateY(1px); }
  .vz-stem-key-on {
    border-color: var(--acc, #00A3FF);
    color: var(--chip-txt, var(--vz-ch-b-text, #6cc4ff));
    background: linear-gradient(180deg, #120d0a, #1d1611);
  }
  .vz-stem-key-disabled {
    cursor: not-allowed;
    color: #b8a68a; /* ≥3:1 même en désactivé (remplace --vz-text-disabled trop bas) */
    filter: saturate(0.45);
    opacity: 0.85;
    border-style: dashed;
  }
  /* ALC-256 WP21 : état muté (visible même en niveaux de gris) */
  .vz-stem-key-muted {
    border-color: var(--vz-key-edge, #665643);
    background: transparent;
    color: var(--vz-text-mid, #b8a68a);
    filter: saturate(0.5);
    opacity: 0.75;
  }
  .vz-stem-key-muted .vz-stem-led {
    background: #241d17;
    border-color: #3d3328;
    box-shadow: inset 0 0 2px rgba(0, 0, 0, 0.9);
  }
  .vz-stem-led {
    position: absolute;
    top: 3px;
    right: 4px;
    width: 4px;
    height: 4px;
    border-radius: 9999px;
    background: #241d17;
    border: 1px solid #3d3328;
    box-shadow: inset 0 0 2px rgba(0, 0, 0, 0.9);
  }
  .vz-stem-key-on .vz-stem-led {
    background: var(--acc, #00A3FF);
    border-color: var(--acc, #00A3FF);
    box-shadow: 0 0 6px var(--acc, #00A3FF);
  }
  .vz-stem-icon { font-size: 16px; flex: none; }
  .vz-stem-label { line-height: 1; text-align: center; padding: 0 2px; }
  .vz-stem-preset {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 30px;
    width: 100%;
    border-radius: var(--vz-radius, 5px);
    background: transparent;
    border: 1px solid var(--vz-key-edge, #665643);
    color: var(--vz-text-mid, #b8a68a);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: filter 140ms var(--vz-ease, cubic-bezier(0.22, 1, 0.36, 1)), transform var(--vz-t-press, 80ms);
  }
  .vz-stem-preset:hover:not([aria-disabled='true']) { filter: brightness(1.08); }
  .vz-stem-preset:active:not([aria-disabled='true']) { transform: translateY(1px); }
  .vz-stem-preset[aria-pressed='true'] {
    border-color: var(--acc, #00A3FF);
    color: var(--chip-txt, var(--vz-ch-b-text, #6cc4ff));
    background: linear-gradient(180deg, #120d0a, #1d1611);
  }
  .vz-stem-preset[aria-disabled='true'] { cursor: not-allowed; color: var(--vz-text-disabled, #7a6a55); filter: saturate(0.4); opacity: 0.6; }
  .vz-stem-preset .vz-stem-icon { font-size: 16px; }
  @media (prefers-reduced-motion: reduce) {
    .vz-stem-loading { animation: none; }
  }
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
  <div class="flex items-center justify-between px-space-xs z-10 relative {deck.transport === 'playing' ? 'drop-shadow-[0_0_10px_rgba(0,163,255,0.5)]' : ''}">
    <div class="pointer-events-none absolute inset-0 rounded-sm" style="background:linear-gradient(135deg,rgba(255,255,255,0.05),transparent 45%);"></div>
    <div class="flex items-center gap-space-xs">
      <div class="w-2.5 h-2.5 rounded-full bg-[#00A3FF] shadow-[0_0_8px_#00A3FF] animate-pulse"></div>
      <span class="font-label-sm text-label-sm text-cyan-300 uppercase font-bold tracking-widest">{deck.channelSub}</span>
    </div>
    <div class="flex items-center gap-2">
      <span class="px-1.5 py-0.5 rounded bg-sky-950/80 border border-cyan-400/40 font-mono text-[10px] text-cyan-300 font-bold tracking-wider whitespace-nowrap shrink-0">{#if deck.filePath}{deck.camelotKey} • {effectiveBpm} BPM{:else}— • —.– BPM{/if}</span>
      <div class="flex items-center gap-[2px] bg-surface-container-highest px-space-sm py-0.5 rounded shadow-[inset_1px_1px_4px_rgba(0,0,0,0.9)] border border-surface-variant/40">
        <VzTip text="Basculer écoulé / restant">
          <button onclick={() => (showRemaining = !showRemaining)} aria-label="Basculer écoulé / restant"
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-primary/60 bg-surface-container-lowest shadow-[inset_0_2px_6px_rgba(0,0,0,0.9),0_0_10px_rgba(237,191,122,0.25)] hover:border-primary/80 transition-colors">
            <span class="font-label-sm text-[10px] text-primary uppercase tracking-widest">ROLL</span>
            <span class="font-mono font-bold text-base text-cyan-300 tracking-[0.15em] tabular-nums">{displayedTime}</span>
          </button>
        </VzTip>
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
    <div class="relative bg-[#efe5cf] text-[#1c1611] rounded p-2 shadow-[inset_0_1px_3px_rgba(0,0,0,0.4)] border-2 border-[#00A3FF]/70 z-40 flex flex-col gap-1">
      <!-- Top Label Specifications -->
      <div class="flex items-center justify-between border-b border-[#c8b99d] pb-1">
        <div class="flex items-center gap-1.5">
          <span class="font-label-sm text-[10px] font-bold tracking-widest text-[#0c4a6e] uppercase font-mono">B</span>
          <span class="font-serif font-bold text-[11px] tracking-wide text-[#2b2219] truncate min-w-0 max-w-full" title={deck.artist}>{deck.artist ? deck.artist.toUpperCase() : 'SERENISSIMA'}</span>
          
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
          <div class="mt-1.5 w-2 h-2 rounded-full {deck.transport === 'playing' ? 'bg-[#00A3FF] shadow-[0_0_8px_#00A3FF] animate-pulse' : 'bg-[#5b4a3a]'}" aria-label="Tête de lecture"></div>
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
  <!-- ALC-256 WP21 : Tiroir 1 — STEMS IA, grille 4 colonnes strictes, ligne statut STEMS PRÊTS 16px -->
  <HorologicalDrawer bind:open={stemsDrawerOpen} title="STEMS IA" subtitle="HTDemucs • local" badge={stemsBadge} active={stemsActive} accent="blue" mode={stemsOverflow ? 'overlay' : 'flow'}>
    <div class="vz-stems-panel">
      <!-- Ligne 1 : EXTRAIRE STEMS 36px / ligne de statut 16px quand prêt -->
      {#if deck.stemsStatus === 'ready'}
        <div class="vz-stem-status" role="status">
          <span class="material-symbols-outlined vz-stem-status-icon" aria-hidden="true">check_circle</span>
          <span class="vz-stem-status-txt">Stems prêts</span>
        </div>
      {:else}
        <VzTip text={deck.stemsStatus === 'separating' ? 'Extraction HTDemucs en cours…' : 'Lancer l’extraction des 4 stems (voix, batterie, basse, autre)'} block>
          <button type="button"
            onclick={() => mixerStore.extractDeckStems(deck.id)}
            disabled={!deck.filePath || deck.stemsStatus === 'separating'}
            aria-disabled={!deck.filePath || deck.stemsStatus === 'separating'}
            class="vz-stem-extract {deck.stemsStatus === 'separating' ? 'vz-stem-loading' : ''}">
            {#if deck.stemsStatus === 'separating'}
              <span class="material-symbols-outlined vz-icon">sync</span>
              <span class="vz-label">Extraction {deck.stemsProgress}%…</span>
              <span class="vz-stem-progress" style="width:{Math.max(0, Math.min(100, deck.stemsProgress))}%"></span>
            {:else}
              <span class="material-symbols-outlined vz-icon">bolt</span>
              <span class="vz-label">Extraire stems</span>
            {/if}
          </button>
        </VzTip>
      {/if}

      <!-- Ligne 2 : 4 stems latching, grille 4 colonnes strictes et égales (VOIX / BATT / BASSE / AUTRE) -->
      <div class="grid grid-cols-4 gap-1.5 w-full">
        {#each [['vocals','VOIX','mic'],['drums','BATT','graphic_eq'],['bass','BASSE','music_note'],['other','AUTRE','piano']] as [k, label, ico] (k)}
          {@const stem = k as 'vocals' | 'drums' | 'bass' | 'other'}
          {@const on = !deck.stemMutes[stem] && (deck.stemGains[stem] ?? 1) > 0.02}
          {@const ready = deck.stemsStatus === 'ready'}
          <VzTip text={ready ? `Clic = Mute • Clic droit / Alt+Clic = Solo (${label})` : 'Extraire d’abord les stems'}>
            <button type="button"
              onclick={() => mixerStore.hitStem(deck.id, stem)}
              oncontextmenu={(e) => { e.preventDefault(); mixerStore.soloStem(deck.id, stem); }}
              aria-pressed={on}
              aria-disabled={!ready}
              disabled={!ready}
              class="vz-stem-key w-full {on ? 'vz-stem-key-on' : (ready && deck.stemMutes[stem] ? 'vz-stem-key-muted' : '')} {ready ? '' : 'vz-stem-key-disabled'}">
              <span class="vz-stem-led" aria-hidden="true"></span>
              <span class="material-symbols-outlined vz-stem-icon" aria-hidden="true">{ico}</span>
              <span class="vz-stem-label">{label}</span>
            </button>
          </VzTip>
        {/each}
      </div>

      <!-- Ligne 3 : presets grid-cols-2 (ACAPELLA mic / SANS VOIX mic_off) -->
      <div class="grid grid-cols-2 gap-1.5 w-full" role="group" aria-label="Préréglages stem">
        <VzTip text="Garder seulement la voix (tout le reste coupé)" block>
          <button type="button" onclick={() => mixerStore.setStemPreset(deck.id, 'acapella')} disabled={deck.stemsStatus !== 'ready'} aria-disabled={deck.stemsStatus !== 'ready'} aria-pressed={deck.stemsStatus === 'ready' && !deck.stemMutes.vocals && (deck.stemGains.drums ?? 1) <= 0.02 && (deck.stemGains.bass ?? 1) <= 0.02 && (deck.stemGains.other ?? 1) <= 0.02} class="vz-stem-preset" data-rail="a">
            <span class="material-symbols-outlined vz-stem-icon" aria-hidden="true">mic</span>
            <span>ACAPELLA</span>
          </button>
        </VzTip>
        <VzTip text="Garder l’instrumental (voix coupée)" block>
          <button type="button" onclick={() => mixerStore.setStemPreset(deck.id, 'instrumental')} disabled={deck.stemsStatus !== 'ready'} aria-disabled={deck.stemsStatus !== 'ready'} aria-pressed={deck.stemsStatus === 'ready' && deck.stemMutes.vocals} class="vz-stem-preset" data-rail="b">
            <span class="material-symbols-outlined vz-stem-icon" aria-hidden="true">mic_off</span>
            <span>SANS VOIX</span>
          </button>
        </VzTip>
      </div>
    </div>
  </HorologicalDrawer>
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
      <div class="relative h-7 bg-surface-container-lowest rounded flex items-center px-space-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.95)] cursor-ew-resize touch-none select-none" role="slider" tabindex={0} aria-valuemin={-6} aria-valuemax={6} aria-valuenow={deck.lowEqDb} aria-label="Low EQ" onpointerdown={captureLowEq} onpointermove={moveLowEq} onpointerup={() => (dragLow = false)} onwheel={onLowEqWheel} ondblclick={() => (deck.lowEqDb = 0.0)}>
        <VzSliderRail value={lowEqNormalized / 100} accent="blue" dragging={dragLow} ticks={[{ at: 0, label: '-6' }, { at: 0.5, label: '0 dB', lum: true }, { at: 1, label: '+6' }]} />
        <div class="w-full h-1 bg-surface-variant rounded-full"></div>
        <div class="absolute -translate-x-1/2 w-7 h-5 bg-gradient-to-b from-primary-fixed to-primary-container rounded shadow-[0_4px_8px_rgba(0,0,0,0.8)] flex items-center justify-center pointer-events-none" style="left:{lowEqNormalized}%;"><span class="w-1.5 h-1.5 rounded-full bg-[#00A3FF] shadow-[0_0_6px_#00A3FF]"></span></div>
      </div>
    </div>
    <div>
      <div class="flex items-center justify-between">
        <span class="font-label-sm text-[9px] text-tertiary uppercase font-bold tracking-wider">FILTRE AIGU • HIGH EQ 3.2 kHz</span>
        <span class="font-label-md text-[10px] text-tertiary font-mono font-bold">{deck.highEqDb >= 0 ? '+' : ''}{deck.highEqDb.toFixed(1)} dB</span>
      </div>
      <div class="relative h-7 bg-surface-container-lowest rounded flex items-center px-space-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.95)] cursor-ew-resize touch-none select-none" role="slider" tabindex={0} aria-valuemin={-6} aria-valuemax={6} aria-valuenow={deck.highEqDb} aria-label="High EQ" onpointerdown={captureHighEq} onpointermove={moveHighEq} onpointerup={() => (dragHigh = false)} onwheel={onHighEqWheel} ondblclick={() => (deck.highEqDb = 0.0)}>
        <VzSliderRail value={highEqNormalized / 100} accent="blue" dragging={dragHigh} ticks={[{ at: 0, label: '-6' }, { at: 0.5, label: '0 dB', lum: true }, { at: 1, label: '+6' }]} />
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
<button onclick={() => mixerStore.setTransport(deck.id, 'playing')} disabled={!deck.filePath} class="flex flex-col items-center justify-center py-space-sm rounded transition-all duration-200 group shadow-[0_2px_4px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,221,176,0.12)] {deck.transport === 'playing' ? 'bg-[#063f6b]/90 translate-y-0.5 shadow-[inset_0_2px_6px_rgba(0,0,0,0.9),0_0_12px_rgba(0,163,255,0.4)]' : 'bg-surface-container-high hover:bg-surface-container-highest disabled:opacity-40 disabled:pointer-events-none'}">
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
<span class="font-label-md text-label-md text-cyan-300 font-mono font-bold tabular-nums">{volumeDisplay}</span>
</div>
<!-- Slider Track -->
<div class="relative h-8 bg-surface-container-lowest rounded flex items-center px-space-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.95)] cursor-ew-resize touch-none select-none" role="slider" tabindex={0} aria-valuemin={-24} aria-valuemax={6} aria-valuenow={deck.volumeDb} aria-label="Volume" onpointerdown={captureVol} onpointermove={moveVol} onpointerup={() => (dragVol = false)} ondblclick={() => (deck.volumeDb = 0.0)}>
<!-- Engraved Decibel Graduation -->
<VzSliderRail value={volumeNormalized / 100} accent="blue" boost dragging={dragVol} ticks={[{ at: 0, label: '−∞' }, { at: 0.25, label: '−12' }, { at: 0.5, label: '0 dB', lum: true }, { at: 0.75, label: '+3' }, { at: 1, label: '+6' }]} />
<div class="w-full h-1 bg-surface-variant rounded-full"></div>
<!-- Gold Heavy Slider Thumb -->
<div class="absolute -translate-x-1/2 w-8 h-6 rounded overflow-hidden border border-[#8c6d3f]/60 bg-gradient-to-b from-[#3a2f24] via-[#6b5a3c] to-[#18120e] flex items-center justify-center pointer-events-none shadow-[0_4px_8px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,221,176,0.16),inset_0_-3px_6px_rgba(0,0,0,0.6)]" style="left: {volumeNormalized}%;">
<span class="absolute inset-0 pointer-events-none opacity-50" style="background:repeating-linear-gradient(0deg,rgba(0,0,0,0.45) 0 1px,transparent 1px 3px);"></span>
<span class="relative w-[3px] h-4 rounded-full bg-[#00A3FF] shadow-[0_0_7px_#00A3FF]"></span>
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
<div class="relative h-8 bg-surface-container-lowest rounded flex items-center px-space-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.95)] cursor-ew-resize touch-none select-none" role="slider" tabindex={0} aria-valuemin={-8} aria-valuemax={8} aria-valuenow={deck.pitchPercent} aria-label="Pitch" onpointerdown={capturePitch} onpointermove={movePitch} onpointerup={() => (dragPitch = false)} ondblclick={() => (deck.pitchPercent = 0.0)}>
<VzSliderRail value={pitchNormalized / 100} accent="blue" dragging={dragPitch} ticks={[{ at: 0, label: '-8%' }, { at: 0.25, label: '-4%' }, { at: 0.5, label: '0%', lum: true }, { at: 0.75, label: '+4%' }, { at: 1, label: '+8%' }]} />
<div class="w-full h-1 bg-surface-variant rounded-full"></div>
<!-- Gold Heavy Slider Thumb -->
<div class="absolute -translate-x-1/2 w-8 h-6 rounded overflow-hidden border border-[#8c6d3f]/60 bg-gradient-to-b from-[#3a2f24] via-[#6b5a3c] to-[#18120e] flex items-center justify-center pointer-events-none shadow-[0_4px_8px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,221,176,0.16),inset_0_-3px_6px_rgba(0,0,0,0.6)]" style="left: {pitchNormalized}%;">
<span class="absolute inset-0 pointer-events-none opacity-50" style="background:repeating-linear-gradient(0deg,rgba(0,0,0,0.45) 0 1px,transparent 1px 3px);"></span>
<span class="relative w-[3px] h-4 rounded-full bg-[#00A3FF] shadow-[0_0_7px_#00A3FF]"></span>
</div>
</div>
</div>
</div>
<!-- Télémétrie Rythme & Clef (ALC-128) : placée sous les 2 sliders, avant Info/Pochette -->
<RhythmKeyTelemetry deck={deck} />

<!-- ALC-186 : Tiroir 2 — MÉTADONNÉES & SPECS AUDIO (trappe horlogère) -->
<HorologicalDrawer bind:open={metaDrawerOpen} title="MÉTADONNÉES & SPECS AUDIO" badge={metaBadge} active={false} accent="blue" direction="up" chips={metaChips} chipsId="alch-meta-chips-b">
<!-- ALC-189-2 / ALC-255 WP16 : grille 3 colonnes (88px pochette | 1fr infos | auto badge technique) -->
<div class="grid grid-cols-[88px_1fr_auto] gap-3 items-center p-3 bg-[#17120f] rounded-lg">
  <!-- Col 1 : pochette 88x88 (cadre laiton 1px, ombre interne) — OPUS décoratif supprimé WP16 -->
  <div class="w-[88px] h-[88px] rounded-[4px] overflow-hidden relative border border-[#8c6d3f]/60 shadow-[inset_0_2px_8px_rgba(0,0,0,0.6)]">
    {#if deck.coverUrl}
      <img class="w-full h-full object-cover" alt={deck.coverAlt} src={deck.coverUrl}>
    {:else}
      <div class="w-full h-full flex items-center justify-center bg-[#120d0a]"><span class="material-symbols-outlined text-[26px] text-outline">album</span></div>
    {/if}
  </div>
  <!-- Col 2 : infos compactes -->
  <div class="min-w-0">
    <span class="font-label-sm text-[10px] text-outline uppercase tracking-wider block">INFORMATIONS</span>
    <span class="font-label-md text-[11px] text-on-surface font-bold leading-tight block truncate">{deck.trackTitle}</span>
    <span class="font-body-sm text-[9px] text-on-surface-variant block truncate">Artiste : {deck.artist || '—'}</span>
    <span class="font-body-sm text-[9px] text-on-surface-variant block truncate">Album : {deck.album || '—'}</span>
    <span class="font-body-sm text-[9px] text-on-surface-variant block truncate">Genre : {deck.genre || '—'}</span>
    <span class="font-body-sm text-[9px] text-on-surface-variant block truncate">Année : {deck.year || '—'}</span>
  </div>
  <!-- Col 3 : badge technique vertical (valeurs neutres, unités mid) -->
  <div class="flex flex-col gap-1.5 justify-center border-l border-[#4f4539]/40 pl-2">
    <div class="flex flex-col"><span class="font-label-sm text-[10px] text-outline uppercase">Format</span><span class="font-mono text-[10px] font-bold text-[#f3dfbd]">{deck.codec}</span></div>
    <div class="flex flex-col"><span class="font-label-sm text-[10px] text-outline uppercase">Échantillon</span><span class="font-mono text-[10px] font-bold text-[#f3dfbd]">{deck.sampleRate}</span></div>
    <div class="flex flex-col"><span class="font-label-sm text-[10px] text-outline uppercase">Débit</span><span class="font-mono text-[10px] font-bold text-[#f3dfbd]">{deck.bitrate}</span></div>
  </div>
</div>
</HorologicalDrawer>
</div>