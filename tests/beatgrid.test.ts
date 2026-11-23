// ALC-202-2 : clés 100 % uniques de measuresFor / beatsFor, même au début du morceau.
// Module pur `src/lib/utils/beatgrid.ts` (hors Svelte / DOM), testé via `node --test`.
// Réplique des paramètres par défaut du Ruban Beatgrid : WAVE_W=640, beatSec=0.5, stride=20.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measuresFor, beatsFor } from '$lib/utils/beatgrid';

function allUnique<T extends { key: string }>(arr: T[]): boolean {
  return new Set(arr.map((a) => a.key)).size === arr.length;
}

test('ALC-202-2 : measuresFor — clés strictement uniques à elapsedSeconds = 0', () => {
  const marks = measuresFor('A', 0, 0.5, 20);
  assert.ok(marks.length >= 1, 'au moins un repère de mesure visible en début de morceau');
  assert.equal(allUnique(marks), true, 'aucune clé dupliquée (M-1 répété interdit)');
});

test('ALC-202-2 : measuresFor — aucune mesure invalide (< 1) émise à elapsedSeconds = 0', () => {
  const marks = measuresFor('A', 0, 0.5, 20);
  for (const m of marks) {
    assert.ok(!/M-/.test(m.m), `mesure négative interdite : ${m.m}`);
    assert.notEqual(m.m, 'M0', 'mesure zéro interdite');
  }
});

test('ALC-202-2 : beatsFor — clés strictement uniques à elapsedSeconds = 0', () => {
  const marks = beatsFor('B', 0, 0.5, 20);
  assert.ok(marks.length >= 1, 'au moins un temps visible en début de morceau');
  assert.equal(allUnique(marks), true, 'aucune clé dupliquée');
});

test('ALC-202-2 : mesuresFor/beatsFor — clés uniques quand le temps avance', () => {
  const m = measuresFor('A', 40, 0.5, 20);
  assert.equal(allUnique(m), true);
  const b = beatsFor('A', 40, 0.5, 20);
  assert.equal(allUnique(b), true);
  // jamais de mesure invalide (< 1) quelle que soit la position du curseur
  assert.ok(!m.some((x) => x.m === 'M0' || /M-/.test(x.m)));
  // le repère le plus proche du curseur est la mesure courante (ph=40s -> M21), tous > 0
  assert.ok(m.every((x) => !/M0|M-/.test(x.m)));
});