<script lang="ts">
  import { mixerStore } from '$lib/stores/mixer.svelte';
  import { SLOT1_MODE_UI, SLOT2_MODE_UI } from '$lib/audio/fxRack';
  import type { FxDeckTarget, FxStemTarget, FxDelayDivision } from '$lib/audio/fxRack';

  const STEM_TARGETS: FxStemTarget[] = ['vocals', 'drums', 'bass', 'other', 'all'];
  const STEM_LABEL: Record<FxStemTarget, string> = {
    vocals: 'VOIX', drums: 'BATTERIE', bass: 'BASSE', other: 'INSTRUMENTS', all: 'TOUT CANAL',
  };
  const DIVISIONS: FxDelayDivision[] = ['1/4', '1/2', '3/4', '1 T'];

  const fx = $derived(mixerStore.fxRack);
  const dur = $derived(
    `${Math.floor(mixerStore.fxRack.fxRecordingDurationSec / 60)}:${String(Math.floor(mixerStore.fxRack.fxRecordingDurationSec % 60)).padStart(2, '0')}.${String(Math.round((mixerStore.fxRack.fxRecordingDurationSec % 1) * 10)).padStart(2, '0')}`
  );
  const vuL = $derived(mixerStore.fxRack.isRecordingFx ? 0.72 + Math.random() * 0.22 : 0.12);
  const vuR = $derived(mixerStore.fxRack.isRecordingFx ? 0.7 + Math.random() * 0.24 : 0.1);

  function setDeck(d: FxDeckTarget) {
    mixerStore.setFxTarget(d, mixerStore.fxRack.stemTarget);
  }
  function setStem(s: FxStemTarget) {
    mixerStore.setFxTarget(mixerStore.fxRack.deck, s);
  }
</script>

<style>
  /* ALC-216 : sliders de rack tactiles — rail encastré sombre + capuchon laiton. */
  input[type='range'].fx-range {
    -webkit-appearance: none;
    appearance: none;
    height: 10px;
    margin: 0;
    border-radius: 6px;
    background: linear-gradient(180deg, #0a0706 0%, #1a140f 45%, #0a0706 100%);
    border: 1px solid #4f4539;
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.9), 0 1px 0 rgba(255, 221, 176, 0.08);
    cursor: pointer;
  }
  input[type='range'].fx-range:focus-visible {
    outline: 1px solid #edbf7a;
  }
  input[type='range'].fx-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 18px;
    border-radius: 3px;
    background: linear-gradient(180deg, #6b5a3c 0%, #3a2f24 55%, #120d0a 100%);
    border: 1px solid #8c6d3f;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.85), inset 0 1px 0 rgba(255, 221, 176, 0.3);
  }
  input[type='range'].fx-range::-moz-range-thumb {
    width: 14px;
    height: 18px;
    border-radius: 3px;
    background: linear-gradient(180deg, #6b5a3c 0%, #3a2f24 55%, #120d0a 100%);
    border: 1px solid #8c6d3f;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.85);
  }
  /* Micro-bouton d'ajustement fin − / + (mécanique, enfoncement au clic). */
  .fx-minus,
  .fx-plus {
    width: 18px;
    height: 20px;
    border-radius: 4px;
    border: 1px solid #4f4539;
    background: linear-gradient(180deg, #2b221c, #120d0a);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255, 221, 176, 0.12);
    color: #e0a860;
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
  }
  .fx-minus:active,
  .fx-plus:active {
    transform: translateY(1px);
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.85);
  }
</style>

<div class="flex flex-col gap-1 flex-1 min-h-0 overflow-hidden">
  <!-- Matrice d'assignation DSP : deck (A / B / MASTER) puis cible stem -->
  <div class="rounded-lg border border-[#4f4539]/50 bg-[#17120f] p-1.5 shadow-[inset_0_2px_8px_rgba(0,0,0,0.9)]">
    <div class="flex items-center gap-1 text-[12px] font-mono uppercase tracking-widest text-outline">
      <span class="material-symbols-outlined text-[13px] text-[#edbf7a]">router</span>
      <span class="whitespace-nowrap">Matrice d'Assignation DSP</span>
      <button type="button" onclick={() => mixerStore.resetFxRack()} title="Remettre les 3 effets à zéro (bypass)"
        class="ml-auto rounded border border-[#edbf7a]/50 bg-[#edbf7a]/10 text-[#ffddb0] px-2 py-0.5 font-mono text-[12px] font-bold uppercase tracking-widest whitespace-nowrap hover:brightness-110">↺ Réinitialiser FX</button>
    </div>
    <div class="mt-1 flex items-center gap-1">
      <!-- Bus maître / platines -->
      {#each (['A', 'B', 'MASTER'] as const) as d (d)}
        <button
          type="button"
          onclick={() => setDeck(d)}
          class="rounded border px-2 py-0.5 font-mono text-[12px] font-bold tracking-wider whitespace-nowrap transition-colors {fx.deck === d
            ? (d === 'A' ? 'border-emerald-400 bg-emerald-400/15 text-emerald-300' : d === 'B' ? 'border-sky-400 bg-sky-400/15 text-sky-300' : 'border-[#edbf7a] bg-[#edbf7a]/15 text-[#edbf7a]')
            : 'border-[#4f4539]/60 bg-[#201a17] text-on-surface-variant hover:text-on-surface'}"
        >
          {d === 'MASTER' ? 'BUS MASTER' : `PLATINE ${d}`}
        </button>
      {/each}
      <span class="mx-1 h-4 w-px bg-[#4f4539]/50"></span>
      <!-- Cible stem -->
      {#each STEM_TARGETS as s (s)}
        <button
          type="button"
          onclick={() => setStem(s)}
          class="rounded border px-1.5 py-0.5 font-mono text-[12px] font-bold tracking-wider whitespace-nowrap transition-colors {fx.stemTarget === s
            ? 'border-[#edbf7a] bg-[#edbf7a]/15 text-[#ffddb0]'
            : 'border-[#4f4539]/60 bg-[#201a17] text-on-surface-variant hover:text-on-surface'}"
        >
          {STEM_LABEL[s]}
        </button>
      {/each}
    </div>
  </div>

  <!-- 3 tranches d'effets côte à côte -->
  <div class="grid grid-cols-3 gap-1 flex-1 min-h-0">
<div class="flex flex-col min-h-0 rounded-xl border border-[#4f4539]/40 bg-[#201a17] p-1.5 shadow-[inset_0_2px_8px_rgba(0,0,0,0.8)] overflow-hidden">
      <div class="flex items-center justify-between gap-1">
        <span class="font-label-sm text-[12px] font-bold uppercase tracking-widest whitespace-nowrap text-[#c9a468]">↘/↗ FILTRE • GRAVES / AIGUS</span>
        <span class="font-mono text-[10px] font-bold tracking-wide whitespace-nowrap {fx.slot1.active ? 'text-emerald-300' : 'text-outline'}">{fx.slot1.active ? 'ACTIF' : 'INACTIF'}</span>
        <button type="button" aria-label="Activer / désactiver SLOT 01 (Filtre Résonant)" onclick={() => mixerStore.toggleFxSlot('slot1')}
          class="w-3.5 h-3.5 rounded-full border transition-all {fx.slot1.active ? 'bg-[#10b981] border-[#10b981] shadow-[0_0_6px_#10b981]' : 'bg-[#4f4539] border-[#4f4539]'}"></button>
      </div>
      <div class="mt-0.5 flex items-center gap-0.5">
        {#each SLOT1_MODE_UI as m (m.mode)}
          <button type="button" onclick={() => mixerStore.setFxSlot('slot1', { mode: m.mode })}
            class="rounded border px-1 py-0.5 font-mono text-[11px] font-bold tracking-wide whitespace-nowrap {fx.slot1.mode === m.mode ? 'border-[#edbf7a] bg-[#edbf7a]/15 text-[#ffddb0]' : 'border-[#4f4539]/60 bg-[#17120f] text-on-surface-variant'}">{m.symbol} {m.label}</button>
        {/each}
      </div>
      <div class="mt-1 flex flex-col gap-0.5">
        <div class="flex items-center justify-between text-[11px] font-mono tabular-nums"><span class="text-outline whitespace-nowrap">Fréq</span><span class="text-[#e0a860]">{Math.round(fx.slot1.cutoff)} Hz</span></div>
        <input type="range" min="40" max="16000" step="10" value={fx.slot1.cutoff} oninput={(e) => mixerStore.setFxSlot('slot1', { cutoff: Number((e.currentTarget as HTMLInputElement).value) })} class="fx-range w-full" />
        <div class="flex items-center justify-between text-[11px] font-mono tabular-nums"><span class="text-outline whitespace-nowrap">Réson</span><span class="text-[#e0a860]">{fx.slot1.resonance.toFixed(1)}</span></div>
        <input type="range" min="0.2" max="12" step="0.1" value={fx.slot1.resonance} oninput={(e) => mixerStore.setFxSlot('slot1', { resonance: Number((e.currentTarget as HTMLInputElement).value) })} class="fx-range w-full" />
        <div class="flex items-center justify-between text-[11px] font-mono tabular-nums"><span class="text-outline whitespace-nowrap">Dry/Wet</span><span class="text-[#e0a860]">{Math.round(fx.slot1.dryWet * 100)}%</span></div>
        <div class="flex items-center gap-1">
          <button type="button" class="fx-minus shrink-0" onclick={() => mixerStore.setFxSlot('slot1', { dryWet: Number(Math.max(0, fx.slot1.dryWet - 0.05).toFixed(2)) })}>−</button>
          <input type="range" class="fx-range w-full" min="0" max="1" step="0.01" value={fx.slot1.dryWet} oninput={(e) => mixerStore.setFxSlot('slot1', { dryWet: Number((e.currentTarget as HTMLInputElement).value) })} />
          <button type="button" class="fx-plus shrink-0" onclick={() => mixerStore.setFxSlot('slot1', { dryWet: Number(Math.min(1, fx.slot1.dryWet + 0.05).toFixed(2)) })}>+</button>
        </div>
        <div class="mt-0.5 flex gap-[2px]">
          {#each [1, 2, 3, 4, 5, 6, 7, 8] as i (i)}
            <div class="h-1 flex-1 rounded-sm {fx.slot1.dryWet >= i / 8 ? 'bg-[#edbf7a]' : 'bg-[#120d0a]'}"></div>
          {/each}
        </div>
      </div>
    </div>

    <!-- SLOT 02 : Saturation & Modulation -->
    <div class="flex flex-col min-h-0 rounded-xl border border-[#4f4539]/40 bg-[#201a17] p-1.5 shadow-[inset_0_2px_8px_rgba(0,0,0,0.8)] overflow-hidden">
      <div class="flex items-center justify-between gap-1">
        <span class="font-label-sm text-[12px] font-bold uppercase tracking-widest whitespace-nowrap text-[#c9a468]">🔥 CHALEUR & VAGUE</span>
        <span class="font-mono text-[10px] font-bold tracking-wide whitespace-nowrap {fx.slot2.active ? 'text-sky-300' : 'text-outline'}">{fx.slot2.active ? 'ACTIF' : 'INACTIF'}</span>
        <button type="button" aria-label="Activer / désactiver SLOT 02 (Saturation & Flanger)" onclick={() => mixerStore.toggleFxSlot('slot2')}
          class="w-3.5 h-3.5 rounded-full border transition-all {fx.slot2.active ? 'bg-[#3b82f6] border-[#3b82f6] shadow-[0_0_6px_#3b82f6]' : 'bg-[#4f4539] border-[#4f4539]'}"></button>
      </div>
      <div class="mt-0.5 flex items-center gap-0.5">
        {#each SLOT2_MODE_UI as m (m.mode)}
          <button type="button" onclick={() => mixerStore.setFxSlot('slot2', { mode: m.mode })}
            class="rounded border px-1 py-0.5 font-mono text-[11px] font-bold tracking-wide whitespace-nowrap {fx.slot2.mode === m.mode ? 'border-[#edbf7a] bg-[#edbf7a]/15 text-[#ffddb0]' : 'border-[#4f4539]/60 bg-[#17120f] text-on-surface-variant'}">{m.symbol} {m.label}</button>
        {/each}
      </div>
      <div class="mt-1 flex flex-col gap-0.5">
        <div class="flex items-center justify-between text-[11px] font-mono tabular-nums"><span class="text-outline whitespace-nowrap">Drive</span><span class="text-[#e0a860]">{Math.round(fx.slot2.drive * 100)}%</span></div>
        <input type="range" min="0" max="1" step="0.01" value={fx.slot2.drive} oninput={(e) => mixerStore.setFxSlot('slot2', { drive: Number((e.currentTarget as HTMLInputElement).value) })} class="fx-range w-full" />
        <div class="flex items-center justify-between text-[11px] font-mono tabular-nums"><span class="text-outline whitespace-nowrap">Modul.</span><span class="text-[#e0a860]">{Math.round(fx.slot2.modulate * 100)}%</span></div>
        <input type="range" min="0" max="1" step="0.01" value={fx.slot2.modulate} oninput={(e) => mixerStore.setFxSlot('slot2', { modulate: Number((e.currentTarget as HTMLInputElement).value) })} class="fx-range w-full" />
        <div class="flex items-center justify-between text-[11px] font-mono tabular-nums"><span class="text-outline whitespace-nowrap">Dry/Wet</span><span class="text-[#e0a860]">{Math.round(fx.slot2.dryWet * 100)}%</span></div>
        <div class="flex items-center gap-1">
          <button type="button" class="fx-minus shrink-0" onclick={() => mixerStore.setFxSlot('slot2', { dryWet: Number(Math.max(0, fx.slot2.dryWet - 0.05).toFixed(2)) })}>−</button>
          <input type="range" class="fx-range w-full" min="0" max="1" step="0.01" value={fx.slot2.dryWet} oninput={(e) => mixerStore.setFxSlot('slot2', { dryWet: Number((e.currentTarget as HTMLInputElement).value) })} />
          <button type="button" class="fx-plus shrink-0" onclick={() => mixerStore.setFxSlot('slot2', { dryWet: Number(Math.min(1, fx.slot2.dryWet + 0.05).toFixed(2)) })}>+</button>
        </div>
        <div class="mt-0.5 flex gap-[2px]">
          {#each [1, 2, 3, 4, 5, 6, 7, 8] as i (i)}
            <div class="h-1 flex-1 rounded-sm {fx.slot2.dryWet >= i / 8 ? 'bg-[#3b82f6]' : 'bg-[#120d0a]'}"></div>
          {/each}
        </div>
      </div>
    </div>
<!-- SLOT 03 : Écho Bande Sync BPM & Réverbération -->
    <div class="flex flex-col min-h-0 rounded-xl border border-[#4f4539]/40 bg-[#201a17] p-1.5 shadow-[inset_0_2px_8px_rgba(0,0,0,0.8)] overflow-hidden">
      <div class="flex items-center justify-between gap-1">
        <span class="font-label-sm text-[12px] font-bold uppercase tracking-widest whitespace-nowrap text-[#c9a468]">((•)) ÉCHO & RÉVERB • TRAÎNÉE</span>
        <span class="font-mono text-[10px] font-bold tracking-wide whitespace-nowrap {fx.slot3.active ? 'text-[#ffddb0]' : 'text-outline'}">{fx.slot3.active ? 'ACTIF' : 'INACTIF'}</span>
        <button type="button" aria-label="Activer / désactiver SLOT 03 (Écho Sync BPM & Réverb)" onclick={() => mixerStore.toggleFxSlot('slot3')}
          class="w-3.5 h-3.5 rounded-full border transition-all {fx.slot3.active ? 'bg-[#edbf7a] border-[#edbf7a] shadow-[0_0_6px_#edbf7a]' : 'bg-[#4f4539] border-[#4f4539]'}"></button>
      </div>
      <div class="mt-0.5 flex items-center gap-0.5">
        {#each DIVISIONS as d (d)}
          <button type="button" onclick={() => mixerStore.setFxSlot('slot3', { division: d })}
            class="rounded border px-1 py-0.5 font-mono text-[11px] font-bold tracking-wide whitespace-nowrap {fx.slot3.division === d ? 'border-[#edbf7a] bg-[#edbf7a]/15 text-[#ffddb0]' : 'border-[#4f4539]/60 bg-[#17120f] text-on-surface-variant'}">{d}</button>
        {/each}
      </div>
      <div class="mt-1 flex flex-col gap-0.5">
        <div class="flex items-center justify-between text-[11px] font-mono tabular-nums"><span class="text-outline whitespace-nowrap">Feedback</span><span class="text-[#e0a860]">{Math.round(fx.slot3.feedback * 100)}%</span></div>
        <input type="range" min="0" max="0.9" step="0.01" value={fx.slot3.feedback} oninput={(e) => mixerStore.setFxSlot('slot3', { feedback: Number((e.currentTarget as HTMLInputElement).value) })} class="fx-range w-full" />
        <div class="flex items-center justify-between text-[11px] font-mono tabular-nums"><span class="text-outline whitespace-nowrap">Dampen</span><span class="text-[#e0a860]">{Math.round(fx.slot3.dampen)} Hz</span></div>
        <input type="range" min="200" max="12000" step="100" value={fx.slot3.dampen} oninput={(e) => mixerStore.setFxSlot('slot3', { dampen: Number((e.currentTarget as HTMLInputElement).value) })} class="fx-range w-full" />
        <div class="flex items-center justify-between text-[11px] font-mono tabular-nums"><span class="text-outline whitespace-nowrap">🏛️ Salle (Reverb)</span><span class="text-[#e0a860]">{Math.round(fx.slot3.reverbMix * 100)}%</span></div>
        <input type="range" min="0" max="1" step="0.01" value={fx.slot3.reverbMix} oninput={(e) => mixerStore.setFxSlot('slot3', { reverbMix: Number((e.currentTarget as HTMLInputElement).value) })} class="fx-range w-full" />
        <button type="button" onclick={() => mixerStore.setFxSlot('slot3', { tailHold: !fx.slot3.tailHold })}
          class="rounded border px-1 py-0.5 font-mono text-[11px] font-bold tracking-wide whitespace-nowrap transition-colors {fx.slot3.tailHold ? 'border-[#edbf7a] bg-[#edbf7a]/20 text-[#ffddb0]' : 'border-[#4f4539]/60 bg-[#17120f] text-on-surface-variant'}">{fx.slot3.tailHold ? "🔒 TRAÎNÉE GARDÉE ✓" : "🔒 GARDER LA TRAÎNÉE"}</button>
        <div class="flex items-center justify-between text-[11px] font-mono tabular-nums mt-0.5"><span class="text-outline whitespace-nowrap">Dry/Wet</span><span class="text-[#e0a860]">{Math.round(fx.slot3.dryWet * 100)}%</span></div>
        <div class="flex items-center gap-1">
          <button type="button" class="fx-minus shrink-0" onclick={() => mixerStore.setFxSlot('slot3', { dryWet: Number(Math.max(0, fx.slot3.dryWet - 0.05).toFixed(2)) })}>−</button>
          <input type="range" class="fx-range w-full" min="0" max="1" step="0.01" value={fx.slot3.dryWet} oninput={(e) => mixerStore.setFxSlot('slot3', { dryWet: Number((e.currentTarget as HTMLInputElement).value) })} />
          <button type="button" class="fx-plus shrink-0" onclick={() => mixerStore.setFxSlot('slot3', { dryWet: Number(Math.min(1, fx.slot3.dryWet + 0.05).toFixed(2)) })}>+</button>
        </div>
        <div class="mt-0.5 flex gap-[2px]">
          {#each [1, 2, 3, 4, 5, 6, 7, 8] as i (i)}
            <div class="h-1 flex-1 rounded-sm {fx.slot3.dryWet >= i / 8 ? 'bg-[#edbf7a]' : 'bg-[#120d0a]'}"></div>
          {/each}
        </div>
      </div>
    </div>
  </div>

  <!-- Banc d'enregistrement .WAV (au-dessus du Crossfader Manter) -->
  <div class="rounded-lg border border-[#4f4539]/50 bg-[#17120f] px-2 py-1.5 shadow-[inset_0_1px_4px_rgba(0,0,0,0.8)]">
    <div class="flex items-center gap-2">
      <button type="button" onclick={() => mixerStore.setFxRecording(!mixerStore.fxRack.isRecordingFx)}
        class="rounded border px-2 py-1 font-mono text-[12px] font-bold uppercase tracking-widest whitespace-nowrap transition-colors {mixerStore.fxRack.isRecordingFx
          ? 'border-[#ff5f56] bg-[#ff5f56]/20 text-[#ffb4ab] shadow-[0_0_8px_rgba(255,95,86,0.4)]'
          : 'border-[#10b981]/60 bg-[#10b981]/10 text-emerald-300'}">
        {mixerStore.fxRack.isRecordingFx ? '■ STOP & SAUVER' : '● REC STEM + FX (.WAV)'}
      </button>
      <span class="font-mono text-[13px] tabular-nums text-outline whitespace-nowrap">DURÉE <span class="text-[#e0a860]">{dur}</span></span>
      <!-- VU-mètre L/R -->
      <div class="flex items-end gap-px">
        <div class="w-1.5 h-4 rounded-sm bg-[#120d0a] overflow-hidden"><div class="w-full bg-emerald-400" style="height:{Math.max(4, vuL * 16)}px"></div></div>
        <div class="w-1.5 h-4 rounded-sm bg-[#120d0a] overflow-hidden"><div class="w-full bg-sky-400" style="height:{Math.max(4, vuR * 16)}px"></div></div>
      </div>
      <button type="button" onclick={() => mixerStore.sendLastFxRecordingToLivePad()}
        disabled={!mixerStore.fxRack.lastRecordedFxBlobUrl}
        class="rounded border border-[#edbf7a]/50 bg-[#edbf7a]/10 text-[#ffddb0] px-2 py-1 font-mono text-[12px] font-bold uppercase tracking-widest whitespace-nowrap hover:brightness-110 disabled:opacity-40"
      >
        ⚡ ENVOYER VERS PAD LIVE
      </button>
      {#if mixerStore.fxRack.lastRecordedFxName}
        <span class="ml-auto font-mono text-[11px] text-outline truncate whitespace-nowrap">✓ {mixerStore.fxRack.lastRecordedFxName}</span>
      {/if}
    </div>
  </div>
</div>