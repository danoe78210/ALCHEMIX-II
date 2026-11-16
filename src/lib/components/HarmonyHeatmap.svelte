<script lang="ts">
  import { mixerStore, type DeckId } from '$lib/stores/mixer.svelte';
  import { parseCamelot, relationFrom, isDissonant } from '$lib/audio/harmony';
  import type { KeySeg } from '$lib/ipc/client';

  // ALC-144 : waveform harmonique secondaire — heatmap des clés Camelot évolutives.
  // Rend les blocs via la même échelle temporelle que la grille rythmique (screenPct),
  // donc parfaitement alignés sous la waveform et traversés par l'aiguille dorée.
  let { id, stride, playhead }: { id: DeckId; stride: number; playhead: number } = $props();

  const WAVE_W = 640;
  const d = $derived(mixerStore.getDeck(id));
  const other = $derived(mixerStore.getDeck(id === 'A' ? 'B' : 'A'));
  const otherKey = $derived(other.camelotKey ? parseCamelot(other.camelotKey) : null);
  const segs = $derived(d.keyTimeline || ([] as KeySeg[]));

  const screenPct = (t: number) => ((t - playhead) * stride + WAVE_W / 2) / WAVE_W * 100;

  // Teinte = numéro Camelot (1A..12B), mode A sombre / B clair, alpha = confiance.
  const colorOf = (code: string, conf: number) => {
    const { num, mode } = parseCamelot(code);
    const hue = ((num - 1) / 12) * 360;
    const light = mode === 'B' ? 40 : 32;
    const alpha = (0.5 + 0.45 * Math.max(0, Math.min(1, conf))).toFixed(2);
    return `hsl(${hue.toFixed(0)} 75% ${light}% / ${alpha})`;
  };
  // Clash : ce segment est dissonant vs la clé globale de l'autre platine (≥ 3 quintes).
  const isClash = (code: string) => {
    const rel = relationFrom(parseCamelot(code), otherKey);
    return !!rel && isDissonant(rel);
  };

  interface Block { l: number; w: number; bg: string; clash: boolean; key: string; start: number }

  const blocks = $derived.by(() => {
    if (!segs.length) return null as Block[] | null;
    const out: Block[] = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const t0 = s.timeSeconds;
      const t1 = i + 1 < segs.length ? segs[i + 1].timeSeconds : (d.durationSeconds || t0 + 6);
      const span = Math.max(0.5, t1 - t0);
      out.push({
        l: screenPct(t0),
        w: (span * stride / WAVE_W) * 100,
        bg: colorOf(s.camelotKey, s.confidence),
        clash: isClash(s.camelotKey),
        key: s.camelotKey,
        start: t0,
      });
    }
    return out;
  });

  // Repli honnête (B) : aucune analyse par fenêtre → clé globale affichée sur toute la frise.
  const fallback = $derived.by(() => {
    if (segs.length || !d.camelotKey) return null;
    const span = Math.max(0.5, d.durationSeconds || 6);
    return {
      l: screenPct(0),
      w: (span * stride / WAVE_W) * 100,
      bg: colorOf(d.camelotKey, d.keyConfidence),
      clash: isClash(d.camelotKey),
      key: d.camelotKey,
    };
  });
</script>

<div class="relative h-3 w-full overflow-hidden rounded-sm bg-[#120d0a] border border-surface-variant/30 mt-1">
  {#if blocks}
    {#each blocks as b (b.start)}
      <div
        class="absolute top-0 bottom-0"
        title="{b.key} · {'dissonant vs ' + id + ''}"
        style="left:{b.l}%;width:max(2%,{b.w}%);background:{b.bg};border-right:1px solid rgba(0,0,0,0.45);"
      ></div>
      <span class="absolute top-0 font-mono text-[7px] font-bold leading-none" style="left:{Math.max(1, Math.min(99, b.l))}%;color:rgba(255,255,255,0.85);mix-blend-mode:difference;">{b.key}</span>
      {#if b.clash}
        <span class="absolute top-0 -translate-x-1/2 text-[8px] text-[#ffb4ab] font-bold z-10" style="left:{Math.max(2, Math.min(98, b.l + b.w / 2))}%;">▲</span>
      {/if}
    {/each}
  {:else if fallback}
    <div class="absolute top-0 bottom-0" style="left:{fallback.l}%;width:max(2%,{fallback.w}%);background:{fallback.bg};"></div>
    <span class="absolute top-0 font-mono text-[7px] font-bold leading-none" style="left:{Math.max(1, Math.min(99, fallback.l))}%;color:rgba(255,255,255,0.85);mix-blend-mode:difference;">{fallback.key}</span>
  {:else}
    <span class="absolute inset-0 flex items-center justify-center text-[7px] text-outline/50 uppercase tracking-widest">heatmap harmonique</span>
  {/if}
  <div class="absolute inset-y-0 left-1/2 w-px bg-[#edbf7a]/50 z-10 pointer-events-none"></div>
</div>