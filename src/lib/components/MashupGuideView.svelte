<script lang="ts">
  // ALC-191-3 : « Codex de l'Alchimiste » — guide mashup pas à pas (6 étapes) dans la colonne centrale.
  import { mixerStore } from '$lib/stores/mixer.svelte';

  type GuideTab = 'camelot' | 'beatgrid' | 'library' | 'stems';
  const STEPS: { n: string; tab: GuideTab; sub: string; color: string; title: string; body: string; tip: string; act: string }[] = [
    { n: '01', tab: 'library', sub: 'Platine A • Émeraude', color: '#10b981',
      title: 'Charger la piste de base', body: 'Glissez-déposez une piste ou passez par le bouton LOAD / l’onglet LIBRAIRIE. Le BPM et la clé Camelot sont détectés automatiquement : ce premier morceau devient le socle instrumental du mashup.',
      tip: 'Choisissez une base à tempo stable et à phase régulière (kick/basse) — un break propre facilite le calage.', act: 'Ouvrir la Librairie →' },
    { n: '02', tab: 'camelot', sub: 'Librairie & Roue de Camelot', color: '#edbf7a',
      title: 'Trouver le partenaire harmonique', body: 'Activez le filtre COMPATIBLE A, pré-écoutez au casque (▶), envoyez le candidat sur Platine B (→ B), puis vérifiez l’intervalle (Même clé, ±1 Quinte, Relatif) sur la Roue de Camelot.',
      tip: 'Sauter d’au plus quelques cases conserve l’harmonie. Restez sur des phrases de 8 à 32 mesures.', act: 'Voir la Roue de Camelot →' },
    { n: '03', tab: 'stems', sub: 'Console STEMS IA', color: '#3b82f6',
      title: 'Extraire les 4 Stems par IA locale', body: 'Lancez ⚡ EXTRAIRE STEMS sur les deux platines pour isoler Voix, Batterie, Basse et Instruments. Extraction 100 % locale (ONNX) avec cache disque : un second chargement est instantané.',
      tip: 'Les stems restent sur votre machine — aucun cloud, aucune fuite.', act: 'Ouvrir Stems IA →' },
    { n: '04', tab: 'stems', sub: 'Acapella + Instrumental', color: '#10b981',
      title: 'Composer la recette Mashup', body: 'Utilisez le Pont Mashup (INST A + VOIX B ou VOIX A + INST B) ou dosez les faders verticaux des 4 tranches pour équilibrer vos couches.',
      tip: 'Règle d’or : ne superposez jamais deux voix principales ni deux basses.', act: 'Configurer les Stems →' },
    { n: '05', tab: 'beatgrid', sub: 'Atelier BEATGRID', color: '#edbf7a',
      title: 'Caler le tempo et le phrasé', body: 'Visualisez les ondes filtrées sur les seuls stems choisis, cliquez sur ALIGNER TEMPO & PHASE, affinez avec CALER TEMPS 1 ou les Hot Cues (1-INTRO, 2-DROP, 3-ACAP) et testez avec ▶ LANCER A + B.',
      tip: 'Raisonnez en phrases 8/16/32 mesures : calez le DROP au pixel près sur la grille rythmique.', act: 'Passer au Beatgrid →' },
    { n: '06', tab: 'library', sub: 'Duo & AUTO-MIX', color: '#10b981',
      title: 'Exécuter la transition & sauvegarder', body: 'Positionnez le Crossfader Master à 50/50 (Équilibre Mashup) ou lancez AUTO-MIX (qui respecte strictement les stems sélectionnés), puis cliquez sur ★ VALIDER DUO dans la Librairie.',
      tip: 'En montage acapella/instrumental, AUTO-MASHUP fusionne les stems complémentaires en continu.', act: 'Sauvegarder dans la Librairie →' },
  ];

  function jump(n: string) {
    document.getElementById(`guide-step-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
</script>

<div class="flex flex-col gap-space-xs flex-1 min-h-0 overflow-hidden">
  <!-- En-tête du Codex -->
  <div class="flex items-center justify-between gap-2 px-space-sm py-2 rounded-lg bg-[#17120f] border border-[#4f4539]">
    <div class="flex items-center gap-2 min-w-0">
      <span class="material-symbols-outlined text-[16px] text-[#edbf7a] shrink-0">auto_stories</span>
      <span class="font-title-md text-[12px] uppercase tracking-wider text-[#edbf7a] font-bold truncate">Manuel de l'Alchimiste • Créer un mashup en 6 étapes</span>
    </div>
    <button type="button" onclick={() => mixerStore.toggleMashupGuide()}
      class="shrink-0 px-2 py-1 rounded border border-[#edbf7a]/50 bg-gradient-to-b from-[#3a2f24] to-[#201a12] text-[#edbf7a] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:brightness-125 flex items-center gap-1">
      <span class="material-symbols-outlined text-[11px]">close</span><span>Retour à la console</span></button>
  </div>

  <!-- Frise de navigation rapide 01..06 -->
  <div class="flex items-center gap-1.5 px-space-sm">
    {#each STEPS as s (s.n)}
      <button type="button" onclick={() => jump(s.n)}
        class="flex-1 py-1 rounded border border-[#4f4539]/60 bg-[#120d0a] hover:bg-[#17120f] text-[#e0a860] font-mono text-[9px] font-bold tracking-wider transition-colors" title={`Aller à l'étape ${s.n}`}>{s.n}</button>
    {/each}
  </div>

  <!-- Cartes d'étapes (défilement interne, aucun scroll global) -->
  <div class="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-2">
    {#each STEPS as s (s.n)}
      <section id={`guide-step-${s.n}`} class="rounded-xl bg-[#120d0a] border border-[#4f4539]/70 p-3">
        <div class="flex items-start gap-3">
          <span class="shrink-0 font-mono text-[24px] font-bold text-[#edbf7a] leading-none pt-0.5">{s.n}</span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-title-md text-[12px] uppercase tracking-wider text-on-surface font-bold">{s.title}</span>
              <span class="text-[8px] font-label-sm font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border" style="color:{s.color};border-color:{s.color}66;background:{s.color}14;">{s.sub}</span>
            </div>
            <p class="font-body-sm text-[11px] text-on-surface-variant mt-1">{s.body}</p>
            <p class="text-[9px] italic text-[#e0a860] mt-1.5 flex items-start gap-1.5"><span class="material-symbols-outlined text-[11px] shrink-0">local_fire_department</span><span>Astuce DJ — {s.tip}</span></p>
          </div>
        </div>
        <div class="mt-2 flex justify-end">
          <button type="button" onclick={() => mixerStore.openTabFromGuide(s.tab)}
            class="px-2.5 py-1 rounded border border-[#edbf7a]/40 bg-gradient-to-b from-[#3a2f24] to-[#201a12] text-[#edbf7a] font-label-sm text-[8px] font-bold uppercase tracking-wider hover:brightness-125 flex items-center gap-1">
            <span>{s.act}</span><span class="material-symbols-outlined text-[11px]">arrow_forward</span></button>
        </div>
      </section>
    {/each}
  </div>
</div>