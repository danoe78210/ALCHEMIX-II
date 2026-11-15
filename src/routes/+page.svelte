<script lang="ts">
  import DeckA from '$lib/components/DeckA.svelte';
  import DeckB from '$lib/components/DeckB.svelte';
  import MixerCenter from '$lib/components/MixerCenter.svelte';
  import CrossfaderBar from '$lib/components/CrossfaderBar.svelte';
  import { mixerStore } from '$lib/stores/mixer.svelte';
</script>

<main class="relative pt-4 w-full bg-background min-h-screen">
  <div class="flex flex-col w-full text-on-surface">
    <!-- Master Chassis Container -->
    <div class="p-space-md lg:p-gutter-lg flex flex-col gap-space-lg max-w-[1720px] mx-auto w-full">
      <!-- Top Chassis Header / Master Metrology Bar (Restauré fidèlement) -->
      <div class="bg-surface-container-low rounded-xl p-space-md shadow-[0_8px_24px_rgba(0,0,0,0.85)] flex flex-wrap items-center justify-between gap-space-md relative overflow-hidden">
        <div class="absolute inset-0 bg-gradient-to-r from-primary/5 via-tertiary/5 to-secondary/5 pointer-events-none"></div>
        <!-- Left: Chassis Serial & Vault Info -->
        <div class="flex items-center gap-space-md min-w-0 z-10">
          <div class="w-10 h-10 rounded bg-surface-container-highest flex items-center justify-center text-primary shadow-[inset_1px_1px_3px_rgba(0,0,0,0.8)]">
            <span class="material-symbols-outlined text-[24px]">precision_manufacturing</span>
          </div>
          <div class="flex flex-col min-w-0">
            <div class="flex items-center gap-space-xs">
              <span class="px-space-xs py-[1px] bg-secondary-container text-on-secondary-container font-label-sm text-[9px] uppercase rounded">
                dj danoë
              </span>
            </div>
            <span class="font-title-md text-[18px] uppercase tracking-wider text-on-surface truncate">
              ALCHEMIX II
            </span>
          </div>
        </div>
        <!-- Right: Real-time Master Pressure & Acoustic Resonance Status -->
        <div class="flex items-center gap-space-lg z-10">
          <div class="flex items-center gap-space-sm bg-surface-container-lowest px-space-md py-space-xs rounded shadow-[inset_1px_1px_4px_rgba(0,0,0,0.9)]">
            <div class="flex flex-col text-right">
              <span class="font-label-sm text-[9px] text-outline uppercase tracking-widest">Main Steam Line</span>
              <span class="font-label-md text-[11px] text-primary font-bold">6.4 BAR • STABLE</span>
            </div>
            <div class="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981] animate-pulse"></div>
          </div>
          <div class="flex items-center gap-space-sm bg-surface-container-lowest px-space-md py-space-xs rounded shadow-[inset_1px_1px_4px_rgba(0,0,0,0.9)]">
            <div class="flex flex-col text-right">
              <span class="font-label-sm text-[9px] text-outline uppercase tracking-widest">Master Clock Sync</span>
              <span class="font-label-md text-[11px] text-secondary font-bold">
                {mixerStore.isBpmLocked ? 'L-4 / R-8 PHASE LOCKED' : 'MODULATION ACTIVE'}
              </span>
            </div>
            <div class="w-2.5 h-2.5 rounded-full bg-secondary shadow-[0_0_8px_#ffb59d]"></div>
          </div>
        </div>
      </div>

      <!-- 3-Column Symmetrical Workstation Grid -->
      <div class="grid grid-cols-12 gap-6 items-start w-full max-w-[1720px] mx-auto">
        <div class="col-span-3">
          <DeckA bind:deck={mixerStore.deckA} />
        </div>
        <div class="col-span-6">
          <MixerCenter />
        </div>
        <div class="col-span-3">
          <DeckB bind:deck={mixerStore.deckB} />
        </div>
      </div>

      <!-- Bottom Master Crossfader Strip -->
      <CrossfaderBar bind:value={mixerStore.crossfader} />
    </div>
  </div>
</main>
