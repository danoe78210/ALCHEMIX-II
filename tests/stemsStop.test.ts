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
          detune: { value: 0 },
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

// ── ALC-193-2/3 : PAUSE A + B en mode stems — coupure matérielle + position conservée + reprise ──

test('PAUSE A + B en stems : coupe les sources, suspend l AudioContext, conserve la position, relance synchronisée', async () => {
  installMocks();
  const { Player } = await import('$lib/audio/player');
  const pa = new Player('A');
  const pb = new Player('B');
  (pa as any).stemModeActive = true;
  (pb as any).stemModeActive = true;
  (pa as any).stemBuffers = { vocals: {}, drums: {}, bass: {}, other: {} };
  (pb as any).stemBuffers = { vocals: {}, drums: {}, bass: {}, other: {} };
  (pa as any).stemGains = { vocals: gainNode(), drums: gainNode(), bass: gainNode(), other: gainNode() };
  (pb as any).stemGains = { vocals: gainNode(), drums: gainNode(), bass: gainNode(), other: gainNode() };
  await pa.playStems(10);
  await pb.playStems(20);
  assert.equal((pa as any).stemNodes.length, 4);
  assert.equal((pb as any).stemNodes.length, 4);
  const posA = pa.position; // ~10 (horloge synthétique stems)
  const posB = pb.position; // ~20
  pa.pause();
  pb.pause();
  assert.equal((pa as any).stemNodes.length, 0, 'A : sources stems coupées');
  assert.equal((pb as any).stemNodes.length, 0, 'B : sources stems coupées');
  assert.equal((pa as any).ctx.state, 'suspended', 'A : AudioContext suspendu (coupure physique)');
  assert.equal((pb as any).ctx.state, 'suspended', 'B : AudioContext suspendu');
  assert.equal((pa as any).stemOffsetSeconds, posA, 'A : position mémorisée à la pause');
  assert.equal((pb as any).stemOffsetSeconds, posB, 'B : position mémorisée à la pause');
  // Reprise synchronisée depuis la position mise en pause.
  await pa.playStems((pa as any).stemOffsetSeconds);
  await pb.playStems((pb as any).stemOffsetSeconds);
  assert.equal((pa as any).stemNodes.length, 4, 'A repart sur ses stems');
  assert.equal((pb as any).stemNodes.length, 4, 'B repart sur ses stems');
  assert.equal((pa as any).stemPlaying, true);
  assert.equal((pb as any).stemPlaying, true);
});

test('chargement/re-play idempotent : un second playStems ne garde jamais plus de 4 sources (pas de superposition)', async () => {
  installMocks();
  const { Player } = await import('$lib/audio/player');
  const p = new Player('A');
  (p as any).stemModeActive = true;
  (p as any).stemBuffers = { vocals: {}, drums: {}, bass: {}, other: {} };
  (p as any).stemGains = { vocals: gainNode(), drums: gainNode(), bass: gainNode(), other: gainNode() };
  await p.playStems(0);
  assert.equal((p as any).stemNodes.length, 4);
  // Second play (continuation du même geste / $effect deck) : toujours 4 sources, jamais 8.
  await p.playStems(5);
  assert.equal((p as any).stemNodes.length, 4, 're-play sans superposition (idempotent)');
  assert.equal((p as any).stemPlaying, true);
});

// ALC-219 : l'instrumental doublé venait du fait que playStems reconstruisait les sources SANS
// arrêter les précédentes (encore branchées) → on prouve ici que la 2e génération coupe la 1re.
test('ALC-219 : re-play en stems arrête l ancienne génération de sources (unicité, pas de doublage)', async () => {
  const { started } = installMocks();
  const { Player } = await import('$lib/audio/player');
// ALC-248-4 : en mode INSTRUMENTAL, seuls drums/bass/other restent audibles (vocals isolé) —
// les lois pures partagées par stiffness/StemsStop restent vraies même hors navigateur.
test('ALC-248-4 : intégrité INSTRUMENTAL via le preset pur (mêmes lois que le store)', async () => {
  const sm = await import('$lib/audio/stemMix');
  const mutes = sm.applyStemPreset({ vocals: false, drums: false, bass: false, other: false }, 'instrumental');
  assert.equal(mutes.vocals, true);
  for (const s of ['drums', 'bass', 'other'] as const) {
    assert.equal(mutes[s], false, `${s} actif`);
    assert.equal(sm.effectiveStemGain(mutes, sm.unitStemGains(), s), 1);
  }
  assert.equal(sm.effectiveStemGain(mutes, sm.unitStemGains(), 'vocals'), 0);
});
  const p = new Player('A');
  (p as any).stemModeActive = true;
  (p as any).stemBuffers = { vocals: {}, drums: {}, bass: {}, other: {} };
  (p as any).stemGains = { vocals: gainNode(), drums: gainNode(), bass: gainNode(), other: gainNode() };
  await p.playStems(0);
  const first = started.slice();
  assert.equal(first.length, 4, '1re génération : 4 sources démarrées');
  assert.equal(first.every((s: any) => s.stopped === false), true);
  await p.playStems(7);
  assert.equal(started.length, 8, '2e génération : 4 nouvelles sources créées');
  assert.equal(first.every((s: any) => s.stopped === true), true, 'les anciennes sources sont COUPÉES');
  assert.equal((p as any).stemNodes.length, 4, 'une seule couche active en mémoire');
});
// ALC-249-3 : rég régression « silence total au franchissement d'ENTRÉE VOIX » — en lancement
// AUTO-MASHUP OST (INST A + VOIX B), au crossing + activation du ducking, A garde drums/bass/other
// `el.muted=false` + gain > 0 et B garde vocals `el.muted=false` + gain > 0 (aucun mute stale).
test('ALC-249-3 : entrée vocale + ducking — les stems actifs de A et B restent !muted avec gain>0', async () => {
  installMocks();
  const { Player } = await import('$lib/audio/player');
  const mkEl = (muted = false) => ({
    muted,
    volume: 1,
    paused: true,
    currentTime: 0,
    readyState: 4,
    playCalls: 0,
    play() { this.playCalls++; this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  });
  const mkDeck = (els: Record<string, ReturnType<typeof mkEl>>) => {
    const p = new Player('A');
    (p as any).stemModeActive = true;
    (p as any).stemMediaActive = true; // emprunte la branche <audio> de seek() (pas de ticker)
    (p as any).audio.duration = 300;
    (p as any).stemBuffers = { vocals: {}, drums: {}, bass: {}, other: {} };
    (p as any).stemGains = { vocals: gainNode(), drums: gainNode(), bass: gainNode(), other: gainNode() };
    (p as any).stemEls = els;
    return p;
  };
  // A = INST (vocals reste stale-muté au départ — exactement l'état mangé par le preset avant création)
  const a = mkDeck({ vocals: mkEl(true), drums: mkEl(false), bass: mkEl(false), other: mkEl(false) });
  // B = VOIX SEULE (les 3 instrumentaux sont mutés, vocals audible)
  const b = mkDeck({ vocals: mkEl(false), drums: mkEl(true), bass: mkEl(true), other: mkEl(true) });
  // applyStemMutes 'A' instr / 'B' acapella
  a.setStemVolume('vocals', 0);
  a.setStemVolume('drums', 1); a.setStemVolume('bass', 1); a.setStemVolume('other', 1);
  b.setStemVolume('vocals', 1);
  b.setStemVolume('drums', 0); b.setStemVolume('bass', 0); b.setStemVolume('other', 0);
  // Franchissement d'ENTRÉE VOIX : seek + rapt de position, puis ducking orchestral sur A (B play continu).
  a.seek(16); b.seek(16);
  a.setMashupRole('ost-instrumental');
  const duckGain = (a as any).ostDuckFilter.gain;
  const duckTargets: number[] = [];
  duckGain.setTargetAtTime = (v: number) => { duckTargets.push(v); };
  a.updateDynamicOrchestralDucking(0.8, -3.0);
  // Invariants APRÈS entrée vocale : A garde drums/bass/other audibles, B garde vocals audible.
  const sa = a.getStemMediaState();
  const sb = b.getStemMediaState();
  for (const s of ['drums', 'bass', 'other'] as const) {
    assert.equal(sa[s].muted, false, `A.${s} !muted après ENTRÉE VOIX`);
    assert.ok(a.stemGainValue(s) as number > 0, `A.${s} gain > 0 (${a.stemGainValue(s)})`);
  }
  assert.equal(sa.vocals.muted, true, 'A.vocals reste muet (INST — cohérent)');
  assert.equal(sb.vocals.muted, false, 'B.vocals !muted après ENTRÉE VOIX');
  assert.ok((b.stemGainValue('vocals') as number) > 0, 'B.vocals gain > 0');
  // Le ducking ne touche QUE le peaking −3 dB (une seule cible ∈ [−3,0]) et JAMAIS le chemin/pas les gains stems.
  assert.ok(duckTargets.length === 1 && duckTargets[0] < 0 && duckTargets[0] >= -3, `ducking borné à [−3,0] dB (${duckTargets})`);
  assert.equal((a as any).outGain.gain.value, 1, 'le ducking ne touche PAS outGain de A');
  // Watchdog : l'état médiatique réel confirme les mêmes invariants (API publique du Player).
  const wa = a.getStemMediaState();
  const wb = b.getStemMediaState();
  for (const s of ['drums', 'bass', 'other'] as const) assert.equal(wa[s].muted, false, `watchdog A.${s} !muted`);
  assert.equal(wb.vocals.muted, false, 'watchdog B.vocals !muted');
});
// ALC-251-1/4 : démarrage SIMULTANÉ A + B dans le geste — le gain vocal de B s ouvre à
// l ENTRÉE VOIX (60 ms) et aucun stem actif de A (drums/bass/other) ni de B (vocals) n est
// muté/à zéro avant, pendant, après le franchissement (déterminisme, n importe quelle paire).
test('ALC-251-4 : démarrage simultané A+B — stems actifs intacts avant, pendant et après ENTRÉE VOIX', async () => {
  installMocks();
  const { Player } = await import('$lib/audio/player');
  const mkEl = (muted = false) => ({
    muted,
    volume: 1,
    paused: true,
    readyState: 4,
    playCalls: 0,
    play() { this.playCalls++; this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  });
  const mkDeck = (els: Record<string, ReturnType<typeof mkEl>>) => {
    const p = new Player('A');
    (p as any).stemModeActive = true;
    (p as any).stemMediaActive = true;
    (p as any).audio.duration = 300;
    (p as any).stemBuffers = { vocals: {}, drums: {}, bass: {}, other: {} };
    (p as any).stemGains = { vocals: gainNode(), drums: gainNode(), bass: gainNode(), other: gainNode() };
    (p as any).stemEls = els;
    return p;
  };
  // A = INST (vocals muted) ; B = VOIX SEULE (instrumentaux muted, voix fermée à l intro par le gate).
  const a = mkDeck({ vocals: mkEl(true), drums: mkEl(false), bass: mkEl(false), other: mkEl(false) });
  const b = mkDeck({ vocals: mkEl(true), drums: mkEl(true), bass: mkEl(true), other: mkEl(true) });
  a.setStemVolume('vocals', 0);
  a.setStemVolume('drums', 1); a.setStemVolume('bass', 1); a.setStemVolume('other', 1);
  b.setStemVolume('vocals', 0); // gate fermé (intro de A)
  b.setStemVolume('drums', 0); b.setStemVolume('bass', 0); b.setStemVolume('other', 0);
  // AVANT le franchissement : A garde drums/bass/other !muted, B a la voix fermée mais en lecture.
  const preA = a.getStemMediaState();
  for (const s of ['drums', 'bass', 'other'] as const) {
    assert.equal(preA[s].muted, false, `avant E.V. : A.${s} !muted`);
    assert.ok((a.stemGainValue(s) as number) > 0, `avant E.V. : A.${s} gain>0`);
  }
  assert.equal(b.getStemMediaState().vocals.muted, true, 'avant E.V. : B.vocals fermé (gate)');
  // AU franchissement d ENTRÉE VOIX : ouverture du gain vocal de B en 60 ms (0 → 1)…
  b.setStemVolume('vocals', 1, 60);
  // …et ré-affirmation de A (applyStemMutes instrumental) — A jamais coupé au crossing.
  a.setStemVolume('vocals', 0);
  a.setStemVolume('drums', 1); a.setStemVolume('bass', 1); a.setStemVolume('other', 1);
  const midA = a.getStemMediaState();
  for (const s of ['drums', 'bass', 'other'] as const) {
    assert.equal(midA[s].muted, false, `à l E.V. : A.${s} !muted`);
    assert.ok((a.stemGainValue(s) as number) === 1, `à l E.V. : A.${s} gain nominal 1.0`);
  }
  assert.equal(b.getStemMediaState().vocals.muted, false, 'à l E.V. : B.vocals ouvert (!muted)');
  assert.ok((b.stemGainValue('vocals') as number) > 0, 'à l E.V. : B.vocals gain>0');
  // APRÈS : l état reste stable (aucun mute tardif au crossing).
  const postA = a.getStemMediaState();
  for (const s of ['drums', 'bass', 'other'] as const) assert.equal(postA[s].muted, false, `après E.V. : A.${s} !muted`);
  assert.equal(b.getStemMediaState().vocals.muted, false, 'après E.V. : B.vocals reste ouvert');
  assert.ok((b.stemGainValue('vocals') as number) > 0, 'après E.V. : B.vocals gain>0');
});
// ALC-252-3 : retour au moteur AudioBufferSourceNode PUR — les 4 sources démarrent au MÊME
// instant futur (+15 ms) et les stemDesiredGains courants sont appliqués dès la création des
// nœuds (INST A : vocals 0, drums/bass/other 1.0) — aucun <audio>/createMediaElementSource.
test('ALC-252-3 : playStems pur — startAt partagé (+15 ms) et gains désirés appliqués à la création', async () => {
  installMocks();
  const { Player } = await import('$lib/audio/player');
  const p = new Player('A');
  (p as any).stemModeActive = true;
  (p as any).stemBuffers = { vocals: {}, drums: {}, bass: {}, other: {} };
  (p as any).stemGains = { vocals: gainNode(), drums: gainNode(), bass: gainNode(), other: gainNode() };
  (p as any).stemDesiredGains = { vocals: 0, drums: 1, bass: 1, other: 1 }; // recette INST A
  const applied: Record<string, number> = {};
  for (const s of ['vocals', 'drums', 'bass', 'other']) {
    (p as any).stemGains[s].gain.setValueAtTime = (v: number) => { applied[s] = v; };
  }
  await p.playStems(0);
  assert.equal((p as any).stemNodes.length, 4, '4 AudioBufferSourceNode démarrent simultanément');
  const when = (p as any).stemStartCtx;
  const now = (p as any).ctx.currentTime;
  assert.ok(Math.abs(when - (now + 0.015)) < 1e-9, `startAt = ctx.currentTime + 15 ms (${when} vs ${now + 0.015})`);
  assert.equal(applied.vocals, 0, 'INST A : vocals gain 0 appliqué dès playStems');
  for (const s of ['drums', 'bass', 'other']) {
    assert.equal(applied[s], 1, `${s} gain 1.0 appliqué dès playStems (INST A)`);
  }
});