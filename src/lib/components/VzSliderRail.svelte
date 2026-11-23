<script lang="ts">
  // ALC-260-2/-3 : rampe de micro-LEDs + repères gradués le long d'un rail horizontal.
  // `value` = position normalisée 0..1, calée sur le `left:%` du thumb parent (60 fps, DOM direct).
  // Les LED s'allument progressivement depuis le centre (50 %) vers la position du curseur.
  // Couleurs : émeraude (A) / bleu électrique (B) / cross (A gauche, B droite) ; centre Or Vénitien #edbf7a.
  type Accent = 'emerald' | 'blue' | 'cross';

  let {
    value = 0.5,
    ledCount = 13,
    accent = 'emerald',
    ticks = undefined,
    boost = false,
    dragging = false,
  }: {
    value?: number;
    ledCount?: number;
    accent?: Accent;
    ticks?: { at: number; label: string; lum?: boolean }[];
    boost?: boolean;
    dragging?: boolean;
  } = $props();

  // `ledCount` est un prop : on le référence dans une closure et un $derived pour éviter la capture initiale.
  const CENTER = $derived(Math.floor(ledCount / 2));
  function posOf(i: number): number {
    return ledCount === 1 ? 0.5 : i / (ledCount - 1);
  }

  function isLit(i: number): boolean {
    if (i === CENTER) return true;
    const v = Math.max(0, Math.min(1, value));
    const p = posOf(i);
    if (v > 0.5) return p >= 0.5 && p <= v;
    if (v < 0.5) return p <= 0.5 && p >= v;
    return false;
  }

  function ledColor(i: number): string {
    const p = posOf(i);
    if (i === CENTER) return '#edbf7a';
    if (accent === 'cross') return p < 0.5 ? '#10b981' : '#00A3FF';
    if (boost) return '#edbf7a';
    return accent === 'emerald' ? '#10b981' : '#00A3FF';
  }

  function ledGlow(i: number): string {
    if (i === CENTER) return '0 0 6px rgba(237,191,122,0.85)';
    if (accent === 'cross') return posOf(i) < 0.5 ? '0 0 6px rgba(16,185,129,0.85)' : '0 0 6px rgba(0,163,255,0.85)';
    if (boost) return '0 0 6px rgba(237,191,122,0.85)';
    return accent === 'emerald' ? '0 0 6px rgba(16,185,129,0.85)' : '0 0 6px rgba(0,163,255,0.85)';
  }
</script>

<div class="vz-rail" class:dz={dragging} aria-hidden="true">
  {#if ticks}
    <div class="vz-scal">
      {#each ticks as t (t.at.toFixed(3) + t.label)}
        <div class="vz-tick" style="left:{t.at * 100}%;">
          <span class="vz-tick-mark" class:lum={!!t.lum}></span>
          <span class="vz-tick-label" class:lum={!!t.lum}>{t.label}</span>
        </div>
      {/each}
    </div>
  {/if}
  <div class="vz-leds">
    {#each Array(ledCount) as _, i (i)}
      {@const on = isLit(i)}
      <span
        class="vz-led"
        class:on={on}
        style={`background:${on ? ledColor(i) : '#241d17'}; box-shadow:${on ? ledGlow(i) : 'none'};`}
      ></span>
    {/each}
  </div>
</div>

<style>
  .vz-rail {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  /* Échelle graduée (repères gravés + micro-étiquettes) en haut du rail */
  .vz-scal {
    position: absolute;
    top: 0;
    left: 6px;
    right: 6px;
    height: 12px;
    /* ALC-261-4 : padding-inline pour que -INF/+6, -8%/+8% ne soient ni collés ni rognés sur les bords */
    padding-inline: 6px;
  }
  .vz-tick {
    position: absolute;
    top: 0;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .vz-tick-mark {
    width: 1px;
    height: 4px;
    background: #5a4e41;
  }
  .vz-tick-mark.lum {
    height: 7px;
    background: #edbf7a;
    box-shadow: 0 0 4px rgba(237, 191, 122, 0.75);
  }
  .vz-tick-label {
    margin-top: 1px;
    font-size: 9px;
    line-height: 1;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: #a89880;
    letter-spacing: 0.02em;
  }
  .vz-tick-label.lum {
    color: #edbf7a;
  }
  /* Rampe de micro-LEDs en bas du rail (toujours visible, hors du thumb) */
  .vz-leds {
    position: absolute;
    bottom: 2px;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 2px;
  }
  .vz-led {
    width: 3px;
    height: 3px;
    border-radius: 9999px;
    flex: none;
    background: #241d17;
    box-shadow: none;
    transition: background-color 80ms cubic-bezier(0.22, 1, 0.36, 1),
      box-shadow 80ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .vz-rail.dz .vz-led.on {
    filter: brightness(1.3);
  }
  @media (prefers-reduced-motion: reduce) {
    .vz-led {
      transition: none;
    }
  }
</style>