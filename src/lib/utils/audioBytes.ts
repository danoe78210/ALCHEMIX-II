import { mimeFromPath } from '$lib/audio/player';

/**
 * ALC-192-1 : crée une URL `blob:` de pré-écoute depuis les octets mémoire Rust
 * (`read_audio_file_bytes`). JAMAIS asset:// / convertFileSrc (bloqué sous WebView2).
 * La révocation de l'ancienne URL appartient à l'appelant (URL.revokeObjectURL au stop/changement).
 */
export function createPreviewObjectUrl(bytes: number[] | Uint8Array, filePath: string): string {
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
  return URL.createObjectURL(new Blob([data.buffer as ArrayBuffer], { type: mimeFromPath(filePath) }));
}