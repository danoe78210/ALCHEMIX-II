import { invoke } from '@tauri-apps/api/core';

export interface TrackData {
  id: string;
  path: string;
  title: string;
  artist: string;
  genre: string;
  serialCode: string;
  bpm: number;
  camelotKey: string;
  durationSeconds: number;
  sampleRate: number;
  bitDepth: number;
  bitrateKbps: number;
  codec: string;
  waveformPeaks: number[];
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
