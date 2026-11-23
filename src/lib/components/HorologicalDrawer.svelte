<script lang="ts">
  // ALC-186-1 : tiroir horloger escamotable réutilisable (trappe laiton oxydé, charte Venezia 1889).
  // État fermé par défaut : plaque métallique compacte (30px) avec micro-vis d'angle, titre gravé,
  // badge de statut, micro-LED d'activité et loquet doré. État ouvert : cuve interne ébène encastrée
  // bordée de liserés laiton/canal, dépliée vers le bas avec une transition fluide 220 ms.
  // `open` est bindable : le parent peut l'ouvrir par programmation (ex. extraction stems).
  import type { Snippet } from 'svelte';

  type Accent = 'emerald' | 'blue';
  type Direction = 'down' | 'up';

  let {
    open = $bindable(false),
    title = '',
    badge = '',
    active = false,
    accent = 'emerald',
    direction = 'down',
    // ALC-255 WP12 : aperçu (peek) de la cuve quand fermée — clic = open.
    peek = false,
    // ALC-255 WP13 : pastilles de façade permanentes (BPM / Clé) en couleur de canal.
    chips = undefined,
    chipsId = undefined,
    // ALC-255 WP14 : mention technique de façade (ex. « HTDEMUCS • LOCAL »).
    subtitle = '',
    // ALC-255 WP14 : mode d'ouverture — 'flow' pousse les blocs, 'overlay' superpose (fallback hauteur).
    mode = 'flow',
    children,
  }: {
    open?: boolean;
    title?: string;
    badge?: string;
    active?: boolean;
    accent?: Accent;
    direction?: Direction;
    peek?: boolean;
    chips?: { bpm: string; key: string };
    chipsId?: string;
    subtitle?: string;
    mode?: 'flow' | 'overlay';
    children?: Snippet;
  } = $props();

  let box: HTMLDivElement;

  // ALC-189-1 : fermeture du volet (direction='up') au clic extérieur / touche Escape.
  $effect(() => {
    if (direction !== 'up' || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') open = false;
    };
    const onDoc = (e: PointerEvent) => {
      if (box && !box.contains(e.target as Node)) open = false;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDoc);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDoc);
    };
  });

  const ACCENT: Record<Accent, string> = { emerald: '#10b981', blue: '#00A3FF' };
  // ALC-255 WP13 : texte couleur de canal pour les pastilles de façade (contraste ~6.9:1).
  const ACCENT_TEXT: Record<Accent, string> = {
    emerald: 'var(--vz-ch-a-text, #34d399)',
    blue: 'var(--vz-ch-b-text, #6cc4ff)',
  };
  const accentHex = $derived(ACCENT[accent]);
  const accentText = $derived(ACCENT_TEXT[accent]);
</script>

<div class="hd" class:hd-up={direction === 'up'} class:hd-overlay={mode === 'overlay'} style="--acc: {accentHex}; --chip-txt: {accentText}" bind:this={box}>
  <button
    class="hd-plate"
    onclick={() => (open = !open)}
    aria-expanded={open}
    aria-label={open ? `Refermer le tiroir ${title}` : `Ouvrir le tiroir ${title}`}
  >
    <span class="hd-corner hc-tl"></span>
    <span class="hd-corner hc-tr"></span>
    <span class="hd-corner hc-bl"></span>
    <span class="hd-corner hc-br"></span>
    <span class="hd-title">{title}</span>
    {#if subtitle && !open}
      <!-- ALC-260-4 : mention technique (ex. HTDEMUCS • LOCAL) visible uniquement tiroir fermé -->
      <span class="hd-subtitle">{subtitle}</span>
    {/if}
    {#if chips && open}
      <!-- ALC-260-4 : pastilles BPM/CLÉ affichées SEULEMENT quand le volet est ouvert (recouvre la Télémétrie) -->
      <span class="hd-chips" id={chipsId}>
        <span class="hd-chip">{chips.bpm}</span>
        <span class="hd-chip">{chips.key}</span>
      </span>
    {/if}
    {#if badge && !open}
      <!-- ALC-260-4 : badge technique (ex. MP3 • 44.1 kHz) affiché uniquement tiroir fermé -->
      <span class="hd-badge">{badge}</span>
    {/if}
    <span class="hd-led" class:hd-led-on={active}></span>
    <span class="hd-grip" aria-hidden="true"></span>
    <span class="hd-latch" aria-hidden="true"></span>
  </button>
  {#if peek && !open}
    <!-- ALC-255 WP12 : aperçu (peek) de la cuve — clic pour ouvrir -->
    <button type="button" class="hd-cuve hd-cuve-peek hd-cuve-peek-btn" class:hd-up-cuve-peek={direction === 'up'} onclick={() => (open = true)} aria-label={`Aperçu — ${title}`} tabindex="-1">
      <div class="hd-cuve-inner">
        {@render children?.()}
      </div>
    </button>
  {/if}
  <div class="hd-cuve" class:hd-cuve-open={open} class:hd-up-cuve={direction === 'up'}>
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
    position: relative;
  }
  /* --- Volet vers le HAUT en superposition (ALC-189-1) --- */
  .hd-up-cuve {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    margin-bottom: 6px;
    z-index: 30;
  }
  .hd-up-cuve .hd-cuve-inner {
    margin-top: 0;
    background: #17120f;
    border: 1px solid rgba(237, 191, 122, 0.7);
    border-radius: 8px;
    box-shadow: 0 -12px 28px rgba(0, 0, 0, 0.95);
  }
  /* --- Plaque fermée (trappe) --- */
  .hd-plate {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 35px;
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
    /* ALC-260-4 : truncate (min-w-0 + ellipsis) sans jamais re-casser sur 2 lignes */
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #e6d7b2;
    white-space: nowrap;
  }
  /* ALC-255 WP14 : mention technique de façade (ex. HTDEMUCS • LOCAL), 10px */
  .hd-subtitle {
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #a89880;
    white-space: nowrap;
  }
  /* ALC-255 WP14 : fallback overlay — la cuve ouverte superpose sans pousser les blocs */
  .hd-overlay .hd-cuve-open {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    z-index: 40;
  }
  .hd-overlay .hd-cuve-open .hd-cuve-inner {
    margin-top: 0;
    margin-bottom: 4px;
    border-radius: 8px 8px 6px 6px;
    border-top: 1px solid var(--acc);
    border-bottom: 1px solid #4f4539;
    box-shadow: 0 -12px 28px rgba(0, 0, 0, 0.95);
  }
  /* ALC-255 WP13 : pastilles BPM / Clé permanentes (chasse fixe, couleur de canal) */
  .hd-chips {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: 0.4rem;
    overflow: hidden;
    flex: none; /* ALC-260-4 : jamais écrasé par le titre truncate ni le chevron */
  }
  .hd-chip {
    padding: 1px 5px;
    border-radius: 999px;
    font-size: 8px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: var(--chip-txt, #e6d7b2);
    background: #201712;
    border: 1px solid var(--acc);
  }
  /* ALC-255 WP12 : aperçu (peek) de la cuve quand fermée */
  .hd-cuve-peek {
    max-height: 120px;
    opacity: 1;
    cursor: zoom-in;
    border-bottom: none;
  }
  .hd-cuve-peek-btn {
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    text-align: left;
    padding: 0;
    font: inherit;
  }
  .hd-up-cuve-peek {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    margin-bottom: 6px;
    z-index: 28;
    border-bottom: 1px solid var(--acc);
  }
  .hd-badge {
    margin-left: auto;
    flex: none; /* ALC-260-4 : pastille MP3 jamais chevauchée ni recouverte */
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
  /* ALC-256 WP24 : chevron rotatif (14px) + poignée centrale gravée */
  .hd-latch {
    width: 10px;
    height: 10px;
    margin-left: 1px;
    border-right: 2px solid var(--acc);
    border-bottom: 2px solid var(--acc);
    transform: rotate(45deg);
    transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
    opacity: 0.85;
    flex: none;
  }
  .hd-plate[aria-expanded='true'] .hd-latch {
    transform: rotate(-135deg);
  }
  .hd-grip {
    width: 26px;
    height: 3px;
    border-radius: 2px;
    margin-left: 0.4rem;
    background: repeating-linear-gradient(
      90deg,
      var(--vz-brass-lo, #b98a42) 0 2px,
      transparent 2px 5px
    );
    opacity: 0.5;
    flex: none;
  }
  /* ALC-256 WP24 : focus clavier Venezia (laiton), remplace l'anneau natif */
  .hd-plate:focus-visible {
    outline: 2px solid var(--vz-brass-text, #edbf7a);
    outline-offset: 2px;
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