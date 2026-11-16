<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    text: string;
    innerClass?: string;
  }
  let { text = '', innerClass = '' }: Props = $props();

  // ALC-132-2 : défilement horizontal doux (marquee) avec fondu latéral et pause au survol.
  let wrap: HTMLElement | undefined;
  let single: HTMLElement | undefined;
  let overflow = $state(false);
  let paused = $state(false);
  const dur = $derived(text ? Math.max(8, Math.ceil(text.length * 0.35)) : 8);

  function measure() {
    if (!wrap || !single) return;
    overflow = single.scrollWidth > wrap.clientWidth + 1;
  }

  onMount(() => {
    measure();
    const ro = new ResizeObserver(() => measure());
    if (wrap) ro.observe(wrap);
    return () => ro.disconnect();
  });
</script>

<div
  role="presentation"
  class="marquee-wrap"
  class:running={overflow}
  class:paused={paused}
  bind:this={wrap}
  onpointerenter={() => (paused = true)}
  onpointerleave={() => (paused = false)}
>
  <div class="marquee-track" style="--dur:{dur}s">
    <span class="marquee-inner {innerClass}" bind:this={single}>{text}</span>
    {#if overflow}
      <span class="marquee-inner {innerClass}" aria-hidden="true">{text}</span>
    {/if}
  </div>
</div>

<style>
  .marquee-wrap {
    overflow: hidden;
    white-space: nowrap;
    position: relative;
    min-width: 0;
  }
  .marquee-wrap.running {
    /* Fondu latéral léger (masque) quand le texte déborde */
    -webkit-mask-image: linear-gradient(to right, transparent, #000 10%, #000 90%, transparent);
    mask-image: linear-gradient(to right, transparent, #000 10%, #000 90%, transparent);
  }
  .marquee-track {
    display: inline-flex;
    will-change: transform;
  }
  .marquee-inner {
    display: inline-block;
    padding-right: 0.75rem; /* espace de respiration entre les deux copies */
  }
  .running .marquee-track {
    animation: marquee-scroll var(--dur, 16s) linear infinite;
  }
  .running.paused .marquee-track {
    animation-play-state: paused;
  }
  @keyframes marquee-scroll {
    from { transform: translateX(0); }
    to { transform: translateX(-50%); }
  }
</style>