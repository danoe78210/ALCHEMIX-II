// ALC-205-4 : tests `node --test` du Barillet Horloger à 6 crans (module pur `viewNav.ts`).
// Lancement :  node --import ./tests/loader.mjs --test tests/barrelNav.test.ts
// Le store (`mixer.svelte.ts`, runes + Tauri) n'est pas importable sous Node : on vérifie le
// CONTRAT exact du module pur (CENTER_MODULES ordonné + bouclage cyclique next/prev).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CENTER_MODULES,
  nextCenterModule,
  prevCenterModule,
  setCenterModule,
  moduleStepDelta,
} from '$lib/utils/viewNav';

test('ALC-205-4 : CENTER_MODULES contient exactement les 6 modules dans l ordre du Barillet', () => {
  assert.equal(CENTER_MODULES.length, 6, 'exactement 6 modules');
  assert.deepEqual(
    CENTER_MODULES.map((m) => m.id),
    ['camelot', 'beatgrid', 'library', 'stems', 'fx_rack', 'live_mix'],
    'ordre exact 01..06'
  );
  assert.deepEqual(CENTER_MODULES.map((m) => m.index), ['01', '02', '03', '04', '05', '06']);
  assert.equal(CENTER_MODULES[4].label, 'RACK FX');
  assert.equal(CENTER_MODULES[5].label, 'MIX LIVE');
  assert.equal(CENTER_MODULES[3].shortLabel, 'STEMS IA');
});

test('ALC-205-4 : nextCenterModule avance cran par cran puis boucle 06 -> 01', () => {
  assert.equal(nextCenterModule('camelot'), 'beatgrid');
  assert.equal(nextCenterModule('beatgrid'), 'library');
  assert.equal(nextCenterModule('library'), 'stems');
  assert.equal(nextCenterModule('stems'), 'fx_rack');
  assert.equal(nextCenterModule('fx_rack'), 'live_mix');
  assert.equal(nextCenterModule('live_mix'), 'camelot', '06 -> 01');
});

test('ALC-205-4 : prevCenterModule recule cran par cran puis boucle 01 -> 06', () => {
  assert.equal(prevCenterModule('camelot'), 'live_mix', '01 -> 06');
  assert.equal(prevCenterModule('live_mix'), 'fx_rack');
  assert.equal(prevCenterModule('fx_rack'), 'stems');
  assert.equal(prevCenterModule('stems'), 'library');
  assert.equal(prevCenterModule('library'), 'beatgrid');
  assert.equal(prevCenterModule('beatgrid'), 'camelot');
});

test('ALC-205-4 : setCenterModule positionne la vue sur le module demande', () => {
  assert.equal(setCenterModule('beatgrid', 'fx_rack'), 'fx_rack');
  assert.equal(setCenterModule('camelot', 'live_mix'), 'live_mix');
});

test('ALC-206-3 : moduleStepDelta — pas adjacent +1/-1 + bouclage 06<->01', () => {
  assert.equal(moduleStepDelta('camelot', 'beatgrid'), 1);
  assert.equal(moduleStepDelta('beatgrid', 'camelot'), -1);
  assert.equal(moduleStepDelta('live_mix', 'camelot'), 1, '06 -> 01 : pas horaire +1');
  assert.equal(moduleStepDelta('camelot', 'live_mix'), -1, '01 -> 06 : pas anti-horaire -1');
});

test('ALC-206-3 : moduleStepDelta — ecart signe court pour un saut direct (rivet/raccourci)', () => {
  assert.equal(moduleStepDelta('camelot', 'library'), 2, '01 -> 03 : +2 horaire');
  assert.equal(moduleStepDelta('library', 'camelot'), -2, '03 -> 01 : -2 anti-horaire');
  assert.equal(moduleStepDelta('camelot', 'stems'), 3, '01 -> 04 : +3 (borne courte)');
  assert.equal(moduleStepDelta('camelot', 'fx_rack'), -2, '01 -> 05 : 4 > 6/2 -> raccourci -2');
  assert.equal(moduleStepDelta('fx_rack', 'library'), -2, '05 -> 03 : -2');
});

test('ALC-206-3 : moduleStepDelta — hors Barillet (guide) renvoie 0', () => {
  assert.equal(moduleStepDelta('guide', 'camelot'), 0);
  assert.equal(moduleStepDelta('camelot', 'guide' as never), 0);
});