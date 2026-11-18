import { mimeFromPath, type Player } from '$lib/audio/player';
import { audioIpc, type StemPaths, type TrackData, type KeySeg, type TrackSegment } from '$lib/ipc/client';
import { searchMusicBrainz, fetchCoverArtArchive, fetchAcousticBrainzKey } from '$lib/ipc/meta';
import { resolveHybridCamelotKey } from '$lib/audio/hybridKey';
import { parseCamelot, relationFrom } from '$lib/audio/harmony';

export type DeckId = 'A' | 'B';
export type DeckTheme = 'emerald' | 'blue';
export type TransportMode = 'playing' | 'paused' | 'stopped';

export interface DeckState {
  id: DeckId;
  theme: DeckTheme;
  channelTitle: string;
  channelSub: string;
  perimeterLabel: string;
  sideLetter: 'A' | 'B';
  opusLabel: string;
  trackTitle: string;
  artist: string;
  /** ALC-157 : album extrait des tags (vide si absent). */
  album: string;
  genre: string;
  year: string;
  coverUrl: string;
  coverAlt: string;
  serialCode: string;
  camelotKey: string;
  camelotLabel: string;
  keyConfidence: number;
  keySource: string;
  externalKey: string;
  hotCues: number[];
  loopBeats: number | null;
  gridOffsetMs: number;
  gridOctave: number;
  waveformPeaks: number[];
  keyTimeline: KeySeg[];
  /** ALC-146 : segments sonores (RMS 3 bandes + tempo/clé locaux), $state.raw — sous-tableau hors proxy profond. */
  segments: TrackSegment[];
  baseBpm: number;
  pitchPercent: number;
  volumeDb: number;
  lowEqDb: number;
  highEqDb: number;
  elapsedSeconds: number;
  durationSeconds: number;
  transport: TransportMode;
  cueActive: boolean;
  codec: string;
  sampleRate: string;
  bitrate: string;
  stereoMode: string;
  freqResponse: string;
  peakVuDb: string;
  filePath: string | null;
  stems: StemPaths | null;
  isExtractingStems: boolean;
  isAnalyzing: boolean;
  lastError: string | null;
}

export function formatTime(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function computeEffectiveBpm(baseBpm: number, pitchPercent: number): number {
  return Number((baseBpm * (1 + pitchPercent / 100)).toFixed(1));
}

/** Convertit un niveau en dB vers un gain linéaire (helper crossfader égal-puissance). */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** ALC-137-5 : normalise les tirets des titres extraits (`--` → `—`). */
export function normalizeTitle(s: string): string {
  return (s || '')
    .replace(/\s*--\s*/g, ' — ')
    .replace(/\s*–\s*/g, ' — ')
    .replace(/--+/g, '—')
    .replace(/\s+/g, ' ')
    .trim();
}

class AlchemixMixerStore {
  deckA = $state<DeckState>({
    id: 'A',
    theme: 'emerald',
    channelTitle: 'TAPE A • CANAL VERT ÉMERAUDE',
    channelSub: 'DECK A • CANAL PRIMAIRE',
    perimeterLabel: 'CHRONO-PÉRIMÈTRE 01',
    sideLetter: 'A',
    opusLabel: 'OPUS 89',
    trackTitle: '',
    artist: '',
    album: '',
    genre: '',
    year: '',
    coverUrl: '',
    coverAlt: 'Vide — aucune piste chargée',
    serialCode: 'SAN MARCO-89',
    camelotKey: '4B',
    camelotLabel: '4B (Mi Maj)',
    keyConfidence: 0,
    keySource: 'dsp',
    externalKey: '',
    hotCues: [-1, -1, -1, -1],
    loopBeats: null,
    gridOffsetMs: 0,
    gridOctave: 1,
    waveformPeaks: [],
    keyTimeline: [],
    segments: [],
    baseBpm: 122.5,
    pitchPercent: 0.0,
    volumeDb: 0.0,
    lowEqDb: 0,
    highEqDb: 0,
    elapsedSeconds: 0,
    durationSeconds: 0,
    transport: 'stopped',
    cueActive: false,
    codec: '—',
    sampleRate: '—',
    bitrate: '—',
    stereoMode: '—',
    freqResponse: '—',
    peakVuDb: '—',
    filePath: null,
    stems: null,
    isExtractingStems: false,
    isAnalyzing: false,
    lastError: null,
  });

  deckB = $state<DeckState>({
    id: 'B',
    theme: 'blue',
    channelTitle: 'TAPE B • CANAL BLEU ÉLECTRIQUE',
    channelSub: 'DECK B • CANAL SECONDAIRE',
    perimeterLabel: 'CHRONO-PÉRIMÈTRE 02',
    sideLetter: 'B',
    opusLabel: 'OPUS 92',
    trackTitle: '',
    artist: '',
    album: '',
    genre: '',
    year: '',
    coverUrl: '',
    coverAlt: 'Vide — aucune piste chargée',
    serialCode: 'DORSODURO-1889',
    camelotKey: '8B',
    camelotLabel: '8B (Do Maj)',
    keyConfidence: 0,
    keySource: 'dsp',
    externalKey: '',
    hotCues: [-1, -1, -1, -1],
    loopBeats: null,
    gridOffsetMs: 0,
    gridOctave: 1,
    waveformPeaks: [],
    keyTimeline: [],
    segments: [],
    baseBpm: 126.0,
    pitchPercent: 0.0,
    volumeDb: 0.0,
    lowEqDb: 0,
    highEqDb: 0,
    elapsedSeconds: 0,
    durationSeconds: 0,
    transport: 'stopped',
    cueActive: false,
    codec: '—',
    sampleRate: '—',
    bitrate: '—',
    stereoMode: '—',
    freqResponse: '—',
    peakVuDb: '—',
    filePath: null,
    stems: null,
    isExtractingStems: false,
    isAnalyzing: false,
    lastError: null,
  });

  crossfader = $state<number>(50);
  // ALC-105-2 : position normalisée [0,1] + loi de puissance égale (gainA=cos, gainB=sin).
  crossfaderX = $derived(this.crossfader / 100);
  gainCrossA = $derived(Math.cos((this.crossfaderX * Math.PI) / 2));
  gainCrossB = $derived(Math.sin((this.crossfaderX * Math.PI) / 2));

  // ── ALC-170 A/B : AUTO-MIX 8/16 mesures — moteur d'auto-transition & Bass-Swap automatique ──
  autoMixActive = $state(false);
  autoMixBars = $state<8 | 16>(16);
  autoMixDirection = $state<'A_TO_B' | 'B_TO_A'>('A_TO_B');
  /** Progression $p ∈ [0,1] de l'auto-mix courant (0 quand inactif). */
  autoMixProgress = $state(0);
  /** Réduction grave (dB) pilotée par l'AUTO-MIX sur chaque platine (0 = EQ neutre). */
  autoBassA = $state(0);
  autoBassB = $state(0);

  private _autoRaf = 0;
  private _autoStart = 0;
  private _autoDur = 0;
  private _autoFromCross = 50;
  private _autoToCross = 100;
  private _autoOut: DeckId = 'A';
  private _autoIn: DeckId = 'B';
  private _autoInLowStart = 0;

  /** Durée exacte de l'auto-transition (s) : bars × 4 × 60 / BPM effectif de la platine maître, repli 120 BPM. */
  autoMixDuration = $derived(
    this.autoMixActive && this._autoDur > 0 ? this._autoDur : 0
  );

  setAutoMixBars(bars: 8 | 16) {
    if (!this.autoMixActive) this.autoMixBars = bars;
  }

  /** Lance l'AUTO-MIX : transition assistée du crossfader + Bass-Swap sur les LOW EQ + pitch glide. */
  startAutoMix(bars: 8 | 16, direction: 'A_TO_B' | 'B_TO_A') {
    this.cancelAutoMix();
    const outId: DeckId = direction === 'A_TO_B' ? 'A' : 'B';
    const inId: DeckId = direction === 'A_TO_B' ? 'B' : 'A';
    const outDeck = this.getDeck(outId);
    const inDeck = this.getDeck(inId);
    if (!outDeck.filePath || !inDeck.filePath || !this.getPlayer(outId) || !this.getPlayer(inId)) return;
    const masterBpm = outId === 'A' ? this.effectiveBpmA : this.effectiveBpmB;
    const duration = bars * 4 * (60 / (masterBpm > 0 ? masterBpm : 120));
    this.autoMixBars = bars;
    this.autoMixDirection = direction;
    this.autoMixProgress = 0;
    this.autoBassA = 0;
    this.autoBassB = 0;
    this._autoOut = outId;
    this._autoIn = inId;
    this._autoFromCross = this.crossfader;
    this._autoToCross = direction === 'A_TO_B' ? 100 : 0;
    this._autoInLowStart = inDeck.lowEqDb;
    this._autoDur = duration;
    this._autoStart = performance.now();
    this.autoMixActive = true;
    const tick = (now: number) => {
      if (!this.autoMixActive) return;
      const p = Math.min(1, Math.max(0, (now - this._autoStart) / this._autoDur));
      this.stepAutoMix(p);
      if (p >= 1) { this.finishAutoMix(); return; }
      this._autoRaf = requestAnimationFrame(tick);
    };
    this._autoRaf = requestAnimationFrame(tick);
  }

  private stepAutoMix(p: number) {
    // 1) Crossfader Master : déplacement fluide vers la platine cible (0 pour A, 100 pour B).
    this.crossfader = this._autoFromCross + (this._autoToCross - this._autoFromCross) * p;
    // 2) Bass-Swap : coupe progressive du grave sortant, neutralisation du grave entrant, puis restauration.
    const inn = this.getDeck(this._autoIn);
    const OUT_CUT = -20; // atténuation profonde (évite annulation de phase / surcharge sub-bass)
    const ATTACK = 0.45; // pleine coupe atteinte à 45 % du parcours
    const RESTORE = 0.9; // restauration propre dès que le volume sortant est coupé
    const outCut = p < RESTORE ? Math.round(Math.min(1, p / ATTACK) * OUT_CUT * 10) / 10 : 0;
    const inTotalZero = Math.round(-this._autoInLowStart * Math.min(1, p / ATTACK) * 10) / 10; // grave entrant → 0.0 dB
    if (this._autoOut === 'A') { this.autoBassA = outCut; this.autoBassB = inTotalZero; }
    else { this.autoBassB = outCut; this.autoBassA = inTotalZero; }
    // 3) Pitch glide : pendant la première moitié, glisse le pitch entrant vers le tempo maître si écart ≤ 6 %.
    const masterBpm = this._autoOut === 'A' ? this.effectiveBpmA : this.effectiveBpmB;
    const targetPitch = Number((masterBpm / (inn.baseBpm || 120) - 1) * 100)
    if (Math.abs(targetPitch - inn.pitchPercent) <= 6) {
      inn.pitchPercent = Number((inn.pitchPercent + (targetPitch - inn.pitchPercent) * Math.min(1, p / 0.5)).toFixed(2));
    }
    this.autoMixProgress = p;
  }

  private finishAutoMix() {
    this.autoBassA = 0;
    this.autoBassB = 0;
    cancelAnimationFrame(this._autoRaf);
    this.autoMixActive = false;
    this.autoMixProgress = 0;
  }

  /** Arrêt immédiat : restaure l'EQ grave et stoppe l'automate (appelé sur intervention manuelle du DJ). */
  cancelAutoMix() {
    const wasActive = this.autoMixActive;
    if (this._autoRaf) cancelAnimationFrame(this._autoRaf);
    this.autoBassA = 0;
    this.autoBassB = 0;
    this.autoMixActive = false;
    this.autoMixProgress = 0;
    void wasActive;
  }

  // ── ALC-171 : pré-écoute audio locale UNIFIÉE — read_audio_file_bytes → Blob URL ──
  /** Chemin du fichier actuellement en pré-écoute (source de vérité pour l'icône ▶/❚❚). */
  previewPath = $state<string | null>(null);
  previewKey = $state<string | null>(null);
  private _previewAudio: HTMLAudioElement | null = null;
  private _previewUrl: string | null = null;

  isPreviewingFile(path: string): boolean {
    return this.previewPath === path && !!this._previewAudio;
  }

  stopFilePreview() {
    if (this._previewAudio) {
      this._previewAudio.pause();
      this._previewAudio = null;
    }
    if (this._previewUrl) {
      URL.revokeObjectURL(this._previewUrl);
      this._previewUrl = null;
    }
    this.previewPath = null;
    this.previewKey = null;
  }

  /**
   * Prée-écoute une piste locale via le pipeline éprouvé read_audio_file_bytes → Blob URL
   * (mimeFromPath), comme Player.ts — évite le blocage asset:// / CORS de WebView2.
   * Bascule (stop) si le même fichier est déjà en lecture ; révocation de l'ancienne URL blob.
   */
  async toggleFilePreview(filePath: string, key: string | null = null) {
    if (this.isPreviewingFile(filePath)) {
      this.stopFilePreview();
      return;
    }
    this.stopFilePreview();
    try {
      const bytes: number[] = await audioIpc.readAudioFileBytes(filePath);
      const mime = mimeFromPath(filePath);
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
      const audio = new Audio(url);
      audio.volume = 0.8;
      audio.addEventListener('ended', () => this.stopFilePreview());
      audio.addEventListener('error', () => {
        console.error('[Pré-écoute] décodage impossible :', filePath);
        this.stopFilePreview();
      });
      this._previewUrl = url;
      this._previewAudio = audio;
      this.previewPath = filePath;
      this.previewKey = key;
      try {
        await audio.play();
      } catch (err) {
        console.error('[Pré-écoute] lecture impossible :', filePath, err);
        this.stopFilePreview();
      }
    } catch (err) {
      console.error('[Pré-écoute] lecture des octets impossible :', filePath, err);
    }
  }
  centerView = $state<'camelot' | 'beatgrid' | 'library'>('camelot');
  isAnalyzing = $state<boolean>(false);
  /** Indicateur d'analyse MIR en cours sur l'un des deux platines (Deck A ou B). */
  anyAnalyzing = $derived(this.deckA.isAnalyzing || this.deckB.isAnalyzing);

  // ALC-146 : segments sonores par platine en $state.raw<TrackSegment[]> — tableaux volumineux
  // (RMS 3 bandes + tempo/clé locaux) hors du proxy profond pour zéro overhead d'observation.
  deckSegmentsA = $state.raw<TrackSegment[]>([]);
  deckSegmentsB = $state.raw<TrackSegment[]>([]);
  /** ALC-146 : sélecteur de calque de la waveform — 'tempo' (dérive locale) ou 'camelot' (clés locales). */
  beatgridOverlayMode = $state<'tempo' | 'camelot'>('tempo');

  // ALC-102-1 : télémétrie VU temps réel (RMS / Peak en dBFS) par platine.
  rmsDbA = $state(-20);
  peakDbA = $state(-20);
  rmsDbB = $state(-20);
  peakDbB = $state(-20);
  isClipping = $state(false);

  setLevels(id: DeckId, rmsDb: number, peakDb: number) {
    if (id === 'A') {
      this.rmsDbA = rmsDb;
      this.peakDbA = peakDb;
    } else {
      this.rmsDbB = rmsDb;
      this.peakDbB = peakDb;
    }
    this.isClipping = this.peakDbA >= 0 || this.peakDbB >= 0;
  }

  resetLevels(id: DeckId) {
    this.setLevels(id, -20, -20);
    this.isClipping = this.peakDbA >= 0 || this.peakDbB >= 0;
  }

  effectiveBpmA = $derived(computeEffectiveBpm(this.deckA.baseBpm, this.deckA.pitchPercent));
  effectiveBpmB = $derived(computeEffectiveBpm(this.deckB.baseBpm, this.deckB.pitchPercent));

  /** Écart de BPM calculé réactivement entre Deck B et Deck A */
  bpmDelta = $derived(Number((this.effectiveBpmB - this.effectiveBpmA).toFixed(2)));
  isBpmLocked = $derived(Math.abs(this.bpmDelta) <= 0.15);

  // ALC-143 : conflit harmonique réactif (source unique harmony.ts) + mode Smart Filter.
  private harmonyRel = $derived(
    relationFrom(
      this.deckA.filePath ? parseCamelot(this.deckA.camelotKey) : null,
      this.deckB.filePath ? parseCamelot(this.deckB.camelotKey) : null
    )
  );
  isHarmonyDissonant = $derived(!!this.harmonyRel && !this.harmonyRel.rel && this.harmonyRel.ring >= 3);
  smartFilterActive = $state(false);
  /** Réduction auto (dB) appliquée aux graves & médiums tant que Smart Filter actif + clés incompatibles. */
  smartFilterDb = $derived(this.smartFilterActive && this.isHarmonyDissonant ? -6 : 0);
  toggleSmartFilter() {
    this.smartFilterActive = !this.smartFilterActive;
  }

  getDeck(id: DeckId): DeckState {
    return id === 'A' ? this.deckA : this.deckB;
  }

  // ALC-142 : registre des lecteurs (BeatgridView accède aux Player pour hot cues / loops / phase).
  private _players: Record<DeckId, Player | null> = { A: null, B: null };
  registerPlayer(id: DeckId, p: Player | null) { this._players[id] = p; }
  getPlayer(id: DeckId): Player | null { return this._players[id]; }

  // ALC-142 : hot cues (4) — poser / rappeler des positions temporelles.
  setHotCue(id: DeckId, idx: number) {
    this.getDeck(id).hotCues[idx] = Number(this.getDeck(id).elapsedSeconds.toFixed(2));
  }
  clearHotCue(id: DeckId, idx: number) { this.getDeck(id).hotCues[idx] = -1; }
  recallHotCue(id: DeckId, idx: number) {
    const d = this.getDeck(id);
    if (d.hotCues[idx] >= 0) this.getPlayer(id)?.seek(d.hotCues[idx]);
  }
  // ALC-142 : auto-loop quantifié (T_beat = 60 / BPM effectif) via le Player.
  setLoop(id: DeckId, beats: number | null) {
    const d = this.getDeck(id);
    d.loopBeats = beats;
    const p = this.getPlayer(id);
    if (!p) return;
    if (beats) p.setQuantizedLoop(beats, id === 'A' ? this.effectiveBpmA : this.effectiveBpmB);
    else p.clearLoop();
  }
  // ALC-142 : édition de grille.
  nudgeGrid(id: DeckId, ms: number) {
    const d = this.getDeck(id);
    d.gridOffsetMs = Math.round((d.gridOffsetMs || 0) + ms);
  }
  anchorGrid(id: DeckId) {
    this.getDeck(id).gridOffsetMs = Math.round(this.getDeck(id).elapsedSeconds * 1000);
  }
  // ALC-142 : correcteur d'octave de grille (÷2 / ×2) — double/halve la résolution rythmique de la grille.
  octaveGrid(id: DeckId, factor: 0.5 | 2) {
    const d = this.getDeck(id);
    const v = Math.max(0.25, Math.min(4, (d.gridOctave || 1) * factor));
    d.gridOctave = v === 1 ? 1 : Math.round(v * 100) / 100;
  }
  // ALC-142 : ALIGNER TEMPO & PHASE — deck B pratiquement calé sur deck A (pitch + position).
  alignTempoAndPhase() {
    const bpmA = this.effectiveBpmA;
    const baseB = this.deckB.baseBpm || 120;
    this.deckB.pitchPercent = Number(((bpmA / baseB - 1) * 100).toFixed(2));
    this.deckB.elapsedSeconds = this.deckA.elapsedSeconds;
  }

  setTransport(id: DeckId, mode: TransportMode) {
    const deck = this.getDeck(id);
    deck.transport = mode;
    if (mode !== 'paused') deck.cueActive = false;
    if (mode === 'stopped') deck.elapsedSeconds = 0;
  }

  /** Navigation rapide ±20 s (REW / FFWD) — renvoie la nouvelle position pour synchroniser le Player. */
  seek(id: DeckId, delta: number) {
    const deck = this.getDeck(id);
    deck.elapsedSeconds = Math.max(0, Math.min(deck.durationSeconds, deck.elapsedSeconds + delta));
    return deck.elapsedSeconds;
  }

  /** ALC-136-3 : synchronise position/durée du ROLL depuis l'élément <audio> (source de vérité lecture). */
  syncPlayback(id: DeckId, current: number, duration: number) {
    const deck = this.getDeck(id);
    if (duration > 0) deck.durationSeconds = duration;
    if (deck.transport === 'playing' && Number.isFinite(current)) deck.elapsedSeconds = current;
  }

  triggerCue(id: DeckId) {
    const deck = this.getDeck(id);
    deck.cueActive = !deck.cueActive;
    if (deck.cueActive) {
      deck.transport = 'paused';
    }
  }

  async loadTrackFromPath(id: DeckId, path: string) {
    const deck = this.getDeck(id);
    deck.lastError = null;
    // ALC-124 : active l'indicateur d'analyse MIR en cours pour ce platine.
    deck.isAnalyzing = true;
    try {
      const data: TrackData = await audioIpc.loadAudioFile(path);
      deck.filePath = data.path;
      deck.trackTitle = normalizeTitle(data.title);
      // ALC-157 : métadonnées réelles extraites des tags (aucune valeur de test).
      deck.album = data.album || '';
      deck.genre = data.genre || '';
      deck.artist = data.artist || '';
      deck.year = data.year || '';
      deck.serialCode = data.serialCode;
      deck.baseBpm = data.bpm;
      deck.pitchPercent = 0;
      deck.camelotKey = data.camelotKey;
      deck.camelotLabel = data.camelotKey;
      deck.keyConfidence = data.keyConfidence || 0;
      deck.keySource = 'dsp';
      deck.externalKey = '';
      deck.waveformPeaks = data.waveformPeaks || [];
      deck.keyTimeline = data.keyTimeline || [];
      deck.segments = data.segments || [];
      // ALC-146 : segments ultra-légers en $state.raw, remplacés par référence (pas de mutation profonde).
      if (id === 'A') this.deckSegmentsA = data.segments || [];
      else this.deckSegmentsB = data.segments || [];
      deck.durationSeconds = data.durationSeconds;
      deck.elapsedSeconds = 0;
      // ALC-122-1 : réinitialise explicitement l'état de lecture (isPlaying=false) au chargement
      // afin que PLAY ne reste pas « enfoncé » et puisse lancer la lecture dès le premier clic.
      deck.transport = 'stopped';
      deck.cueActive = false;
      deck.codec = data.codec;
      deck.sampleRate = `${(data.sampleRate / 1000).toFixed(1)} kHz / ${data.bitDepth}-bit`;
      deck.bitrate = `${data.bitrateKbps} kbps`;
      // ALC-127-2 : pochette embarquée (extraction Rust) → coverUrl
      deck.coverUrl = data.coverData || '';
      // ALC-134 : enrichissement MusicBrainz / Cover Art Archive si les tags lofty sont génériques.
      await this.enrichMetadataFromExternal(id, data);
      // Actualise immédiatement le BPM effectif & la clé Camelot via le pont IPC (ALC-006-3)
      await this.refreshTempoCamelot(id);
    } catch (err) {
      deck.lastError = err instanceof Error ? err.message : 'Échec de chargement audio';
    } finally {
      deck.isAnalyzing = false; // ALC-124 : libère l'indicateur dès que le backend a répondu.
    }
  }

  async extractStems(id: DeckId) {
    const deck = this.getDeck(id);
    const targetPath = deck.filePath ?? `/audio/${deck.serialCode.toLowerCase()}.flac`;
    deck.isExtractingStems = true;
    deck.lastError = null;
    try {
      deck.stems = await audioIpc.extractStemsOnnx(targetPath);
    } catch (err) {
      deck.lastError = err instanceof Error ? err.message : 'Échec extraction ONNX';
    } finally {
      deck.isExtractingStems = false;
    }
  }

  /**
   * Interroge le pont IPC Rust (detect_tempo_camelot) pour actualiser en temps réel
   * le BPM effectif et la clé Camelot d'un deck, puis la Roue réagit (ALC-006-3).
   */
  /** Fallback API iTunes Search pour la pochette d'album (ALC-127-3). */
  async fetchCoverFallback(id: DeckId, title: string, artist: string) {
    try {
      const term = encodeURIComponent(`${artist} ${title}`.trim());
      const res = await fetch(`https://itunes.apple.com/search?term=${term}&media=music&limit=1`);
      const json = await res.json();
      const artwork: string | undefined = json?.results?.[0]?.artworkUrl100;
      if (artwork) {
        // Upgrade vers 600×600 (artworkUrl100 → remplacement du suffixe).
        this.getDeck(id).coverUrl = artwork
          .replace('100x100bb', '600x600bb')
          .replace('100x100', '600x600');
      }
    } catch { /* le réseau peut être indisponible — on garde l'absence de pochette */ }
  }

  /**
   * ALC-157 : si les tags lofty locaux sont absents ou réduits au nom de fichier, interroge
   * MusicBrainz (titre, artiste, année, genre, MBID) et ajoute la pochette Cover Art Archive.
   */
  async enrichMetadataFromExternal(id: DeckId, data: TrackData) {
    const deck = this.getDeck(id);
    const hasRealTags = !!(
      data.title &&
      (data.artist || data.genre || data.album) &&
      !/[_\[\(]/.test(data.title));

    if (hasRealTags) {
      // Tags réels : on conserve le fallback pochette iTunes historique (ALC-127-3).
      if (!deck.coverUrl && (data.title || data.artist)) this.fetchCoverFallback(id, data.title, data.artist);
      return;
    }

    const mb = await searchMusicBrainz(data.artist, data.title);
    if (mb) {
      deck.trackTitle = normalizeTitle(mb.title || deck.trackTitle);
      deck.artist = mb.artist || deck.artist;
      deck.genre = mb.genre || deck.genre;
      deck.year = mb.year || '';
      if (!deck.coverUrl) {
        const caa = fetchCoverArtArchive(mb.releaseMbid);
        if (mb.releaseMbid && caa) deck.coverUrl = caa;
        else if (mb.title || mb.artist) this.fetchCoverFallback(id, mb.title, mb.artist);
      }
      // ALC-141 : arbitrage harmonique hybride — croise la clé DSP locale avec AcousticBrainz.
      if (mb.recordingMbid) {
        const ext = await fetchAcousticBrainzKey(mb.recordingMbid);
        if (ext) {
          const res = resolveHybridCamelotKey({ camelotKey: deck.camelotKey, confidence: deck.keyConfidence }, ext);
          deck.camelotKey = res.camelotKey;
          deck.camelotLabel = res.camelotKey;
          deck.keySource = res.source;
          deck.externalKey = res.externalKey;
        }
      }
    } else if (!deck.coverUrl && (data.title || data.artist)) {
      this.fetchCoverFallback(id, data.title, data.artist);
    }
  }

  async refreshTempoCamelot(id: DeckId) {
    const deck = this.getDeck(id);
    deck.lastError = null;
    try {
      const res = await audioIpc.detectTempoCamelot({
        baseBpm: deck.baseBpm,
        pitchPercent: deck.pitchPercent,
        camelotKey: deck.camelotKey,
      });
      deck.baseBpm = res.bpm;
      deck.pitchPercent = res.pitchPercent;
      deck.camelotKey = res.camelotKey;
      deck.camelotLabel = res.camelotLabel;
    } catch (err) {
      deck.lastError = err instanceof Error ? err.message : 'Échec analyse tempo/clé';
    }
  }

  /** Décharge la piste d'un platine (ALC-129) : arrêt, vidage filePath, reset piste/pochette. */
  eject(id: DeckId) {
    const deck = this.getDeck(id);
    deck.transport = 'stopped';
    deck.filePath = null;
    deck.trackTitle = '';
    deck.artist = '';
    deck.album = '';
    deck.genre = '';
    deck.year = '';
    deck.coverUrl = '';
    deck.lowEqDb = 0;
    deck.highEqDb = 0;
    deck.waveformPeaks = [];
    deck.keyTimeline = [];
    deck.segments = [];
    // ALC-146 : ne vide que le platine éjecté (l'autre conserve sa segmentation analytique).
    if (id === 'A') this.deckSegmentsA = [];
    else this.deckSegmentsB = [];
    deck.coverAlt = 'Vide — aucune piste chargée';
    deck.baseBpm = 0;
    deck.pitchPercent = 0;
    deck.elapsedSeconds = 0;
    deck.durationSeconds = 0;
    deck.codec = '—';
    deck.lastError = null;
  }

  /** Déclenche l'analyse temps réel sur les deux decks (utilisé lors du chargement/analyse). */
  async analyzeAllTempoCamelot() {
    await Promise.all([
      this.refreshTempoCamelot('A'),
      this.refreshTempoCamelot('B'),
    ]);
  }

  // ALC-132-3 : horloge de lecture — avance elapsedSeconds (MM:SS) pour les decks en lecture.
  private _clockId: number | undefined;
  startClock() {
    if (this._clockId !== undefined) return;
    this._clockId = window.setInterval(() => this.advanceClock(), 250);
  }
  private advanceClock() {
    const dt = 0.25;
    [this.deckA, this.deckB].forEach((deck) => {
      if (deck.transport === 'playing' && deck.durationSeconds > 0) {
        deck.elapsedSeconds = Math.min(deck.durationSeconds, deck.elapsedSeconds + dt);
      }
    });
  }
}

export const mixerStore = new AlchemixMixerStore();
