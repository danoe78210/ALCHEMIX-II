import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanVocalsSamples } from '$lib/utils/vocalClean';

const SR = 44100;

test('ALC-218 : cleanVocalsSamples — longueur et mono préservées', () => {
  const n = SR;
  const inp = new Float32Array(n);
  for (let i = 0; i < n; i++) inp[i] = Math.sin((2 * Math.PI * 350 * i) / SR) * 0.2;
  const out = cleanVocalsSamples(inp, SR);
  assert.equal(out.length, n);
  assert.ok(Number.isFinite(out[0]) && Number.isFinite(out[n - 1]));
});

test('ALC-218/220 : cleanVocalsSamples — le passe-haut élimine le DC en régime établi', () => {
  const out = cleanVocalsSamples(new Float32Array(SR).fill(0.5), SR);
  // Le DC stabilisé est annihilé : la fin du buffer (régime établi) tend vers 0.
  let tail = 0;
  for (let i = SR - Math.floor(SR / 4); i < SR; i++) tail = Math.max(tail, Math.abs(out[i]));
  assert.ok(tail < 0.02, `DC établi coupé (tail=${tail.toExponential(2)})`);
  // NB : le transitoire d'attaque (1er échantillon) peut subsister — c'est une attaque réelle,
  // pas du DC ; le passe-haut corrigé (unitaires) laisse passer les attaques, ce qui est voulu.
});

test('ALC-218 : cleanVocalsSamples — de-ess : les aigus francs (12 kHz) atténués bien plus que la voix (200 Hz)', () => {
  const low = new Float32Array(SR);
  const hi = new Float32Array(SR);
  for (let i = 0; i < SR; i++) {
    low[i] = Math.sin((2 * Math.PI * 200 * i) / SR) * 0.2;
    hi[i] = Math.sin((2 * Math.PI * 12000 * i) / SR) * 0.2;
  }
  const rms = (a: Float32Array) => {
    let s = 0;
    for (const v of a) s += v * v;
    return Math.sqrt(s / a.length);
  };
  const ol = cleanVocalsSamples(low, SR);
  const oh = cleanVocalsSamples(hi, SR);
  // Seuil qualitatif souple : le grave doit largement passer par rapport à l'aigu (de-ess net).
  assert.ok(rms(ol) > rms(oh) * 3, `voix ${rms(ol).toFixed(4)} vs aigus ${rms(oh).toFixed(4)}`);
});

test('ALC-220 : cleanVocalsSamples NORMALISÉ — niveau ABSOLU préservé (voix non muette)', () => {
  // Cause racine du bug « vocals muet » : le passe-haut DC-blocker non normalisé écrasait tout le
  // spectre de ~-33 dB (ratio ~0.01). Un tonus vocal franc 200 Hz doit passer à ~unitaire (> 0.6).
  const inp = new Float32Array(SR);
  for (let i = 0; i < SR; i++) inp[i] = Math.sin((2 * Math.PI * 200 * i) / SR) * 0.3;
  const rms = (a: Float32Array) => {
    let s = 0;
    for (const v of a) s += v * v;
    return Math.sqrt(s / a.length);
  };
  const rIn = rms(inp);
  const rOut = rms(cleanVocalsSamples(inp, SR));
  assert.ok(rOut > 0.6 * rIn, `niveau vocal préservé ~unitaire (ratio ${(rOut / rIn).toFixed(3)})`);
});

test('ALC-218 : cleanVocalsSamples — gate doux des silences sans chant', () => {
  // Une voix courte au début (350 Hz, faible), puis un long silence.
  const inp = new Float32Array(SR);
  const seg = 5000;
  for (let i = 0; i < seg; i++) inp[i] = Math.sin((2 * Math.PI * 350 * i) / SR) * 0.05;
  const out = cleanVocalsSamples(inp, SR);
  const rms = (from: number, to: number) => {
    let s = 0;
    for (let i = from; i < to; i++) s += out[i] * out[i];
    return Math.sqrt(s / (to - from));
  };
  const segRms = rms(0, seg);
  const tailRms = rms(seg, SR);
  assert.ok(tailRms < segRms * 0.5, `la traînée silencieuse doit être atténuée (tail=${tailRms.toExponential(2)})`);
});