<script lang="ts">
  import { computeEffectiveBpm, type DeckState } from '$lib/stores/mixer.svelte';

  interface Props {
    deck: DeckState;
  }

  let { deck = $bindable() }: Props = $props();

  // Thème du canal : émeraude (Deck A) ou bleu électrique (Deck B).
  const isEmerald = $derived(deck.theme === 'emerald');
  // Rythme effectif (BPM) calculé de la même façon que la console centrale (cohérence Roue/Oracle).
  const effectiveBpm = $derived(computeEffectiveBpm(deck.baseBpm, deck.pitchPercent));
  const pitchSign = $derived(deck.pitchPercent >= 0 ? '+' : '');

  // Table officielle des 24 clés Camelot → notation musicale standard (ALC-125).
  const KEY_NAMES: Record<string, string> = {
    '1B': 'B major', '2B': 'F# major', '3B': 'Db major', '4B': 'Ab major', '5B': 'Eb major',
    '6B': 'Bb major', '7B': 'F major', '8B': 'C major', '9B': 'G major', '10B': 'D major',
    '11B': 'A major', '12B': 'E major',
    '1A': 'G# minor', '2A': 'D# minor', '3A': 'A# minor', '4A': 'F minor', '5A': 'C minor',
    '6A': 'G minor', '7A': 'D minor', '8A': 'A minor', '9A': 'E minor', '10A': 'B minor',
    '11A': 'F# minor', '12A': 'C# minor',
  };
  const keyUpper = $derived((deck.camelotKey || '').trim().toUpperCase());
  const keyName = $derived(KEY_NAMES[keyUpper] ?? (deck.camelotLabel || deck.camelotKey || ''));
  const modeLabel = $derived(keyUpper.endsWith('A') ? 'Mineur' : 'Majeur');
  // ALC-141 : micro-indicateur de source de la clé (DSP / DSP+API ✓ / ARBITRÉ) + infobulle comparée.
  const sourceLabel = $derived(
    deck.keySource === 'consensus' ? 'DSP+API ✓'
      : deck.keySource === 'arbitred' ? 'ARBITRÉ'
      : 'DSP'
  );
  const sourceTitle = $derived(
    `DSP local : ${deck.camelotKey} (confiance ${Math.round((deck.keyConfidence || 0) * 100)}%)` +
    (deck.externalKey && deck.keySource !== 'dsp' ? ` · Réf. externe : ${deck.externalKey}` : '')
  );

  // Palette d'accent du canal (ALC-120-2) : appliquée aux badges BPM & Camelot.
  const accentText = $derived(isEmerald ? 'text-emerald-400' : 'text-[#00A3FF]');
  const accentSoft = $derived(isEmerald ? 'text-emerald-300' : 'text-[#38bdf8]');
  const accentBg = $derived(
    isEmerald ? 'border-emerald-500/30' : 'border-[#00A3FF]/30'
  );
  const glowColor = $derived(isEmerald ? '#10b981' : '#00A3FF');
</script>

<!-- Télémétrie Rythme & Clef (ALC-106 · refonte ALC-120) : bloc compact sous chaque platine -->
<div
  class="bg-surface-container-lowest/90 border border-surface-variant/40 rounded-xl p-space-sm shadow-[inset_0_2px_8px_rgba(0,0,0,0.7)] flex flex-col gap-space-xs"
>
  <div class="flex items-center justify-between pb-1 border-b border-surface-variant/40">
    <div class="flex items-center gap-space-xs">
      <span class="material-symbols-outlined text-[14px] {accentText}">speed</span>
      <span class="font-label-sm text-label-sm font-bold uppercase tracking-wider {accentText}">
        TÉLÉMÉTRIE RYTHME &amp; CLÉ
      </span>
    </div>
  </div>

  {#if deck.isAnalyzing}
    <!-- ALC-124 : badge d'analyse MIR en cours -->
    <div
      class="flex items-center gap-3 px-space-sm py-2 rounded-lg border {accentBg} {isEmerald ? 'bg-emerald-400/10' : 'bg-[#00A3FF]/10'} animate-pulse"
    >
      <span class="material-symbols-outlined text-[22px] animate-spin {accentText}">autorenew</span>
      <div class="flex flex-col min-w-0">
        <span class="font-label-sm text-[8px] text-outline uppercase tracking-wider">Analyse Spectrale</span>
        <span class="font-mono text-[12px] font-bold {accentText} truncate">ANALYSE MIR EN COURS…</span>
      </div>
    </div>
  {:else if !deck.filePath}
    <!-- ALC-126-3 : état initial vide — aucun fichier chargé -->
    <div class="grid grid-cols-3 gap-space-xs pt-1 items-stretch">
      <div class="bg-surface-container-low px-space-sm py-2 rounded-lg border {accentBg} flex flex-col min-w-0">
        <span class="font-label-sm text-[8px] text-outline uppercase tracking-wider">BPM</span>
        <span class="font-mono text-xl font-extrabold {accentSoft}">—.–</span>
      </div>
      <div class="bg-surface-container-low px-space-sm py-2 rounded-lg border {accentBg} flex flex-col items-center text-center min-w-0">
        <span class="font-label-sm text-[8px] text-outline uppercase tracking-wider">Clé Camelot</span>
        <span class="font-mono text-xl font-extrabold {accentSoft}">—</span>
      </div>
      <div class="bg-surface-container-low px-space-sm py-2 rounded-lg border {accentBg} flex flex-col items-center text-center min-w-0">
        <span class="font-label-sm text-[8px] text-outline uppercase tracking-wider">Clé</span>
        <span class="font-mono text-[11px] font-bold {accentSoft}">En attente</span>
      </div>
    </div>
  {:else}
    <div class="grid grid-cols-3 gap-space-xs pt-1 items-stretch">
      <!-- BPM -->
      <div class="bg-surface-container-low px-space-sm py-2 rounded-lg border {accentBg} flex flex-col min-w-0">
        <span class="font-label-sm text-[8px] text-outline uppercase tracking-wider">BPM</span>
        <span
          class="font-title-md text-xl md:text-2xl font-extrabold font-mono leading-tight {accentText} truncate"
          style="text-shadow:0 0 10px {glowColor};"
        >
          {effectiveBpm.toFixed(1)}
        </span>
        <span class="font-label-sm text-[8px] font-mono {accentSoft} truncate">
          {deck.baseBpm.toFixed(1)} BPM • {pitchSign}{deck.pitchPercent}%
          {#if deck.stemsCalibrated}
            <span
              class="text-[9px] leading-none text-[#e0a860]"
              title="BPM (drums) & clé Camelot (other+bass) recalibrés par HTDemucs"
            >✦</span>
          {/if}
        </span>
      </div>
      <!-- CLÉ CAMELOT -->
      <div class="bg-surface-container-low px-space-sm py-2 rounded-lg border {accentBg} flex flex-col items-center text-center min-w-0">
        <span class="font-label-sm text-[8px] text-outline uppercase tracking-wider">Clé Camelot</span>
        <span
          class="font-title-md text-xl md:text-2xl font-extrabold font-mono leading-tight {accentText} truncate"
          style="text-shadow:0 0 10px {glowColor};"
        >
          {deck.camelotKey}
        </span>
        <span title={sourceTitle} class="font-mono text-[8px] tracking-wider uppercase {deck.keySource === 'dsp' || deck.keySource === 'dsp-priority' ? accentSoft : 'text-primary'}">{sourceLabel}</span>
        <span class="font-label-sm text-[8px] font-mono {accentSoft}">{modeLabel}</span>
      </div>
      <!-- CLÉ (notation musicale standard) -->
      <div class="bg-surface-container-low px-space-sm py-2 rounded-lg border {accentBg} flex flex-col items-center text-center min-w-0">
        <span class="font-label-sm text-[8px] text-outline uppercase tracking-wider">Clé</span>
        <span
          class="font-title-md text-lg md:text-xl font-extrabold leading-tight {accentSoft} truncate"
          style="text-shadow:0 0 8px {glowColor};"
        >
          {keyName}
        </span>
        <span class="font-label-sm text-[8px] font-mono text-outline truncate">{deck.camelotLabel}</span>
      </div>
    </div>
  {/if}
</div>