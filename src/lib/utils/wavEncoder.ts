// ALC-226 : encodeur WAV PCM 16-bit stéréo + formatage horloge mix — logique PUR testable sous node.
// `samples` est INTERLEAVED [L0,R0,L1,R1,…] en float32 (amplitude -1..1), échantillonné à `sampleRate`.

export function encodeWav16Stereo(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 2;
  const numFrames = Math.floor(samples.length / numChannels);
  const byteRate = sampleRate * numChannels * 2;
  const dataSize = numFrames * numChannels * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, numChannels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, numChannels * 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Nom de fichier horodaté : `AlcheMix_Mashup_YYYY-MM-DD_HH-mm-ss.wav`. */
export function mashupWavFilename(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `AlcheMix_Mashup_${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(
    now.getHours()
  )}-${p(now.getMinutes())}-${p(now.getSeconds())}.wav`;
}

/** Format `MM:SS` (ou `HH:MM:SS` au-delà de 59:59) — chiffres tabulaires. */
export function formatMixClock(totalSeconds: number): string {
  const t = Math.max(0, Math.trunc(totalSeconds || 0));
  const s = t % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}