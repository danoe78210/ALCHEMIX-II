import { invoke } from '@tauri-apps/api/core';

export interface TrackData {
  id: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: string;
  tagBpm: number;
  tagKey: string;
  serialCode: string;
  bpm: number;
  camelotKey: string;
  keyConfidence: number;
  durationSeconds: number;
  sampleRate: number;
  bitDepth: number;
  bitrateKbps: number;
  codec: string;
  waveformPeaks: number[];
  keyTimeline: KeySeg[];
  segments: TrackSegment[];
  coverData: string;
}

/** ALC-146 : segment sonore de la frise — bandes de fréquence normalisées, tempo et clé locaux. */
export interface TrackSegment {
  startSec: number;
  endSec: number;
  rmsLow: number;
  rmsMid: number;
  rmsHigh: number;
  localBpm: number;
  localCamelot: string;
}

/** ALC-144 : segment tonal (clé Camelot par fenêtre temporelle) pour la heatmap harmonique. */
export interface KeySeg {
  timeSeconds: number;
  camelotKey: string;
  confidence: number;
}

export interface TempoCamelot {
  bpm: number;
  camelotKey: string;
  camelotLabel: string;
  pitchPercent: number;
  effectiveBpm: number;
}

export interface StemPaths {
  sourcePath: string;
  vocals: string;
  drums: string;
  bass: string;
  other: string;
  modelVersion: string;
  processingTimeMs: number;
}

export interface IpcErrorPayload {
  code: string;
  message: string;
}

export class IpcError extends Error {
  readonly code: string;

  constructor(payload: IpcErrorPayload) {
    super(payload.message);
    this.code = payload.code;
  }
}

async function safeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
      throw new IpcError(err as IpcErrorPayload);
    }
    throw new IpcError({
      code: 'IPC_UNKNOWN',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface AudioBytes {
  bytes: number[];
  mime: string;
  name: string;
}

export const audioIpc = {
  /**
   * Ouvre le sélecteur de fichiers système (commande Rust `open_audio_file`),
   * filtré sur les formats audio, et renvoie le chemin choisi (ou `null` si annulé).
   */
  openAudioFile(): Promise<string | null> {
    return safeInvoke<string | null>('open_audio_file');
  },
  loadAudioFile(path: string): Promise<TrackData> {
    return safeInvoke<TrackData>('load_audio_file', { path });
  },
  /** ALC-136-2 : lit les octets d'un fichier local (commande Rust) pour une URL blob: (Player). */
  readAudioFileBytes(path: string): Promise<number[]> {
    return safeInvoke<number[]>('read_audio_file_bytes', { path });
  },
  /** ALC-139-2 : fermeture propre de l'application Tauri. */
  exitApp(): Promise<void> {
    return safeInvoke<void>('exit_app');
  },
  /** Expose en temps réel le BPM effectif et la clé Camelot (pont IPC ALC-006-3). */
  detectTempoCamelot(args: {
    baseBpm: number;
    pitchPercent: number;
    camelotKey?: string | null;
  }): Promise<TempoCamelot> {
    return safeInvoke<TempoCamelot>('detect_tempo_camelot', {
      baseBpm: args.baseBpm,
      pitchPercent: args.pitchPercent,
      camelotKey: args.camelotKey ?? null,
    });
  },
  extractStemsOnnx(path: string): Promise<StemPaths> {
    return safeInvoke<StemPaths>('extract_stems_onnx', { path });
  },
};

// ── ALC-165 : catalogue de la LIBRAIRIE (base SQLite locale, backend `library.rs`) ──────────────

/** Une piste du catalogue (Serde Rust `rename_all = "camelCase"`). */
export interface LibraryTrack {
  id: number;
  filePath: string;
  title: string;
  artist: string;
  genre: string;
  camelotKey: string;
  bpm: number;
  durationSec: number;
  addedAt: string;
  codec?: string;
  coverData?: string;
}

/** Piste fournie au catalogue (archivage depuis une Platine ou import de dossier). */
export interface LibraryTrackInput {
  filePath: string;
  title?: string | null;
  artist?: string | null;
  genre?: string | null;
  camelotKey?: string | null;
  bpm?: number | null;
  durationSec?: number | null;
  coverData?: string | null;
}

/** Bilan d'un import de dossier (Serde camelCase). */
export interface LibraryImportReport {
  folderPath: string;
  found: number;
  inserted: number;
  updated: number;
  failed: number;
  totalTracks: number;
  elapsedMs: number;
}

/** Duo validé (paire non ordonnée, `trackAId < trackBId`). */
export interface ValidatedDuo {
  trackAId: number;
  trackBId: number;
  note: string;
  createdAt: string;
}

/** Progression d'un import, diffusée sur l'événement `library://scan`. */
export interface LibraryScanProgress {
  done: number;
  total: number;
  current: string;
}

export const libraryIpc = {
  listTracks(): Promise<LibraryTrack[]> {
    return safeInvoke<LibraryTrack[]>('library_list_tracks', {});
  },
  upsertTrack(track: LibraryTrackInput): Promise<LibraryTrack> {
    return safeInvoke<LibraryTrack>('library_upsert_track', { track });
  },
  importFolder(folderPath: string): Promise<LibraryImportReport> {
    return safeInvoke<LibraryImportReport>('library_import_folder', { folderPath });
  },
  deleteTrack(id: number): Promise<boolean> {
    return safeInvoke<boolean>('library_delete_track', { id });
  },
  toggleDuo(trackAId: number, trackBId: number): Promise<boolean> {
    return safeInvoke<boolean>('library_toggle_duo', { trackAId, trackBId });
  },
  listDuos(): Promise<ValidatedDuo[]> {
    return safeInvoke<ValidatedDuo[]>('library_list_duos', {});
  },
  /** ALC-166-4 : édition rapide des métadonnées (titre/genre Option) directement en base. */
  updateTrackMeta(id: number, title: string | null, genre: string | null): Promise<LibraryTrack> {
    return safeInvoke<LibraryTrack>('library_update_track_meta', { id, title, genre });
  },
};
