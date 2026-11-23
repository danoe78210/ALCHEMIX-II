<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Snippet } from 'svelte';

  let {
    text = '',
    block = false,
    children,
  }: {
    text?: string;
    block?: boolean;
    children?: Snippet;
  } = $props();

  let root = $state<HTMLElement | null>(null);
  let tip = $state<HTMLElement | null>(null);
  let visible = $state(false);
  let pos = $state({ left: 0, top: 0, above: false });
  let timer: number | undefined;
  const tipId = `vztip-${Math.random().toString(36).slice(2, 9)}`;
  let isPointer = $state(false);

  function measure() {
    if (!root) return;
    const r = root.getBoundingClientRect();
    const tw = tip?.offsetWidth ?? 160;
    const th = tip?.offsetHeight ?? 32;
    const gap = 8;
    const above = r.top >= window.innerHeight - r.bottom;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    const top = above ? r.top - th - gap : r.bottom + gap;
    pos = { left, top, above };
  }
  function showNow() {
    if (!text) return;
    visible = true;
    requestAnimationFrame(() => requestAnimationFrame(measure));
  }
  function showDelayed() {
    if (!text) return;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(showNow, 400);
  }
  function hide() {
    if (timer) window.clearTimeout(timer);
    visible = false;
    isPointer = false;
  }
  function onEnter() {
    if (isPointer) return;
    isPointer = true;
    showDelayed();
  }
  function onFocus(e: FocusEvent) {
    if (isPointer) return;
    showNow();
  }
  function onEscape(e: KeyboardEvent) {
    if (e.key === 'Escape') hide();
  }

  onMount(() => window.addEventListener('keydown', onEscape));
  onDestroy(() => window.removeEventListener('keydown', onEscape));
</script>

<div class="vztip-root" class:vztip-block={block} bind:this={root}>
  <span
    class="vztip-target"
    role="group"
    aria-describedby={visible && text ? tipId : undefined}
    onpointerenter={onEnter}
    onpointerleave={hide}
    onfocusin={onFocus}
    onfocusout={hide}
  >
    {@render children?.()}
  </span>
</div>

{#if visible && text}
  <div id={tipId} class="vztip" class:vztip-above={pos.above} bind:this={tip} role="tooltip" style="left:{pos.left}px; top:{pos.top}px; position:fixed;">{text}</div>
{/if}

<style>
  .vztip-root { display: contents; }
  .vztip-target { display: inline-flex; align-items: center; min-width: 0; }
  .vztip-block .vztip-target { display: flex; width: 100%; }
  .vztip {
    z-index: 9999;
    max-width: 240px;
    background: #0f0b09;
    border: 1px solid var(--vz-key-edge, #665643);
    border-radius: 4px;
    padding: 6px 10px;
    color: var(--vz-text-hi, #f3dfbd);
    font-family: var(--font-label-sm, ui-monospace, 'JetBrains Mono', monospace);
    font-size: 11px;
    line-height: 1.3;
    white-space: nowrap;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.5);
    pointer-events: none;
    opacity: 1;
    transition: opacity 120ms ease;
  }
  @media (prefers-reduced-motion: reduce) {
    .vztip { transition: none; }
  }
</style>