// ALC-165-2 : tests unitaires `node --test` du moteur de scoring MASHUP.
// Lancement :  node --import ./tests/loader.mjs --test tests/mashupMatcher.test.ts
// Les valeurs attendues encodent la maquette validee (MÊME CLÉ / RELATIF MAJ-MIN /
// ±1 QUINTE / SAUT ÉNERGIE, écart BPM <= 6 %, ratios ×2/÷2/×1.5).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HARMONY_WEIGHT,
  RHYTHM_WEIGHT,
  CREATIVE_WEIGHT,
  DIRECT_TEMPO_TOLERANCE_PCT,
  RATIO_TEMPO_TOLERANCE_PCT,
  quintCircleDelta,
  keyMatch,
  tempoMatch,
  scoreMatch,
  compareScores,
  type MashupScore,
} from '$lib/utils/mashupMatcher';

// ------------------------------------------------------------------ harmonique

test('MEME CLE -> note 100, delta 0', () => {
  const km = keyMatch('8B', '8B');
  assert.equal(km.label, 'SAME KEY');
  assert.equal(km.score, 100);
  assert.equal(km.delta, 0);
  assert.equal(km.rel, false);
});

test('RELATIF MAJ-MIN (8B <-> 8A) -> note 95, rel=true', () => {
  const km = keyMatch('8B', '8A');
  assert.equal(km.rel, true);
  assert.equal(km.score, 95);
  assert.equal(km.label, 'RELATIVE MAJ');
  assert.equal(keyMatch('8A', '8B').label, 'RELATIVE MIN');
});

test('+1 QUINTE (8B <-> 9B) -> note 94, delta +1', () => {
  const km = keyMatch('8B', '9B');
  assert.equal(km.label, '+1 FIFTH');
  assert.equal(km.score, 94);
  assert.equal(km.delta, 1);
});

test('-1 QUINTE (8B <-> 7B) -> note 94, delta -1', () => {
  const km = keyMatch('8B', '7B');
  assert.equal(km.label, '-1 FIFTH');
  assert.equal(km.score, 94);
  assert.equal(km.delta, -1);
});

test('SAUT ENERGIE (+2 quintes, 8B <-> 10B) -> note 84', () => {
  const km = keyMatch('8B', '10B');
  assert.equal(km.label, 'ENERGY JUMP');
  assert.equal(km.score, 84);
});

test('ecart >= 3 quintes -> tension controlee 50', () => {
  const km = keyMatch('8B', '12B'); // 8 -> 12 = 4 quintes
  assert.equal(km.label, 'FAR KEY');
  assert.equal(km.score, 50);
});

test('cle absente -> FAR KEY score 0', () => {
  const km = keyMatch('', '8B');
  assert.equal(km.score, 0);
  assert.equal(km.label, 'FAR KEY');
});

test('quintCircleDelta : chemin court (12B <-> 1B = +1)', () => {
  assert.equal(quintCircleDelta('12B', '1B'), 1);
  assert.equal(quintCircleDelta('1A', '12A'), -1);
});

// ------------------------------------------------------------------ rythmique

test('BPM direct <= 6 % -> mode direct + libelle %', () => {
  const tm = tempoMatch(120, 124);
  assert.equal(tm.mode, 'direct');
  assert.equal(tm.deltaPct, 3.3);
  assert.equal(tm.label, '+3.3%');
  assert.ok(tm.score >= 60);
});

test('BPM identique -> direct +0.0%', () => {
  const tm = tempoMatch(120, 120);
  assert.equal(tm.mode, 'direct');
  assert.equal(tm.label, '+0.0%');
});

test('demi-tempo : 140 vs 70 -> mode ratio x2', () => {
  const tm = tempoMatch(140, 70);
  assert.equal(tm.mode, 'ratio');
  assert.equal(tm.ratio, 2);
});

test('ternaire : 135 vs 90 -> mode ratio x1.5 avec libelle exact', () => {
  const tm = tempoMatch(135, 90);
  assert.equal(tm.mode, 'ratio');
  assert.equal(tm.ratio, 1.5);
  assert.equal(tm.label, 'x1.5 (+0.0%)');
});



test('ratio x1.5 -> libelle "M\u00d4ME CL\u00c9 \u2022 x1.5" quand sameKey', () => {
  const tm = tempoMatch(100, 66.7, true);
  assert.equal(tm.mode, 'ratio');
  assert.equal(tm.ratio, 1.5);
  assert.equal(tm.keyLocked, true);
  assert.match(tm.label, /\u00caME CL\u00c9 \u2022 x1\.5/);
});

test('BPM incoherent (<=0) -> mode false, score 0', () => {
  const tm = tempoMatch(120, 0);
  assert.equal(tm.mode, 'false');
  assert.equal(tm.score, 0);
});

// ------------------------------------------------------------------ ponderation & tri

test('les trois poids totalisent 100 %', () => {
  assert.equal(Math.round((HARMONY_WEIGHT + RHYTHM_WEIGHT + CREATIVE_WEIGHT) * 100), 100);
  assert.equal(DIRECT_TEMPO_TOLERANCE_PCT, 6);
  assert.equal(RATIO_TEMPO_TOLERANCE_PCT, 3);
});

test("scoreMatch : cles relatives + duo booste l'affinite", () => {
  const ref = { id: 1, camelotKey: '8B', bpm: 120, genre: 'Pop' };
  const cand = { id: 2, camelotKey: '8A', bpm: 118, genre: 'House' };
  const s = scoreMatch(ref, cand, true);
  assert.equal(s.duo, true);
  assert.ok(s.sendTo === 'A' || s.sendTo === 'B');
  assert.ok(s.affinity >= 90);
  assert.ok(s.affinity <= 100);
});

test('compareScores : duo prioritaire puis affinite decroissante', () => {
  // Mocks volontairement réduits pour tester le TRI uniquement (cast vers le type plein).
  const a = { trackId: 1, affinity: 80, duo: false, sendTo: 'A' as const, harmony: { score: 0 }, tempo: { score: 0 } } as unknown as MashupScore;
  const b = { trackId: 2, affinity: 91, duo: true, sendTo: 'B' as const, harmony: { score: 0 }, tempo: { score: 0 } } as unknown as MashupScore;
  const c = { trackId: 3, affinity: 75, duo: false, sendTo: 'A' as const, harmony: { score: 0 }, tempo: { score: 0 } } as unknown as MashupScore;
  const sorted = [a, c, b].sort(compareScores);
  assert.equal(sorted[0].trackId, 2); // duo d'abord
  assert.equal(sorted[1].trackId, 1); // puis 80 > 75
  assert.equal(sorted[2].trackId, 3);
});