// ALC-225 : tests `node --test` de l'échange de platines A <-> B (swapDeckState, pur).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapDeckState } from '$lib/utils/deckSwap';

test('ALC-225 : swapDeckState échange fidèlement toutes les propriétés métier (sauf id)', () => {
  const a = {
    id: 'A',
    filePath: '/a.flac',
    trackTitle: 'Piste A',
    baseBpm: 120,
    pitchPercent: 2,
    camelotKey: '8A',
    lowEqDb: -4,
    highEqDb: 1,
    elapsedSeconds: 42.5,
    stemsStatus: 'ready',
    stemMutes: { vocals: false, drums: false, bass: false, other: false },
    stemGains: { vocals: 1, drums: 1, bass: 1, other: 1 },
    segments: [{ startSec: 0, endSec: 5, localBpm: 120, localCamelot: '8A' }],
    hotCues: [10, 20, -1, -1],
  };
  const b = {
    id: 'B',
    filePath: '/b.mp3',
    trackTitle: 'Piste B',
    baseBpm: 90,
    pitchPercent: -1,
    camelotKey: '5B',
    lowEqDb: 0,
    highEqDb: 0,
    elapsedSeconds: 8,
    stemsStatus: 'ready',
    stemMutes: { vocals: true, drums: false, bass: false, other: false },
    stemGains: { vocals: 0.5, drums: 1, bass: 1, other: 1 },
    segments: [{ startSec: 0, endSec: 6, localBpm: 90, localCamelot: '5B' }],
    hotCues: [1, -1, -1, -1],
  };
  const { a: na, b: nb } = swapDeckState(a as any, b as any);
  // A garde son id mais reçoit le contenu de B.
  assert.equal(na.id, 'A');
  assert.equal(na.filePath, '/b.mp3');
  assert.equal(na.trackTitle, 'Piste B');
  assert.equal(na.baseBpm, 90);
  assert.equal(na.camelotKey, '5B');
  assert.equal(na.pitchPercent, -1);
  assert.equal(na.lowEqDb, 0);
  assert.equal(na.elapsedSeconds, 8);
  assert.deepEqual(na.stemMutes, { vocals: true, drums: false, bass: false, other: false });
  assert.equal(na.segments[0].localBpm, 90);
  assert.equal(na.hotCues[0], 1);
  // B reçoit le contenu de A.
  assert.equal(nb.id, 'B');
  assert.equal(nb.filePath, '/a.flac');
  assert.equal(nb.trackTitle, 'Piste A');
  assert.equal(nb.baseBpm, 120);
  assert.equal(nb.camelotKey, '8A');
  assert.equal(nb.pitchPercent, 2);
  assert.equal(nb.lowEqDb, -4);
  assert.equal(nb.highEqDb, 1);
  assert.equal(nb.elapsedSeconds, 42.5);
  assert.equal(nb.segments[0].localBpm, 120);
  assert.equal(nb.hotCues[0], 10);
});

test('ALC-225 : swapDeckState est involutif (inverser deux fois = état d origine)', () => {
  const a = { id: 'A', filePath: '/a', trackTitle: 'A', baseBpm: 120 };
  const b = { id: 'B', filePath: '/b', trackTitle: 'B', baseBpm: 90 };
  const once = swapDeckState(a as any, b as any);
  const twice = swapDeckState(once.a as any, once.b as any);
  assert.equal(twice.a.filePath, '/a');
  assert.equal(twice.a.trackTitle, 'A');
  assert.equal(twice.b.filePath, '/b');
  assert.equal(twice.b.baseBpm, 90);
});