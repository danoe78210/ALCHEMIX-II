<script lang="ts">
  interface Props {
    value: number;
  }

  let { value = $bindable() }: Props = $props();

  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

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
</script>

<!-- Bottom Master Crossfader & Mechanical Lubrication Gauge Strip -->
<div class="bg-surface-container-low rounded-xl p-space-md shadow-[0_8px_24px_rgba(0,0,0,0.85)] flex flex-col md:flex-row items-center justify-between gap-space-md">
  <!-- Crossfader Channel Assignment Label Left -->
  <div class="flex items-center">
    <span class="font-label-md text-[11px] font-bold text-emerald-400 font-mono">[CANAL A]</span>
  </div>

  <!-- Master Tactile Heavy Crossfader -->
  <div class="w-full max-w-xl flex flex-col gap-space-xs">
    <div class="flex justify-between items-center text-[10px] font-mono text-outline tabular-nums">
      <span class="text-emerald-400 font-bold">100% CANAL A</span>
      <span class="text-primary font-bold">{100 - value} / {value} ÉQUILIBRE</span>
      <span class="text-cyan-400 font-bold">100% CANAL B</span>
    </div>
    <div
      role="slider" tabindex={0} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}
      onpointerdown={capture}
      onpointermove={move}
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
  <div class="flex items-center">
    <span class="font-label-md text-[11px] font-bold text-cyan-400 font-mono">[CANAL B]</span>
  </div>
</div>
