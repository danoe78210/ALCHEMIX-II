import { audioIpc, type StemPaths, type TrackData } from '$lib/ipc/client';

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
  genre: string;
  coverUrl: string;
  coverAlt: string;
  serialCode: string;
  camelotKey: string;
  camelotLabel: string;
  baseBpm: number;
  pitchPercent: number;
  volumeDb: number;
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

class AlchemixMixerStore {
  deckA = $state<DeckState>({
    id: 'A',
    theme: 'emerald',
    channelTitle: 'TAPE A • CANAL VERT ÉMERAUDE',
    channelSub: 'DECK A • CANAL PRIMAIRE',
    perimeterLabel: 'CHRONO-PÉRIMÈTRE 01',
    sideLetter: 'A',
    opusLabel: 'OPUS 89',
    trackTitle: 'Barcarolle Mécanique',
    genre: 'Steampunk Baroque / Dark Electro',
    coverUrl: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCJ93K3FIbjSNPr2pTBl9z8143fUccl9uZ6M1BCmyiMlbHsaY62xSCqlDvyIM_svovkQ_NpqV-CDg2dkJt0Kj2ReBxBJGZqI0bmfixFWOo7Pz8dM0XSlfcW86VNte2HM-Xr4I5fL-Uijg1xn-WVrEA-UrDPOUkNQein09Qphr0ADbF5Q0OOvIpflIXB2t7j0hRxFAq1_-QooP9CmnBGSt6sF76rTKNL1WgH5rKm-KU',
    coverAlt:
      'Ornate Venetian Renaissance clockwork illustration with intricate gold gears, an emerald canal reflection in Venice at midnight, deep shadow, baroque oil painting finish, fine aesthetic details.',
    serialCode: 'SAN MARCO-89',
    camelotKey: '4B',
    camelotLabel: '4B (Mi Maj)',
    baseBpm: 122.5,
    pitchPercent: 1.2,
    volumeDb: 0.0,
    elapsedSeconds: 222,
    durationSeconds: 368,
    transport: 'playing',
    cueActive: false,
    codec: 'FLAC',
    sampleRate: '96.0 kHz / 24-bit',
    bitrate: '4608 kbps',
    stereoMode: 'STÉRÉO (Phase L/R Lock)',
    freqResponse: '20 Hz - 44 kHz',
    peakVuDb: '+1.8 dB VU',
    filePath: null,
    stems: null,
    isExtractingStems: false,
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
    trackTitle: "L'Automate de Lido",
    genre: 'Venetian Clockwork Ensemble',
    coverUrl: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDGO94KvOuCqQHBtlWm1-AIH4R6dkGCH1kROJSdY0jCNLJzMzWUQrIoXNJZy-_Z64uoXcMwKd06GZCY4Nk-Fa_phqwgIOg37EmX_KBImmLVj_p8KnnqCAyqYLCFPSUUybWVunjrjwbLgqf6lYG1djgCPO1cZR_s_QJNX8V8chqYBayE_fdB6N-4rCf534RHNWEA8mNomrkRZ8XPPZ2fkayaeH0jvLR6Zy4FP29zTz0',
    coverAlt:
      'Mechanical copper automaton dressed in Venetian carnival attire, electric blue steam vents, dark atmospheric workshop setting with brass chronometers and antique dials, dramatic lighting.',
    serialCode: 'DORSODURO-1889',
    camelotKey: '8B',
    camelotLabel: '8B (Do Maj)',
    baseBpm: 126.0,
    pitchPercent: -1.6,
    volumeDb: 0.0,
    elapsedSeconds: 78,
    durationSeconds: 342,
    transport: 'playing',
    cueActive: false,
    codec: 'FLAC',
    sampleRate: '96.0 kHz / 24-bit',
    bitrate: '4608 kbps',
    stereoMode: 'STÉRÉO (L/R Calé)',
    freqResponse: '20 Hz - 44 kHz',
    peakVuDb: '+1.2 dB VU',
    filePath: null,
    stems: null,
    isExtractingStems: false,
    lastError: null,
  });

  crossfader = $state<number>(50);
  centerView = $state<'camelot' | 'beatgrid'>('camelot');
  isAnalyzing = $state<boolean>(false);

  effectiveBpmA = $derived(computeEffectiveBpm(this.deckA.baseBpm, this.deckA.pitchPercent));
  effectiveBpmB = $derived(computeEffectiveBpm(this.deckB.baseBpm, this.deckB.pitchPercent));

  /** Écart de BPM calculé réactivement entre Deck B et Deck A */
  bpmDelta = $derived(Number((this.effectiveBpmB - this.effectiveBpmA).toFixed(2)));
  isBpmLocked = $derived(Math.abs(this.bpmDelta) <= 0.15);

  getDeck(id: DeckId): DeckState {
    return id === 'A' ? this.deckA : this.deckB;
  }

  setTransport(id: DeckId, mode: TransportMode) {
    const deck = this.getDeck(id);
    deck.transport = mode;
    if (mode !== 'paused') deck.cueActive = false;
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
    try {
      const data: TrackData = await audioIpc.loadAudioFile(path);
      deck.filePath = data.path;
      deck.trackTitle = data.title;
      deck.genre = data.genre;
      deck.serialCode = data.serialCode;
      deck.baseBpm = data.bpm;
      deck.pitchPercent = 0;
      deck.camelotKey = data.camelotKey;
      deck.camelotLabel = data.camelotKey;
      deck.durationSeconds = data.durationSeconds;
      deck.elapsedSeconds = 0;
      deck.codec = data.codec;
      deck.sampleRate = `${(data.sampleRate / 1000).toFixed(1)} kHz / ${data.bitDepth}-bit`;
      deck.bitrate = `${data.bitrateKbps} kbps`;
      // Actualise immédiatement le BPM effectif & la clé Camelot via le pont IPC (ALC-006-3)
      await this.refreshTempoCamelot(id);
    } catch (err) {
      deck.lastError = err instanceof Error ? err.message : 'Échec de chargement audio';
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

  /** Déclenche l'analyse temps réel sur les deux decks (utilisé lors du chargement/analyse). */
  async analyzeAllTempoCamelot() {
    await Promise.all([
      this.refreshTempoCamelot('A'),
      this.refreshTempoCamelot('B'),
    ]);
  }
}

export const mixerStore = new AlchemixMixerStore();
