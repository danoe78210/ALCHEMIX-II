<script lang="ts">
  import { mixerStore } from '$lib/stores/mixer.svelte';
  import { CENTER_MODULES, type CenterModuleId } from '$lib/utils/viewNav';
  import { fly } from 'svelte/transition'; // ALC-210-2 : titre du guichet qui glisse en synchro avec la colonne
  import { cubicOut } from 'svelte/easing';

  // ALC-194-1 : module actif (repli CAMELOT si vue guide).
  const idx = $derived(Math.max(0, CENTER_MODULES.findIndex((m) => m.id === mixerStore.centerView)));
  const activeModule = $derived(CENTER_MODULES[idx]);
  const prevModule = $derived(CENTER_MODULES[(idx - 1 + CENTER_MODULES.length) % CENTER_MODULES.length]);
  const nextModule = $derived(CENTER_MODULES[(idx + 1) % CENTER_MODULES.length]);

  // ALC-206-1 : témoin émeraude/or sur le rivet 04 • STEMS IA.
  const stemsOn = $derived(
    (mixerStore.deckA.filePath && mixerStore.deckA.stemsStatus === 'ready') ||
      (mixerStore.deckB.filePath && mixerStore.deckB.stemsStatus === 'ready')
  );
  const stemsBusy = $derived(
    mixerStore.deckA.stemsStatus === 'separating' || mixerStore.deckB.stemsStatus === 'separating'
  );

  // ALC-194-2 : navigation de base + molettes directionnelles qui glissent au clic.
  function goPrev() { mixerStore.prevCenterModule(); }
  function goNext() { mixerStore.nextCenterModule(); }
  let glideL = $state(false);
  let glideR = $state(false);
  function knobPrev() { glideL = true; setTimeout(() => (glideL = false), 420); goPrev(); }
  function knobNext() { glideR = true; setTimeout(() => (glideR = false), 420); goNext(); }

  // ALC-206-1 : molette de souris (anti-rebond ~180 ms) sur le tambour.
  let lastWheel = $state(0);
  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheel < 180) return;
    lastWheel = now;
    if (e.deltaY > 0 || e.deltaX > 0) goNext();
    else goPrev();
  }

  // ALC-194-2 : glisser-déposer horizontal (drag) sur le tambour.
  let dragging = $state(false);
  let dragDelta = $state(0);
  let dragStartX = 0;
  function onDragStart(e: PointerEvent) {
    const t = e.target as HTMLElement | null;
    if (t && t.closest('button')) return; // laisse le clic sur les crans latéraux / molettes
    dragging = true;
    dragStartX = e.clientX;
    dragDelta = 0;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onDragMove(e: PointerEvent) {
    if (!dragging) return;
    dragDelta = e.clientX - dragStartX;
  }
  function onDragEnd() {
    if (!dragging) return;
    dragging = false;
    if (Math.abs(dragDelta) >= 24) {
      if (dragDelta < 0) goNext(); // tirer vers la gauche → module suivant
      else goPrev();
    }
    dragDelta = 0;
  }

  // ALC-206-1 : raccourcis F1..F6 (ignorés en saisie texte — Librairie).
  const MODULE_BY_KEY: Record<string, CenterModuleId> = {
    F1: 'camelot', F2: 'beatgrid', F3: 'library', F4: 'stems', F5: 'fx_rack', F6: 'live_mix',
  };
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const target = MODULE_BY_KEY[e.key];
      if (target) { e.preventDefault(); mixerStore.setCenterModule(target); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const GLIDE = 'transform 420ms cubic-bezier(0.22,1,0.36,1)';
</script>

<div class="flex flex-col gap-1 select-none">
  <!-- Boîtier laiton brossé encastré -->
  <div class="flex items-center gap-1 rounded-xl bg-[#120d0a] border border-[#4f4539] p-1 shadow-[inset_0_2px_8px_rgba(0,0,0,0.9)]">
    <!-- ALC-210-2 : Médaillon de Boussole Horlogère gauche (index baroque pointant à gauche, rotation légère à l'impulsion) -->
    <button type="button" onclick={knobPrev} title="Module précédent" aria-label="Module précédent"
      class="shrink-0 w-11 h-11 rounded-lg border border-[#7c6649] bg-gradient-to-b from-[#33271e] via-[#1f1813] to-[#120d0a] text-[#edbf7a] flex items-center justify-center shadow-[inset_0_1px_0_rgba(255,221,176,0.25),0_4px_10px_rgba(0,0,0,0.8)] hover:brightness-125 active:scale-95 relative overflow-hidden cursor-pointer"
      style="transition:{GLIDE};transform:translateX({glideL ? -3 : 0}px) scale(1)">
      <span class="pointer-events-none absolute inset-[2px] rounded-lg border border-[#2e261a]/70 shadow-[inset_0_2px_6px_rgba(0,0,0,0.8)]"></span>
      <!-- index de boussole vénitienne massif : pointe diamantée or + empennage ciselé + anneau central -->
      <svg width="22" height="22" viewBox="0 0 24 24" class="relative drop-shadow-[0_0_4px_rgba(237,191,122,0.5)]"
        style="transition:transform 360ms cubic-bezier(0.22,1,0.36,1);transform:rotate({-90 - (glideL ? 20 : 0)}deg)">
        <g fill="#edbf7a">
          <path d="M12 2 L14.6 9 L12 7.4 L9.4 9 Z"/>
          <path d="M9.6 15 L12 22 L14.4 15 L12 13.4 Z"/>
        </g>
        <circle cx="12" cy="12" r="2.4" fill="#120d0a" stroke="#edbf7a" stroke-width="1.1"/>
        <circle cx="12" cy="12" r="0.9" fill="#ffddb0"/>
      </svg>
    </button>

<!-- Tambour cylindrique (pleine largeur) : couches réalistes + zones précédent / actif / suivant -->
    <div role="group" aria-label="Sélecteur de module : tirer le tambour ou molette pour changer de cran"
      class="flex-1 min-w-0 relative overflow-hidden rounded-lg border border-[#4f4539]/60 shadow-[inset_0_4px_14px_rgba(0,0,0,0.95)] h-[62px] touch-none cursor-grab active:cursor-grabbing"
      onwheel={handleWheel}
      onpointerdown={onDragStart} onpointermove={onDragMove} onpointerup={onDragEnd} onpointerleave={onDragEnd}
      title="Tirer le tambour ou molette : changer de module. Raccourcis F1..F6.">

      <!-- Corps du cylindre (courbure laiton / ébène) -->
      <div class="absolute inset-0 pointer-events-none" style="background:linear-gradient(180deg,#241c12 0%,#4a3c28 10%,#2b2218 24%,#17120f 46%,#3a3022 64%,#120d0a 84%,#241c12 100%);"></div>
      <!-- Ombre profonde haut -->
      <div class="absolute inset-x-0 top-0 h-[20%] pointer-events-none" style="background:linear-gradient(180deg,rgba(0,0,0,0.7),rgba(0,0,0,0));"></div>
      <!-- Ombre courbe bas -->
      <div class="absolute inset-x-0 bottom-0 h-[26%] pointer-events-none" style="background:linear-gradient(0deg,rgba(0,0,0,0.8),rgba(0,0,0,0));"></div>
      <!-- Bande lumineuse métallique horizontale centrale -->
      <div class="absolute inset-x-0 top-1/2 h-[26%] -translate-y-1/2 pointer-events-none" style="background:linear-gradient(180deg,rgba(0,0,0,0),rgba(237,191,122,0.14) 42%,rgba(255,240,205,0.30) 52%,rgba(237,191,122,0.12) 62%,rgba(0,0,0,0));"></div>
      <!-- ALC-207-2 : reflet courbe de verre saphir + vignette latérale profonde + graduation gravée -->
      <div class="absolute inset-x-1 top-0 h-3/5 pointer-events-none z-[1] rounded-t-lg" style="background:linear-gradient(180deg,rgba(205,228,255,0.10) 0%,rgba(255,255,255,0.03) 38%,rgba(0,0,0,0) 72%);"></div>
      <div class="absolute inset-y-0 left-0 w-[11%] pointer-events-none z-[1] bg-gradient-to-r from-[#090604] via-transparent to-[#090604]"></div>
      <div class="absolute inset-y-0 right-0 w-[11%] pointer-events-none z-[1] bg-gradient-to-l from-[#090604] via-transparent to-[#090604]"></div>
      <!-- ALC-209-2 : échelle vernier horlogère gravée (haut + bas) qui défile légèrement au changement de cran -->
      <div class="absolute inset-x-1 top-0.5 h-1.5 pointer-events-none z-[1] transition-transform duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]" style="transform:translateX({-mixerStore.moduleStepDelta * 5}px);background:repeating-linear-gradient(90deg,rgba(209,208,190,0.28) 0 1px,transparent 1px 4px);"></div>
      <div class="absolute inset-x-1 bottom-0.5 h-1.5 pointer-events-none z-[1] transition-transform duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]" style="transform:translateX({mixerStore.moduleStepDelta * 5}px);background:repeating-linear-gradient(90deg,rgba(209,208,190,0.22) 0 1px,transparent 1px 4px);"></div>
      <!-- Stries verticales de moletage (bords) -->
      <div class="absolute inset-y-0 left-0 w-3 pointer-events-none opacity-90" style="background:repeating-linear-gradient(90deg,rgba(0,0,0,0.45) 0 1px,transparent 1px 3px),linear-gradient(90deg,rgba(0,0,0,0.55),rgba(0,0,0,0));"></div>
      <div class="absolute inset-y-0 right-0 w-3 pointer-events-none opacity-90" style="background:repeating-linear-gradient(90deg,rgba(255,255,255,0.16) 0 1px,transparent 1px 3px),linear-gradient(-90deg,rgba(0,0,0,0.55),rgba(0,0,0,0));"></div>

      <!-- ALC-209-2 : 4 micro-rivets en laiton aux coins du boîtier du tambour -->
      <span class="pointer-events-none absolute top-[2px] left-[2px] w-[6px] h-[6px] rounded-full bg-[#b9935a] border border-[#6b5a3c] shadow-[0_1px_2px_rgba(0,0,0,0.9)] z-[3]"></span>
      <span class="pointer-events-none absolute top-[2px] right-[2px] w-[6px] h-[6px] rounded-full bg-[#b9935a] border border-[#6b5a3c] shadow-[0_1px_2px_rgba(0,0,0,0.9)] z-[3]"></span>
      <span class="pointer-events-none absolute bottom-[2px] left-[2px] w-[6px] h-[6px] rounded-full bg-[#b9935a] border border-[#6b5a3c] shadow-[0_1px_2px_rgba(0,0,0,0.9)] z-[3]"></span>
      <span class="pointer-events-none absolute bottom-[2px] right-[2px] w-[6px] h-[6px] rounded-full bg-[#b9935a] border border-[#6b5a3c] shadow-[0_1px_2px_rgba(0,0,0,0.9)] z-[3]"></span>

      <!-- 3 zones internes en perspective 3D (26 % / 48 % / 26 %) -->
      <div class="absolute inset-0 flex items-center" style="perspective:700px;">
        <!-- Cran précédent (gauche, 26 %, une seule ligne) -->
        <button type="button" onclick={goPrev} title="Module précédent"
          class="group w-[26%] min-w-0 h-full flex items-center justify-center px-1 cursor-pointer transition-colors duration-[420ms]"
          style="transform:rotateY(28deg);transform-origin:right center;">
          <span class="font-mono text-[11px] font-bold tracking-[0.12em] opacity-70 group-hover:opacity-100 group-hover:[text-shadow:0_0_6px_rgba(237,191,122,0.6)]" style="whitespace-nowrap">
            <span class="text-[#a3824f]">{prevModule.index}</span> • <span class="text-[#c9a468]">{prevModule.shortLabel}</span>
          </span>
        </button>

        <!-- Guichet central actif (48 %, 1 seule ligne, double lunette laiton poli + verre saphir) -->
        <div class="relative z-[2] w-[48%] min-w-[240px] flex items-center justify-center px-3 h-[46px] rounded-lg bg-[#16100c] shadow-[0_8px_18px_rgba(0,0,0,0.85)]">
          <!-- Double filet or (#edbf7a) + lunette interne -->
          <div class="absolute inset-0 pointer-events-none rounded-lg border-2 border-[#edbf7a]"></div>
          <div class="absolute inset-[3px] pointer-events-none rounded-md border border-[#6b5a3c] shadow-[inset_0_2px_10px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,221,176,0.14)]"></div>
          <!-- Verre saphir : reflet diagonal + ombre portée interne -->
          <div class="absolute inset-0 pointer-events-none rounded-lg" style="background:linear-gradient(135deg,rgba(255,255,255,0.16) 0%,rgba(255,255,255,0.04) 30%,rgba(0,0,0,0.18) 58%,rgba(255,255,255,0.05) 84%);"></div>
          <!-- Deux rivets d'angle + deux micro-vis -->
          <span class="absolute left-1.5 top-1.5 w-[5px] h-[5px] rounded-full bg-[#edbf7a] shadow-[0_0_4px_#edbf7a]"></span>
          <span class="absolute right-1.5 top-1.5 w-[5px] h-[5px] rounded-full bg-[#edbf7a] shadow-[0_0_4px_#edbf7a]"></span>
          <span class="absolute left-1.5 bottom-1.5 w-[5px] h-[5px] rounded-full bg-[#8c7853]"></span>
          <span class="absolute right-1.5 bottom-1.5 w-[5px] h-[5px] rounded-full bg-[#8c7853]"></span>
          <!-- Micro-LED respirante -->
          <span class="absolute -top-1 right-2 w-1 h-1 rounded-full bg-[#edbf7a] shadow-[0_0_7px_#edbf7a] animate-pulse"></span>
          <!-- Libellé actif (1 ligne, #ffddb0, drop-shadow doré) -->
          <span class="relative font-mono text-[13px] font-bold tracking-[0.14em] text-[#ffddb0] flex items-center gap-1.5 tabular-nums" style="whitespace-nowrap;text-shadow:0 0 10px rgba(237,191,122,0.45);">
            <span class="w-1.5 h-1.5 rounded-full bg-[#edbf7a] shadow-[0_0_6px_#edbf7a]"></span>
            {#key mixerStore.centerView}
              <span class="inline-block" style="will-change:transform"
                in:fly={{ x: mixerStore.moduleStepDelta >= 0 ? 26 : -26, duration: 360, opacity: 0.15, easing: cubicOut }}
                out:fly={{ x: mixerStore.moduleStepDelta >= 0 ? -26 : 26, duration: 360, opacity: 0.15, easing: cubicOut }}>
                {activeModule.index} • {activeModule.shortLabel}
              </span>
            {/key}
          </span>
        </div>

        <!-- Cran suivant (droite, 26 %, une seule ligne) -->
        <button type="button" onclick={goNext} title="Module suivant"
          class="group w-[26%] min-w-0 h-full flex items-center justify-center px-1 cursor-pointer transition-colors duration-[420ms]"
          style="transform:rotateY(-28deg);transform-origin:left center;">
          <span class="font-mono text-[11px] font-bold tracking-[0.12em] opacity-70 group-hover:opacity-100 group-hover:[text-shadow:0_0_6px_rgba(237,191,122,0.6)]" style="whitespace-nowrap">
            <span class="text-[#a3824f]">{nextModule.index}</span> • <span class="text-[#c9a468]">{nextModule.shortLabel}</span>
          </span>
        </button>
      </div>
    </div>

<!-- ALC-210-2 : Médaillon de Boussole Horlogère droit (index baroque pointant à droite, rotation légère à l'impulsion) -->
    <button type="button" onclick={knobNext} title="Module suivant" aria-label="Module suivant"
      class="shrink-0 w-11 h-11 rounded-lg border border-[#7c6649] bg-gradient-to-b from-[#33271e] via-[#1f1813] to-[#120d0a] text-[#edbf7a] flex items-center justify-center shadow-[inset_0_1px_0_rgba(255,221,176,0.25),0_4px_10px_rgba(0,0,0,0.8)] hover:brightness-125 active:scale-95 relative overflow-hidden cursor-pointer"
      style="transition:{GLIDE};transform:translateX({glideR ? 3 : 0}px) scale(1)">
      <span class="pointer-events-none absolute inset-[2px] rounded-lg border border-[#2e261a]/70 shadow-[inset_0_2px_6px_rgba(0,0,0,0.8)]"></span>
      <!-- index de boussole vénitienne massif : pointe diamantée or + empennage ciselé + anneau central -->
      <svg width="22" height="22" viewBox="0 0 24 24" class="relative drop-shadow-[0_0_4px_rgba(237,191,122,0.5)]"
        style="transition:transform 360ms cubic-bezier(0.22,1,0.36,1);transform:rotate({90 + (glideR ? 20 : 0)}deg)">
        <g fill="#edbf7a">
          <path d="M12 2 L14.6 9 L12 7.4 L9.4 9 Z"/>
          <path d="M9.6 15 L12 22 L14.4 15 L12 13.4 Z"/>
        </g>
        <circle cx="12" cy="12" r="2.4" fill="#120d0a" stroke="#edbf7a" stroke-width="1.1"/>
        <circle cx="12" cy="12" r="0.9" fill="#ffddb0"/>
      </svg>
    </button>
  </div>

<!-- 6 rivets lumineux inférieurs (accès direct 01..06) -->
  <div class="flex items-center justify-center gap-3 py-0.5">
    {#each CENTER_MODULES as m (m.id)}
      {@const active = m.id === activeModule.id}
      {@const isStems = m.id === 'stems'}
      <button type="button" onclick={() => mixerStore.setCenterModule(m.id)}
        title={`${m.index} • ${m.label}`} aria-label={`${m.label} (${m.index})`}
        class="relative w-4 h-4 rounded-full flex items-center justify-center transition-all duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] {active ? 'ring-2 ring-[#edbf7a] shadow-[0_0_10px_#edbf7a] scale-125' : 'ring-1 ring-[#8c6d3f] opacity-80 hover:opacity-100'}">
        <!-- serti or -->
        <span class="absolute inset-[2px] rounded-full bg-gradient-to-b from-[#3a2f24] to-[#18120e]"></span>
        <!-- ALC-261-4 : pastille neutre bronze au lieu de la pierre rubis rouge -->
        <span class="absolute inset-[4px] rounded-full bg-[#4f4539] shadow-[inset_0_1px_1px_rgba(0,0,0,0.5)]"></span>
        {#if isStems && (stemsOn || stemsBusy)}
          <!-- ALC-261-4 : 4e point vert remplacé par un témoin or vénitien -->
          <span class="absolute inset-0 rounded-full bg-[#edbf7a] shadow-[0_0_8px_#edbf7a] {stemsBusy ? 'animate-pulse' : ''}"></span>
        {/if}
      </button>
    {/each}
  </div>
</div>