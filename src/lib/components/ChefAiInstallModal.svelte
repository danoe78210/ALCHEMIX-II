<script lang="ts">
  import { onMount } from 'svelte';
  import { Channel } from '@tauri-apps/api/core';
  import { chefLlmIpc } from '$lib/ipc/client';
  import { chefAiState, openChefAiModal, closeChefAiModal } from '$lib/stores/chefAi.svelte';

  // ALC-270 : modale horlogère Venezia 1889 — choix explicite de l'IA Chef d'Orchestre (~1,9 Go,
  // 100 % hors-ligne). Affichée au premier lancement si `optInState === 'unset'` (ex. exécutable
  // portable .exe) et ré-ouvrable à tout moment via le bouton `GÉNÉRER IA` du Beatgrid.

  let installing = $state(false);
  let progress = $state(0);
  let installed = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const status = await chefLlmIpc.getChefLlmStatus();
      if (status.optInState === 'unset') openChefAiModal();
    } catch {
      // backend indisponible (test/dev) → pas de modale spontanée
    }
  });

  async function installer() {
    installing = true;
    installed = false;
    error = null;
    progress = 0;
    const ch = new Channel<number>();
    ch.onmessage = (p: number) => {
      if (Number.isFinite(p)) progress = Math.max(0, Math.min(100, Math.round(p * 100)));
    };
    try {
      await chefLlmIpc.installChefLlmModel(ch);
      installed = true;
      progress = 100;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      installing = false;
    }
  }

  function continuerSans() {
    void chefLlmIpc.setChefLlmOptIn('declined').catch(() => {});
    closeChefAiModal();
  }
</script>

{#if chefAiState.open}
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    aria-label="Installation de l'IA Chef d'Orchestre"
    tabindex={-1}
    onclick={(e) => { if (e.target === e.currentTarget && !installing) closeChefAiModal(); }}
    onkeydown={(e) => { if (e.key === 'Escape' && !installing) closeChefAiModal(); }}
  >
    <div class="w-[520px] max-w-[92vw] rounded-xl border border-[#544738] bg-[#16110e] p-5 shadow-2xl">
      <div class="flex items-center justify-between gap-3 border-b border-[#544738]/50 pb-3">
        <span class="flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-widest text-[#edbf7a]">
          <span class="material-symbols-outlined text-[18px]" aria-hidden="true">auto_awesome</span>IA Chef d'Orchestre
        </span>
        <button type="button" class="venezia-key h-7 w-7 text-[12px] text-outline" aria-label="Fermer" onclick={closeChefAiModal}><span class="material-symbols-outlined text-[14px]" aria-hidden="true">close</span></button>
      </div>

      <p class="mt-4 font-mono text-[10px] leading-relaxed text-[#ecd9ad]">
        Module optionnel : <span class="font-bold text-[#e0a860]">génération hors-ligne de partitions mashup</span>.
        ~1,9 Go téléchargés une seule fois, <span class="font-bold text-[#e0a860]">100 % local</span>
        (aucun service externe au run). Décoché ici = mode léger, ré-installable à tout moment depuis
        <span class="whitespace-nowrap">GÉNÉRER IA</span> du Beatgrid.
      </p>

      {#if installed}
        <div class="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-emerald-300">
          <span class="flex items-center gap-2"><span class="material-symbols-outlined text-[14px]" aria-hidden="true">task_alt</span>IA installée (~1,9 Go)</span>
        </div>
        <div class="mt-4 flex justify-end">
          <button type="button" class="venezia-key h-8 px-4 text-[10px] font-bold uppercase tracking-widest text-[#e0a860]" onclick={closeChefAiModal}>Fermer</button>
        </div>
      {:else if installing}
        <div class="mt-4">
          <div class="mb-1 flex items-center justify-between gap-2 font-mono text-[9px] font-bold uppercase tracking-widest text-outline">
            <span class="flex items-center gap-2"><span class="material-symbols-outlined text-[14px]" aria-hidden="true">download</span>Téléchargement du modèle</span>
            <span class="tabular-nums text-[#e0a860]">{progress} %</span>
          </div>
          <div class="h-3 w-full overflow-hidden rounded-full border border-[#544738] bg-[#0f0b09]">
            <div class="h-full rounded-full bg-gradient-to-r from-[#c8a05c] to-[#edbf7a] transition-[width] duration-150" style="width:{progress}%;"></div>
          </div>
          <p class="mt-1 font-mono text-[9px] text-outline/70 whitespace-nowrap">qwen2.5-coder-3b-instruct-q4_k_m.gguf</p>
          <div class="mt-4 flex justify-end">
            <button type="button" class="venezia-key h-8 px-4 text-[10px] font-bold uppercase tracking-widest text-[#ffb4ab]" onclick={closeChefAiModal}>Annuler</button>
          </div>
        </div>
      {:else}
        {#if error}
          <div class="mt-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 font-mono text-[9px] font-bold uppercase tracking-widest text-[#ffb4ab]">⚠ {error}</div>
        {/if}
        <div class="mt-5 flex flex-col gap-2">
          <button type="button" class="venezia-key h-10 w-full justify-center px-3 text-[11px] font-bold uppercase tracking-widest text-[#120d0a] bg-gradient-to-b from-[#edbf7a] to-[#9a6f2f]" onclick={() => void installer()}>
            <span class="flex items-center gap-2"><span class="material-symbols-outlined text-[16px]" aria-hidden="true">download</span>Installer l'IA Chef d'Orchestre (~1,9 Go • hors-ligne)</span>
          </button>
          <button type="button" class="venezia-key h-9 w-full justify-center px-3 text-[10px] font-bold uppercase tracking-widest text-outline" onclick={continuerSans}>
            <span class="flex items-center gap-2"><span class="material-symbols-outlined text-[14px]" aria-hidden="true">close</span>Continuer sans l'IA (mode léger)</span>
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}