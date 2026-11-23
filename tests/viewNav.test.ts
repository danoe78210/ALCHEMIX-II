// ALC-191-4 : tests `node --test` de la navigation du guide Mashup (module pur `viewNav`).
// Lancement :  node --import ./tests/loader.mjs --test tests/viewNav.test.ts
// Le store (`mixer.svelte.ts`, runes) n'est pas importable sous Node : le store délègue ici ses
// actions `toggleMashupGuide()` / `openTabFromGuide(tab)`. On vérifie donc le CONTRAT exact :
// aller-retour vers la vue précédente + ouverture d'un onglet depuis l'aide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guideTransition, guideIsOpen, switchCenterView, type CenterView } from '$lib/utils/viewNav';

// Repli EXACT des actions du store (mixer.svelte.ts) sur le module pur.
function makeNav(view: CenterView) {
  return { view, prev: 'camelot' as CenterView };
}
function toggle(nav: ReturnType<typeof makeNav>) {
  const r = guideTransition(nav.view, nav.prev);
  nav.prev = r.memorize;
  nav.view = r.view;
}
function openTab(nav: ReturnType<typeof makeNav>, tab: 'camelot' | 'beatgrid' | 'library' | 'stems') {
  nav.view = tab;
}

test('toggleMashupGuide : ouverture mémorise la vue active, fermeture la restaure (aller-retour)', () => {
  const nav = makeNav('stems'); // le DJ était sur l'onglet STEMS IA
  toggle(nav); // ouvrir le guide
  assert.equal(nav.view, 'guide', 'ouverture -> guide');
  assert.equal(guideIsOpen(nav.view), true);
  assert.equal(nav.prev, 'stems', 'vue précédente mémorisée (stems)');

  toggle(nav); // fermer le guide
  assert.equal(nav.view, 'stems', 'fermeture -> retour exact à la vue précédente (stems)');
  assert.equal(nav.prev, 'stems');
  assert.equal(guideIsOpen(nav.view), false);
});

test('toggleMashupGuide : restaure la vue précédente même quand on ouvrait depuis d autres onglets', () => {
  for (const from of ['camelot', 'beatgrid', 'library', 'stems'] as const) {
    const nav = makeNav(from);
    toggle(nav);
    assert.equal(nav.view, 'guide');
    assert.equal(nav.prev, from);
    toggle(nav);
    assert.equal(nav.view, from, `retour vers ${from}`);
  }
});

test('openTabFromGuide : depuis le guide, ouvre directement l onglet demandé', () => {
  const nav = makeNav('stems');
  toggle(nav); // ouvre le guide
  assert.equal(nav.view, 'guide');
  openTab(nav, 'beatgrid'); // ex: étape 05 (Beatgrid)
  assert.equal(nav.view, 'beatgrid', 'guide fermé -> onglet beatgrid actif');
  assert.equal(guideIsOpen(nav.view), false);
});

test('ALC-198-3 : bascule d onglet vers BEATGRID depuis guide ou stems', () => {
  assert.equal(switchCenterView('guide', 'beatgrid'), 'beatgrid', 'depuis guide');
  assert.equal(switchCenterView('stems', 'beatgrid'), 'beatgrid', 'depuis stems');
  assert.equal(switchCenterView('library', 'beatgrid'), 'beatgrid', 'depuis library');
});