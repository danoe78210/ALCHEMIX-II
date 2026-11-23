<!--
  ALC-230 — VzKey : touche mécanique « Venezia 1889 » réutilisable.
  Une seule primitive pour tout le pupitre Beatgrid.
  data-tier : hero | secondary | ghost. États : hover / pressed / focus-visible /
  latched (aria-pressed + LED) / disabled (aria-disabled + raison) / loading
  (barre de progression + aspect enclenché).
  On n'anime JAMAIS box-shadow directement : deux pseudo-éléments empilés
  (::before = relief relevé, ::after = relief enfoncé) sont croisés en opacité.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    tier = 'secondary',
    pressed = undefined,
    disabled = false,
    reason = '',
    reasonId = undefined,
    icon = undefined,
    ledColor = undefined,
    ariaLabel = undefined,
    expand = false,
    size = 'md',
    loading = false,
    loadingValue = 0,
    ready = false,
    onclick = undefined,
    children,
  }: {
    tier?: 'hero' | 'secondary' | 'ghost';
    /** Cible d'un verrouillage (undefined = touche momentanée). */
    pressed?: boolean;
    /** Désactivée (aria-disabled, jamais l'attribut disabled : focus + infobulle conservés). */
    disabled?: boolean;
    /** Raison affichée en title quand désactivée. */
    reason?: string;
    /** id du libellé de groupe « REQUIERT A + B » référencé par aria-describedby. */
    reasonId?: string;
    /** Glyphe Material Symbols (16 px, currentColor). */
    icon?: string;
    /** Couleur de la LED (var(--vz-ch-a) émeraude, --vz-ch-b bleu, sinon laiton). */
    ledColor?: string;
    /** Nom accessible (bouton icône seule, ex. « Sortir de la boucle »). */
    ariaLabel?: string;
    /** Occupe 100 % de la largeur du parent (héro / colonne). */
    expand?: boolean;
    /** Taille compacte ('sm' = --vz-key-h-sm, 32 px / 28 px compact) — boucles. */
    size?: 'md' | 'sm';
    /** État chargement (aspect enclenché + barre de progression 3 px). */
    loading?: boolean;
    /** Progression 0..1 de la barre (transform: scaleX uniquement). */
    loadingValue?: number;
    /** Pulse LED « prêt » (hero prêt : A+B chargées, pipeline inactif). */
    ready?: boolean;
    onclick?: (e: MouseEvent) => void;
    children?: Snippet;
  } = $props();
</script>

<button
  type="button"
  class="vz-key"
  data-tier={tier}
  data-size={size}
  data-loading={loading || undefined}
  data-ready={ready || undefined}
  aria-pressed={pressed}
  aria-disabled={disabled || undefined}
  aria-describedby={disabled && reasonId ? reasonId : undefined}
  title={disabled && reason ? reason : undefined}
  aria-label={ariaLabel}
  style={ledColor || expand ? `${ledColor ? `--vz-led:${ledColor}` : ''}${expand ? 'width:100%;' : ''}` : undefined}
  onclick={(e) => {
    if (!disabled) onclick?.(e);
  }}
>
  {#if pressed !== undefined || loading || ready}
    <span class="vz-led" data-on={pressed === true || loading || ready || undefined}></span>
  {/if}
  {#if icon}
    <span class="vz-icon material-symbols-outlined" aria-hidden="true">{icon}</span>
  {/if}
  <span class="vz-label">{@render children?.()}</span>
  {#if loading}
    <span
      class="vz-progress"
      style="transform: scaleX({Math.max(0, Math.min(1, loadingValue))});"
    ></span>
  {/if}
</button>

<style>
  .vz-key {
    position: relative;
    isolation: isolate;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-width: 0;
    padding: 0 10px;
    border: 1px solid var(--vz-key-edge);
    border-radius: var(--vz-radius);
    background: transparent;
    color: var(--vz-brass-text);
    font-family: var(--font-label-sm, ui-monospace, monospace);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    line-height: 1;
    white-space: nowrap;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: transform var(--vz-t-press) var(--vz-ease), filter var(--vz-t-hover) var(--vz-ease);
  }
  .vz-key > * { position: relative; z-index: 1; }
  .vz-key:hover { filter: brightness(1.08); }

  /* Relief relevé / enfoncé : cross-fade d'opacité, jamais box-shadow animé. */
  .vz-key::before,
  .vz-key::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    z-index: 0;
    transition: opacity var(--vz-t-release) var(--vz-ease);
  }
  .vz-key:active::before,
  .vz-key:active::after {
    transition: opacity var(--vz-t-press) var(--vz-ease);
  }
  .vz-key::before { opacity: 1; box-shadow: var(--vz-sh-raised); }
  .vz-key::after { opacity: 0; box-shadow: var(--vz-sh-pressed); }

  /* −−− Tier hero (unique AUTO-MASHUP 1-CLIC) −−− */
  .vz-key[data-tier='hero'] {
    height: var(--vz-key-h-hero);
    border-color: #8c6d3f;
    color: var(--vz-ink-on-brass);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.08em;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);
  }
  .vz-key[data-tier='hero']::before {
    background: linear-gradient(
      180deg,
      var(--vz-brass-hi) 0%,
      var(--vz-brass-mid) 50%,
      var(--vz-brass-lo) 100%
    );
  }
  .vz-key[data-tier='hero']::after {
    background: linear-gradient(180deg, var(--vz-brass-mid) 0%, var(--vz-brass-lo) 100%);
  }

  /* −−− Tier secondary −−− */
  .vz-key[data-tier='secondary'] {
    height: var(--vz-key-h-lg);
    color: var(--vz-brass-text);
  }
  .vz-key[data-tier='secondary']::before {
    background: linear-gradient(180deg, var(--vz-key-top) 0%, var(--vz-key-bottom) 100%);
  }
  .vz-key[data-tier='secondary']::after {
    background: linear-gradient(180deg, var(--vz-key-bottom) 0%, #100b08 100%);
  }

  /* −−− Tier ghost (transparent, bordure sombre) −−− */
  .vz-key[data-tier='ghost'] {
    height: var(--vz-key-h);
    border-color: #3a3027;
    color: var(--vz-text-mid);
  }
  /* Taille sm (boucles 32 px / 28 px compact) */
  .vz-key[data-size='sm'] { height: var(--vz-key-h-sm); padding: 0 6px; font-size: 11px; }
  .vz-key[data-tier='ghost']::before {
    background: transparent;
    box-shadow: inset 0 1px 0 rgba(237, 191, 122, 0.06);
  }
  .vz-key[data-tier='ghost']::after {
    background: linear-gradient(180deg, #120d0a 0%, #1d1611 100%);
  }
/* −−− Enfoncement momentané (translateY + relief enfoncé) −−− */
  .vz-key:active:not([aria-disabled='true']) {
    transform: translateY(1px);
  }
  .vz-key:active:not([aria-disabled='true'])::before { opacity: 0; }
  .vz-key:active:not([aria-disabled='true'])::after { opacity: 1; }

  /* −−− Verrouillé / on (aria-pressed=true) −−− */
  .vz-key[aria-pressed='true'],
  .vz-key[data-loading='true'] {
    color: var(--vz-text-hi);
  }
  .vz-key[aria-pressed='true']::before,
  .vz-key[data-loading='true']::before { opacity: 0; }
  .vz-key[aria-pressed='true']::after,
  .vz-key[data-loading='true']::after {
    opacity: 1;
    background: linear-gradient(180deg, #120d0a 0%, #1d1611 100%);
  }

  /* −−− Focus clavier visible −−− */
  .vz-key:focus-visible { outline: 2px solid var(--vz-brass-text); outline-offset: 2px; }

  /* −−− Désactivée : plat (ni biseau, ni specular) · LED éteinte −−− */
  .vz-key[aria-disabled='true'] {
    cursor: not-allowed;
    color: var(--vz-text-disabled);
    background: var(--vz-disabled-bg);
    border-color: var(--vz-disabled-edge);
    filter: saturate(0.5);
    box-shadow: none;
  }
  .vz-key[aria-disabled='true']::before,
  .vz-key[aria-disabled='true']::after {
    opacity: 0;
    box-shadow: none;
  }
  .vz-key[aria-disabled='true']:active { transform: none; }

  /* −−− LED serti 6 px −−− */
  .vz-led {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
    background: #241d17;
    border: 1px solid #3d3328;
    box-shadow: inset 0 0 2px rgba(0, 0, 0, 0.9);
    transition: background-color var(--vz-t-led) var(--vz-ease), opacity var(--vz-t-led) var(--vz-ease);
  }
  .vz-led[data-on='true'] {
    background: var(--vz-led, var(--vz-brass-text));
    border-color: var(--vz-led, var(--vz-brass-text));
    box-shadow: 0 0 6px var(--vz-led, var(--vz-brass-text));
  }

  /* −−− Pulse LED « prêt » du hero (0.55 ↔ 1 sur 2.4 s), coupé en reduced-motion −−− */
  @keyframes vz-led-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
  .vz-key[data-ready='true'] .vz-led {
    animation: vz-led-pulse 2.4s var(--vz-ease) infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .vz-key[data-ready='true'] .vz-led { animation: none; }
  }

  /* −−− Barre de progression (hero, pendant le pipeline) : scaleX seul −−− */
  .vz-progress {
    position: absolute;
    left: 1px;
    right: 1px;
    bottom: 0;
    height: 3px;
    border-radius: 0 0 var(--vz-radius) var(--vz-radius);
    background: linear-gradient(90deg, var(--vz-brass-hi), var(--vz-brass-mid));
    transform-origin: left;
    transform: scaleX(0);
    transition: transform 180ms var(--vz-ease);
    z-index: 2;
  }

  /* Icône Material Symbols unifiée : 16 px, currentColor */
  .vz-icon { font-size: 16px; flex: none; line-height: 1; }

  /* Écrans < 1440 px : cache les icônes non essentielles des ghost keys
     pour que les libellés whitespace-nowrap ne débordent jamais. */
  @media (max-width: 1440px) {
    .vz-key[data-tier='ghost'] .vz-icon { display: none; }
  }
</style>