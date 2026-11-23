<script lang="ts">
  // ALC-187-2 : console verticale STEMS IA — 2 baies PLATINE A/B lisant STRICTEMENT
  // mixerStore.deckA/deckB (source unique de vérité). Sync latérale ⟷ centrale par construction.
  import { mixerStore, formatTime } from '$lib/stores/mixer.svelte';
  import type { DeckId } from '$lib/stores/mixer.svelte';
  import type { StemName } from '$lib/audio/player';

  const STRIPS: [StemName, string][] = [
    ['vocals', 'VOIX'],
    ['drums', 'BATT'],
    ['bass', 'BASSE'],
    ['other', 'INST.'],
  ];

  let drag: { id: DeckId; stem: StemName; el: HTMLElement } | null = $state(null);

  function setVol(id: DeckId, stem: StemName, el: HTMLElement, clientY: number) {
    const r = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((r.bottom - clientY) / r.height) * 100));
    mixerStore.setDeckStemVolume(id, stem, pct / 100);
  }
  function fDown(id: DeckId, stem: StemName, e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    drag = { id, stem, el };
    setVol(id, stem, el, e.clientY);
  }
  function fMove(e: PointerEvent) {
    if (drag && (e.buttons & 1) !== 0) setVol(drag.id, drag.stem, drag.el, e.clientY);
  }
  function fUp() {
    drag = null;
  }
  function busy(id: DeckId) {
    return (id === 'A' ? mixerStore.deckA : mixerStore.deckB).stemsStatus === 'separating';
  }
  function ready(id: DeckId) {
    const d = id === 'A' ? mixerStore.deckA : mixerStore.deckB;
    return !!d.filePath && d.stemsStatus === 'ready';
  }
  function statusInfo(id: DeckId) {
    const d = id === 'A' ? mixerStore.deckA : mixerStore.deckB;
    if (d.stemsStatus === 'ready')
      return id === 'A' ? 'text-[#10b981] border-[#10b981]/40 bg-[#10b981]/10' : 'text-[#3b82f6] border-[#3b82f6]/40 bg-[#3b82f6]/10';
    if (d.stemsStatus === 'separating') return 'text-[#edbf7a] border-[#edbf7a]/40 bg-[#edbf7a]/10';
    if (d.stemsStatus === 'error') return 'text-[#ffb4ab] border-[#ffb4ab]/40 bg-[#ffb4ab]/10';
    return 'text-outline border-outline/20 bg-surface-container-high';
  }
  function statusTxt(id: DeckId) {
    const d = id === 'A' ? mixerStore.deckA : mixerStore.deckB;
    if (d.stemsStatus === 'ready') return 'Stems prêts';
    if (d.stemsStatus === 'separating') return `Extraction ${d.stemsProgress}%`;
    if (d.stemsStatus === 'error') return 'Échec extraction';
    return d.filePath ? 'En attente' : 'Sleeve vide';
  }
  function vol(id: DeckId, stem: StemName) {
    return (id === 'A' ? mixerStore.deckA : mixerStore.deckB).stemGains[stem] ?? 1;
  }
  function muted(id: DeckId, stem: StemName) {
    return (id === 'A' ? mixerStore.deckA : mixerStore.deckB).stemMutes[stem];
  }

  // ALC-188-1 : symboles Material Symbols par tranche + niveau effectif + micro-LEDs.
  const SYMBOL: Record<StemName, string> = { vocals: 'mic', drums: 'album', bass: 'waves', other: 'piano' };
  const LEDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  function eff(id: DeckId, stem: StemName) {
    return muted(id, stem) ? 0 : vol(id, stem);
  }
  function active(id: DeckId, stem: StemName) {
    return !muted(id, stem) && vol(id, stem) > 0.02;
  }
  function ledCls(id: DeckId, stem: StemName, i: number) {
    const e = Math.min(1, eff(id, stem));
    const lit = Math.round(e * 10);
    if (i >= lit) return 'bg-[#1a1410]';
    if (e > 0.85 && i >= 8) return 'bg-[#edbf7a]';
    return id === 'A' ? 'bg-[#10b981]' : 'bg-[#3b82f6]';
  }
</script>

<div class="flex flex-col gap-space-xs flex-1 min-h-0 overflow-hidden">
  <!-- ALC-227 : Pont Mashup — ⇄ RELAIS A ↔ B (bidirectionnel) -->
  {#if mixerStore.deckA.stemsStatus === 'ready' && mixerStore.deckB.stemsStatus === 'ready'}
    <div class="flex items-center justify-between gap-2 px-1">
      <button type="button" onclick={() => mixerStore.toggleVocalRelayStep()} title="⇄ Relais vocal bidirectionnel — coupe la voix active puis rouvre l'autre platine à la strophe suivante" class="px-2 py-1 rounded border border-[#edbf7a]/50 text-[#e0a860] text-[9px] font-bold uppercase tracking-widest whitespace-nowrap hover:bg-[#edbf7a]/15">⇄ RELAIS A ↔ B</button>
      {#if mixerStore.vocalRelayState.pendingTarget !== null}
        <span class="font-mono text-[9px] font-bold uppercase tracking-widest text-[#e0a860] whitespace-nowrap tabular-nums">⏳ VOIX {mixerStore.vocalRelayState.pendingTarget} À {formatTime(mixerStore.vocalRelayState.triggerAtSeconds ?? 0)}</span>
        <button type="button" onclick={() => mixerStore.toggleVocalRelayStep()} title="Forcer la reprise de la voix maintenant" class="px-2 py-1 rounded bg-gradient-to-b from-[#edbf7a] to-[#9a6f2f] text-[#120d0a] text-[9px] font-bold uppercase tracking-widest whitespace-nowrap animate-pulse shadow-[0_2px_6px_rgba(0,0,0,0.7)] hover:brightness-110">Forcer maintenant</button>
      {/if}
    </div>
  {/if}
  <div class="flex flex-row items-stretch gap-space-sm flex-1 min-h-0">
    <!-- PLATINE A -->
    <div class="flex-1 min-w-0 flex flex-col gap-1.5 bg-[#120d0a] rounded-xl p-space-sm border border-[#4f4539]/40 shadow-[inset_0_2px_6px_rgba(0,0,0,0.8)]">
      <div class="flex items-center justify-between gap-1 px-space-xs">
        <span class="font-label-sm text-[9px] font-bold uppercase tracking-widest text-[#10b981]">PLATINE A • Émeraude</span>
        <span class="font-label-sm text-[8px] font-mono uppercase tracking-wider text-outline truncate max-w-[45%]">{mixerStore.deckA.filePath ? (mixerStore.deckA.trackTitle || '—') : 'Sleeve vide'}</span>
      </div>
      <div class="flex items-center justify-between gap-1 px-space-xs">
        <span class="text-[8px] font-label-sm font-bold uppercase tracking-wider rounded px-1.5 py-0.5 border {statusInfo('A')}">{statusTxt('A')}</span>
        {#if mixerStore.deckA.filePath}
        {#if busy('A')}
          <div class="flex flex-1 items-center gap-1.5 min-w-0">
            <div class="flex-1 h-1.5 bg-[#17120f] rounded-full overflow-hidden border border-[#4f4539]/50">
              <div class="h-full bg-[#edbf7a] transition-[width] duration-75" style="width:{mixerStore.deckA.stemsProgress}%"></div>
            </div>
            <span class="text-[9px] font-mono text-[#edbf7a] tabular-nums">{mixerStore.deckA.stemsProgress}%</span>
          </div>
        {:else}
          <div class="flex flex-1 justify-end gap-1 min-w-0">
            <button type="button" onclick={() => mixerStore.extractDeckStems('A')} disabled={mixerStore.deckA.stemsStatus === 'separating' || mixerStore.deckA.stemsStatus === 'ready'}
              class="px-1.5 py-0.5 rounded border border-[#4a3b2c]/70 bg-gradient-to-b from-[#3a2f24] to-[#201a12] text-[#edbf7a] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:brightness-125 disabled:opacity-40 flex items-center gap-1">
              <span class="material-symbols-outlined text-[10px]">bolt</span><span>Extraire stems</span></button>
            {#if ready('A')}
            <button type="button" onclick={() => mixerStore.exportDeckStems('A')}
              class="px-1.5 py-0.5 rounded border border-[#4a3b2c]/70 bg-gradient-to-b from-[#3a2f24] to-[#201a12] text-[#edbf7a] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:brightness-125 flex items-center gap-1">
              <span class="material-symbols-outlined text-[10px]">{mixerStore.deckA.stemsExported ? 'check' : 'download'}</span><span>{mixerStore.deckA.stemsExported ? 'Exportés' : '↓ Export WAV'}</span></button>
            {/if}
          </div>
        {/if}
        {/if}
      </div>
<div class="flex flex-1 items-stretch gap-1.5 min-h-0">
        {#each STRIPS as [stem, label] (stem)}
          <div class="flex-1 min-w-0 flex flex-col items-center gap-0.5 bg-[#17120f] rounded-lg p-1 border border-[#4f4539]/30">
            <span class="material-symbols-outlined text-[13px] leading-none {active('A', stem) ? 'text-[#10b981]' : 'text-[#7a6449]'}">{SYMBOL[stem]}</span>
            <span class="font-label-sm text-[7px] font-bold uppercase tracking-wider {active('A', stem) ? 'text-[#10b981]' : 'text-outline/50'}">{label}</span>
            <div class="relative flex flex-1 w-full gap-1 items-stretch min-h-[150px]">
              <div class="flex flex-col justify-end gap-[2px] w-[7px] h-full">
                {#each LEDS as i (i)}
                  <div class="flex-1 rounded-[1px] {ledCls('A', stem, i)}"></div>
                {/each}
              </div>
              <div class="relative flex-1 h-full">
                <div class="absolute right-0 top-1 bottom-1 flex flex-col justify-between items-end pr-0.5 pointer-events-none font-mono text-[6px] leading-none text-outline/40">
                  <span>100</span><span>75</span><span>50</span><span>25</span><span>0</span>
                </div>
                <div class="absolute left-0 top-1 bottom-1 w-3 bg-[#120d0a] rounded-full border border-[#201a17] shadow-[inset_0_2px_4px_rgba(0,0,0,0.9)] cursor-ns-resize touch-none select-none"
                  role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100"
                  aria-valuenow={Math.round(vol('A', stem) * 100)} aria-label={label + ' niveau'}
                  onpointerdown={(e) => fDown('A', stem, e)} onpointermove={fMove} onpointerup={fUp} onpointercancel={fUp}>
                  <div class="absolute inset-y-1 left-0.5 right-0.5 flex flex-col justify-between pointer-events-none opacity-40">
                    <div class="h-px bg-[#3a3330]"></div><div class="h-px bg-[#3a3330]"></div>
                    <div class="h-px bg-[#3a3330]"></div><div class="h-px bg-[#3a3330]"></div>
                    <div class="h-px bg-[#3a3330]"></div>
                  </div>
                  <div class="absolute left-1/2 -translate-x-1/2 w-6 h-3 rounded-sm bg-gradient-to-b from-[#edbf7a] to-[#b8893f] shadow-[0_2px_4px_rgba(0,0,0,0.8)] pointer-events-none"
                    style="bottom:{Math.max(0, Math.min(100, vol('A', stem) * 100 - 4))}%"></div>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-1">
              <button type="button" onclick={() => mixerStore.toggleStemMute('A', stem)}
                class="w-5 h-5 rounded text-[8px] font-bold border transition-colors {muted('A', stem) ? 'bg-[#3a2f24] text-outline border-[#4f4539]/60' : 'bg-[#10b981]/15 text-[#10b981] border-[#10b981]/40'}" title="Mute">M</button>
              <button type="button" onclick={() => mixerStore.soloStem('A', stem)}
                class="w-5 h-5 rounded text-[8px] font-bold border transition-colors {muted('A', stem) ? 'bg-[#10b981]/15 text-[#10b981] border-[#10b981]/40' : 'bg-[#3a2f24] text-outline border-[#4f4539]/60'}" title="Solo">S</button>
            </div>
            <span class="font-mono text-[7px] text-outline tabular-nums">{Math.round(vol('A', stem) * 100)}%</span>
          </div>
        {/each}
      </div>
      <div class="flex items-center gap-1 px-space-xs">
        <button type="button" onclick={() => mixerStore.setStemPreset('A', 'all')} class="flex-1 py-0.5 rounded border border-[#4f4539]/50 text-outline font-label-sm text-[8px] font-bold uppercase tracking-wider hover:brightness-125">TOUT</button>
        <button type="button" onclick={() => mixerStore.setStemPreset('A', 'acapella')} class="flex-1 py-0.5 rounded bg-[#10b981]/10 border border-[#10b981]/40 text-[#10b981] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:bg-[#10b981]/20">ACAPELLA</button>
        <button type="button" onclick={() => mixerStore.setStemPreset('A', 'instrumental')} class="flex-1 py-0.5 rounded bg-[#3b82f6]/10 border border-[#3b82f6]/40 text-[#3b82f6] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:bg-[#3b82f6]/20">INST</button>
      </div>
    </div>
<!-- Pont Mashup -->
    <div class="w-28 shrink-0 flex flex-col items-center justify-center gap-2 bg-[#17120f] rounded-xl p-space-sm border border-[#4f4539]/50">
      <span class="font-label-sm text-[8px] font-bold uppercase tracking-widest text-[#edbf7a] text-center">Pont Mashup</span>
      <button type="button" onclick={() => mixerStore.applyCrossDeckMashup('A')} disabled={!ready('A') || !ready('B')}
        class="w-full px-1.5 py-1 rounded bg-gradient-to-b from-[#3a2f24] to-[#201a12] border border-[#edbf7a]/50 text-[#edbf7a] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:brightness-125 disabled:opacity-40 leading-tight">VOIX A<br>+ INST B</button>
      <button type="button" onclick={() => mixerStore.applyCrossDeckMashup('B')} disabled={!ready('A') || !ready('B')}
        class="w-full px-1.5 py-1 rounded bg-gradient-to-b from-[#3a2f24] to-[#201a12] border border-[#edbf7a]/50 text-[#edbf7a] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:brightness-125 disabled:opacity-40 leading-tight">INST A<br>+ VOIX B</button>
      <button type="button" onclick={() => mixerStore.resetAllStemMutes()} disabled={!ready('A') && !ready('B')}
        class="w-full px-1.5 py-1 rounded border border-outline/40 text-outline font-label-sm text-[7px] font-bold uppercase tracking-wider hover:text-[#edbf7a] hover:border-[#edbf7a]/40 disabled:opacity-40">Reset 8 pistes</button>
      <span class="font-label-sm text-[6px] text-outline uppercase tracking-wider text-center leading-tight">sync<br>latérale</span>
    </div>
<!-- PLATINE B -->
    <div class="flex-1 min-w-0 flex flex-col gap-1.5 bg-[#120d0a] rounded-xl p-space-sm border border-[#4f4539]/40 shadow-[inset_0_2px_6px_rgba(0,0,0,0.8)]">
      <div class="flex items-center justify-between gap-1 px-space-xs">
        <span class="font-label-sm text-[9px] font-bold uppercase tracking-widest text-[#3b82f6]">PLATINE B • Bleu</span>
        <span class="font-label-sm text-[8px] font-mono uppercase tracking-wider text-outline truncate max-w-[45%]">{mixerStore.deckB.filePath ? (mixerStore.deckB.trackTitle || '—') : 'Sleeve vide'}</span>
      </div>
      <div class="flex items-center justify-between gap-1 px-space-xs">
        <span class="text-[8px] font-label-sm font-bold uppercase tracking-wider rounded px-1.5 py-0.5 border {statusInfo('B')}">{statusTxt('B')}</span>
        {#if mixerStore.deckB.filePath}
        {#if busy('B')}
          <div class="flex flex-1 items-center gap-1.5 min-w-0">
            <div class="flex-1 h-1.5 bg-[#17120f] rounded-full overflow-hidden border border-[#4f4539]/50">
              <div class="h-full bg-[#edbf7a] transition-[width] duration-75" style="width:{mixerStore.deckB.stemsProgress}%"></div>
            </div>
            <span class="text-[9px] font-mono text-[#edbf7a] tabular-nums">{mixerStore.deckB.stemsProgress}%</span>
          </div>
        {:else}
          <div class="flex flex-1 justify-end gap-1 min-w-0">
            <button type="button" onclick={() => mixerStore.extractDeckStems('B')} disabled={mixerStore.deckB.stemsStatus === 'separating' || mixerStore.deckB.stemsStatus === 'ready'}
              class="px-1.5 py-0.5 rounded border border-[#4a3b2c]/70 bg-gradient-to-b from-[#3a2f24] to-[#201a12] text-[#edbf7a] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:brightness-125 disabled:opacity-40 flex items-center gap-1">
              <span class="material-symbols-outlined text-[10px]">bolt</span><span>Extraire stems</span></button>
            {#if ready('B')}
            <button type="button" onclick={() => mixerStore.exportDeckStems('B')}
              class="px-1.5 py-0.5 rounded border border-[#4a3b2c]/70 bg-gradient-to-b from-[#3a2f24] to-[#201a12] text-[#edbf7a] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:brightness-125 flex items-center gap-1">
              <span class="material-symbols-outlined text-[10px]">{mixerStore.deckB.stemsExported ? 'check' : 'download'}</span><span>{mixerStore.deckB.stemsExported ? 'Exportés' : '↓ Export WAV'}</span></button>
            {/if}
          </div>
        {/if}
        {/if}
      </div>
<div class="flex flex-1 items-stretch gap-1.5 min-h-0">
        {#each STRIPS as [stem, label] (stem)}
          <div class="flex-1 min-w-0 flex flex-col items-center gap-0.5 bg-[#17120f] rounded-lg p-1 border border-[#4f4539]/30">
            <span class="material-symbols-outlined text-[13px] leading-none {active('B', stem) ? 'text-[#3b82f6]' : 'text-[#7a6449]'}">{SYMBOL[stem]}</span>
            <span class="font-label-sm text-[7px] font-bold uppercase tracking-wider {active('B', stem) ? 'text-[#3b82f6]' : 'text-outline/50'}">{label}</span>
            <div class="relative flex flex-1 w-full gap-1 items-stretch min-h-[150px]">
              <div class="flex flex-col justify-end gap-[2px] w-[7px] h-full">
                {#each LEDS as i (i)}
                  <div class="flex-1 rounded-[1px] {ledCls('B', stem, i)}"></div>
                {/each}
              </div>
              <div class="relative flex-1 h-full">
                <div class="absolute right-0 top-1 bottom-1 flex flex-col justify-between items-end pr-0.5 pointer-events-none font-mono text-[6px] leading-none text-outline/40">
                  <span>100</span><span>75</span><span>50</span><span>25</span><span>0</span>
                </div>
                <div class="absolute left-0 top-1 bottom-1 w-3 bg-[#120d0a] rounded-full border border-[#201a17] shadow-[inset_0_2px_4px_rgba(0,0,0,0.9)] cursor-ns-resize touch-none select-none"
                  role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100"
                  aria-valuenow={Math.round(vol('B', stem) * 100)} aria-label={label + ' niveau'}
                  onpointerdown={(e) => fDown('B', stem, e)} onpointermove={fMove} onpointerup={fUp} onpointercancel={fUp}>
                  <div class="absolute inset-y-1 left-0.5 right-0.5 flex flex-col justify-between pointer-events-none opacity-40">
                    <div class="h-px bg-[#3a3330]"></div><div class="h-px bg-[#3a3330]"></div>
                    <div class="h-px bg-[#3a3330]"></div><div class="h-px bg-[#3a3330]"></div>
                    <div class="h-px bg-[#3a3330]"></div>
                  </div>
                  <div class="absolute left-1/2 -translate-x-1/2 w-6 h-3 rounded-sm bg-gradient-to-b from-[#edbf7a] to-[#b8893f] shadow-[0_2px_4px_rgba(0,0,0,0.8)] pointer-events-none"
                    style="bottom:{Math.max(0, Math.min(100, vol('B', stem) * 100 - 4))}%"></div>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-1">
              <button type="button" onclick={() => mixerStore.toggleStemMute('B', stem)}
                class="w-5 h-5 rounded text-[8px] font-bold border transition-colors {muted('B', stem) ? 'bg-[#3a2f24] text-outline border-[#4f4539]/60' : 'bg-[#3b82f6]/15 text-[#3b82f6] border-[#3b82f6]/40'}" title="Mute">M</button>
              <button type="button" onclick={() => mixerStore.soloStem('B', stem)}
                class="w-5 h-5 rounded text-[8px] font-bold border transition-colors {muted('B', stem) ? 'bg-[#3b82f6]/15 text-[#3b82f6] border-[#3b82f6]/40' : 'bg-[#3a2f24] text-outline border-[#4f4539]/60'}" title="Solo">S</button>
            </div>
            <span class="font-mono text-[7px] text-outline tabular-nums">{Math.round(vol('B', stem) * 100)}%</span>
          </div>
        {/each}
      </div>
      <div class="flex items-center gap-1 px-space-xs">
        <button type="button" onclick={() => mixerStore.setStemPreset('B', 'all')} class="flex-1 py-0.5 rounded border border-[#4f4539]/50 text-outline font-label-sm text-[8px] font-bold uppercase tracking-wider hover:brightness-125">TOUT</button>
        <button type="button" onclick={() => mixerStore.setStemPreset('B', 'acapella')} class="flex-1 py-0.5 rounded bg-[#10b981]/10 border border-[#10b981]/40 text-[#10b981] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:bg-[#10b981]/20">ACAPELLA</button>
        <button type="button" onclick={() => mixerStore.setStemPreset('B', 'instrumental')} class="flex-1 py-0.5 rounded bg-[#3b82f6]/10 border border-[#3b82f6]/40 text-[#3b82f6] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:bg-[#3b82f6]/20">INST</button>
      </div>
    </div>
  </div>
</div>