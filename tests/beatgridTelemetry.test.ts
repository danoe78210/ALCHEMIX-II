// ALC-224 : tests `node --test` des helpers de télémétrie du Beatgrid (courbe tempo / courbe clé).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEffectiveSegmentBpm, getActiveKeyPointAtTime } from '$lib/utils/beatgridTelemetry';

test('ALC-224 : getEffectiveSegmentBpm — normalise l octave (×2/÷2) puis applique le pitch', () => {
  // 240 vs global 120 → demi-tempo (÷2).
  assert.equal(getEffectiveSegmentBpm(240, 120, 1), 120);
  // 60 vs global 120 → double-tempo (×2).
  assert.equal(getEffectiveSegmentBpm(60, 120, 1), 120);
  assert.equal(getEffectiveSegmentBpm(118, 120, 1), 118, 'déjà dans [90,162] → inchangé');
  assert.equal(getEffectiveSegmentBpm(80, 120, 1), 160, '<90 → ×2');
  assert.equal(getEffectiveSegmentBpm(200, 120, 1), 100, '>162 → ÷2');
  // Pitch : pitch +5% → global 130.2.
  assert.ok(Math.abs(getEffectiveSegmentBpm(124, 120, 1.05) - 130.2) < 0.05, 'segment × playbackRate');
  assert.equal(getEffectiveSegmentBpm(0, 120, 1), 120, 'localBpm invalide → repli global');
});

test('ALC-224 : getActiveKeyPointAtTime — suivi des modulations de clé au fil d elapsedSeconds', () => {
  const segs = [
    { startSec: 0, endSec: 10, localBpm: 120, localCamelot: '1A' },
    { startSec: 10, endSec: 20, localBpm: 121, localCamelot: '7A' },
  ] as any;
  const at4 = getActiveKeyPointAtTime(segs, 4, '5B');
  assert.equal(at4.key, '1A');
  assert.equal(at4.num, 1);
  assert.equal(at4.mode, 'A');
  assert.equal(at4.rank, 0, 'rang normalisé ((1-1)/11)');
  const at15 = getActiveKeyPointAtTime(segs, 15, '5B');
  assert.equal(at15.key, '7A');
  assert.equal(at15.num, 7);
  assert.ok(Math.abs(at15.rank - 6 / 11) < 1e-9);
  // Hors segments → repli sur la clé globale.
  const fb = getActiveKeyPointAtTime([], 5, '9B');
  assert.equal(fb.key, '9B');
  assert.equal(fb.num, 9);
  assert.equal(fb.mode, 'B');
});