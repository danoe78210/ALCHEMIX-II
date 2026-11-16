<script lang="ts">
  import { onDestroy } from 'svelte';

  interface Props {
    value: number;
    min?: number;
    max?: number;
    label?: string;
    unit?: string;
  }
  let { value = $bindable(), min = -6, max = 6, label = 'LOW EQ', unit = 'dB' }: Props = $props();

  // ALC-132-4 : potentiomètre rotatif cranté laiton/cuivre — glissement vertical ou molette.
  const pct = $derived(((value - min) / (max - min)) * 100);
  const angle = $derived(-135 + ((value - min) / (max - min)) * 270);
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const ticks = $derived(Array.from({ length: 9 }, (_, i) => -135 + i * (270 / 8)));

  let startY = 0;
  let startVal = 0;

  function capture(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    startY = e.clientY;
    startVal = value;
  }
  function move(e: PointerEvent) {
    if ((e.buttons & 1) !== 0) {
      value = clamp(startVal + ((startY - e.clientY) / 140) * (max - min));
    }
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const step = (max - min) / 30;
    value = clamp(value + (e.deltaY < 0 ? step : -step));
  }

  onDestroy(() => {});
</script>

<div class="flex flex-col items-center gap-1 select-none touch-none">
  <div
    role="slider"
    tabindex="0"
    aria-label={label}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={Number(value.toFixed(1))}
    onpointerdown={capture}
    onpointermove={move}
    onwheel={onWheel}
    onkeydown={(e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); value = clamp(value + 1); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); value = clamp(value - 1); }
    }}
    class="relative w-11 h-11 cursor-ns-resize"
  >
    <!-- Corps du bouton laiton / cuivre -->
    <svg viewBox="0 0 48 48" class="w-full h-full">
      <circle cx="24" cy="24" r="21" fill="url(#knob-body)" stroke="#7a5c2f" stroke-width="1.5" />
      <defs>
        <radialGradient id="knob-body" cx="35%" cy="30%" r="80%">
          <stop offset="0%" stop-color="#f0cf96" />
          <stop offset="55%" stop-color="#c89d5c" />
          <stop offset="100%" stop-color="#6f5226" />
        </radialGradient>
      </defs>
      <!-- Encoches crantées -->
      {#each ticks as t (t)}
        <line
          x1={24 + 17 * Math.sin((t * Math.PI) / 180)}
          y1={24 - 17 * Math.cos((t * Math.PI) / 180)}
          x2={24 + 20 * Math.sin((t * Math.PI) / 180)}
          y2={24 - 20 * Math.cos((t * Math.PI) / 180)}
          stroke="#5b431f"
          stroke-width="1.4"
        />
      {/each}
      <!-- Aiguille / pointeur -->
      <line
        x1="24"
        y1="24"
        x2={24 + 12 * Math.sin((angle * Math.PI) / 180)}
        y2={24 - 12 * Math.cos((angle * Math.PI) / 180)}
        stroke="#2b200f"
        stroke-width="2.4"
        stroke-linecap="round"
      />
      <circle cx="24" cy="24" r="3.5" fill="#241c10" />
    </svg>
  </div>
  <span class="font-mono text-[9px] text-on-surface-variant uppercase tracking-wider">{label}</span>
  <span class="font-mono text-[9px] text-primary tabular-nums">{value >= 0 ? '+' : ''}{value.toFixed(1)} {unit}</span>
</div>