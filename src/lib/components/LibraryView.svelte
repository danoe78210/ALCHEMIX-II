<script lang="ts">
  // ALC-165 : Vue LIBRAIRIE — catalogue SQLite local + moteur de matching MASHUP.
  // Fidèle au mockup `sources/Library v4.html` (Venezia 1889, grille 84px 1fr 72px 42px 76px 110px),
  // branchée sur le backend Rust (`library.rs`) via `libraryIpc` et sur le matcher `mashupMatcher.ts`.
  import { onMount, onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { open, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
  import VzTip from './VzTip.svelte'; // ALC-257 WP30 : infobulles horlogères remplaçant les title natifs
  import { mixerStore } from '$lib/stores/mixer.svelte';
  import { createPreviewObjectUrl } from '$lib/utils/audioBytes';
  import {
    libraryIpc,
    audioIpc,
    type LibraryTrack,
    type LibraryTrackTagPayload,
    type LibraryScanProgress,
  } from '$lib/ipc/client';
  import { scoreMatch, isSameTrack, findLocalBridgeTracks, type LocalBridgeResult } from '$lib/utils/mashupMatcher';

  let tracks = $state<LibraryTrack[]>([]);
  let duos = $state<Set<string>>(new Set());
  let query = $state('');
  let filter = $state<'all' | 'compatA' | 'compatB' | 'duos'>('all');
  let sortKey = $state<'affinity' | 'title' | 'key' | 'tempo'>('affinity');
  let sortDir = $state<'asc' | 'desc'>('desc'); // ALC-262-2 : ▲ / ▼
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

  // ── ALC-232 : panneau d'édition complète des tags (Titre, Artiste, Genre, BPM, Clé Camelot) ──
  let editingTags = $state<LibraryTrack | null>(null);
  let tagTitle = $state('');
  let tagArtist = $state('');
  let tagGenre = $state('');
  let tagBpm = $state<number>(120);
  let tagKey = $state('8A');
  let tagWriteFile = $state(true);
  let savedToast = $state('');
  let _toastTimer: number | undefined;
  // ALC-257 WP30 : confirmation de suppression en 2 temps par ligne (id en attente).
  let confirmingDelete = $state<number | null>(null);
  let _confirmTimer: number | undefined;
  function askDelete(id: number) {
    confirmingDelete = id;
    if (_confirmTimer) window.clearTimeout(_confirmTimer);
    _confirmTimer = window.setTimeout(() => (confirmingDelete = null), 4000);
  }
  function cancelDelete() {
    confirmingDelete = null;
    if (_confirmTimer) window.clearTimeout(_confirmTimer);
  }

  // Table officielle des 24 clés Camelot du projet (ALC-125) — équivalents tonaux lisibles.
  const CAMELOT_OPTIONS: { code: string; label: string; mode: 'A' | 'B' }[] = [
    { code: '1A', label: 'Sol♯ mineur', mode: 'A' }, { code: '2A', label: 'Ré♯ mineur', mode: 'A' },
    { code: '3A', label: 'La♯ mineur', mode: 'A' }, { code: '4A', label: 'Fa mineur', mode: 'A' },
    { code: '5A', label: 'Do mineur', mode: 'A' }, { code: '6A', label: 'Sol mineur', mode: 'A' },
    { code: '7A', label: 'Ré mineur', mode: 'A' }, { code: '8A', label: 'La mineur', mode: 'A' },
    { code: '9A', label: 'Mi mineur', mode: 'A' }, { code: '10A', label: 'Si mineur', mode: 'A' },
    { code: '11A', label: 'Fa♯ mineur', mode: 'A' }, { code: '12A', label: 'Do♯ mineur', mode: 'A' },
    { code: '1B', label: 'Si majeur', mode: 'B' }, { code: '2B', label: 'Fa♯ majeur', mode: 'B' },
    { code: '3B', label: 'Ré♭ majeur', mode: 'B' }, { code: '4B', label: 'La♭ majeur', mode: 'B' },
    { code: '5B', label: 'Mi♭ majeur', mode: 'B' }, { code: '6B', label: 'Si♭ majeur', mode: 'B' },
    { code: '7B', label: 'Fa majeur', mode: 'B' }, { code: '8B', label: 'Do majeur', mode: 'B' },
    { code: '9B', label: 'Sol majeur', mode: 'B' }, { code: '10B', label: 'Ré majeur', mode: 'B' },
    { code: '11B', label: 'La majeur', mode: 'B' }, { code: '12B', label: 'Mi majeur', mode: 'B' },
  ];

  const clampBpm = (v: number) => Math.max(40, Math.min(240, Math.round(v * 10) / 10));
  const bpmHalve = () => (tagBpm = clampBpm(tagBpm / 2));
  const bpmDouble = () => (tagBpm = clampBpm(tagBpm * 2));

  function openTagEditor(t: LibraryTrack) {
    editing = null; // ferme l'édition inline titre/genre éventuelle
    editingTags = t;
    tagTitle = t.title || '';
    tagArtist = t.artist || '';
    tagGenre = t.genre || '';
    tagBpm = t.bpm > 0 ? clampBpm(t.bpm) : 120;
    const k = (t.camelotKey || '').trim().toUpperCase();
    tagKey = CAMELOT_OPTIONS.some((o) => o.code === k) ? k : '8A';
    // ALC-234 : les .wav ne supportent pas l'écriture ID3 → case « écrire dans le fichier » désactivée.
    tagWriteFile = !(t.filePath || '').toLowerCase().endsWith('.wav');
  }
  // ALC-234 : la piste éditée est-elle un WAV ? (pas de tags ID3 → conservation en base uniquement)
  const isWavFile = $derived(!!editingTags && editingTags.filePath.toLowerCase().endsWith('.wav'));
  function closeTagEditor() {
    editingTags = null;
  }

  function showToast(msg: string) {
    savedToast = msg;
    if (_toastTimer) window.clearTimeout(_toastTimer);
    _toastTimer = window.setTimeout(() => (savedToast = ''), 2000);
  }

  // ALC-232 : la touche Échap ferme la modale d'édition (écouteur actif seulement quand elle est ouverte).
  $effect(() => {
    if (!editingTags) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeTagEditor();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // ALC-257 WP30 : Échap annule la confirmation de suppression en cours.
  $effect(() => {
    if (confirmingDelete === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDelete();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function saveTagEditor() {
    const t = editingTags;
    if (!t) return;
    const payload: LibraryTrackTagPayload = {
      title: tagTitle.trim(),
      artist: tagArtist.trim(),
      genre: tagGenre.trim(),
      bpm: Number.isFinite(tagBpm) && tagBpm > 0 ? tagBpm : null,
      camelotKey: tagKey,
      writeToFile: tagWriteFile,
    };
    closeTagEditor();
    error = '';
    try {
      const updated = await mixerStore.updateLibraryTrackTags(t.id, payload);
      // Remplacement immédiat de la ligne : tous les $derived (affinités, filtres, Oracle, Ponts)
      // sont recalculés instantanément, sans re-requêter la base.
      tracks = tracks.map((tr) => (tr.id === updated.id ? updated : tr));
      showToast('TAGS ENREGISTRÉS ✓');
    } catch (e) {
      error = e instanceof Error ? e.message : 'Mise à jour des tags interrompue';
    }
  }

  let previewAudio: HTMLAudioElement | null = null;
  let previewUrl: string | null = null;
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

  // ALC-262-2 : rang Camelot logique (1A,1B,2A,2B...12A,12B) — jamais de tri texte (10A > 2A).
  const cmpCamelotRank = (k: string): number => {
    const m = (k || '').match(/(\d{1,2})([AB])/);
    if (!m) return 9999;
    const n = Math.min(12, Math.max(1, parseInt(m[1], 10) || 1));
    return (n - 1) * 2 + (m[2] === 'B' ? 1 : 0);
  };
  const sortedRows = $derived.by<Row[]>(() => {
    const arr = [...visibleRows];
    const dirM = sortDir === 'asc' ? 1 : -1;
    if (sortKey === 'title') {
      arr.sort((a, b) => (a.track.title || '').localeCompare(b.track.title || '', 'fr') * dirM || b.track.id - a.track.id);
    } else if (sortKey === 'key') {
      arr.sort((a, b) => (cmpCamelotRank(a.track.camelotKey) - cmpCamelotRank(b.track.camelotKey)) * dirM || b.track.id - a.track.id);
    } else if (sortKey === 'tempo') {
      arr.sort((a, b) => (((a.track.bpm || 0) - (b.track.bpm || 0)) * dirM) || b.track.id - a.track.id);
    } else {
      arr.sort((a, b) => (((a.aff ?? -1) - (b.aff ?? -1)) * dirM) || b.track.id - a.track.id);
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
      // ALC-234 : hydrate le cache Store (source des métadonnées éditées au chargement sur platine).
      mixerStore.setLibraryTracks(tracks);
      duos = new Set(duoList.map((d) => duoKey(d.trackAId, d.trackBId)));
    } catch (e) {
      error = e instanceof Error ? e.message : 'Impossible de charger la Librairie';
    }
  }

  function stopPreview() {
    previewAudio?.pause();
    previewAudio = null;
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    previewing = null;
    previewPos = 0;
    previewDur = 0;
  }

  async function togglePreview(track: LibraryTrack) {
    if (previewing === track.id) {
      stopPreview();
      return;
    }
    stopPreview();
    try {
      // ALC-192-1 : pipeline mémoire Rust → Blob URL (jamais asset:// / convertFileSrc, bloqué WebView2).
      const bytes: number[] = await audioIpc.readAudioFileBytes(track.filePath);
      const url = createPreviewObjectUrl(bytes, track.filePath);
      const audio = new Audio(url);
      audio.volume = previewVolume;
      audio.addEventListener('ended', stopPreview);
      audio.addEventListener('error', () => {
        console.error('[Pré-écoute] décodage impossible :', track.filePath);
        stopPreview();
      });
      audio.addEventListener('loadedmetadata', () => {
        previewDur = audio.duration || 0;
        previewPos = 0;
      });
      audio.addEventListener('timeupdate', () => {
        previewPos = audio.currentTime || 0;
      });
      previewUrl = url;
      previewAudio = audio;
      previewing = track.id;
      try {
        await audio.play();
      } catch (err) {
        console.error('[Pré-écoute] lecture impossible :', track.filePath, err);
        stopPreview();
      }
    } catch (err) {
      console.error('[Pré-écoute] lecture des octets impossible :', track.filePath, err);
      stopPreview();
    }
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

  const SORT_KEYS = ['affinity', 'title', 'key', 'tempo'] as const;
  // ALC-262-2 : clic sur un en-tête = activer le tri, second clic = inverser ▲/▼.
  function setSort(k: (typeof SORT_KEYS)[number]) {
    if (k === sortKey) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = k;
      sortDir = k === 'affinity' ? 'desc' : 'asc';
    }
  }
  function cycleSort() {
    const i = SORT_KEYS.indexOf(sortKey);
    const nk = SORT_KEYS[(i + 1) % SORT_KEYS.length];
    sortKey = nk;
    sortDir = nk === 'affinity' ? 'desc' : 'asc';
  }

  const sortLabel = $derived(
    sortKey === 'title' ? 'TITRE' : sortKey === 'key' ? 'CLÉ' : sortKey === 'tempo' ? 'TEMPO' : 'AFFINITÉ'
  );
  const sortArrow = $derived(sortDir === 'asc' ? '▲' : '▼');

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
  class="w-full h-full flex flex-col min-h-0 bg-surface-container-lowest rounded-xl border border-outline-variant/30 shadow-[inset_0_2px_8px_rgba(0,0,0,0.85)] overflow-hidden"
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
        <span>TRI : {sortLabel} {sortArrow}</span>
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
      <div class="vz-lib-grid vz-lib-head" class:has-ref={reference}>
        <div class="vz-head-aff">
          <button type="button" onclick={() => setSort('affinity')} aria-label="Trier par affinité" class="inline-flex items-center gap-1 cursor-pointer {sortKey === 'affinity' ? 'text-[#edbf7a]' : 'text-[#8a7c66]'} hover:text-[#ffddb0]">
            AFFINITÉ {#if sortKey === 'affinity'}<span class="text-[9px]">{sortArrow}</span>{/if}
          </button>
        </div>
        <div class="vz-head-cover" aria-hidden="true"></div>
        <div class="min-w-0">
          <button type="button" onclick={() => setSort('title')} aria-label="Trier par titre" class="inline-flex items-center gap-1 min-w-0 w-full text-left cursor-pointer {sortKey === 'title' ? 'text-[#edbf7a]' : 'text-[#9b8f80]'} hover:text-[#ffddb0]">
            <span class="truncate">TITRE &amp; ARTISTE</span>{#if sortKey === 'title'}<span class="text-[9px] shrink-0">{sortArrow}</span>{/if}
          </button>
        </div>
        <div class="vz-head-genre">GENRE</div>
        <div class="vz-head-key">
          <button type="button" onclick={() => setSort('key')} aria-label="Trier par clé Camelot" class="inline-flex items-center justify-center gap-1 w-full cursor-pointer {sortKey === 'key' ? 'text-[#edbf7a]' : 'text-[#9b8f80]'} hover:text-[#ffddb0]">
            CLÉ {#if sortKey === 'key'}<span class="text-[9px]">{sortArrow}</span>{/if}
          </button>
        </div>
        <div class="vz-head-bpm">
          <button type="button" onclick={() => setSort('tempo')} aria-label="Trier par tempo (BPM)" class="inline-flex items-center justify-end gap-1 w-full cursor-pointer {sortKey === 'tempo' ? 'text-[#edbf7a]' : 'text-[#9b8f80]'} hover:text-[#ffddb0]">
            TEMPO {#if sortKey === 'tempo'}<span class="text-[9px]">{sortArrow}</span>{/if}
          </button>
        </div>
        <div class="vz-head-act">ACTIONS</div>
      </div>
      <div class="vz-lib-scroll min-h-0 flex-1 overflow-y-auto">
        {#if sortedRows.length === 0}
          <div class="flex items-center justify-center h-full px-3 text-center text-on-surface-variant font-label-sm text-[10px] tracking-widest uppercase py-6">
            {tracks.length === 0 ? 'Librairie vide — importez un dossier ou archivez une platine' : 'Aucun résultat pour ce filtre'}
          </div>
        {:else}
          {#each sortedRows as r (r.track.id)}
            <div class="vz-lib-grid vz-lib-row group {r.aff !== null && r.aff >= 82 && !r.loaded ? 'vz-row-high' : ''}" class:has-ref={reference} style="--line-accent:{r.onA ? '#10b981' : r.onB ? '#00A3FF' : 'transparent'}">
              <!-- cellule Affinité -->
              <div class="vz-cell-aff">
                {#if reference && !r.loaded}
                  <div class="flex items-center gap-1 font-label-sm text-[11px] font-bold {r.color} whitespace-nowrap">
                    {#if r.aff !== null}<span class="tabular-nums">{Math.round(r.aff)}%</span>{:else}<span class="text-outline-variant">—</span>{/if}
                    {#if r.duo}<span class="text-primary text-[9px]">★</span>{/if}
                  </div>
                  <div class="vz-aff-bar" aria-hidden="true">
                    {#each [0,1,2,3,4] as i (i)}
                      <span class="vz-aff-seg {r.aff !== null && i < Math.ceil((r.aff ?? 0) / 20) ? 'on' : ''}"></span>
                    {/each}
                  </div>
                {:else if r.loaded}
                  <span class="text-[9px] font-label-sm font-bold {r.onA ? 'text-[#10b981]' : 'text-[#00A3FF]'} tracking-wider uppercase whitespace-nowrap">SUR PLATINE {r.onA ? 'A' : 'B'}</span>
                {:else}
                  <span class="text-outline-variant text-[11px]">—</span>
                {/if}
              </div>
              <!-- pochette toujours réservée -->
              <div class="vz-cell-cover">
                <div class="vz-cover">
                  {#if r.track.coverData}
                    <img src={r.track.coverData} alt="" class="w-full h-full object-cover" />
                  {:else}
                    <span class="material-symbols-outlined text-[13px] text-[#7a6a55]">album</span>
                  {/if}
                </div>
              </div>
              <!-- Titre + Artiste -->
              <div class="vz-cell-title min-w-0">
                <div class="font-medium text-[13px] text-[#ece0da] truncate group-hover:text-[#edbf7a] transition-colors">
                  {#if editing && editing.id === r.track.id && editing.field === 'title'}
                    <input type="text" value={editValue} oninput={(e) => (editValue = (e.currentTarget as HTMLInputElement).value)} onkeydown={(e) => { if (e.key === 'Enter') void saveEdit(r.track); else if (e.key === 'Escape') cancelEdit(); }} onblur={() => void saveEdit(r.track)} class="bg-surface-container-high rounded px-1 text-[12px] text-on-surface w-full min-w-0 outline-none border border-[#edbf7a]/60" />
                  {:else}
                    <span class="truncate cursor-text" role="button" tabindex="0" ondblclick={() => startEdit(r.track, 'title')} onkeydown={(e) => { if (e.key === 'Enter') startEdit(r.track, 'title'); }} title="Double-clic pour éditer le titre">{r.track.title || fileBase(r.track.filePath)}</span>
                  {/if}
                </div>
                <div class="text-[11px] text-[#9b8f80] truncate font-body-sm">{r.track.artist || '—'}</div>
                {#if previewing === r.track.id}
                  <span class="text-[8px] font-label-sm font-bold text-[#edbf7a] tracking-widest uppercase px-1 py-0.2 rounded bg-[#edbf7a]/10 border border-[#edbf7a]/30 shrink-0">ÉCOUTE EN COURS</span>
                {/if}
              </div>
              <div class="vz-cell-genre">
                {#if editing && editing.id === r.track.id && editing.field === 'genre'}
                  <input type="text" value={editValue} oninput={(e) => (editValue = (e.currentTarget as HTMLInputElement).value)} onkeydown={(e) => { if (e.key === 'Enter') void saveEdit(r.track); else if (e.key === 'Escape') cancelEdit(); }} onblur={() => void saveEdit(r.track)} class="bg-surface-container-high rounded px-1 text-[10px] text-on-surface w-20 outline-none border border-[#00A3FF]/50 text-center uppercase tracking-wider" />
                {:else if r.track.genre}
                  <span class="vz-genre" title={r.track.genre} role="button" tabindex="0" ondblclick={() => startEdit(r.track, 'genre')} onkeydown={(e) => { if (e.key === 'Enter') startEdit(r.track, 'genre'); }}>{r.track.genre}</span>
                {:else}
                  <span class="vz-genre vz-genre-empty" aria-hidden="true">—</span>
                {/if}
              </div>
              <div class="vz-cell-key">
                <span class="font-label-sm text-[11px] font-bold px-1.5 py-1 rounded bg-surface-container-high {r.color} {keyBadgeBorder(r)}">{r.track.camelotKey || '—'}</span>
              </div>
              <div class="vz-cell-bpm text-right font-label-sm text-[11px]">
                <span class="text-on-surface font-bold tabular-nums whitespace-nowrap">{r.track.bpm ? r.track.bpm.toFixed(1) : '—'}</span> <span class="text-outline text-[9px]">BPM</span>
                {#if r.aff !== null}<div class="text-[9px] {r.color} font-semibold leading-none tabular-nums">{deltaPct(r.track.bpm)}</div>{/if}
              </div>
              <div class="vz-cell-act flex items-center justify-end gap-1.5">
                <VzTip text={previewing === r.track.id ? 'Arrêter la pré-écoute' : 'Pré-écouter au casque'}>
                  <button type="button" aria-pressed={previewing === r.track.id} onclick={() => togglePreview(r.track)} class="vz-act vz-act-primary {previewing === r.track.id ? 'enabled' : ''}"><span class="vz-act-led"></span><span class="vz-act-icon">{previewing === r.track.id ? '❚❚' : '▶'}</span></button>
                </VzTip>
                <VzTip text="Charger sur la platine A">
                  <button type="button" aria-pressed={r.onA} onclick={() => loadToDeck('A', r.track)} class="vz-load-a {r.onA ? 'enabled' : ''}"><span class="vz-load-led"></span>→ A</button>
                </VzTip>
                <VzTip text="Charger sur la platine B">
                  <button type="button" aria-pressed={r.onB} onclick={() => loadToDeck('B', r.track)} class="vz-load-b {r.onB ? 'enabled' : ''}"><span class="vz-load-led"></span>→ B</button>
                </VzTip>
                <VzTip text="Éditer les tags">
                  <button type="button" onclick={() => openTagEditor(r.track)} class="vz-act vz-act-edit"><span class="material-symbols-outlined text-[15px]">edit</span></button>
                </VzTip>
                <div class="vz-act-sep"></div>
                {#if confirmingDelete === r.track.id}
                  <VzTip text="Confirmer le retrait de la librairie">
                    <button type="button" onclick={cancelDelete} class="vz-act vz-act-conf-cancel">✕</button>
                  </VzTip>
                  <VzTip text={`Retirer définitivement ${r.track.title || fileBase(r.track.filePath)}`}>
                    <button type="button" onclick={() => { cancelDelete(); void removeTrack(r.track); }} class="vz-act vz-act-confirm" aria-label="Confirmer le retrait">RETIRER ?</button>
                  </VzTip>
                {:else}
                  <VzTip text="Retirer de la librairie">
                    <button type="button" onclick={() => askDelete(r.track.id)} aria-label="Retirer de la librairie" class="vz-act vz-act-del"><span class="material-symbols-outlined text-[15px]">delete</span></button>
                  </VzTip>
                {/if}
                {#if previewing === r.track.id}
                  <div class="absolute inset-x-0 bottom-0 h-[2px] cursor-pointer bg-[#edbf7a]/25 hover:bg-[#edbf7a]/45 z-10" onpointerdown={scrubPreview} role="slider" aria-valuemin="0" aria-valuemax="100" aria-valuenow={previewDur > 0 ? Math.round((previewPos / previewDur) * 100) : 0} title="Naviguer dans la pré-écoute" tabindex="-1">
                    <div class="h-full bg-[#edbf7a]" style="width:{previewDur > 0 ? Math.round((previewPos / previewDur) * 100) : 0}%"></div>
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

  {#if editingTags}
    <div class="fixed inset-0 z-50 bg-black/65 backdrop-blur-[1px] flex items-center justify-center p-4" role="presentation" onpointerdown={closeTagEditor}>
      <form
        class="w-full max-w-[430px] max-h-[90vh] overflow-y-auto rounded-lg bg-surface-container-high border border-[#665643] shadow-[0_14px_44px_rgba(0,0,0,0.92),inset_0_1px_0_rgba(237,191,122,0.1)] flex flex-col"
        onsubmit={(e) => { e.preventDefault(); void saveTagEditor(); }}
        onpointerdown={(e) => e.stopPropagation()}
      >
        <!-- En-tête : pochette miniature + fichier source (tronqué, infobulle) -->
        <div class="flex items-center gap-2.5 px-3 py-2.5 border-b border-[#544738]">
          <div class="w-9 h-9 rounded-[2px] overflow-hidden border border-[#c89d5c]/60 bg-surface-container-lowest shrink-0 flex items-center justify-center shadow-[0_1px_3px_rgba(0,0,0,0.6)]">
            {#if editingTags.coverData}
              <img src={editingTags.coverData} alt="" class="w-full h-full object-cover" />
            {:else}
              <span class="material-symbols-outlined text-[16px] text-[#9b8f80]">music_note</span>
            {/if}
          </div>
          <div class="min-w-0 flex-1">
            <div class="font-label-sm text-[9px] uppercase tracking-widest text-[#edbf7a] font-bold">Édition des tags</div>
            <div class="font-mono text-[10px] text-outline truncate" title={editingTags.filePath}>{editingTags.filePath || '—'}</div>
          </div>
          <span class="material-symbols-outlined text-[15px] text-outline-variant">edit_note</span>
        </div>

        <div class="px-3 py-3 flex flex-col gap-2 min-h-0">
          <label class="flex flex-col gap-1">
            <span class="font-label-sm text-[9px] uppercase tracking-widest text-outline">Titre</span>
            <input bind:value={tagTitle} type="text" placeholder="Titre du morceau" class="w-full bg-surface-container-lowest border border-[#4f4539] rounded px-2 py-1.5 text-[12px] text-on-surface outline-none focus:border-[#edbf7a]/70 focus:shadow-[0_0_0_1px_rgba(237,191,122,0.25)]" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="font-label-sm text-[9px] uppercase tracking-widest text-outline">Artiste</span>
            <input bind:value={tagArtist} type="text" placeholder="Artiste / Compositeur" class="w-full bg-surface-container-lowest border border-[#4f4539] rounded px-2 py-1.5 text-[12px] text-on-surface outline-none focus:border-[#edbf7a]/70" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="font-label-sm text-[9px] uppercase tracking-widest text-outline">Genre</span>
            <input bind:value={tagGenre} type="text" list="genre-suggestions" placeholder="Pop, Rock, OST / Cinéma…" class="w-full bg-surface-container-lowest border border-[#4f4539] rounded px-2 py-1.5 text-[12px] text-on-surface outline-none focus:border-[#edbf7a]/70" />
          </label>
          <datalist id="genre-suggestions">
            {#each ['Pop', 'Rock', 'House', 'Electro', 'Synthpop', 'Hip-Hop', 'R&B', 'Funk', 'OST / Cinéma', 'Trance'] as g (g)}
              <option value={g}></option>
            {/each}
          </datalist>
          <label class="flex flex-col gap-1">
            <span class="font-label-sm text-[9px] uppercase tracking-widest text-outline">BPM</span>
            <div class="flex items-center gap-1.5">
              <input bind:value={tagBpm} type="number" step="0.1" min="40" max="240" class="w-24 bg-surface-container-lowest border border-[#4f4539] rounded px-2 py-1.5 text-[12px] tabular-nums text-on-surface outline-none focus:border-[#edbf7a]/70" />
              <button type="button" onclick={bpmHalve} class="px-2 py-1 rounded border border-[#4f4539]/70 text-[#edbf7a] font-label-sm text-[10px] font-bold tracking-wider hover:bg-[#edbf7a]/10 transition-colors cursor-pointer whitespace-nowrap" title="Diviser par 2 (corriger une erreur d'octave rythmique)">÷2</button>
              <button type="button" onclick={bpmDouble} class="px-2 py-1 rounded border border-[#4f4539]/70 text-[#edbf7a] font-label-sm text-[10px] font-bold tracking-wider hover:bg-[#edbf7a]/10 transition-colors cursor-pointer whitespace-nowrap" title="Multiplier par 2 (corriger une erreur d'octave rythmique)">×2</button>
              <span class="font-mono text-[9px] text-outline tabular-nums">BPM</span>
            </div>
          </label>
          <label class="flex flex-col gap-1">
            <span class="font-label-sm text-[9px] uppercase tracking-widest text-outline">Clé Camelot</span>
            <div class="flex items-center gap-1.5">
              <select bind:value={tagKey} class="flex-1 min-w-0 bg-surface-container-lowest border border-[#4f4539] rounded px-2 py-1.5 text-[12px] font-bold outline-none focus:border-[#edbf7a]/70 {tagKey.endsWith('A') ? 'text-[#10b981]' : 'text-[#00A3FF]'}">
                {#each CAMELOT_OPTIONS as o (o.code)}
                  <option value={o.code} class="text-on-surface">{o.code} · {o.label}</option>
                {/each}
              </select>
            </div>
          </label>
          <label class={"flex items-center gap-2 mt-0.5 " + (isWavFile ? 'cursor-not-allowed' : 'cursor-pointer select-none')}>
            <input type="checkbox" bind:checked={tagWriteFile} disabled={isWavFile} class="accent-[#edbf7a] w-3.5 h-3.5 shrink-0" />
            <span class="font-label-sm text-[10px] tracking-wider text-outline uppercase leading-tight">
              {isWavFile
                ? 'Format WAV : métadonnées sauvegardées dans la base AlcheMix II (tags ID3 non supportés par WAV)'
                : 'Écrire aussi dans les tags du fichier audio (ID3 / Vorbis / MP4)'}
            </span>
          </label>
        </div>

        <div class="flex items-center justify-end gap-2 px-3 py-2.5 border-t border-[#544738]">
          <button type="button" onclick={closeTagEditor} class="px-3 py-1.5 rounded bg-surface-container border border-[#4f4539]/70 text-outline font-label-sm text-[10px] font-bold uppercase tracking-widest hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer whitespace-nowrap">Annuler</button>
          <button type="submit" class="px-3 py-1.5 rounded bg-gradient-to-b from-[#edbf7a] to-[#9a6f2f] text-[#120d0a] font-label-sm text-[10px] font-bold uppercase tracking-widest shadow-[0_2px_6px_rgba(0,0,0,0.7)] hover:brightness-110 transition-all cursor-pointer whitespace-nowrap">ENREGISTRER LES TAGS</button>
        </div>
      </form>
    </div>
  {/if}

  {#if savedToast}
    <div class="fixed inset-x-0 bottom-4 z-[60] flex justify-center pointer-events-none">
      <div class="flex items-center gap-2 px-3 py-1.5 rounded bg-gradient-to-b from-[#201a17] to-[#16110e] border border-[#edbf7a]/50 shadow-[0_8px_24px_rgba(0,0,0,0.8)] font-label-sm text-[10px] font-bold tracking-widest uppercase text-[#edbf7a] whitespace-nowrap">
        <span class="material-symbols-outlined text-[14px]">check_circle</span>
        <span>{savedToast}</span>
      </div>
    </div>
  {/if}
</div>

<style>
  /* ALC-257 WP32 : grille unifiée Librairie (en-tête + lignes) */
  .vz-lib-grid {
    display: grid;
    align-items: center;
    column-gap: 10px;
    padding: 0 12px;
    width: 100%;
    grid-template-columns: 32px minmax(0, 1fr) 96px 48px 82px 212px;
  }
  /* ALC-261-2 : platine de référence chargée → colonne AFFINITÉ 68px en tête */
  .vz-lib-grid.has-ref {
    grid-template-columns: 68px 32px minmax(0, 1fr) 96px 48px 82px 212px;
  }
  .vz-lib-head {
    height: 36px;
    padding: 0 26px 0 12px; /* ALC-261-2 : décalage droit = 12px grille + ~14px scrollbar-gutter de la liste */
    gap: 0;
    font-family: var(--font-label-sm, ui-monospace, 'JetBrains Mono', monospace);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #9b8f80;
    white-space: nowrap;
  }
  .vz-lib-head > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .vz-head-aff { display: flex; align-items: center; gap: 4px; font-weight: 700; color: #edbf7a; }
  .vz-head-genre { text-align: left; }
  .vz-head-key { text-align: center; }
  .vz-head-bpm { text-align: right; }
  .vz-head-act { text-align: right; }
  .vz-lib-head .vz-head-cover, .vz-lib-head .vz-head-aff { padding-right: 0; }

  .vz-lib-row {
    position: relative;
    height: 44px;
    /* ALC-261-2 : padding géré par .vz-lib-grid (0 12px) pour un alignement identique en-tête/lignes */
    border-left: 3px solid var(--line-accent, transparent);
    border-bottom: 1px solid rgba(237, 191, 122, 0.06);
    background: #120d0a;
    transition: background-color 120ms ease, border-color 120ms ease;
  }
  .vz-lib-row:hover { background: rgba(237, 191, 122, 0.06); }
  .vz-lib-row:focus-within { outline: 2px solid rgba(237, 191, 122, 0.7); outline-offset: -2px; }
  .vz-row-high { background: rgba(237, 191, 122, 0.045); }

  /* ALC-261-2 : cellule AFFINITÉ masquée sans platine de référence (grille 6 colonnes) */
  .vz-lib-head:not(.has-ref) .vz-head-aff,
  .vz-lib-row:not(.has-ref) .vz-cell-aff { display: none; }

  /* ALC-261-2 : gouttière de scroll stable → colonnes alignées avec l'en-tête, même sans barre */
  .vz-lib-scroll { scrollbar-gutter: stable; }

  /* ALC-261-2 : alignements des cellules de données */
  .vz-cell-key { text-align: center; }
  .vz-cell-bpm { text-align: right; }
  .vz-cell-act { text-align: right; min-width: 0; }

  /* pochette toujours réservée */
  .vz-cell-cover { display: flex; align-items: center; }
  .vz-cover {
    width: 28px;
    height: 28px;
    border-radius: 2px;
    border: 1px solid #8c6d3f;
    background: #17120f;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    flex: none;
  }
  .vz-cell-aff, .vz-cell-title, .vz-cell-genre, .vz-cell-key, .vz-cell-bpm, .vz-cell-act { min-width: 0; }

  /* barre laiton 5 segments */
  .vz-aff-bar { display: flex; gap: 2px; margin-top: 4px; }
  .vz-aff-seg { flex: 1; height: 3px; border-radius: 1px; background: rgba(120,110,90,0.25); }
  .vz-aff-seg.on { background: #edbf7a; }

  /* genre 104px une ligne */
  .vz-genre {
    display: inline-block;
    max-width: 104px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--font-label-sm, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #d2c4b4;
    cursor: text;
  }
  .vz-genre-empty { color: #7a6a55; cursor: default; }

  /* actions cluster via .vz-key */
  .vz-act {
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    border: 1px solid var(--vz-key-edge, #665643);
    background: transparent;
    color: var(--vz-text-mid, #b8a68a);
    flex: none;
    cursor: pointer;
    transition: filter 140ms var(--vz-ease, cubic-bezier(0.22,1,0.36,1)), transform 80ms;
  }
  .vz-act:hover { filter: brightness(1.12); }
  .vz-act:active { transform: translateY(1px); }
  .vz-act-led { width: 6px; height: 6px; position: absolute; display: none; border-radius: 50%; background: #34d399; }
  .vz-act-primary { position: relative; color: #edbf7a; }
  .vz-act-primary.enabled { border-color: #edbf7a; background: rgba(237,191,122,0.14); }
  .vz-act-primary.enabled .vz-act-led { display: block; top: 3px; right: 3px; }
  .vz-load-a, .vz-load-b {
    height: 32px;
    padding: 0 8px;
    min-width: 36px;
    border-radius: 6px;
    border: 1px solid;
    font-family: var(--font-label-sm, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    cursor: pointer;
    transition: filter 140ms var(--vz-ease, cubic-bezier(0.22,1,0.36,1)), transform 80ms;
  }
  .vz-load-a { border-color: rgba(16,185,129,0.5); color: #34d399; background: rgba(16,185,129,0.10); }
  .vz-load-b { border-color: rgba(0,163,255,0.5); color: #6cc4ff; background: rgba(0,163,255,0.10); }
  .vz-load-a:hover { background: rgba(16,185,129,0.20); }
  .vz-load-b:hover { background: rgba(0,163,255,0.20); }
  .vz-act-edit { color: var(--vz-text-mid, #b8a68a); }
  .vz-act-edit:hover { color: #edbf7a; border-color: rgba(237,191,122,0.6); }
  .vz-act-del { color: #9b8f80; }
  .vz-act-del:hover { color: #f87171; border-color: rgba(248,113,113,0.5); }
  /* ALC-257 WP30 : séparateur + LED de chargement + états enclenchés →A/→B */
  .vz-act-sep { width: 1px; height: 20px; background: rgba(255,255,255,0.10); margin: 0 2px; flex: none; }
  .vz-load-a, .vz-load-b { position: relative; }
  .vz-load-led { width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-right: 4px; background: transparent; }
  .vz-load-a.enabled, .vz-load-b.enabled {
    border-color: currentColor;
    filter: brightness(1.15);
    box-shadow: inset 0 0 0 1px rgba(237,191,122,0.12);
  }
  .vz-load-a.enabled .vz-load-led { background: #10b981; box-shadow: 0 0 6px #10b981; }
  .vz-load-b.enabled .vz-load-led { background: #00A3FF; box-shadow: 0 0 6px #00A3FF; }
  /* Confirmation en 2 temps */
  .vz-act-confirm {
    width: auto;
    min-width: 76px;
    height: 32px;
    padding: 0 8px;
    border-color: rgba(248,113,113,0.6);
    color: #f87171;
    background: rgba(248,113,113,0.08);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    font-family: var(--font-label-sm, ui-monospace, monospace);
    text-transform: uppercase;
  }
  .vz-act-confirm:hover { background: rgba(248,113,113,0.18); filter: none; }
  .vz-act-conf-cancel { color: #9b8f80; }

  /* recherche : bouton × pour vider */
  .vz-search-clear {
    width: 22px; height: 22px; border-radius: 4px;
    display: inline-flex; align-items: center; justify-content: center;
    color: #9b8f80; cursor: pointer; flex: none;
  }
  .vz-search-clear:hover { color: #edbf7a; background: rgba(237,191,122,0.10); }
</style>