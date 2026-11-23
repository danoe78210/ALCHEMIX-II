<script lang="ts">
  import DeckA from '$lib/components/DeckA.svelte';
  import DeckB from '$lib/components/DeckB.svelte';
  import MixerCenter from '$lib/components/MixerCenter.svelte';
  import VzTip from '$lib/components/VzTip.svelte'; // ALC-255 WP15
  import { mixerStore } from '$lib/stores/mixer.svelte';
  import { audioIpc } from '$lib/ipc/client';

  // ALC-139 : interruption POWER OFF + purge du cache + fermeture propre.
  let showPower = $state(false);
  function confirmShutdown() { showPower = true; }

  // ALC-191-2 : fermeture du guide Mashup au clavier (Escape) quand il est ouvert.
  $effect(() => {
    if (mixerStore.centerView !== 'guide') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') mixerStore.toggleMashupGuide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ALC-262-4 : cadran horloger système en temps réel (HH:MM:SS) — mise à jour 1 s + nettoyage propre.
  let clockNow = $state(new Date().toLocaleTimeString('fr-FR', { hour12: false }));
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  $effect(() => {
    clockTimer = setInterval(() => {
      clockNow = new Date().toLocaleTimeString('fr-FR', { hour12: false });
    }, 1000);
    return () => {
      if (clockTimer) clearInterval(clockTimer);
      clockTimer = undefined;
    };
  });

  async function shutdownAndPurgeCache() {
    showPower = false;
    // 1) Stopper les deux platines + pré-écoute Deezer (via event « alchemix:shutdown »).
    mixerStore.setTransport('A', 'stopped');
    mixerStore.setTransport('B', 'stopped');
    window.dispatchEvent(new CustomEvent('alchemix:shutdown'));
    // 2) Purge du cache applicatif + storage temporaire.
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch { /* l'API CacheStorage peut être indisponible */ }
    try { sessionStorage.clear(); } catch { /* */ }
    try { localStorage.removeItem('alchemix-board'); } catch { /* */ }
    // 3) Vider le cache mémoire (pochettes / métadonnées).
    mixerStore.getDeck('A').coverUrl = '';
    mixerStore.getDeck('B').coverUrl = '';
    // 4) Fermeture propre de l'application Tauri.
    setTimeout(() => audioIpc.exitApp().catch(() => {}), 250);
  }
</script>

<main class="relative w-full h-screen overflow-hidden bg-background">
  <div class="flex flex-col w-full h-full min-h-0 text-on-surface">
    <!-- Master Chassis Container -->
    <div class="p-space-sm lg:p-space-md flex flex-col gap-space-md max-w-[1720px] mx-auto w-full h-full min-h-0">
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
          <!-- ALC-262-4 : cadran horloger système Venezia 1889 (sans casser l'alignement du header) -->
          <div class="flex items-center gap-space-sm bg-surface-container-lowest px-space-md py-space-xs rounded shadow-[inset_1px_1px_4px_rgba(0,0,0,0.9)]">
            <span class="material-symbols-outlined text-[15px] text-[#edbf7a] shrink-0">schedule</span>
            <div class="flex flex-col text-right leading-none">
              <span class="font-label-sm text-[8px] text-outline uppercase tracking-widest whitespace-nowrap">Heure Venezia</span>
              <span class="font-mono text-[13px] font-bold text-[#edbf7a] tabular-nums tracking-[0.12em] whitespace-nowrap">{clockNow}</span>
            </div>
          </div>
          <!-- ALC-191-2 : bouton GUIDE MASHUP (onboarding intégré, laiton oxydé / or quand actif) -->
          <VzTip text="Guide Mashup pas à pas (Codex de l'Alchimiste)">
            <button
              type="button"
              onclick={() => mixerStore.toggleMashupGuide()}
              aria-pressed={mixerStore.centerView === 'guide'}
              aria-label="Guide Mashup pas à pas (Codex de l'Alchimiste)"
              class="flex items-center gap-1.5 px-space-md py-space-xs rounded border bg-surface-container-lowest shadow-[inset_1px_1px_4px_rgba(0,0,0,0.9)] transition-colors {mixerStore.centerView === 'guide'
                ? 'border-[#edbf7a] bg-[#edbf7a]/15 text-[#edbf7a] shadow-[0_0_10px_rgba(237,191,122,0.35)]'
                : 'border-[#4f4539] text-outline hover:text-[#edbf7a] hover:border-[#edbf7a]/50'}"
            >
              <span class="material-symbols-outlined text-[15px]">help_outline</span>
              <span class="font-label-sm text-[8px] uppercase tracking-widest">Guide Mashup</span>
            </button>
          </VzTip>
          <div class="flex items-center gap-space-sm bg-surface-container-lowest px-space-md py-space-xs rounded shadow-[inset_1px_1px_4px_rgba(0,0,0,0.9)]">
            <div class="flex flex-col text-right">
              <span class="font-label-sm text-[9px] text-outline uppercase tracking-widest">Moteur Audio</span>
              <span class="font-label-md text-[11px] text-primary font-bold">{mixerStore.anyAnalyzing ? 'ANALYSE MIR EN COURS' : '48 KHZ • PRÊT'}</span>
            </div>
            <div class="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981] animate-pulse"></div>
          </div>
          <div class="flex items-center gap-space-sm bg-surface-container-lowest px-space-md py-space-xs rounded shadow-[inset_1px_1px_4px_rgba(0,0,0,0.9)]">
            <div class="flex flex-col text-right">
              <span class="font-label-sm text-[9px] text-outline uppercase tracking-widest">Master Clock Sync</span>
              <span class="font-label-md text-[11px] text-primary font-bold">
                {mixerStore.anyAnalyzing
                  ? 'SYNC EN COURS…'
                  : (mixerStore.deckA.filePath && mixerStore.deckB.filePath)
                    ? (mixerStore.isBpmLocked
                        ? 'TEMPOS ALIGNÉS ✓'
                        : `Δ BPM : ${mixerStore.bpmDelta.toFixed(2)}`)
                    : (mixerStore.deckA.filePath || mixerStore.deckB.filePath)
                      ? (mixerStore.deckA.filePath
                          ? `MAÎTRE : DECK A (${mixerStore.effectiveBpmA.toFixed(1)} BPM)`
                          : `MAÎTRE : DECK B (${mixerStore.effectiveBpmB.toFixed(1)} BPM)`)
                      : 'EN ATTENTE DE PISTE'}
              </span>
            </div>
            <!-- ALC-255 WP19 : LED MASTER CLOCK avec sémantique —
                 émeraude (verrouillé/sync) · laiton (maître présent) · neutre (en attente) -->
            <div
              class="w-2.5 h-2.5 rounded-full
                {mixerStore.anyAnalyzing ? 'bg-[#edbf7a] shadow-[0_0_8px_#edbf7a] animate-pulse'
                  : (mixerStore.deckA.filePath && mixerStore.deckB.filePath)
                    ? (mixerStore.isBpmLocked
                        ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]'
                        : 'bg-[#edbf7a]/80 shadow-[0_0_8px_#edbf7a]')
                    : (mixerStore.deckA.filePath || mixerStore.deckB.filePath)
                      ? 'bg-[#edbf7a] shadow-[0_0_8px_#edbf7a]'
                      : 'bg-[#4f4539] shadow-none'}"
            ></div>
          </div>
          <!-- ALC-139-3 : Bureau POWER OFF (style horloger Venezia) -->
          <VzTip text="Couper l'alimentation et vider le cache">
            <button onclick={confirmShutdown} aria-label="Couper l'alimentation et vider le cache"
              class="group flex flex-col items-center gap-1 px-space-md py-space-xs rounded bg-surface-container-lowest border border-primary/40 shadow-[inset_1px_1px_4px_rgba(0,0,0,0.9)] transition-colors hover:border-[#ff9c6e]/70">
              <span class="material-symbols-outlined text-[16px] text-primary group-hover:text-[#ff9c6e] group-hover:drop-shadow-[0_0_6px_#ff9c6e]">power_settings_new</span>
              <span class="font-label-sm text-[8px] uppercase tracking-widest text-outline group-hover:text-[#ff9c6e]">Power Off</span>
            </button>
          </VzTip>
        </div>
      </div>

      <!-- ALC-210-1 : grille 3 colonnes pleine hauteur (items-stretch + h-full min-h-0) -->
      <div class="grid grid-cols-12 gap-4 items-stretch h-full min-h-0 w-full max-w-[1720px] mx-auto">
        <div class="col-span-3 h-full min-h-0">
          <DeckA bind:deck={mixerStore.deckA} />
        </div>
        <div class="col-span-6 h-full min-h-0">
          <MixerCenter />
        </div>
        <div class="col-span-3 h-full min-h-0">
          <DeckB bind:deck={mixerStore.deckB} />
        </div>
      </div>

      </div>
  </div>

  <!-- ALC-139-3 : Modale de confirmation POWER OFF -->
  {#if showPower}
    <div class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" role="presentation" onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); showPower = false; } }}>
      <div class="bg-surface-container-high rounded-xl p-space-md shadow-[0_8px_32px_rgba(0,0,0,0.9)] border border-surface-container-high max-w-sm w-full text-center" role="dialog" aria-modal="true" aria-label="Confirmation d'arrêt" tabindex={-1}>
        <span class="material-symbols-outlined text-[28px] text-[#ff9c6e]">power_settings_new</span>
        <h3 class="font-display text-[15px] font-bold text-on-surface mt-2">Couper l'alimentation et vider le cache&nbsp;?</h3>
        <p class="text-[12px] text-on-surface-variant mt-1">La lecture s'arrêtera et les caches seront purgés avant la fermeture.</p>
        <div class="flex items-center justify-center gap-space-sm mt-space-md">
          <button onclick={() => (showPower = false)} class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-[12px] font-bold uppercase tracking-wide">Annuler</button>
          <button onclick={shutdownAndPurgeCache} class="px-4 py-2 rounded-lg bg-[#ff9c6e]/20 border border-[#ff9c6e]/50 text-[#ff9c6e] text-[12px] font-bold uppercase tracking-wide hover:bg-[#ff9c6e]/30">Éteindre</button>
        </div>
      </div>
    </div>
  {/if}
</main>
