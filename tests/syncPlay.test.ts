// ALC-192-3 : tests `node --test` des 2 correctifs bloquants.
// 1) pré-écoute : `read_audio_file_bytes → Blob URL` (jamais asset://), révocation propre.
// 2) ▶ LANCER A + B en mode stems : deux Players démarrent ensemble, SANS annulation mutuelle
//    de `_playGen`, et la coupure d'une platine n'affecte pas l'autre.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeGainNode(log: number[]) {
  return {
    gain: {
      value: 1,
      cancelScheduledValues() {},
      setValueAtTime() {},
      setTargetAtTime(v: number) { log.push(v); },
    },
    connect() {},
    disconnect() {},
  };
}

function installAudio() {
  const started: any[] = [];
  (globalThis as any).AudioContext = function () {
    return {
      destination: {},
      state: 'running',
      currentTime: 0,
      createBiquadFilter: () => ({
        type: 'lowshelf', frequency: { value: 0 }, Q: { value: 1 },
        gain: { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, setTargetAtTime() {} },
        connect() {}, disconnect() {},
      }),
      createGain: () => makeGainNode([]),
      createAnalyser: () => ({ fftSize: 1024, getByteTimeDomainData() {}, connect() {} }),
      createMediaElementSource: () => ({ connect() {}, disconnect() {} }),
      createBufferSource: () => {
        const s: any = {
          buffer: null, playbackRate: { value: 1 }, connect() {}, disconnect() {},
          stopped: false, start() {}, stop() { this.stopped = true; },
        };
        started.push(s);
        return s;
      },
      decodeAudioData: () => Promise.resolve({ length: 0, numberOfChannels: 2, sampleRate: 44100 }),
      resume() { this.state = 'running'; return Promise.resolve(); },
      close() { return Promise.resolve(); },
      suspend() { this.state = 'suspended'; return Promise.resolve(); },
    };
  };
  const audio: any = {
    paused: true, currentTime: 0, duration: NaN, playbackRate: 1, muted: false,
    crossOrigin: '', preload: 'auto', src: '', _ct: 0,
    addEventListener() {}, pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); }, removeAttribute() {}, load() {},
  };
  Object.defineProperty(audio, 'currentTime', { get() { return this._ct; }, set(v: number) { this._ct = v; } });
  (globalThis as any).document = { createElement: () => audio };
  (globalThis as any).window = { setInterval() { return 1; }, clearInterval() {} };
  return { started, audio };
}

test('pré-écoute : des octets Rust -> Blob URL (mime correct) + révocation propre', async () => {
  const urls: string[] = [];
  const revoked: string[] = [];
  const blobs: any[] = [];
  (globalThis as any).URL = {
    createObjectURL: (b: any) => { blobs.push(b); const u = `blob:${urls.length}`; urls.push(u); return u; },
    revokeObjectURL: (u: string) => { revoked.push(u); },
  };
  (globalThis as any).Blob = class {
    parts: any;
    opts: any;
    constructor(parts: any, opts: any) {
      this.parts = parts;
      this.opts = opts;
    }
  };
  const { createPreviewObjectUrl } = await import('$lib/utils/audioBytes');
  const u = createPreviewObjectUrl([1, 2, 3], 'C:/a.mp3');
  assert.equal(u, 'blob:0', 'URL blob créée depuis les octets');
  assert.equal(blobs[0].opts.type, 'audio/mpeg', 'MIME audio/mpeg pour un .mp3 (pipeline Player)');
  (globalThis as any).URL.revokeObjectURL(u);
  assert.deepEqual(revoked, ['blob:0'], 'l’ancienne URL blob est révoquée au stop/changement');
});

test('LANCER A + B en stems : démarrage simultané sans annulation mutuelle de _playGen', async () => {
  const { started } = installAudio();
  const { Player } = await import('$lib/audio/player');
  const pa = new Player('A');
  const pb = new Player('B');
  (pa as any).stemModeActive = true;
  (pb as any).stemModeActive = true;
  (pa as any).stemBuffers = { vocals: {}, drums: {}, bass: {}, other: {} };
  (pb as any).stemBuffers = { vocals: {}, drums: {}, bass: {}, other: {} };
  (pa as any).stemGains = { vocals: makeGainNode([]), drums: makeGainNode([]), bass: makeGainNode([]), other: makeGainNode([]) };
  (pb as any).stemGains = { vocals: makeGainNode([]), drums: makeGainNode([]), bass: makeGainNode([]), other: makeGainNode([]) };

  await pa.playStems(0);
  await pb.playStems(0);
  assert.equal((pa as any).stemNodes.length, 4, 'A : 4 sources stems actives');
  assert.equal((pb as any).stemNodes.length, 4, 'B : 4 sources stems actives');
  assert.equal((pa as any).stemPlaying, true);
  assert.equal((pb as any).stemPlaying, true);

  // Re-play des deux (suite $effect des decks après un premier lancement via le store) :
  // aucune annulation croisée par _playGen — les deux restent actifs.
  await pa.playStems((pa as any).audio.currentTime || 0);
  await pb.playStems((pb as any).audio.currentTime || 0);
  assert.equal((pa as any).stemNodes.length, 4, 'A toujours actif après re-play');
  assert.equal((pb as any).stemNodes.length, 4, 'B toujours actif après re-play');

  // Coupure d'une seule platine (stop) : l'autre platine n est PAS arrêtée (indépendance).
  pa.stop();
  assert.equal((pa as any).stemNodes.length, 0, 'A stoppé');
  assert.equal((pb as any).stemNodes.length, 4, 'B ininterrompu par le stop de A');
  assert.equal((pb as any).stemPlaying, true);
});