<script lang="ts">
  // ALC-186-1 : tiroir horloger escamotable réutilisable (trappe laiton oxydé, charte Venezia 1889).
  // État fermé par défaut : plaque métallique compacte (30px) avec micro-vis d'angle, titre gravé,
  // badge de statut, micro-LED d'activité et loquet doré. État ouvert : cuve interne ébène encastrée
  // bordée de liserés laiton/canal, dépliée vers le bas avec une transition fluide 220 ms.
  // `open` est bindable : le parent peut l'ouvrir par programmation (ex. extraction stems).
  import type { Snippet } from 'svelte';

  type Accent = 'emerald' | 'blue';

  let {
    open = $bindable(false),
    title = '',
    badge = '',
    active = false,
    accent = 'emerald',
    children,
  }: {
    open?: boolean;
    title?: string;
    badge?: string;
    active?: boolean;
    accent?: Accent;
    children?: Snippet;
  } = $props();

  const ACCENT: Record<Accent, string> = { emerald: '#10b981', blue: '#3b82f6' };
  const accentHex = $derived(ACCENT[accent]);
</script>

<div class="hd" style="--acc: {accentHex}">
  <button
    class="hd-plate"
    onclick={() => (open = !open)}
    aria-expanded={open}
    title={open ? 'Refermer le tiroir' : 'Ouvrir le tiroir'}
  >
    <span class="hd-corner hc-tl"></span>
    <span class="hd-corner hc-tr"></span>
    <span class="hd-corner hc-bl"></span>
    <span class="hd-corner hc-br"></span>
    <span class="hd-title">{title}</span>
    <span class="hd-badge">{badge}</span>
    <span class="hd-led" class:hd-led-on={active}></span>
    <span class="hd-latch">{open ? '▴' : '▾'}</span>
  </button>
  <div class="hd-cuve" class:hd-cuve-open={open}>
    <div class="hd-cuve-inner">
      {@render children?.()}
    </div>
  </div>
</div>

<style>
  .hd {
    display: flex;
    flex-direction: column;
    width: 100%;
  }
  /* --- Plaque fermée (trappe) --- */
  .hd-plate {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 30px;
    padding: 0 0.5rem 0 0.8rem;
    background: linear-gradient(180deg, #221b15, #140e09);
    border: 1px solid #4f4539;
    border-radius: 6px;
    cursor: pointer;
    color: #e6d7b2;
    font-family: 'Space Grotesk', ui-sans-serif, system-ui, sans-serif;
    text-align: left;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 2px 6px rgba(0, 0, 0, 0.5);
  }
  .hd-plate:hover {
    border-color: #6a5d47;
  }
  /* Micro-vis d'angle décoratives */
  .hd-corner {
    position: absolute;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: #8c7a5a;
    box-shadow: inset 0 0 0 0.5px #3a3024;
  }
  .hc-tl { top: 3px; left: 3px; }
  .hc-tr { top: 3px; right: 3px; }
  .hc-bl { bottom: 3px; left: 3px; }
  .hc-br { bottom: 3px; right: 3px; }
  .hd-title {
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #e6d7b2;
    white-space: nowrap;
  }
  .hd-badge {
    margin-left: auto;
    font-size: 7px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #b39a70;
    background: #201712;
    border: 1px solid #3b3123;
    padding: 1px 5px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .hd-led {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #3a2f20;
    box-shadow: inset 0 0 2px rgba(0, 0, 0, 0.9);
  }
  .hd-led-on {
    background: var(--acc);
    box-shadow: 0 0 6px var(--acc);
  }
  .hd-latch {
    font-size: 9px;
    color: var(--acc);
  }
  /* --- Cuve interne (état ouvert) --- */
  .hd-cuve {
    overflow: hidden;
    max-height: 0;
    opacity: 0;
    transition: max-height 220ms cubic-bezier(0.22, 1, 0.36, 1),
      opacity 220ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .hd-cuve-open {
    max-height: 520px;
    opacity: 1;
  }
  .hd-cuve-inner {
    margin-top: 4px;
    background: linear-gradient(180deg, #120d0a, #17110c);
    border: 1px solid var(--acc);
    border-top: 1px solid #4f4539;
    border-radius: 0 0 8px 8px;
    box-shadow: inset 0 4px 12px rgba(0, 0, 0, 0.9);
    padding: 0.5rem;
  }
</style>