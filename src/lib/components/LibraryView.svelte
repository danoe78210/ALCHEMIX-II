<script lang="ts">
  // ALC-165 : Vue LIBRAIRIE — catalogue SQLite local + moteur de matching MASHUP.
  // Fidèle au mockup `sources/Library v4.html` (Venezia 1889, grille 84px 1fr 72px 42px 76px 110px),
  // branchée sur le backend Rust (`library.rs`) via `libraryIpc` et sur le matcher `mashupMatcher.ts`.
  import { onMount, onDestroy } from 'svelte';
  import { convertFileSrc } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { open, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
  import { mixerStore } from '$lib/stores/mixer.svelte';
  import {
    libraryIpc,
    type LibraryTrack,
    type LibraryScanProgress,
  } from '$lib/ipc/client';
  import { scoreMatch, isSameTrack, findLocalBridgeTracks, type LocalBridgeResult } from '$lib/utils/mashupMatcher';

  let tracks = $state<LibraryTrack[]>([]);
  let duos = $state<Set<string>>(new Set());
  let query = $state('');
  let filter = $state<'all' | 'compatA' | 'compatB' | 'duos'>('all');
  let sortKey = $state<'affinity' | 'key' | 'tempo'>('affinity');
  let importing = $state(false);
  let importingPct = $state(0);
  let error = $state('');
  let previewing = $state<number | null>(null);
  // ALC-166-2 : mini-spectre de la pré-écoute (position/durée) + volume casque dédié.
  let previewPos = $state(0);
  let previewDur = $state(0);
  let previewVolume = $state(0.5);
  // ALC-166-4 : édition rapide des métadonnées (titre / genre) en double-clic.
  let editing = $state<{ id: number; field: 'title' | 'genre' } | null>(null);
  let editValue = $state('');

  let previewAudio: HTMLAudioElement | null = null;
  let unlistenScan: UnlistenFn | null = null;

  interface Row {
    track: LibraryTrack;
    affA: number | null;
    affB: number | null;
    aff: number | null;
    label: string;
    color: string;
    duo: boolean;
    onA: boolean;
    onB: boolean;
    loaded: boolean;
  }

  const duoKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const isDuo = (a: number, b: number) => duos.has(duoKey(a, b));

  // ALC-168-1 : identité normalisée d'une platine (filePath + titre + artiste) pour isSameTrack().
  const mixToIdentity = (side: 'A' | 'B'): { filePath: string; title: string; artist: string } | null => {
    const d = side === 'A' ? mixerStore.deckA : mixerStore.deckB;
    return d.filePath ? { filePath: d.filePath, title: d.trackTitle || '', artist: d.artist || '' } : null;
  };

  // Références des platines chargées (clé Camelot + BPM effectif) pour la compatibilité.
  const refA = $derived(
    mixerStore.deckA.filePath
      ? { key: mixerStore.deckA.camelotKey, bpm: mixerStore.effectiveBpmA }
      : null
  );
  const refB = $derived(
    mixerStore.deckB.filePath
      ? { key: mixerStore.deckB.camelotKey, bpm: mixerStore.effectiveBpmB }
      : null
  );

  // Platine de référence pour le calcul des lignes — suit le filtre actif (bug #1) :
  // COMPATIBLE B → Platine B ; COMPATIBLE A / TOUS → Platine A (repli si non chargée).
  const reference = $derived.by<{
    side: 'A' | 'B';
    key: string;
    bpm: number;
    filePath: string;
  } | null>(() => {
    const a = mixerStore.deckA;
    const b = mixerStore.deckB;
    const prefer = filter === 'compatB' ? 'B' : 'A';
    if (prefer === 'B' && b.filePath)
      return { side: 'B', key: b.camelotKey, bpm: mixerStore.effectiveBpmB, filePath: b.filePath };
    if (a.filePath) return { side: 'A', key: a.camelotKey, bpm: mixerStore.effectiveBpmA, filePath: a.filePath };
    if (b.filePath) return { side: 'B', key: b.camelotKey, bpm: mixerStore.effectiveBpmB, filePath: b.filePath };
    return null;
  });

  const labelOf = (l: string): string =>
    ({
      'SAME KEY': 'MÊME CLÉ',
      'RELATIVE MAJ': 'RELATIF MAJ',
      'RELATIVE MIN': 'RELATIF MIN',
      '+1 FIFTH': '+1 QUINTE',
      '-1 FIFTH': '-1 QUINTE',
      'ENERGY JUMP': 'SAUT ÉNERGIE',
      'FAR KEY': 'CLÉ LOINTAINE',
    })[l] ?? l;

  const rows = $derived.by<Row[]>(() =>
    tracks.map((track) => {
      // ALC-167-1 : détection des pistes déjà chargées (SUR PLATINE A / B) → pas de score, badge d'état.
      const onA =
        !!mixerStore.deckA.filePath &&
        isSameTrack(track, { filePath: mixerStore.deckA.filePath, title: mixerStore.deckA.trackTitle, artist: mixerStore.deckA.artist });
      const onB =
        !!mixerStore.deckB.filePath &&
        isSameTrack(track, { filePath: mixerStore.deckB.filePath, title: mixerStore.deckB.trackTitle, artist: mixerStore.deckB.artist });
      const loaded = onA || onB;
      let affC: number | null = null;
      let label = '';
      let color = 'text-outline';
      if (reference && !loaded) {
        const s = scoreMatch(
          { camelotKey: reference.key, bpm: reference.bpm },
          { camelotKey: track.camelotKey, bpm: track.bpm }
        );
        affC = s.affinity;
        label = labelOf(s.harmony.label);
        color = s.harmony.label === 'ENERGY JUMP' ? 'text-primary' : affC >= 82 ? 'text-emerald-400' : 'text-outline';
      }
      const duo = track.id >= 0 && tracks.some((o) => o.id >= 0 && o.id !== track.id && isDuo(track.id, o.id));
      return {
        track,
        affA: refA ? scoreMatch({ camelotKey: refA.key, bpm: refA.bpm }, { camelotKey: track.camelotKey, bpm: track.bpm }).affinity : null,
        affB: refB ? scoreMatch({ camelotKey: refB.key, bpm: refB.bpm }, { camelotKey: track.camelotKey, bpm: track.bpm }).affinity : null,
        aff: affC,
        label,
        color,
        duo,
        onA,
        onB,
        loaded,
      };
    })
  );

  const visibleRows = $derived.by<Row[]>(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      // ALC-167-2 : la piste déjà chargée sur la platine de référence est exclue (vrais partenaires uniquement).
      if (filter === 'compatA' && ((r.affA ?? 0) < 70 || r.loaded)) return false;
      if (filter === 'compatB' && ((r.affB ?? 0) < 70 || r.loaded)) return false;
      if (filter === 'duos' && !r.duo) return false;
      if (q && !`${r.track.title} ${r.track.artist} ${r.track.genre}`.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  const sortedRows = $derived.by<Row[]>(() => {
    const arr = [...visibleRows];
    if (sortKey === 'key') {
      arr.sort((a, b) => (a.track.camelotKey || 'zzz').localeCompare(b.track.camelotKey || 'zzz') || b.track.id - a.track.id);
    } else if (sortKey === 'tempo') {
      arr.sort((a, b) => a.track.bpm - b.track.bpm || b.track.id - a.track.id);
    } else {
      arr.sort((a, b) => (b.aff ?? 0) - (a.aff ?? 0) || b.track.id - a.track.id);
    }
    // ALC-167-1 : les pistes déjà chargées (SUR PLATINE A/B) passent en bas de liste,
    // quel que soit le tri, pour mettre en avant les vrais partenaires de mashup.
    const loadedRows = arr.filter((r) => r.loaded);
    if (loadedRows.length > 0) {
      const rest = arr.filter((r) => !r.loaded);
      arr.length = 0;
      arr.push(...rest, ...loadedRows);
    }
    return arr;
  });

  const countCompatA = $derived(rows.filter((r) => (r.affA ?? 0) >= 70 && !r.loaded).length);
  const countCompatB = $derived(rows.filter((r) => (r.affB ?? 0) >= 70 && !r.loaded).length);
  const countDuos = $derived(rows.filter((r) => r.duo).length);

  const anchor = $derived.by<LibraryTrack | null>(() => {
    const aId = mixToIdentity('A');
    const bId = mixToIdentity('B');
    const byA = aId ? tracks.find((t) => isSameTrack(t, aId)) : undefined;
    if (byA) return byA;
    const byB = bId ? tracks.find((t) => isSameTrack(t, bId)) : undefined;
    if (byB) return byB;
    return tracks.length ? tracks[0] : null;
  });

  // Bug #2 : côté de la platine dont provient l'ancre de l'Oracle (destination du candidat).
  const anchorSide = $derived.by<'A' | 'B' | 'none'>(() => {
    const a = anchor;
    if (a && isSameTrack(a, mixToIdentity('A') ?? {})) return 'A';
    if (a && isSameTrack(a, mixToIdentity('B') ?? {})) return 'B';
    return 'none';
  });

  const oracle = $derived.by<{ row: Row; affinity: number } | null>(() => {
    const a = anchor;
    if (!a) return null;
    let best: Row | null = null;
    let bestAff = -1;
    for (const r of rows) {
      // ALC-167-2 : l'Oracle n'associe jamais un morceau avec lui-même ni avec une piste déjà chargée.
      if (r.track.id === a.id || r.loaded) continue;
      const aff = scoreMatch(
        { camelotKey: a.camelotKey, bpm: a.bpm },
        { camelotKey: r.track.camelotKey, bpm: r.track.bpm }
      ).affinity;
      if (aff > bestAff) {
        bestAff = aff;
        best = r;
      }
    }
    return best ? { row: best, affinity: bestAff } : null;
  });
  const oracleDuo = $derived(
    !!anchor && !!oracle && isDuo(anchor.id, oracle.row.track.id)
  );

  // Envoyer le candidat vers LA platine qui n'est PAS celle de la référence (ne pas l'écraser).
  const sendTarget = $derived<'A' | 'B'>(anchorSide === 'B' ? 'A' : 'B');

  // ALC-166-1 : états des platines pour l'action du Duo Oracle à platines vides.
  const deckALoaded = $derived(!!mixerStore.deckA.filePath);
  const deckBLoaded = $derived(!!mixerStore.deckB.filePath);
  const bothEmpty = $derived(!deckALoaded && !deckBLoaded);

  // ALC-170-3 : meilleure piste PONT locale (Harmonic Bridge Finder) quand écart harmonique/rythmique A↔B.
  const localBridgeBest = $derived.by<LocalBridgeResult | null>(() => {
    const dA = mixerStore.deckA;
    const dB = mixerStore.deckB;
    if (!dA.filePath || !dB.filePath || !tracks.length) return null;
    const res = findLocalBridgeTracks(
      { camelotKey: dA.camelotKey, bpm: mixerStore.effectiveBpmA, filePath: dA.filePath, title: dA.trackTitle, artist: dA.artist },
      { camelotKey: dB.camelotKey, bpm: mixerStore.effectiveBpmB, filePath: dB.filePath, title: dB.trackTitle, artist: dB.artist },
      tracks,
      1,
      duos
    );
    return res[0] ?? null;
  });

  async function loadLocalBridgeOnce() {
    const br = localBridgeBest;
    const fp = br?.track.filePath;
    if (!br || !fp) return;
    const target: 'A' | 'B' =
      mixerStore.deckA.filePath && !mixerStore.deckB.filePath
        ? 'B'
        : !mixerStore.deckA.filePath && mixerStore.deckB.filePath
          ? 'A'
          : 'B';
    await mixerStore.loadTrackFromPath(target, fp);
  }

  const fileBase = (p: string | null | undefined): string => {
    if (!p) return '';
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
  };

  const deckSummary = (side: 'A' | 'B'): string => {
    const d = side === 'A' ? mixerStore.deckA : mixerStore.deckB;
    if (!d.filePath) return 'aucune piste chargée';
    const name = (d.trackTitle || fileBase(d.filePath) || 'piste').trim();
    const bpm = side === 'A' ? mixerStore.effectiveBpmA : mixerStore.effectiveBpmB;
    return `${name} (${d.camelotKey} • ${bpm.toFixed(1)})`;
  };

  const deltaPct = (bpm: number): string => {
    const ref = reference;
    if (!ref?.bpm || !Number.isFinite(bpm) || bpm <= 0) return '';
    const d = ((bpm - ref.bpm) / ref.bpm) * 100;
    return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
  };

  // ALC-166-3 : couleur du liseré du badge CLÉ selon la compatibilité avec la platine de référence
  // (vert émeraude pour A, bleu électrique pour B, doré pour relatif majeur/mineur).
  const keyBadgeBorder = (r: Row): string => {
    if (r.label === 'RELATIF MAJ' || r.label === 'RELATIF MIN') return 'border-[#edbf7a]/70';
    if (reference?.side === 'A') return 'border-[#10b981]/70';
    if (reference?.side === 'B') return 'border-[#3b82f6]/70';
    return 'border-outline-variant/40';
  };

  async function loadLibrary() {
    error = '';
    try {
      const [list, duoList] = await Promise.all([libraryIpc.listTracks(), libraryIpc.listDuos()]);
      tracks = list.sort((a, b) => b.id - a.id);
      duos = new Set(duoList.map((d) => duoKey(d.trackAId, d.trackBId)));
    } catch (e) {
      error = e instanceof Error ? e.message : 'Impossible de charger la Librairie';
    }
  }

  function stopPreview() {
    previewAudio?.pause();
    previewAudio = null;
    previewing = null;
    previewPos = 0;
    previewDur = 0;
  }

  function togglePreview(track: LibraryTrack) {
    if (previewing === track.id) {
      stopPreview();
      return;
    }
    stopPreview();
    const audio = new Audio(convertFileSrc(track.filePath));
    audio.volume = previewVolume;
    audio.addEventListener('ended', stopPreview);
    audio.addEventListener('loadedmetadata', () => {
      previewDur = audio.duration || 0;
      previewPos = 0;
    });
    audio.addEventListener('timeupdate', () => {
      previewPos = audio.currentTime || 0;
    });
    audio.play().catch(() => stopPreview());
    previewAudio = audio;
    previewing = track.id;
  }

  // ALC-166-2 : volume casque dédié à la pré-écoute (évite la superposition sonore avec les platines).
  function setPreviewVolume(value: number) {
    previewVolume = Math.max(0, Math.min(1, value));
    if (previewAudio) previewAudio.volume = previewVolume;
  }

  // ALC-166-2 : scrubbing de la pré-écoute via la clic sur la barre dorée.
  function scrubPreview(e: MouseEvent) {
    if (!previewAudio || previewDur <= 0) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    previewAudio.currentTime = ratio * previewDur;
    previewPos = previewAudio.currentTime;
  }

  async function importFolder() {
    const dir = await open({ directory: true, multiple: false, title: 'Importer un dossier musique' });
    if (!dir) return;
    importing = true;
    importingPct = 0;
    error = '';
    try {
      await libraryIpc.importFolder(String(dir));
      await loadLibrary();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Import de dossier interrompu';
    } finally {
      importing = false;
      importingPct = 0;
    }
  }

  async function archiveDeck(side: 'A' | 'B') {
    const d = side === 'A' ? mixerStore.deckA : mixerStore.deckB;
    if (!d.filePath) return;
    error = '';
    try {
      await libraryIpc.upsertTrack({
        filePath: d.filePath,
        title: d.trackTitle || undefined,
        artist: d.artist || undefined,
        genre: d.genre || undefined,
        camelotKey: d.camelotKey || undefined,
        bpm: d.baseBpm,
        durationSec: d.durationSeconds,
      });
      await loadLibrary();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Archivage dans la Librairie interrompu';
    }
  }

  async function loadToDeck(side: 'A' | 'B', track: LibraryTrack) {
    stopPreview();
    await mixerStore.loadTrackFromPath(side, track.filePath);
  }

  // ALC-166-1 : charge simultanément le duo Oracle (titre 1 → A, titre 2 → B) à platines vides.
  function loadDuoOracle() {
    if (!anchor || !oracle) return;
    stopPreview();
    void mixerStore.loadTrackFromPath('A', anchor.filePath);
    void mixerStore.loadTrackFromPath('B', oracle.row.track.filePath);
  }

  // ALC-166-4 : édition rapide des métadonnées (titre / genre) en double-clic.
  function startEdit(t: LibraryTrack, field: 'title' | 'genre') {
    editing = { id: t.id, field };
    editValue = field === 'title' ? (t.title || '') : (t.genre || '');
  }
  function cancelEdit() {
    editing = null;
  }
  async function saveEdit(t: LibraryTrack) {
    const field = editing?.field;
    const val = editValue.trim();
    editing = null;
    if (!field || !val) return;
    const unchanged = field === 'title' ? val === t.title : val === t.genre;
    if (unchanged) return;
    error = '';
    try {
      await libraryIpc.updateTrackMeta(
        t.id,
        field === 'title' ? val : null,
        field === 'genre' ? val : null
      );
      await loadLibrary();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Mise à jour des métadonnées interrompue';
    }
  }

  // ALC-166-4 : export de la setlist des duos validés (.m3u / .txt).
  const lineTrack = (t: LibraryTrack): string =>
    `${t.artist || '—'} - ${t.title || '—'} (${t.camelotKey || '?'} • ${t.bpm ? t.bpm.toFixed(1) : '?'} BPM)`;

  async function exportSetlist() {
    const pairs: [LibraryTrack, LibraryTrack][] = [];
    for (const key of duos) {
      const [a, b] = key.split('|').map(Number);
      const ta = tracks.find((t) => t.id === a);
      const tb = tracks.find((t) => t.id === b);
      if (ta && tb) pairs.push([ta, tb]);
    }
    if (pairs.length === 0) {
      error = 'Aucun duo ★ validé à exporter';
      return;
    }
    let m3u = '#EXTM3U\n';
    let txt = '';
    for (const [ta, tb] of pairs) {
      m3u += `#EXTINF:${ta.durationSec || 0},${ta.artist || ''} - ${ta.title || ''}\n${ta.filePath}\n`;
      m3u += `#EXTINF:${tb.durationSec || 0},${tb.artist || ''} - ${tb.title || ''}\n${tb.filePath}\n`;
      txt += `${lineTrack(ta)}\n\t↔\n${lineTrack(tb)}\n\n`;
    }
    const path = await save({
      title: 'Exporter la setlist des duos validés',
      defaultPath: 'alchemix-setlist.m3u',
      filters: [
        { name: 'Playlist M3U', extensions: ['m3u'] },
        { name: 'Texte', extensions: ['txt'] },
      ],
    });
    if (!path) return;
    try {
      const isTxt = path.toLowerCase().endsWith('.txt');
      await writeTextFile(path, isTxt ? txt : m3u);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Écriture de la setlist interrompue';
    }
  }

  async function removeTrack(track: LibraryTrack) {
    if (previewing === track.id) stopPreview();
    error = '';
    try {
      await libraryIpc.deleteTrack(track.id);
      await loadLibrary();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Retrait de la piste interrompu';
    }
  }

  async function toggleOracleDuo() {
    if (!anchor || !oracle) return;
    error = '';
    try {
      await libraryIpc.toggleDuo(Math.min(anchor.id, oracle.row.track.id), Math.max(anchor.id, oracle.row.track.id));
      await loadLibrary();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Mise à jour du duo interrompue';
    }
  }

  function cycleSort() {
    sortKey = sortKey === 'affinity' ? 'key' : sortKey === 'key' ? 'tempo' : 'affinity';
  }

  const sortLabel = $derived(sortKey === 'key' ? 'CLÉ' : sortKey === 'tempo' ? 'TEMPO' : 'AFFINITÉ');

  onMount(async () => {
    await loadLibrary();
    unlistenScan = await listen<LibraryScanProgress>('library://scan', (e) => {
      if (e.payload && e.payload.total > 0) {
        importing = true;
        importingPct = Math.min(100, Math.round((e.payload.done / e.payload.total) * 100));
      }
    });
  });
  onDestroy(() => {
    stopPreview();
    unlistenScan?.();
  });
</script>

<div
  class="w-full flex-1 flex flex-col min-h-[440px] bg-surface-container-lowest rounded-xl border border-outline-variant/30 shadow-[inset_0_2px_8px_rgba(0,0,0,0.85)] overflow-hidden"
>
  <!-- ARCHIVER PLATINE A / B -->
  <div class="px-3 pt-2 grid grid-cols-2 gap-2 shrink-0">
    <button
      type="button"
      onclick={() => archiveDeck('A')}
      class="flex items-center justify-between px-2.5 py-1.5 rounded-[3px] bg-surface-container-low hover:bg-surface-container transition-all group shadow-sm text-left relative overflow-hidden border border-[#10b981]/30 disabled:opacity-40 disabled:cursor-not-allowed"
      disabled={!mixerStore.deckA.filePath}
    >
      <div class="absolute left-0 inset-y-0 w-1 bg-[#10b981] shadow-[0_0_8px_#10b981]"></div>
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="w-2 h-2 rounded-full bg-[#10b981] shadow-[0_0_6px_#10b981] shrink-0"></span>
        <div class="min-w-0 leading-tight">
          <div class="font-label-sm text-[10px] text-[#10b981] font-bold tracking-wider uppercase">+ ARCHIVER PLATINE A</div>
          <div class="font-body-sm text-[12px] text-on-surface truncate">{mixerStore.deckA.filePath ? deckSummary('A') : 'Aucune piste chargée'}</div>
        </div>
      </div>
      <span class="material-symbols-outlined text-outline group-hover:text-[#10b981] text-[17px] shrink-0">archive</span>
    </button>
    <button
      type="button"
      onclick={() => archiveDeck('B')}
      class="flex items-center justify-between px-2.5 py-1.5 rounded-[3px] bg-surface-container-low hover:bg-surface-container transition-all group shadow-sm text-left relative overflow-hidden border border-[#3b82f6]/30 disabled:opacity-40 disabled:cursor-not-allowed"
      disabled={!mixerStore.deckB.filePath}
    >
      <div class="absolute left-0 inset-y-0 w-1 bg-[#3b82f6] shadow-[0_0_8px_#3b82f6]"></div>
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="w-2 h-2 rounded-full bg-[#3b82f6] shadow-[0_0_6px_#3b82f6] shrink-0"></span>
        <div class="min-w-0 leading-tight">
          <div class="font-label-sm text-[10px] text-[#3b82f6] font-bold tracking-wider uppercase">+ ARCHIVER PLATINE B</div>
          <div class="font-body-sm text-[12px] text-on-surface truncate">{mixerStore.deckB.filePath ? deckSummary('B') : 'Aucune piste chargée'}</div>
        </div>
      </div>
      <span class="material-symbols-outlined text-outline group-hover:text-[#3b82f6] text-[17px] shrink-0">archive</span>
    </button>
  </div>

  <div class="px-3 pt-1 pb-1.5 flex flex-col gap-1.5 shrink-0">
    <div class="flex items-center gap-2 px-2.5 py-1 rounded-[3px] bg-surface-container-lowest shadow-[inset_0_2px_5px_rgba(0,0,0,0.85)] border border-outline-variant/35">
      <span class="material-symbols-outlined text-primary text-[17px]">search</span>
      <input
        class="bg-transparent border-0 outline-none text-on-surface font-body-sm text-[12px] flex-1 placeholder:text-outline/60 focus:ring-0 p-0"
        placeholder="Rechercher un titre, artiste, genre..."
        type="text"
        bind:value={query}
      />
      {#if importing}
        <span class="font-label-sm text-[9px] text-primary bg-surface-container px-1.5 py-0.5 rounded tracking-widest uppercase border border-primary/40 shrink-0">IMPORT {importingPct}%</span>
      {:else}
        <span class="font-label-sm text-[9px] text-outline bg-surface-container px-1.5 py-0.5 rounded tracking-widest uppercase border border-outline-variant/30 shrink-0">{tracks.length} TITRES ARCHIVÉS</span>
      {/if}
      <button
        type="button"
        onclick={importFolder}
        class="flex items-center gap-1 px-2 py-1 rounded-[2px] border border-primary/50 bg-surface-container-high/90 hover:bg-surface-container-high hover:border-primary text-primary font-label-sm text-[9px] font-semibold tracking-wider uppercase transition-colors cursor-pointer shrink-0 shadow-sm"
        title="Importer un dossier musical complet"
      >
        <span class="material-symbols-outlined text-[13px]">folder_open</span>
        <span>+ IMPORTER DOSSIER</span>
      </button>
      <button
        type="button"
        onclick={exportSetlist}
        class="flex items-center gap-1 px-2 py-1 rounded-[2px] border border-outline-variant/40 bg-surface-container-lowest hover:bg-surface-container text-on-surface-variant font-label-sm text-[9px] font-semibold tracking-wider uppercase transition-colors cursor-pointer shrink-0 shadow-sm"
        title="Exporter la setlist des duos validés (.m3u / .txt)"
      >
        <span class="material-symbols-outlined text-[13px]">playlist_play</span>
        <span>EXPORTER SET</span>
      </button>
    </div>
    {#if importing}
      <div class="h-1 w-full rounded-full overflow-hidden bg-surface-container-high">
        <div class="h-full bg-primary transition-all" style="width:{importingPct}%"></div>
      </div>
    {/if}
    <div class="flex items-center gap-1.5 flex-wrap">
      <button
        type="button"
        onclick={() => (filter = 'all')}
        class="px-2 py-0.5 rounded-[2px] font-label-sm text-[10px] tracking-wider uppercase transition-colors {filter === 'all' ? 'bg-surface-container-high text-primary font-bold' : 'bg-surface-container-low text-outline hover:text-on-surface'}"
      >TOUS ({tracks.length})</button>
      <button
        type="button"
        onclick={() => (filter = filter === 'compatA' ? 'all' : 'compatA')}
        class="px-2 py-0.5 rounded-[2px] font-label-sm text-[10px] tracking-wider uppercase flex items-center gap-1 transition-colors {filter === 'compatA' ? 'bg-gradient-to-r from-surface-container to-surface-container-high text-[#10b981] shadow-[inset_0_1px_3px_rgba(16,185,129,0.3)] border border-[#10b981]/40 font-bold' : 'bg-surface-container-low text-outline hover:text-[#10b981]'}"
      >
        <span class="w-1.5 h-1.5 rounded-full bg-[#10b981] shadow-[0_0_5px_#10b981]"></span>
        <span>COMPATIBLE A ({refA?.key ?? '—'})</span>
        <span class="bg-[#10b981]/20 text-[#10b981] px-1 rounded text-[9px] font-bold">{countCompatA}</span>
      </button>
      <button
        type="button"
        onclick={() => (filter = filter === 'compatB' ? 'all' : 'compatB')}
        class="px-2 py-0.5 rounded-[2px] font-label-sm text-[10px] tracking-wider uppercase flex items-center gap-1 transition-colors {filter === 'compatB' ? 'bg-gradient-to-r from-surface-container to-surface-container-high text-[#3b82f6] shadow-[inset_0_1px_3px_rgba(59,130,246,0.3)] border border-[#3b82f6]/40 font-bold' : 'bg-surface-container-low text-outline hover:text-[#3b82f6]'}"
      >
        <span class="w-1.5 h-1.5 rounded-full bg-[#3b82f6]/40"></span>
        <span>COMPATIBLE B ({refB?.key ?? '—'})</span>
        <span class="bg-[#3b82f6]/20 text-[#3b82f6] px-1 rounded text-[9px] font-bold">{countCompatB}</span>
      </button>
      <button
        type="button"
        onclick={() => (filter = filter === 'duos' ? 'all' : 'duos')}
        class="px-2 py-0.5 rounded-[2px] font-label-sm text-[10px] tracking-wider uppercase flex items-center gap-1 border transition-colors {filter === 'duos' ? 'bg-surface-container-low text-primary border-primary/40 shadow-sm font-bold' : 'bg-surface-container-low text-primary/70 hover:bg-surface-container border-transparent'}"
      >
        <span>★ DUOS</span>
        <span class="bg-primary/20 text-primary px-1 rounded text-[9px] font-bold">{countDuos}</span>
      </button>
      <button
        type="button"
        class="ml-auto flex items-center gap-1 text-outline font-label-sm text-[10px] cursor-pointer hover:text-primary transition-colors"
        onclick={cycleSort}
        title="Changer le tri"
      >
        <span class="material-symbols-outlined text-[14px] text-primary">swap_vert</span>
        <span>TRI : {sortLabel} ▼</span>
      </button>
    </div>
  </div>

  <div class="px-3 flex-1 flex flex-col min-h-0">
    <div class="flex flex-col h-full rounded-[3px] bg-surface-container-lowest shadow-[inset_0_2px_8px_rgba(0,0,0,0.85)] border border-[#4f4539]/40 overflow-hidden">
      <div class="px-2.5 py-1.5 border-b border-[#4f4539]/40 shrink-0">
        <div class="h-6 bg-[#201a17]/85 border border-[#4f4539]/30 rounded-[3px] px-2.5 flex items-center gap-2 shadow-inner">
          <span class="material-symbols-outlined text-primary text-[14px] shrink-0">info</span>
          <span class="font-body-sm text-[10px] text-[#9b8f80] truncate leading-none">ASTUCE MIX : Cliquez sur ▶ pour pré-écouter au casque, puis sur A ou B pour charger le morceau compatible sur une platine.</span>
          {#if previewing !== null}
            <div class="flex items-center gap-1.5 ml-auto shrink-0" title="Volume casque de la pré-écoute">
              <span class="material-symbols-outlined text-primary text-[13px]">headphones</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={previewVolume}
                oninput={(e) => setPreviewVolume(Number((e.currentTarget as HTMLInputElement).value))}
                class="w-16 h-[4px] accent-[#edbf7a] cursor-pointer"
              />
            </div>
          {/if}
        </div>
      </div>
      <div class="grid px-2.5 py-1.5 bg-surface-container-high text-outline font-label-sm text-[10px] tracking-widest uppercase border-b border-[#4f4539]/40 shrink-0" style="grid-template-columns: 84px 1fr 72px 42px 76px 110px; gap: 6px; align-items: center;">
        <div class="flex items-center gap-0.5 text-primary font-bold">AFFINITÉ <span class="text-[9px]">▼</span></div>
        <div>TITRE &amp; ARTISTE</div>
        <div class="text-center">GENRE</div>
        <div class="text-center">CLÉ</div>
        <div class="text-right">TEMPO</div>
        <div class="text-center">ACTIONS</div>
      </div>
      <div class="flex-1 overflow-y-auto">
        {#if sortedRows.length === 0}
          <div class="flex items-center justify-center h-full px-3 text-center text-on-surface-variant font-label-sm text-[10px] tracking-widest uppercase py-6">
            {tracks.length === 0 ? 'Librairie vide — importez un dossier ou archivez une platine' : 'Aucun résultat pour ce filtre'}
          </div>
        {:else}
          {#each sortedRows as r (r.track.id)}
            <div class="grid px-2.5 py-1 relative group hover:bg-surface-container transition-colors {r.aff !== null && r.aff >= 82 ? 'bg-surface-container-low/90' : 'bg-surface-container-lowest'}" style="grid-template-columns: 84px 1fr 72px 42px 76px 110px; gap: 6px; align-items: center;">
              <div class="flex flex-col justify-center">
                {#if r.loaded}
                  <span class="text-[9px] font-label-sm font-bold {r.onA ? 'text-[#10b981]' : 'text-[#3b82f6]'} tracking-wider uppercase whitespace-nowrap">SUR PLATINE {r.onA ? 'A' : 'B'}</span>
                {:else}
                  <div class="flex items-center gap-1 font-label-sm text-[11px] font-bold {r.color}">
                    {#if r.aff !== null}<span>{Math.round(r.aff)}%</span>{:else}<span class="text-outline-variant">—</span>{/if}
                    {#if r.duo}<span class="text-primary text-[9px]">★ DUO</span>{/if}
                  </div>
                  <div class="w-16 h-1 bg-surface-container rounded-full overflow-hidden mt-0.5">
                    <div class="h-full {r.color}" style="width:{r.aff !== null ? r.aff : 0}%"></div>
                  </div>
                  <span class="text-[8px] font-label-sm font-bold {r.color} tracking-wider mt-0.5 uppercase">{r.aff !== null ? r.label : ''}</span>
                {/if}
              </div>
              <div class="min-w-0 pr-1 flex items-center gap-2">
                {#if r.track.coverData}
                  <div class="w-7 h-7 rounded-[2px] overflow-hidden border border-[#c89d5c]/60 bg-surface-container shadow-[0_1px_3px_rgba(0,0,0,0.6)] shrink-0">
                    <img src={r.track.coverData} alt="" class="w-full h-full object-cover" />
                  </div>
                {/if}
                <div class="min-w-0 flex-1">
                  <div class="font-medium text-[13px] text-[#ece0da] truncate group-hover:text-primary transition-colors flex items-center gap-1.5">
                  {#if editing && editing.id === r.track.id && editing.field === 'title'}
                    <input
                      type="text"
                      value={editValue}
                      oninput={(e) => (editValue = (e.currentTarget as HTMLInputElement).value)}
                      onkeydown={(e) => {
                        if (e.key === 'Enter') void saveEdit(r.track);
                        else if (e.key === 'Escape') cancelEdit();
                      }}
                      onblur={() => void saveEdit(r.track)}
                      class="bg-surface-container-high rounded px-1 text-[12px] text-on-surface w-full min-w-0 outline-none border border-primary/50"
                    />
                  {:else}
                    <span class="truncate cursor-text" role="button" tabindex="0" ondblclick={() => startEdit(r.track, 'title')} onkeydown={(e) => { if (e.key === 'Enter') startEdit(r.track, 'title'); }} title="Double-clic pour éditer le titre">{r.track.title || fileBase(r.track.filePath)}</span>
                  {/if}
                  {#if previewing === r.track.id}
                    <span class="text-[8px] font-label-sm font-bold text-primary tracking-widest uppercase px-1 py-0.2 rounded bg-primary/10 border border-primary/30 shrink-0">ÉCOUTE EN COURS</span>
                  {/if}
                  {#if r.onA}
                    <span class="text-[8px] font-label-sm font-bold text-[#10b981] tracking-widest uppercase px-1 py-0.2 rounded bg-[#10b981]/20 border border-[#10b981]/40 shrink-0">SUR PLATINE A</span>
                  {/if}
                  {#if r.onB}
                    <span class="text-[8px] font-label-sm font-bold text-[#3b82f6] tracking-widest uppercase px-1 py-0.2 rounded bg-[#3b82f6]/20 border border-[#3b82f6]/40 shrink-0">SUR PLATINE B</span>
                  {/if}
                </div>
                <div class="text-[11px] text-[#9b8f80] truncate font-body-sm">{r.track.artist || '—'}</div>
                </div>
              </div>
              <div class="flex justify-center">
                {#if editing && editing.id === r.track.id && editing.field === 'genre'}
                    <input
                      type="text"
                      value={editValue}
                      oninput={(e) => (editValue = (e.currentTarget as HTMLInputElement).value)}
                      onkeydown={(e) => {
                        if (e.key === 'Enter') void saveEdit(r.track);
                        else if (e.key === 'Escape') cancelEdit();
                      }}
                      onblur={() => void saveEdit(r.track)}
                      class="bg-surface-container-high rounded px-1 text-[10px] text-on-surface w-16 outline-none border border-[#3b82f6]/50 text-center uppercase tracking-wider"
                    />
                  {:else}
                    <span class="text-[9px] border border-[#4f4539]/60 bg-[#120d0a] rounded px-1.5 py-0.5 text-outline font-label-sm tracking-wider uppercase cursor-text" role="button" tabindex="0" ondblclick={() => startEdit(r.track, 'genre')} onkeydown={(e) => { if (e.key === 'Enter') startEdit(r.track, 'genre'); }} title="Double-clic pour éditer le genre">{r.track.genre || '—'}</span>
                  {/if}
              </div>
              <div class="flex justify-center">
                <span class="font-label-sm text-[11px] font-bold px-1.5 py-0.5 rounded bg-surface-container-high {r.color} {keyBadgeBorder(r)}">{r.track.camelotKey || '—'}</span>
              </div>
              <div class="text-right font-label-sm text-[11px]">
                <span class="text-on-surface font-bold tabular-nums whitespace-nowrap">{r.track.bpm ? r.track.bpm.toFixed(1) : '—'}</span> <span class="text-outline text-[9px]">BPM</span>
                {#if r.aff !== null}<div class="text-[9px] {r.color} font-semibold leading-none tabular-nums">{deltaPct(r.track.bpm)}</div>{/if}
              </div>
              <div class="flex items-center justify-end gap-1.5">
                <button type="button" onclick={() => togglePreview(r.track)} class="w-6 h-6 rounded-full border flex items-center justify-center transition-colors cursor-pointer shrink-0 {previewing === r.track.id ? 'border-primary bg-primary/20 text-primary shadow-[0_0_8px_#edbf7a] animate-pulse' : 'border-outline-variant text-[#edbf7a] hover:bg-[#edbf7a]/20'}" title="Pré-écouter / Arrêter">
                  <span class="text-[11px] leading-none">{previewing === r.track.id ? '❚❚' : '▶'}</span>
                </button>
                <button type="button" onclick={() => loadToDeck('A', r.track)} class="w-6 h-6 rounded-[2px] bg-[#06423a] border border-[#10b981]/50 text-[#10b981] font-bold text-[11px] font-label-sm hover:bg-[#10b981] hover:text-black flex items-center justify-center transition-colors cursor-pointer shrink-0" title="Charger Platine A">A</button>
                <button type="button" onclick={() => loadToDeck('B', r.track)} class="w-6 h-6 rounded-[2px] bg-[#194f47]/50 border border-[#3b82f6]/50 text-[#3b82f6] font-bold text-[11px] font-label-sm hover:bg-[#3b82f6] hover:text-black flex items-center justify-center transition-colors cursor-pointer shrink-0" title="Charger Platine B">B</button>
                <div class="border-l border-[#4f4539]/50 pl-1.5 ml-0.5 flex items-center">
                  <button type="button" onclick={() => removeTrack(r.track)} class="text-[#9b8f80] hover:text-red-400 font-bold text-[13px] leading-none transition-colors cursor-pointer" title="Retirer de la Librairie">×</button>
                </div>
                {#if previewing === r.track.id}
                  <div
                      class="absolute inset-x-0 bottom-0 h-[2px] cursor-pointer bg-primary/20 hover:bg-primary/40 z-10"
                      onpointerdown={scrubPreview}
                      role="slider"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow={previewDur > 0 ? Math.round((previewPos / previewDur) * 100) : 0}
                      title="Naviguer dans la pré-écoute"
                      tabindex="-1"
                    >
                    <div class="h-full bg-primary" style="width:{previewDur > 0 ? Math.round((previewPos / previewDur) * 100) : 0}%"></div>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>

  {#if error}
    <div class="px-3 pt-1 shrink-0">
      <div class="flex items-center gap-2 px-2.5 py-1 rounded-[3px] border border-[#ffb4ab]/40 bg-[#93000a]/20 text-[#ffb4ab] font-label-sm text-[10px] tracking-wider uppercase">
        <span class="material-symbols-outlined text-[14px] shrink-0">error</span>
        <span class="truncate">{error}</span>
      </div>
    </div>
  {/if}

  {#if oracle && anchor}
    <div class="px-3 pb-2 shrink-0">
      <div class="p-2.5 rounded-[3px] bg-gradient-to-r from-surface-container-high via-surface-container to-surface-container-high shadow-[0_2px_8px_rgba(0,0,0,0.7)] relative overflow-hidden flex items-center justify-between gap-3 border border-primary/40">
        <div class="absolute inset-x-0 top-0 h-[1.5px] bg-gradient-to-r from-primary/20 via-primary to-primary/20"></div>
        <div class="flex items-center gap-2.5 min-w-0 pr-2">
          <div class="w-8 h-8 rounded-full bg-surface-container-lowest flex items-center justify-center text-primary shadow-inner shrink-0 relative border border-[#4f4539]/50">
            <span class="material-symbols-outlined text-[18px]">auto_awesome</span>
            <span class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#10b981] shadow-[0_0_4px_#10b981]"></span>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 font-label-sm text-[10px] tracking-wider uppercase">
              <span class="text-[#edbf7a] font-bold">MEILLEURE ASSOCIATION MASHUP DÉTECTÉE</span>
              <span class="text-outline-variant">•</span>
              <span class="px-1 py-0.2 rounded bg-[#10b981]/20 text-[#10b981] font-bold">{Math.round(oracle.affinity)}% AFFINITÉ</span>
            </div>
            <div class="font-body-sm text-[11px] text-[#ece0da] truncate mt-0.5">
              {anchor.title || fileBase(anchor.filePath)} ({anchor.camelotKey} • {anchor.bpm.toFixed(1)} BPM) + {oracle.row.track.title || fileBase(oracle.row.track.filePath)} ({oracle.row.track.camelotKey} • {oracle.row.track.bpm.toFixed(1)} BPM)
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button type="button" onclick={toggleOracleDuo} class="px-2.5 py-1.5 rounded-[2px] bg-surface-container-lowest border border-primary/50 {oracleDuo ? 'text-emerald-400 border-[#10b981]/50' : 'text-primary'} font-label-sm text-[10px] font-bold tracking-wider uppercase shadow-sm hover:bg-primary/10 transition-colors flex items-center gap-1 cursor-pointer">
            <span>{oracleDuo ? '★ DUO VALIDÉ' : '★ VALIDER DUO'}</span>
          </button>
          <button
            type="button"
            onclick={bothEmpty ? loadDuoOracle : () => loadToDeck(sendTarget, oracle.row.track)}
            class="px-3 py-1.5 rounded-[2px] bg-gradient-to-b from-primary via-primary-container to-inverse-primary text-on-primary font-label-sm text-[10px] font-bold tracking-wider uppercase shadow-[0_2px_6px_rgba(0,0,0,0.8)] hover:brightness-110 active:translate-y-0.5 transition-all flex items-center gap-1 cursor-pointer"
          >
            <span>{bothEmpty ? 'CHARGER LE DUO → A & B' : `ENVOYER SUR ${sendTarget} →`}</span>
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if localBridgeBest}
    <div class="px-3 pb-2 shrink-0">
      <div class="flex items-center gap-2.5 rounded-[3px] bg-gradient-to-r from-[#06423a]/40 via-surface-container to-surface-container-high border border-emerald-500/40 p-2">
        <span class="material-symbols-outlined text-[16px] text-emerald-400 shrink-0">swap_calls</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 font-label-sm text-[9px] uppercase tracking-widest">
            <span class="text-emerald-400 font-bold">PONT A↔B</span>
            <span class="px-1 py-0.2 rounded bg-emerald-400/20 text-emerald-300 font-bold">LIBRAIRIE LOCALE</span>
          </div>
          <div class="font-body-sm text-[11px] text-[#ece0da] truncate mt-0.5">
            {localBridgeBest.track.title || fileBase(localBridgeBest.track.filePath)} ({localBridgeBest.pivot} • {localBridgeBest.bpm.toFixed(1)} BPM)
          </div>
        </div>
        <span class="shrink-0 text-[10px] font-mono text-emerald-300 font-bold px-1.5 py-0.5 rounded bg-emerald-400/10 border border-emerald-500/30">{localBridgeBest.score}% PONT</span>
        <button
          type="button"
          onclick={loadLocalBridgeOnce}
          class="shrink-0 px-2.5 py-1 rounded-[2px] bg-gradient-to-b from-primary via-primary-container to-inverse-primary text-on-primary font-label-sm text-[10px] font-bold uppercase tracking-wider shadow-sm hover:brightness-110 transition-all cursor-pointer"
          title="Charger la piste pont locale pour débloquer la transition"
        >
          <span>CHARGER PONT</span>
        </button>
      </div>
    </div>
  {/if}
</div>