// ALC-226 : tests `node --test` de l'encodeur WAV + formatage horloge mix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav16Stereo, mashupWavFilename, formatMixClock } from '$lib/utils/wavEncoder';

test('ALC-226 : formatMixClock — MM:SS puis HH:MM:SS (tabular)', () => {
  assert.equal(formatMixClock(0), '00:00');
  assert.equal(formatMixClock(7), '00:07');
  assert.equal(formatMixClock(65), '01:05');
  assert.equal(formatMixClock(3599), '59:59');
  assert.equal(formatMixClock(3601), '01:00:01');
  assert.equal(formatMixClock(-5), '00:00');
});

test('ALC-226 : mashupWavFilename — AlcheMix_Mashup_YYYY-MM-DD_HH-mm-ss.wav', () => {
  const n = new Date(2026, 4, 22, 9, 7, 5); // 22/05/2026 09:07:05
  assert.equal(mashupWavFilename(n), 'AlcheMix_Mashup_2026-05-22_09-07-05.wav');
});

test('ALC-226 : encodeWav16Stereo — entête RIFF/WAVE PCM 16-bit stéréo + données', async () => {
  // 1 s de silence stéréo (interleaved).
  const sr = 48000;
  const samples = new Float32Array(sr * 2);
  const blob = encodeWav16Stereo(samples, sr);
  assert.equal(blob.type, 'audio/wav');
  const buf = new Uint8Array(await blob.arrayBuffer());
  assert.equal(buf.length, 44 + sr * 4);
  const str = (o: number, l: number) => String.fromCharCode(...buf.slice(o, o + l));
  assert.equal(str(0, 4), 'RIFF');
  assert.equal(str(8, 4), 'WAVE');
  assert.equal(str(12, 4), 'fmt ');
  assert.equal(str(36, 4), 'data');
  const v = new DataView(buf.buffer);
  assert.equal(v.getUint16(20, true), 1, 'PCM');
  assert.equal(v.getUint16(22, true), 2, 'stéréo');
  assert.equal(v.getUint32(24, true), sr, 'sampleRate');
  assert.equal(v.getUint16(34, true), 16, '16 bits');
  assert.equal(v.getUint32(40, true), sr * 4, 'dataSize');
});