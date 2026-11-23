<script lang="ts">
  // ALC-205-3 : vue d'accueil « MIX LIVE » — coquille Venezia 1889 en 2 colonnes asymétriques
  // (55 % Playlist Harmonique Automatique / 45 % Mini-Rack FX & Grille 8 Pads Sampler).
  // Aucun scroll global : flex-1 min-h-0 overflow-hidden.
  const PADS = Array.from({ length: 8 }, (_, i) => i + 1);
</script>

<div class="flex flex-col gap-1 flex-1 min-h-0 overflow-hidden">
  <!-- Surcharge d'attente Étape 1 -->
  <div class="flex items-center gap-2 rounded-lg border border-[#edbf7a]/40 bg-[#edbf7a]/5 px-2 py-1.5">
    <span class="material-symbols-outlined text-[14px] text-[#edbf7a]">graphic_eq</span>
    <span class="font-label-sm text-[9px] uppercase tracking-wider text-[#e0a860]">Mix Live — En préparation · Étape 1</span>
  </div>

  <div class="grid grid-cols-[55%_45%] gap-1 flex-1 min-h-0">
    <!-- 55 % Playlist Harmonique Automatique -->
    <div class="flex flex-col min-h-0 rounded-xl border border-[#4f4539]/40 bg-[#201a17] p-2 shadow-[inset_0_2px_8px_rgba(0,0,0,0.8)]">
      <div class="flex items-center justify-between">
        <span class="font-label-sm text-[9px] font-bold uppercase tracking-widest text-on-surface">Playlist Harmonique Automatique</span>
        <span class="font-mono text-[8px] text-[#4f4539]">55 %</span>
      </div>
      <div class="mt-2 flex-1 min-h-0 rounded-lg border border-dashed border-[#4f4539]/50 bg-[#17120f] flex items-center justify-center">
        <span class="text-[8px] text-outline px-2 text-center leading-relaxed">Enchaînement en clés compatibles · vivra avec RACK FX / MIX LIVE</span>
      </div>
    </div>

    <!-- 45 % Mini-Rack FX & Grille 8 Pads Sampler -->
    <div class="flex flex-col min-h-0 rounded-xl border border-[#4f4539]/40 bg-[#201a17] p-2 shadow-[inset_0_2px_8px_rgba(0,0,0,0.8)]">
      <span class="font-label-sm text-[9px] font-bold uppercase tracking-widest text-on-surface">Mini-Rack FX</span>
      <div class="mt-1 flex-1 min-h-0 rounded-lg border border-dashed border-[#4f4539]/50 bg-[#17120f] flex items-center justify-center">
        <span class="text-[8px] text-outline text-center px-1 leading-relaxed">8 Pads Sampler · déclenchement quantifié</span>
      </div>
      <div class="mt-1 grid grid-cols-4 gap-1">
        {#each PADS as p (p)}
          <button
            type="button"
            disabled
            title={`Pad ${p} — sample à assigner`}
            class="aspect-square rounded-lg border border-[#4f4539]/40 bg-[#17120f] text-[#4f4539] font-mono text-[8px] hover:border-[#edbf7a]/40 disabled:opacity-70"
          >
            P{p}
          </button>
        {/each}
      </div>
    </div>
  </div>
</div>