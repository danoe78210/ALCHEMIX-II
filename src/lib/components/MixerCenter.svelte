<script lang="ts">
  import { mixerStore } from '$lib/stores/mixer.svelte';

  const formattedDelta = $derived(
    mixerStore.bpmDelta > 0
      ? `+${mixerStore.bpmDelta.toFixed(2)} BPM`
      : `${mixerStore.bpmDelta.toFixed(2)} BPM`
  );

  const recommendedPitchForB = $derived(
    Number((((mixerStore.effectiveBpmA / mixerStore.deckB.baseBpm) - 1) * 100).toFixed(1))
  );

  const camelotAngle = (key: string): number => {
    const n = Number.parseInt(key, 10);
    if (!Number.isFinite(n) || n < 1 || n > 12) return 120;
    return (n % 12) * 30; // 0° = haut, sens horaire (12B -> 0, 1B -> 30, … 8B -> 240)
  };

  // Angles des aiguilles Camelot (points vers les tonalités actives)
  const angleA = $derived(camelotAngle(mixerStore.deckA.camelotKey));
  const angleB = $derived(camelotAngle(mixerStore.deckB.camelotKey));

  const ptOnCircle = (deg: number, r: number) => {
    const rad = (deg * Math.PI) / 180;
    return { x: 250 + r * Math.sin(rad), y: 250 - r * Math.cos(rad) };
  };

  // Chemin de l'arc lumineux extérieur (rayon 246) empruntant le chemin le plus court (≤180°).
  const harmonyArcPath = $derived((() => {
    const r = 246;
    const diff = ((angleB - angleA + 540) % 360) - 180; // normalisé en [-180, 180)
    const a = ptOnCircle(angleA, r);
    const b = ptOnCircle(angleB, r);
    const sweep = diff >= 0 ? 1 : 0;
    return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} A ${r} ${r} 0 0 ${sweep} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  })());

  // Chemin de la particule animée (approximé par une quadratique le long de l'arc court)
  const harmonyMotionPath = $derived((() => {
    const r = 246;
    const diff = ((angleB - angleA + 540) % 360) - 180;
    const a = ptOnCircle(angleA, r);
    const b = ptOnCircle(angleB, r);
    const mid = ptOnCircle(angleA + diff / 2, r);
    return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${mid.x.toFixed(1)} ${mid.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  })());
</script>

<div class="flex flex-col gap-space-md bg-surface-container-low p-space-md rounded-xl shadow-[0_12px_32px_rgba(0,0,0,0.9)] relative overflow-hidden">
  <!-- Center Console Mechanical Toggle Switch Bar -->
  <div class="flex items-center justify-between gap-space-xs pb-space-xs">
    <div class="flex items-center gap-space-xs w-full">
      <button
        type="button"
        onclick={() => (mixerStore.centerView = 'camelot')}
        class="flex-1 py-space-xs px-space-sm rounded font-label-sm text-[9px] font-bold uppercase tracking-wider text-center flex items-center justify-center gap-1 transition-colors {mixerStore.centerView === 'camelot'
          ? 'bg-primary-container text-on-primary-container shadow-[inset_0_1px_3px_rgba(255,221,176,0.3)]'
          : 'bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant shadow-sm'}"
      >
        <span class="material-symbols-outlined text-[14px]">rotate_right</span>
        <span>ROUE DE CAMELOT</span>
      </button>
      <button
        type="button"
        onclick={() => (mixerStore.centerView = 'beatgrid')}
        class="flex-1 py-space-xs px-space-sm rounded font-label-sm text-[9px] uppercase tracking-wider text-center flex items-center justify-center gap-1 transition-colors {mixerStore.centerView === 'beatgrid'
          ? 'bg-primary-container text-on-primary-container shadow-[inset_0_1px_3px_rgba(255,221,176,0.3)] font-bold'
          : 'bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant shadow-sm'}"
      >
        <span class="material-symbols-outlined text-[14px]">grid_4x4</span>
        <span>BEATGRID</span>
      </button>
    </div>
  </div>

  <!-- Large Brass Push Button: Lancer L'Analyse -->
  <button
    type="button"
    onclick={() => {
      mixerStore.isAnalyzing = true;
      setTimeout(() => (mixerStore.isAnalyzing = false), 700);
    }}
    class="w-full py-space-sm px-space-md rounded-lg bg-gradient-to-r from-primary via-primary-container to-primary text-on-primary font-headline-md text-[20px] tracking-wider uppercase font-bold shadow-[0_4px_16px_rgba(237,191,122,0.3)] hover:brightness-110 active:translate-y-0.5 transition-all flex items-center justify-center gap-space-sm"
  >
    <span class="w-3 h-3 rounded-full bg-on-primary animate-pulse"></span>
    <span>{mixerStore.isAnalyzing ? 'ANALYSE EN COURS…' : "LANCER L'ANALYSE"}</span>
    <span class="material-symbols-outlined text-[20px]">arrow_forward</span>
  </button>

  <div class="relative bg-surface-container-lowest rounded-xl p-space-md shadow-[inset_0_4px_20px_rgba(0,0,0,0.95)] flex flex-col items-center justify-center overflow-hidden min-h-[490px]">
  <!-- Astronomical Venetian Camelot Wheel: Expanded Diameter -->
    <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/10 via-surface-container-lowest/80 to-surface-container-lowest pointer-events-none"></div>
<div class="relative w-full max-w-[460px] aspect-square flex items-center justify-center my-1"><svg class="w-full h-full transform -rotate-90 pointer-events-none" viewBox="0 0 500 500">
<defs>
  <filter id="glow-emerald-strong" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="5" result="blur"></feGaussianBlur>
    <feMerge>
      <feMergeNode in="blur"></feMergeNode>
      <feMergeNode in="blur"></feMergeNode>
      <feMergeNode in="SourceGraphic"></feMergeNode>
    </feMerge>
  </filter>
  <filter id="glow-blue-strong" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="5" result="blur"></feGaussianBlur>
    <feMerge>
      <feMergeNode in="blur"></feMergeNode>
      <feMergeNode in="blur"></feMergeNode>
      <feMergeNode in="SourceGraphic"></feMergeNode>
    </feMerge>
  </filter>
  <filter id="glow-gold" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="4" result="blur"></feGaussianBlur>
    <feMerge>
      <feMergeNode in="blur"></feMergeNode>
      <feMergeNode in="SourceGraphic"></feMergeNode>
    </feMerge>
  </filter>
  <linearGradient id="emerald-compass-grad" x1="0%" y1="100%" x2="0%" y2="0%">
    <stop offset="0%" stop-color="#064e3b"></stop>
    <stop offset="25%" stop-color="#059669"></stop>
    <stop offset="70%" stop-color="#10b981"></stop>
    <stop offset="100%" stop-color="#6ee7b7"></stop>
  </linearGradient>
  <linearGradient id="blue-compass-grad" x1="0%" y1="100%" x2="0%" y2="0%">
    <stop offset="0%" stop-color="#0c4a6e"></stop>
    <stop offset="25%" stop-color="#0284c7"></stop>
    <stop offset="70%" stop-color="#38bdf8"></stop>
    <stop offset="100%" stop-color="#bae6fd"></stop>
  </linearGradient>
</defs>

<!-- Concentric Astrolabe Brass Rings & Track Geometry -->
<circle cx="250" cy="250" fill="none" r="240" stroke="#4f4539" stroke-dasharray="3 5" stroke-width="2.5"></circle>
<circle cx="250" cy="250" fill="none" r="226" stroke="#edbf7a" stroke-opacity="0.35" stroke-width="1.5"></circle>
<circle cx="250" cy="250" fill="none" r="170" stroke="#4f4539" stroke-dasharray="2 4" stroke-opacity="0.6" stroke-width="1.5"></circle>
<circle cx="250" cy="250" fill="none" r="154" stroke="#edbf7a" stroke-opacity="0.25" stroke-width="1"></circle>
<circle cx="250" cy="250" fill="none" r="96" stroke="#edbf7a" stroke-opacity="0.45" stroke-width="1.5"></circle>

<!-- Astrolabe Clock Hour Tick Marks (every 30 deg) -->
<g stroke="#3a3330" stroke-width="1.5">
  <line x1="250" y1="250" x2="250" y2="14"></line>
  <line x1="250" y1="250" x2="368" y2="45"></line>
  <line x1="250" y1="250" x2="455" y2="132"></line>
  <line x1="250" y1="250" x2="486" y2="250"></line>
  <line x1="250" y1="250" x2="455" y2="368"></line>
  <line x1="250" y1="250" x2="368" y2="455"></line>
  <line x1="250" y1="250" x2="250" y2="486"></line>
  <line x1="250" y1="250" x2="132" y2="455"></line>
  <line x1="250" y1="250" x2="45" y2="368"></line>
  <line x1="250" y1="250" x2="14" y2="250"></line>
  <line x1="250" y1="250" x2="45" y2="132"></line>
  <line x1="250" y1="250" x2="132" y2="45"></line>
</g>

<!-- Luminous Golden Connector Chord between 4B (405, 340) and 8B (95, 340) -->
<g id="harmonic-energy-bridge">
  <!-- Arc lumineux extérieur (rayon 246, hors du cercle r=240) reliant 4B -> 8B -->
  <path d={harmonyArcPath} fill="none" stroke="#7b581e" stroke-width="6" stroke-linecap="round" stroke-opacity="0.5" filter="url(#glow-gold)"></path>
  <path d={harmonyArcPath} fill="none" stroke="#edbf7a" stroke-width="3" stroke-linecap="round" class="harmonic-beam-glow"></path>
  <path d={harmonyArcPath} fill="none" stroke="#ffe8c2" stroke-width="1.5" stroke-linecap="round" class="harmonic-flow-line" style="stroke-dasharray: 6 24; animation-duration: 0.9s; filter: drop-shadow(0 0 6px #ffddb0) drop-shadow(0 0 10px #edbf7a);"></path>
  <circle r="4" fill="#ffffff" style="filter: drop-shadow(0 0 8px #ffddb0);"><animatemotion path={harmonyMotionPath} dur="1.8s" repeatcount="indefinite"></animatemotion></circle>
  <circle r="2.5" fill="#edbf7a" style="filter: drop-shadow(0 0 6px #edbf7a);"><animatemotion path={harmonyMotionPath} dur="1.8s" begin="0.9s" repeatcount="indefinite"></animatemotion></circle>
</g>
<path d="M 405 340 A 180 180 0 0 1 95 340" fill="none" stroke="#edbf7a" stroke-dasharray="8 6" stroke-width="2.5" stroke-opacity="0.7"></path>

<!-- Outer Ring Labels: 1B to 12B (Major Keys) -->
<text fill="#9b8f80" font-family="Space Grotesk" font-size="14" font-weight="600" text-anchor="middle" transform="rotate(90 250 36)" x="250" y="36">12B</text>
<text fill="#9b8f80" font-family="Space Grotesk" font-size="14" font-weight="600" text-anchor="middle" transform="rotate(90 354 64)" x="354" y="64">1B</text>
<text fill="#9b8f80" font-family="Space Grotesk" font-size="14" font-weight="600" text-anchor="middle" transform="rotate(90 436 146)" x="436" y="146">2B</text>
<text fill="#9b8f80" font-family="Space Grotesk" font-size="14" font-weight="600" text-anchor="middle" transform="rotate(90 464 250)" x="464" y="250">3B</text>
<text fill="#10b981" font-family="Space Grotesk" font-size="17" font-weight="bold" text-anchor="middle" transform="rotate(90 410 368)" x="410" y="368">4B</text>
<text fill="#9b8f80" font-family="Space Grotesk" font-size="14" font-weight="600" text-anchor="middle" transform="rotate(90 344 440)" x="344" y="440">5B</text>
<text fill="#9b8f80" font-family="Space Grotesk" font-size="14" font-weight="600" text-anchor="middle" transform="rotate(90 250 468)" x="250" y="468">6B</text>
<text fill="#9b8f80" font-family="Space Grotesk" font-size="14" font-weight="600" text-anchor="middle" transform="rotate(90 156 440)" x="156" y="440">7B</text>
<text fill="#38bdf8" font-family="Space Grotesk" font-size="17" font-weight="bold" text-anchor="middle" transform="rotate(90 90 368)" x="90" y="368">8B</text>
<text fill="#9b8f80" font-family="Space Grotesk" font-size="14" font-weight="600" text-anchor="middle" transform="rotate(90 36 250)" x="36" y="250">9B</text>
<text fill="#9b8f80" font-family="Space Grotesk" font-size="14" font-weight="600" text-anchor="middle" transform="rotate(90 64 146)" x="64" y="146">10B</text>
<text fill="#9b8f80" font-family="Space Grotesk" font-size="14" font-weight="600" text-anchor="middle" transform="rotate(90 146 64)" x="146" y="64">11B</text>

<!-- Inner Ring Labels: 1A to 12A (Minor Keys) -->
<text fill="#7a6e60" font-family="JetBrains Mono" font-size="11" text-anchor="middle" transform="rotate(90 250 114)" x="250" y="114">12A</text>
<text fill="#7a6e60" font-family="JetBrains Mono" font-size="11" text-anchor="middle" transform="rotate(90 318 132)" x="318" y="132">1A</text>
<text fill="#7a6e60" font-family="JetBrains Mono" font-size="11" text-anchor="middle" transform="rotate(90 368 182)" x="368" y="182">2A</text>
<text fill="#7a6e60" font-family="JetBrains Mono" font-size="11" text-anchor="middle" transform="rotate(90 386 250)" x="386" y="250">3A</text>
<text fill="#7a6e60" font-family="JetBrains Mono" font-size="11" text-anchor="middle" transform="rotate(90 368 318)" x="368" y="318">4A</text>
<text fill="#7a6e60" font-family="JetBrains Mono" font-size="11" text-anchor="middle" transform="rotate(90 318 368)" x="318" y="368">5A</text>
<text fill="#7a6e60" font-family="JetBrains Mono" font-size="11" text-anchor="middle" transform="rotate(90 250 386)" x="250" y="386">6A</text>
<text fill="#7a6e60" font-family="JetBrains Mono" font-size="11" text-anchor="middle" transform="rotate(90 182 368)" x="182" y="368">7A</text>
<text fill="#7a6e60" font-family="JetBrains Mono" font-size="11" text-anchor="middle" transform="rotate(90 132 318)" x="132" y="318">8A</text>
<text fill="#7a6e60" font-family="JetBrains Mono" font-size="11" text-anchor="middle" transform="rotate(90 114 250)" x="114" y="250">9A</text>
<text fill="#7a6e60" font-family="JetBrains Mono" font-size="11" text-anchor="middle" transform="rotate(90 132 182)" x="132" y="182">10A</text>
<text fill="#7a6e60" font-family="JetBrains Mono" font-size="11" text-anchor="middle" transform="rotate(90 182 132)" x="182" y="132">11A</text>

<!-- 1. AIGUILLE VERTE LUMINEUSE D'HORLOGERIE (Pointant vers 4B à 120deg depuis le centre) -->
<g transform="rotate({angleA} 250 250)">
  <!-- Trait laser / contre-lueur externe -->
  <line x1="250" y1="250" x2="250" y2="50" stroke="#10b981" stroke-width="4" filter="url(#glow-emerald-strong)" stroke-linecap="round"></line>
  <!-- Lame d'aiguille effilée mécanique à double facette -->
  <polygon points="248.5,250 248.5,74 242,54 250,28 258,54 251.5,74 251.5,250" fill="url(#emerald-compass-grad)" stroke="#edbf7a" stroke-width="1"></polygon>
  <!-- Flèche diamant et perle lumineuse de tête -->
  <polygon points="250,30 244,52 250,44 256,52" fill="#ffffff" filter="url(#glow-emerald-strong)"></polygon>
  <line x1="250" y1="245" x2="250" y2="46" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"></line>
  <circle cx="250" cy="56" r="3.5" fill="#10b981" stroke="#ffffff" stroke-width="1.2"></circle>
  <!-- Contrepoids mécanique opposé en laiton -->
  <circle cx="250" cy="285" r="7" fill="#241e1b" stroke="#edbf7a" stroke-width="2"></circle>
  <path d="M 248 285 L 248 250 L 252 250 L 252 285 Z" fill="#edbf7a"></path>
</g>

<!-- 2. AIGUILLE BLEUE LUMINEUSE D'HORLOGERIE (Pointant vers 8B à 240deg depuis le centre) -->
<g transform="rotate({angleB} 250 250)">
  <!-- Trait laser / contre-lueur externe -->
  <line x1="250" y1="250" x2="250" y2="50" stroke="#00A3FF" stroke-width="4" filter="url(#glow-blue-strong)" stroke-linecap="round"></line>
  <!-- Lame d'aiguille effilée mécanique à double facette -->
  <polygon points="248.5,250 248.5,74 242,54 250,28 258,54 251.5,74 251.5,250" fill="url(#blue-compass-grad)" stroke="#edbf7a" stroke-width="1"></polygon>
  <!-- Flèche diamant et perle lumineuse de tête -->
  <polygon points="250,30 244,52 250,44 256,52" fill="#ffffff" filter="url(#glow-blue-strong)"></polygon>
  <line x1="250" y1="245" x2="250" y2="46" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"></line>
  <circle cx="250" cy="56" r="3.5" fill="#38bdf8" stroke="#ffffff" stroke-width="1.2"></circle>
  <!-- Contrepoids mécanique opposé en laiton -->
  <circle cx="250" cy="285" r="7" fill="#241e1b" stroke="#edbf7a" stroke-width="2"></circle>
  <path d="M 248 285 L 248 250 L 252 250 L 252 285 Z" fill="#edbf7a"></path>
</g>

<!-- Active Node: Tape A (4B - Mi Majeur) Glowing Emerald -->
<circle cx="405" cy="340" fill="#10b981" filter="url(#glow-emerald-strong)" r="16"></circle>
<circle cx="405" cy="340" fill="#ffffff" r="6"></circle>

<!-- Active Node: Tape B (8B - Do Majeur) Glowing Electric Blue -->
<circle cx="95" cy="340" fill="#00A3FF" filter="url(#glow-blue-strong)" r="16"></circle>
<circle cx="95" cy="340" fill="#ffffff" r="6"></circle>
</svg>
    </div>


      <!-- Center Clockwork Horological Hub with Mechanical Brass Pivot Ring -->
      <div class="absolute w-36 h-36 rounded-full bg-surface-container-high/95 border-2 border-primary/60 flex flex-col items-center justify-center text-center p-space-sm shadow-[0_6px_24px_rgba(0,0,0,0.95)] z-20 backdrop-blur-sm">
        <div class="absolute -top-3 w-6 h-6 rounded-full bg-gradient-to-tr from-primary to-primary-container border border-surface-container-lowest flex items-center justify-center shadow-[0_2px_6px_rgba(0,0,0,0.8)]">
          <div class="w-2 h-2 rounded-full bg-surface-container-lowest"></div>
        </div>
        <span class="font-label-sm text-[9px] text-outline uppercase font-bold tracking-widest">INTERVALLE</span>
        <span class="font-title-md text-[16px] font-bold text-primary tracking-tight">Δ = +4 QUINTES</span>
        <span class="font-label-sm text-[9px] text-emerald-400 mt-1 uppercase font-bold tabular-nums">
          Δ BPM : {formattedDelta}
        </span>
        <div class="absolute -bottom-2 w-4 h-4 rounded-full bg-primary-container/80 border border-surface-container-lowest flex items-center justify-center shadow-inner">
          <div class="w-1.5 h-1.5 rounded-full bg-primary"></div>
        </div>
      </div>
    </div>

  <!-- Key & Transition Breakdown Cards (Restauré fidèlement) -->
  <div class="grid grid-cols-2 gap-space-sm">
    <div class="bg-surface-container p-space-sm rounded-lg shadow-sm flex flex-col justify-between">
      <span class="font-label-sm text-[9px] text-outline uppercase">Affinité Harmonique</span>
      <span class="font-headline-md text-[24px] text-primary font-bold">94%</span>
      <span class="font-label-sm text-[9px] text-tertiary">Saut de +4 Quintes Harmonique</span>
    </div>
    <div class="bg-surface-container p-space-sm rounded-lg shadow-sm flex flex-col justify-between">
      <span class="font-label-sm text-[9px] text-outline uppercase">Modulation Énergétique</span>
      <span class="font-headline-md text-[24px] text-secondary font-bold">+1.8 LUFS</span>
      <span class="font-label-sm text-[9px] text-on-surface-variant">Ascension de Tension Mesurée</span>
    </div>
  </div>

  <!-- Acoustic Oracle Advice Card (CONSEILS DE MIXAGE • ORACLE ACOUSTIQUE) - Restauré fidèlement -->
  <div class="bg-surface-container-high rounded-xl p-space-md shadow-[0_6px_18px_rgba(0,0,0,0.8)] flex flex-col gap-space-sm">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-space-xs">
        <span class="material-symbols-outlined text-primary text-[18px]">psychology</span>
        <span class="font-label-md text-[11px] text-primary font-bold uppercase tracking-wider">
          CONSEILS DE MIXAGE • ORACLE ACOUSTIQUE
        </span>
      </div>
    </div>

    <div class="flex flex-col gap-space-xs bg-surface-container-lowest p-space-sm rounded-lg">
      <div class="flex items-start gap-space-sm">
        <span class="material-symbols-outlined text-[18px] text-tertiary mt-0.5">tune</span>
        <div class="flex flex-col">
          <span class="font-label-md text-[11px] font-bold text-on-surface">Ajustement de Cadence (BPM)</span>
          <span class="font-body-sm text-[12px] text-on-surface-variant">
            Ajuster Deck B à {mixerStore.effectiveBpmA.toFixed(1)} BPM (Pitch {recommendedPitchForB >= 0 ? `+${recommendedPitchForB}` : recommendedPitchForB}%) pour sceller la synchronicité métrique complète.
          </span>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-space-xs bg-surface-container-lowest p-space-sm rounded-lg">
      <div class="flex items-start gap-space-sm">
        <span class="material-symbols-outlined text-[18px] text-secondary mt-0.5">equalizer</span>
        <div class="flex flex-col">
          <span class="font-label-md text-[11px] font-bold text-on-surface">Filtrage des Fréquences Basses</span>
          <span class="font-body-sm text-[12px] text-on-surface-variant">
            Atténuer le grave de Deck A à la mesure 64 (-4 dB sous 120 Hz) et introduire la ligne de basse de Deck B à 100%.
          </span>
        </div>
      </div>
    </div>

    <!-- Alternative Harmonic Paths Strip -->
    <div class="flex flex-col gap-1 pt-1">
      <span class="font-label-sm text-[9px] text-outline uppercase tracking-wider">
        Itinéraires Harmoniques Alternatifs:
      </span>
      <div class="grid grid-cols-3 gap-1 font-mono text-[10px]">
        <div class="bg-surface-container-low px-2 py-1 rounded text-center text-on-surface-variant">
          <span class="block text-primary font-bold">DIRECTE</span>
          <span>4B → 5B (98%)</span>
        </div>
        <div class="bg-surface-container-low px-2 py-1 rounded text-center text-emerald-300">
          <span class="block text-emerald-400 font-bold">CHOISIE</span>
          <span>4B → 8B (94%)</span>
        </div>
        <div class="bg-surface-container-low px-2 py-1 rounded text-center text-on-surface-variant">
          <span class="block text-secondary font-bold">ASCENSION</span>
          <span>4B → 9B (91%)</span>
        </div>
      </div>
    </div>
  </div>

  </div>
