// ALC-182-3 : tests unitaires `node --test` du STOP en mode stems (Player).
// Lancement :  node --import ./tests/loader.mjs --test tests/stemsStop.test.ts
//
// Contexte : en mode stems (stemModeActive), le <audio> mono est deja verrouille muet ->
// Player.stop() doit AUSSI arreter les 4 AudioBufferSourceNode actifs (regression ALC-182-1),
// vider stemNodes, forcer stemPlaying=false et remettre la position a 0. Le contrat
// « transport === stopped + elapsedSeconds === 0 » est pose par mixerStore.setTransport(id,
// 'stopped') du bouton STOP des decks (non importable sous node : store = runes Svelte 5) ;
// on verifie donc l'arret reel des sources + position()=0 (valeur que le ROLL affiche apres
// un STOP : syncPlayback ne met a jour elapsedSeconds que si transport === 'playing').

import { test } from 'node:test';
import assert from 'node:assert/strict';

function biquad() {
  return {
    type: 'lowshelf',
    frequency: { value: 0 },
    gain: { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, setTargetAtTime() {} },
    Q: { value: 1 },
    connect() {},
    disconnect() {},
  };
}
function gainNode() {
  return {
    gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, setTargetAtTime() {} },
    connect() {},
    disconnect() {},
  };
}

function installMocks() {
  const audio: any = {
    paused: true,
    currentTime: 0,
    duration: NaN,
    playbackRate: 1,
    muted: false,
    crossOrigin: '',
    preload: 'auto',
    preservesPitch: true,
    src: '',
    _ct: 0,
    addEventListener() {},
    pause() { this.paused = true; },
    playCalls: 0,
    play() { this.playCalls++; this.paused = false; return Promise.resolve(); },
    removeAttribute() {},
    load() {},
  };
  Object.defineProperty(audio, 'currentTime', {
    get() { return this._ct; },
    set(v: number) { this._ct = v; },
  });
  const started: any[] = [];
  (globalThis as any).AudioContext = function () {
    return {
      destination: {},
      state: 'suspended',
      currentTime: 0,
      createBiquadFilter: biquad,
      createGain: gainNode,
      createAnalyser() { return { fftSize: 1024, getByteTimeDomainData() {}, connect() {} }; },
      createMediaElementSource() { return { connect() {}, disconnect() {} }; },
      createBufferSource() {
        const s: any = {
          buffer: null,
          playbackRate: { value: 1 },
          connect() {},
          disconnect() {},
          stopped: false,
          start() {},
          stop() { this.stopped = true; },
        };
        started.push(s);
        return s;
      },
      decodeAudioData() { return Promise.resolve({ length: 0, numberOfChannels: 2, sampleRate: 44100 }); },
      resume() { this.state = 'running'; return Promise.resolve(); },
      close() { return Promise.resolve(); },
      suspend() { this.state = 'suspended'; return Promise.resolve(); },
    };
  };
  (globalThis as any).document = {
    createElement(t: string) { assert.equal(t, 'audio'); return audio; },
  };
  (globalThis as any).window = { setInterval() { return 1; }, clearInterval() {} };
  return { started };
}

test('STOP en mode stems : arrete les sources, vide stemNodes, position=0, pas de superposition', async () => {
  installMocks();
  const { Player } = await import('$lib/audio/player');
  const p = new Player('A');
  (p as any).stemModeActive = true;
  (p as any).stemBuffers = { vocals: {}, drums: {}, bass: {}, other: {} };
  (p as any).stemGains = { vocals: gainNode(), drums: gainNode(), bass: gainNode(), other: gainNode() };
  await p.playStems(12.5);
  const active = (p as any).stemNodes;
  assert.equal(active.length, 4, '4 AudioBufferSourceNode actifs');
  assert.equal((p as any).position, 12.5, 'position synthetique pendant la lecture stems');

  p.stop();
  for (const s of active) assert.equal(s.stopped, true, 'chaque source stop()');
  assert.equal((p as any).stemNodes.length, 0, 'stemNodes vides apres STOP');
  assert.equal((p as any).stemPlaying, false, 'plus d horloge synthetique stems');
  assert.equal((p as any).ctx.state, 'suspended', 'AudioContext suspendu apres STOP (coupure materielle ALC-184)');
  assert.equal((p as any).audio.currentTime, 0, 'audio.currentTime remis a zero');
  assert.equal((p as any).position, 0, 'position()=0 (ROLL / elapsedSeconds apres STOP)');
  assert.equal((p as any).audio.muted, true, 'le mono reste MUET tant que le mode stems est actif');

  await p.playStems(0);
  assert.equal((p as any).stemNodes.length, 4, 're-PLAY : une seule couche, pas de superposition');
  p.stop();
  assert.equal((p as any).stemNodes.length, 0);
});

test('STOP invalide une play() en vol — le mono n est PAS relance (garde ALC-183 génération)', async () => {
  installMocks();
  const { Player } = await import('$lib/audio/player');
  const p = new Player('A');
  (p as any).stemModeActive = false;
  (p as any).stemsReady = false;
  const pr = p.play(); // capture la generation, attend resume() (asynchrone)
  p.stop(); // genere++ => invalide la lecture en vol (continuation $effect péri-mlée)
  await pr;
  assert.equal((p as any).audio.playCalls, 0, 'audio.play() (mono) ne doit pas etre appele apres STOP');
  assert.equal((p as any).stemPlaying, false);
  assert.equal((p as any).audio.paused, true);
});

test('play() mono ne part que si aucune generation n a ete invalidee', async () => {
  installMocks();
  const { Player } = await import('$lib/audio/player');
  const p = new Player('A');
  (p as any).stemModeActive = false;
  (p as any).stemsReady = false;
  await p.play();
  assert.equal((p as any).audio.playCalls, 1, 'mono lance de facon normale');
});

test('sequence EJECT (stop + disposeStems + setStemMode(false) + clearSource) rend le player silencieux', async () => {
  installMocks();
  const { Player } = await import('$lib/audio/player');
  const p = new Player('A');
  (p as any).stemModeActive = true;
  (p as any).stemBuffers = { vocals: {}, drums: {}, bass: {}, other: {} };
  (p as any).stemGains = { vocals: gainNode(), drums: gainNode(), bass: gainNode(), other: gainNode() };
  await p.playStems(0);
  assert.equal((p as any).stemNodes.length, 4);
  (p as any).url = 'blob:fake';
  (p as any).sourcePath = 'C:/t.mp3';
  p.stop();
  p.disposeStems();
  p.setStemMode(false);
  p.clearSource();
  assert.equal((p as any).stemNodes.length, 0, 'aucune source stem apres eject');
  assert.equal((p as any).stemPlaying, false);
  assert.equal((p as any).stemsReady, false, 'buffers stems libres');
  assert.equal((p as any).audio.muted, false, 'mono deverrouille apres setStemMode(false)');
  assert.equal((p as any).url, null, 'URL blob revoquee');
  assert.equal((p as any).sourcePath, null);
});