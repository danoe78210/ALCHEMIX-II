import { invoke, Channel } from '@tauri-apps/api/core';

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
  /** ALC-255 WP16 : débit binaire réel (kbps), `null` si lofty ne l'expose pas. */
  bitrateKbps: number | null;
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

/** ALC-242 : télémétrie HTDemucs (BPM sur drums, clé Camelot sur other+bass, densité vocale…). */
export interface StemsTelemetry {
  bpm: number | null;
  camelotKey: string | null;
  camelotConfidence: number;
  vocalActivityRatio: number;
  midCongestionScore: number;
  drumsEnergy: number;
  firstDownbeatSeconds: number | null; // ALC-253-1 : downbeat percussif (kick) en secondes
  calibratedAt: string;
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
  /** ALC-195-2 : lit un fichier en ArrayBuffer BRUT (invoke binaire `read_audio_file_raw`) — aucun JSON. */
  readAudioFileRaw(path: string): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>('read_audio_file_raw', { path });
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
  /** ALC-174 : séparation 4 Stems (HTDemucs / ONNX local) avec progression. */
  separateStems(path: string, onProgress: Channel<number>): Promise<StemPaths> {
    return safeInvoke<StemPaths>('separate_stems', { path, onProgress });
  },
  /** ALC-174 : rechargement instantané des stems déjà calculés (cache disque). */
  checkCachedStems(path: string): Promise<StemPaths | null> {
    return safeInvoke<StemPaths | null>('check_cached_stems', { path });
  },
  /** ALC-177 : copie les 4 WAV stems du cache vers un dossier utilisateur, renommés <préfixe> - <stem>.wav. */
  exportStemsToFolder(filePath: string, destDir: string, trackPrefix: string | null): Promise<string[]> {
    return safeInvoke<string[]>('export_stems_to_folder', { filePath, destDir, trackPrefix });
  },
  /** ALC-242 / ALC-243 : télémétrie HTDemucs (lit `stems_meta.json` ; `referenceBpm` borne le BPM
   * drums et `force=true` purge/recalcule les métadonnées erronées — ex. biais ×1,25). */
  stemsTelemetry(path: string, referenceBpm?: number | null, force?: boolean): Promise<StemsTelemetry | null> {
    return safeInvoke<StemsTelemetry | null>('stems_telemetry', {
      path,
      referenceBpm: referenceBpm ?? null,
      force: force ?? false,
    });
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

/** ALC-232 : payload d'édition manuelle des tags (tous les champs optionnels). */
export interface LibraryTrackTagPayload {
  title?: string | null;
  artist?: string | null;
  genre?: string | null;
  bpm?: number | null;
  camelotKey?: string | null;
  /** Réécrit aussi les tags embarqués du fichier audio (ID3 / Vorbis / MP4) via lofty. */
  writeToFile?: boolean;
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
  /** ALC-232 : édition complète des tags (title/artist/genre/bpm/camelotKey + réécriture fichier). */
  updateLibraryTrackTags(id: number, fields: LibraryTrackTagPayload): Promise<LibraryTrack> {
    return safeInvoke<LibraryTrack>('library_update_track_meta', {
      id,
      title: fields.title ?? null,
      artist: fields.artist ?? null,
      genre: fields.genre ?? null,
      bpm: fields.bpm ?? null,
      camelotKey: fields.camelotKey ?? null,
      writeToFile: fields.writeToFile ?? false,
    });
  },
  /** ALC-242 : rétro-alimentation automatique depuis `stems_meta.json` (ignorée si tags verrouillés). */
  applyStemsTelemetry(
    filePath: string,
    bpm: number | null,
    camelotKey: string | null
  ): Promise<LibraryTrack | null> {
    return safeInvoke<LibraryTrack | null>('library_apply_stems_telemetry', {
      filePath,
      bpm,
      camelotKey,
    });
  },
};
