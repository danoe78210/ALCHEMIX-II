// ALC-222 : tests `node --test` — MASTER CLOCK SYNC sur les BPM effectifs + arbitrage anti-collision vocale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveBpmDelta } from '$lib/utils/tempo';
import { bothVocalsActive, autoVocalMuteDecision } from '$lib/audio/stemMix';

test('ALC-222 : MASTER CLOCK — Δ BPM sur les BPM EFFECTIFS, normalisés à l octave', () => {
  // B=86,3 vs A=166,1 (demi-tempo) : octave normalisée — le Δ est faible (≈ +3,25), jamais -80.
  const d = effectiveBpmDelta(166.1, 86.3);
  assert.ok(Math.abs(d - 3.25) < 0.05, `delta octaves=${d}`);
  assert.ok(Math.abs(d) < 4, 'ne déraille pas à l octave');
  assert.equal(effectiveBpmDelta(120, 120), 0);
  assert.ok(effectiveBpmDelta(120, 121) > 0, 'écart réel préservé');
});

test('ALC-222 : MASTER CLOCK — TEMPOS ALIGNÉS si |Δ effective| <= 0.15', () => {
  assert.ok(Math.abs(effectiveBpmDelta(166.1, 83.05)) <= 0.15, 'après APPLIQUER (B pitch -3,75%) → aligné');
  assert.ok(Math.abs(effectiveBpmDelta(120, 120.1)) <= 0.15, '120.0 vs 120.1 → aligné');
  assert.ok(Math.abs(effectiveBpmDelta(120, 120.05)) <= 0.15);
  assert.ok(Math.abs(effectiveBpmDelta(120, 121)) > 0.15, 'écart 1 BPM → non aligné');
});

test('ALC-222 : anti-collision — bothVocalsActive (stems prêts + VOIX actif des deux côtés)', () => {
  const on = { vocals: false, drums: false, bass: false, other: false };
  assert.equal(bothVocalsActive('ready', 'ready', on, on), true);
  assert.equal(bothVocalsActive('ready', 'ready', { ...on, vocals: true }, on), false, 'A voix coupée');
  assert.equal(bothVocalsActive('ready', 'ready', on, { ...on, vocals: true }), false, 'B voix coupée');
  assert.equal(bothVocalsActive('idle', 'ready', on, on), false, 'stems A non prêts');
  assert.equal(bothVocalsActive('ready', 'ready', on, on), true);
});

test('ALC-222 : arbitrage AUTO VOIX — couper B pendant une phrase chantée de A, ne pas l écraser sinon', () => {
  assert.equal(autoVocalMuteDecision(true, false), 'mute', 'A chante, B non coupé → mute B');
  assert.equal(autoVocalMuteDecision(true, true), 'none', 'B déjà coupé → ne retouche pas');
  assert.equal(autoVocalMuteDecision(false, false), 'none', 'A instrumental → ne mute pas');
  assert.equal(autoVocalMuteDecision(false, true), 'none', 'B déjà coupé en instrumental → aucun ordre');
});