// ALC-211-3 : tests `node --test` de la normalisation d'octave BPM (module pur `src/lib/utils/tempo.ts`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOctaveBpm,
  computeNormalizedTempoRatio,
  normalizePlaybackRate,
  OCTAVE_HALF_MIN,
  OCTAVE_HALF_MAX,
  OCTAVE_DOUBLE_MIN,
  OCTAVE_DOUBLE_MAX,
} from '$lib/utils/tempo';

test('ALC-211 : ratio ≈ 2.0 → le candidat est divisé par 2 (double-tempo)', () => {
  // Julia (166.1) face à Crying in the Rain (86.3) : 166.1/86.3 = 1.925 ∈ [1.75;2.25] → 83.05
  assert.equal(normalizeOctaveBpm(86.3, 166.1), 83.05);
  assert.equal(normalizeOctaveBpm(120, 240), 120);
  assert.equal(normalizeOctaveBpm(90, 200), 100); // 200/90 = 2.22 ≤ 2.25 → 100
});

test('ALC-211 : ratio ≈ 0.5 → le candidat est multiplié par 2 (demi-tempo)', () => {
  assert.equal(normalizeOctaveBpm(166.1, 86.3), 172.6); // 86.3/166.1 = 0.5196 ∈ [0.44;0.57] → ×2
  assert.equal(normalizeOctaveBpm(140, 70), 140);
});

test('ALC-211 : hors intervalle → BPM inchangé', () => {
  assert.equal(normalizeOctaveBpm(120, 120), 120);
  assert.equal(normalizeOctaveBpm(140, 150), 150); // ratio 1.071 hors plage
  assert.equal(normalizeOctaveBpm(100, 130), 130); // ratio 1.30 hors plage
});

test('ALC-211 : valeurs non positives inchangées (aucun calcul)', () => {
  assert.equal(normalizeOctaveBpm(0, 120), 120);
  assert.equal(normalizeOctaveBpm(120, 0), 0);
});

test('ALC-211 : cas Julia/Crying — playbackRate cible ≈ +3.9 % (et non -48 %)', () => {
  const bpmA = 86.3; // Crying in the Rain (maître)
  const baseB = 166.1; // Julia
  const matchB = normalizeOctaveBpm(bpmA, baseB); // 83.05
  const playbackRate = bpmA / matchB; // 86.3 / 83.05 ≈ 1.0391
  assert.equal(matchB, 83.05);
  expectRate(playbackRate, 1.0391);
});

test('ALC-211 : bornes des intervalles', () => {
  assert.equal(normalizeOctaveBpm(100, 100 * OCTAVE_HALF_MIN), (100 * OCTAVE_HALF_MIN) / 2, 'borne basse 1.75 → /2');
  assert.equal(normalizeOctaveBpm(100, 100 * OCTAVE_HALF_MAX), (100 * OCTAVE_HALF_MAX) / 2, 'borne haute 2.25 → /2');
  assert.equal(normalizeOctaveBpm(100, 100 * OCTAVE_DOUBLE_MIN), (100 * OCTAVE_DOUBLE_MIN) * 2, 'borne basse 0.44 → ×2');
  assert.equal(normalizeOctaveBpm(100, 100 * OCTAVE_DOUBLE_MAX), (100 * OCTAVE_DOUBLE_MAX) * 2, 'borne haute 0.57 → ×2');
});

test('ALC-212 : computeNormalizedTempoRatio(166.1, 86.3) → effectiveSourceBpm 83.05, ratio ≈ 1.039 (jamais 0.519)', () => {
  const n = computeNormalizedTempoRatio(166.1, 86.3);
  assert.equal(n.effectiveSourceBpm, 83.05, 'Julia normalisé à l octave la plus proche (83.05)');
  assert.ok(Math.abs(n.ratio - 1.0391) < 1e-3, `ratio ≈ 1.0391 (got ${n.ratio}) — playbackRate +3.9 %, pas −48 %`);
  assert.ok(n.ratio > 0.9 && n.ratio < 1.1, 'ratio toujours proche de 1 (aucun ralentissement)');
});

test('ALC-212 : computeNormalizedTempoRatio — source alignée sur la cible octave', () => {
  // 86.3 (maître) → Julia 166.1 : source doublée à 172.6 (octave la plus proche), ratio ≈ 0.962
  const d = computeNormalizedTempoRatio(86.3, 166.1);
  assert.equal(d.effectiveSourceBpm, 172.6);
  assert.ok(Math.abs(d.ratio - 0.9623) < 1e-3);
  // tempos identiques : ratio 1, source inchangée
  assert.equal(computeNormalizedTempoRatio(120, 120).ratio, 1);
  assert.equal(computeNormalizedTempoRatio(120, 120).effectiveSourceBpm, 120);
});

test('ALC-212 : normalizePlaybackRate rejette ~0.5 / ~2.0 et borne à [0.75;1.35]', () => {
  assert.ok(Math.abs(normalizePlaybackRate(0.52) - 1.04) < 1e-3, '0.52 → ~1.04');
  assert.ok(Math.abs(normalizePlaybackRate(1.939) - 0.9695) < 1e-3, '1.94 → ~0.97');
  assert.equal(normalizePlaybackRate(1.04), 1.04, '1.04 (dans la plage) inchangé');
  assert.ok(normalizePlaybackRate(0.02) >= 0.75, 'clamp bas [0.75]');
  assert.ok(normalizePlaybackRate(9) <= 1.35, 'clamp haut [1.35]');
});

function expectRate(actual: number, expected: number, tol = 1e-3) {
  assert.ok(Math.abs(actual - expected) < tol, `playbackRate ${actual} ≈ ${expected}`);
}