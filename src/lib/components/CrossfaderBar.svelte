<script lang="ts">
  import { mixerStore } from '$lib/stores/mixer.svelte';
  import MarqueeText from '$lib/components/MarqueeText.svelte';

  interface Props {
    value: number;
  }

  let { value = $bindable() }: Props = $props();

  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
  const pctA = $derived(100 - value);
  const pctB = $derived(value);
  const titleA = $derived(mixerStore.deckA.trackTitle || 'Vide');
  const keyA = $derived(mixerStore.deckA.camelotKey || '');
  const titleB = $derived(mixerStore.deckB.trackTitle || 'Vide');
  const keyB = $derived(mixerStore.deckB.camelotKey || '');

  function applyValue(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    value = Math.round(clamp01((e.clientX - rect.left) / rect.width) * 100);
  }

  function capture(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    applyValue(e);
  }

  function move(e: PointerEvent) {
    if ((e.buttons & 1) !== 0) applyValue(e);
  }

  function reset() {
    value = 50;
  }

  // ALC-105-1 : réagit aux touches fléchées / Home / End sur le curseur.
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); value = Math.max(0, value - 2); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); value = Math.min(100, value + 2); }
    else if (e.key === 'Home') { value = 0; }
    else if (e.key === 'End') { value = 100; }
  }
</script>

<!-- Bottom Master Crossfader & Mechanical Lubrication Gauge Strip -->
<div class="bg-surface-container-low rounded-xl p-space-md shadow-[0_8px_24px_rgba(0,0,0,0.85)] flex flex-col md:flex-row items-center justify-between gap-space-md">
  <!-- Crossfader Channel Assignment Label Left -->
  <button
    onclick={() => (value = 0)}
    class="flex flex-col items-start gap-1 px-2 py-1 rounded-lg border text-left transition-all {value <= 10 ? 'bg-emerald-500/20 border-emerald-500/60 shadow-[0_0_12px_#10b981]' : 'bg-surface-container-high border-surface-variant/40'}"
  >
    <span class="font-mono text-[11px] font-bold text-emerald-400">DECK A • {pctA}%</span>
    <div class="w-full min-w-0 max-w-[9rem]">
        <MarqueeText text={titleA + (keyA ? ` — ${keyA}` : '')} innerClass="text-[9px] text-on-surface-variant" />
      </div>
  </button>

  <!-- Master Tactile Heavy Crossfader -->
  <div class="w-full max-w-xl flex flex-col gap-space-xs">
    <div class="flex justify-between items-center text-[10px] font-mono text-outline tabular-nums">
      <span class="text-emerald-400 font-bold">100% CANAL A</span>
      <button onclick={() => (value = 50)} class="text-primary font-bold cursor-pointer" aria-label="Centrer le crossfader (50/50)">{100 - value} / {value} ÉQUILIBRE</button>
      <span class="text-cyan-400 font-bold">100% CANAL B</span>
    </div>
    <div
      role="slider" tabindex={0} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}
      onpointerdown={capture}
      onpointermove={move}
      onkeydown={onKey}
      ondblclick={reset}
      class="relative h-10 bg-surface-container-lowest rounded-lg flex items-center px-space-md shadow-[inset_0_3px_8px_rgba(0,0,0,0.95)] cursor-ew-resize touch-none select-none"
    >
      <div class="w-full h-1.5 bg-surface-variant rounded-full"></div>
      <!-- Crossfader Chiseled Brass Handle -->
      <div
        class="pointer-events-none absolute -translate-x-1/2 w-14 h-8 bg-gradient-to-b from-primary-fixed via-primary-container to-secondary-container rounded shadow-[0_4px_12px_rgba(0,0,0,0.9)] flex items-center justify-center border-none"
        style="left: {Math.max(8, Math.min(92, value))}%;"
      >
        <!-- Micro-LED ambre/dorée au cœur de la poignée du crossfader -->
        <span class="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_6px_#edbf7a] animate-pulse"></span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        bind:value
        ondblclick={reset}
        aria-label="Master Crossfader"
        class="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize"
      />
    </div>
  </div>

  <!-- Crossfader Channel Assignment Label Right -->
  <button
    onclick={() => (value = 100)}
    class="flex flex-col items-end gap-1 px-2 py-1 rounded-lg border text-right transition-all {value >= 90 ? 'bg-[#00A3FF]/20 border-[#00A3FF]/60 shadow-[0_0_12px_#00A3FF]' : 'bg-surface-container-high border-surface-variant/40'}"
  >
    <span class="font-mono text-[11px] font-bold text-[#38bdf8]">DECK B • {pctB}%</span>
    <div class="w-full min-w-0 max-w-[9rem] ml-auto">
        <MarqueeText text={titleB + (keyB ? ` — ${keyB}` : '')} innerClass="text-[9px] text-on-surface-variant" />
      </div>
  </button>
</div>
