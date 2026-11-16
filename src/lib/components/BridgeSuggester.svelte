<script lang="ts">
  import { mixerStore } from '$lib/stores/mixer.svelte';
  import { parseCamelot, relationFrom, isDissonant, pivotFrom } from '$lib/audio/harmony';

  // ALC-143 : assistant de transition harmonique — s'active dès qu'un "écart harmonique important"
  // est détecté (Roue de Camelot ≥ 3 quintes, hors couple relatif). Propose une clé tampon (pivot)
  // et un raccourci vers la Roue de Camelot, plus le mode Smart Filter.
  const keyA = $derived(mixerStore.deckA.filePath ? parseCamelot(mixerStore.deckA.camelotKey) : null);
  const keyB = $derived(mixerStore.deckB.filePath ? parseCamelot(mixerStore.deckB.camelotKey) : null);
  const harm = $derived(relationFrom(keyA, keyB));
  const conflict = $derived(!!keyA && !!keyB && isDissonant(harm));
  const pivot = $derived(
    conflict ? pivotFrom(keyA, keyB, harm, true, mixerStore.effectiveBpmA, mixerStore.effectiveBpmB, '') : null
  );
  const ring = $derived(harm?.ring ?? 0);
</script>

{#if conflict && keyA && keyB && pivot}
  <div
    class="flex items-center justify-between gap-space-sm flex-wrap bg-[#2a110d] border border-[#ff8a65]/40 rounded-lg p-space-sm"
    role="status"
  >
    <div class="flex items-center gap-2 min-w-0">
      <span class="material-symbols-outlined text-[15px] text-[#ffb4ab] shrink-0">warning</span>
      <div class="min-w-0">
        <span class="block font-label-sm text-[8px] text-[#ffb4ab] uppercase tracking-widest">Écart harmonique important — Δ {ring} quintes</span>
        <span class="block font-mono text-[10px] text-on-surface tabular-nums truncate">
          Clé tampon suggérée&nbsp;: <span class="text-[#ffb4ab] font-bold">{pivot.pivotKey}</span>
          <span class="text-outline"> · {keyA.num}{keyA.mode} → {pivot.pivotKey} → {keyB.num}{keyB.mode} · {pivot.targetBpm} BPM</span>
        </span>
      </div>
    </div>

    <div class="flex items-center gap-2 shrink-0">
      <button
        type="button"
        onclick={() => (mixerStore.centerView = 'camelot')}
        title="Identifier instantanément le morceau tampon compatible sur la Roue de Camelot (Ponts Harmoniqés suggérés)"
        class="px-3 py-1.5 rounded bg-primary/15 border border-primary/40 text-primary text-[9px] font-bold uppercase tracking-widest hover:bg-primary/25"
      >
        Ouvrir Roue de Camelot
      </button>

      <button
        type="button"
        role="switch"
        aria-checked={mixerStore.smartFilterActive}
        onclick={() => mixerStore.toggleSmartFilter()}
        title="Smart Filter : réduit automatiquement les médiums/basses en cas de superposition de clés incompatibles"
        class="flex items-center gap-1.5 px-2 py-1 rounded border text-[9px] font-bold uppercase tracking-widest {mixerStore.smartFilterActive
          ? 'border-[#10b981] bg-[#10b981]/15 text-emerald-300'
          : 'border-surface-variant bg-surface-container-low text-on-surface-variant'}"
      >
        <span class="w-2 h-2 rounded-full {mixerStore.smartFilterActive ? 'bg-[#10b981] shadow-[0_0_5px_#10b981]' : 'bg-outline/50'}"></span>
        Smart Filter {mixerStore.smartFilterActive ? '· ACTIF −6 dB' : '· OFF'}
      </button>
    </div>
  </div>
{/if}