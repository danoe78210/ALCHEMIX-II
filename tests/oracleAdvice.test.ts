// ALC-221 : tests `node --test` de la logique pure « APPLIQUER LES CONSEILS » de l'Oracle Acoustique.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOracleAdvice,
  oracleAdviceSummary,
  captureOracleSnapshot,
  oracleRevertValues,
  isHarmonicallyCompatible,
} from '$lib/audio/oracleAdvice';

test('ALC-221 : computeOracleAdvice — harmonique compatible (rel ou ring<=1) → LOW EQ B -12 dB + 16 MES', () => {
  const a = computeOracleAdvice({ baseBpmB: 120, masterBpmA: 120, ring: 1, rel: false });
  assert.equal(a.lowEqB, -12, 'compatible : basses B préparées -12 dB');
  assert.equal(a.lowEqA, 0, 'A reste à 0 dB (échange de basses propre)');
  assert.equal(a.autoMixBars, 16);
  assert.equal(a.targetPitchB, 0);
});

test('ALC-221 : computeOracleAdvice — relation relative (rel=true) → compatible (16 MES, -12 dB)', () => {
  const a = computeOracleAdvice({ baseBpmB: 100, masterBpmA: 90, ring: 0, rel: true });
  assert.equal(a.autoMixBars, 16);
  assert.equal(a.lowEqB, -12);
  assert.equal(a.lowEqA, 0);
});

test('ALC-221 : computeOracleAdvice — dissonant (ring>=2) → LOW EQ B -18 dB + 8 MES', () => {
  const a = computeOracleAdvice({ baseBpmB: 128, masterBpmA: 120, ring: 5, rel: false });
  assert.equal(a.lowEqB, -18, 'transition courte : basses B coupées préventivement');
  assert.equal(a.autoMixBars, 8);
  assert.ok(a.targetPitchB < 0, 'B ralenti vers A');
});

test('ALC-221 : pitch B normalisé OCTAVE (double/demi-tempo) — Julia ≈166 vs Crying ≈86 → ~+3.9%', () => {
  // B (base 166.1) doit être calé sur A (86.3) : normalisé à 83.05 → +3.9 % (et non -48 %).
  const a = computeOracleAdvice({ baseBpmB: 166.1, masterBpmA: 86.3, ring: 1, rel: false });
  assert.ok(Math.abs(a.targetPitchB - 3.9) < 0.2, `pitch B normalisé (~+3.9 %), obtenu ${a.targetPitchB}`);
  // Sens inverse : B (86.3) calé sur A (166.1) → -48 % ∉ [0.75,1.35] → normalisé ?
  const b = computeOracleAdvice({ baseBpmB: 86.3, masterBpmA: 166.1, ring: 1, rel: false });
  assert.ok(b.targetPitchB >= -35, `garde-fou octave : pitch B ${b.targetPitchB} ne déraille pas`);
});

test('ALC-221 : oracleAdviceSummary — format « Pitch B <x>% • Low EQ B <y> dB • <N> Mes »', () => {
  const s = oracleAdviceSummary({ targetPitchB: -0.6, lowEqA: 0, lowEqB: -12, autoMixBars: 16 });
  assert.equal(s, 'Pitch B -0.6% • Low EQ B -12 dB • 16 Mes');
  const plus = oracleAdviceSummary({ targetPitchB: 3.9, lowEqA: 0, lowEqB: -18, autoMixBars: 8 });
  assert.equal(plus, 'Pitch B +3.9% • Low EQ B -18 dB • 8 Mes');
});

test('ALC-221 : revert — oracleRevertValues restitue EXACTEMENT les valeurs du snapshot', () => {
  const snap = captureOracleSnapshot(2.5, -3, -12, 16);
  assert.deepEqual(oracleRevertValues(snap), { pitchB: 2.5, lowEqA: -3, lowEqB: -12, autoMixBars: 16 });
  // restore exact porte aussi sur un snapshot dissonant.
  assert.deepEqual(oracleRevertValues({ pitchB: -1.2, lowEqA: 0, lowEqB: -18, autoMixBars: 8 }), {
    pitchB: -1.2,
    lowEqA: 0,
    lowEqB: -18,
    autoMixBars: 8,
  });
});

test('ALC-221 : isHarmonicallyCompatible — rel ou ring<=1 vrai, ring>=2 faux', () => {
  assert.equal(isHarmonicallyCompatible(0, false), true);
  assert.equal(isHarmonicallyCompatible(1, false), true);
  assert.equal(isHarmonicallyCompatible(0, true), true);
  assert.equal(isHarmonicallyCompatible(2, false), false);
  assert.equal(isHarmonicallyCompatible(7, true), true);
});