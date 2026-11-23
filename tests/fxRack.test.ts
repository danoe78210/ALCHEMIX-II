// ALC-213-4 : tests `node --test` de la logique pure du Rack FX (module `src/lib/audio/fxRack.ts`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultFxRackState,
  fxDelaySeconds,
  fxEqualPower,
  fxComplementaryBalance,
  fxEchoDelayClipped,
  FX_ECHO_MIN_SECONDS,
  clampLivePadIndex,
  fxRecordingFileName,
  SLOT1_MODE_UI,
  SLOT2_MODE_UI,
  autoActivatesOnAdjust,
} from '$lib/audio/fxRack';

test('ALC-213 : état par défaut du Rack FX', () => {
  const s = defaultFxRackState();
  assert.equal(s.deck, 'A');
  assert.equal(s.stemTarget, 'all');
  assert.equal(s.slot1.active, false);
  assert.equal(s.slot1.mode, 'LPF');
  assert.equal(s.slot3.division, '1/4');
  assert.equal(s.slot3.tailHold, false);
  assert.equal(s.isRecordingFx, false);
  assert.equal(s.livePadIndex, null);
});

test('ALC-213 : subdivision BPM (durée de délai) 1/4, 1/2, 3/4, 1 T', () => {
  const bpm = 120; // beat = 0.5 s
  assert.equal(fxDelaySeconds('1/4', bpm), 0.5);
  assert.equal(fxDelaySeconds('1/2', bpm), 1);
  assert.equal(fxDelaySeconds('3/4', bpm), 1.5);
  // '1 T' = triplet (2/3 de beat)
  assert.ok(Math.abs(fxDelaySeconds('1 T', bpm) - (2 / 3) * 0.5) < 1e-3);
  // clamp BPM hors plage [40;220]
  assert.ok(Math.abs(fxDelaySeconds('1/4', 10) - 60 / 40) < 1e-3, 'clamp bas 40 BPM');
  assert.ok(Math.abs(fxDelaySeconds('1/4', 500) - 60 / 220) < 1e-3, 'clamp haut 220 BPM');
});

test('ALC-213 : dry/wet à puissance égale (equal-power)', () => {
  const half = fxEqualPower(0.5);
  assert.ok(Math.abs(half.wet - Math.SQRT1_2) < 1e-3);
  assert.ok(Math.abs(half.dry - Math.SQRT1_2) < 1e-3);
  assert.equal(fxEqualPower(0).wet, 0);
  assert.equal(fxEqualPower(1).dry, 0);
  assert.equal(fxEqualPower(2).wet, 1, 'clamp haut');
  assert.equal(fxEqualPower(-1).dry, 1, 'clamp bas');
});

test('ALC-215 : reset FX — un nouvel état par défaut remet les 3 slots en bypass', () => {
  const s = defaultFxRackState();
  assert.equal(s.slot1.active, false);
  assert.equal(s.slot2.active, false);
  assert.equal(s.slot3.active, false);
  assert.equal(s.slot1.dryWet, 0.35);
  assert.equal(s.isRecordingFx, false);
});

test('ALC-215 : modes/symboles débutants des tranches 1 et 2', () => {
  assert.equal(SLOT1_MODE_UI.length, 3);
  assert.equal(SLOT1_MODE_UI[0].symbol, '↘');
  assert.equal(SLOT1_MODE_UI[0].label, 'LPF · Graves');
  assert.equal(SLOT1_MODE_UI[1].symbol, '∧');
  assert.equal(SLOT1_MODE_UI[2].symbol, '↗');
  assert.equal(SLOT2_MODE_UI.length, 2);
  assert.equal(SLOT2_MODE_UI[0].symbol, '🔥');
  assert.equal(SLOT2_MODE_UI[0].label, 'Lampe chaude');
  assert.equal(SLOT2_MODE_UI[1].symbol, '〰');
});

test('ALC-217 : autoActivatesOnAdjust — régler un paramètre enclenche le slot', () => {
  assert.equal(autoActivatesOnAdjust({ cutoff: 500 }), true, 'filtre ajusté → activation');
  assert.equal(autoActivatesOnAdjust({ dryWet: 0.5 }), true, 'dosage ajusté → activation');
  assert.equal(autoActivatesOnAdjust({ tailHold: true }), true, 'TRAÎNÉE GARDÉE → activation');
  // Seul le champ `active` (bascule explicite) n'enclenche pas l'auto-activation par réglage.
  assert.equal(autoActivatesOnAdjust({ active: true }), false);
});

test('ALC-217 : propagation des paramètres — états par défaut des 3 slots distincts et applicables', () => {
  const s = defaultFxRackState();
  // Chaque slot possède ses paramètres dédiés (filtre / saturation-flanger / écho-réverb).
  assert.equal(s.slot1.mode, 'LPF');
  assert.ok(s.slot1.cutoff > 0 && s.slot1.resonance > 0);
  assert.equal(s.slot2.mode, 'LAMPE CHAUDE');
  assert.ok(s.slot2.drive > 0);
  assert.equal(s.slot3.division, '1/4');
  assert.ok(s.slot3.feedback >= 0 && s.slot3.reverbMix >= 0);
  // Le dosage par défaut est réellement > 0 (l'effet sera audible dès qu'on monte le curseur).
  assert.ok(s.slot3.dryWet > 0);
});

test('ALC-218 : balance Dry/Wet complémentaire stricte — pas de double routage', () => {
  for (const m of [0, 0.2, 0.35, 0.5, 0.8, 1]) {
    const { dry, wet } = fxComplementaryBalance(m);
    assert.ok(Math.abs(dry + wet - 1) < 1e-9, `dry+wet===1 pour mix=${m}`);
    assert.equal(wet, m);
    assert.equal(dry, 1 - m);
  }
  assert.equal(fxComplementaryBalance(2).wet, 1, 'clamp haut');
  assert.equal(fxComplementaryBalance(2).dry, 0);
  assert.equal(fxComplementaryBalance(-1).dry, 1, 'clamp bas');
  assert.equal(fxComplementaryBalance(-1).wet, 0);
});

test('ALC-218 : plancher écho >= 110 ms — pas de slapback / pas de double voix', () => {
  // Écho actif : jamais en dessous de 110 ms, même aux tempos très rapides / subdivisions courtes.
  assert.ok(fxEchoDelayClipped('1/4', 220, true) >= FX_ECHO_MIN_SECONDS);
  assert.ok(fxEchoDelayClipped('1 T', 220, true) >= FX_ECHO_MIN_SECONDS);
  assert.equal(fxEchoDelayClipped('1/4', 200, true), Math.max(fxDelaySeconds('1/4', 200), FX_ECHO_MIN_SECONDS));
  // Écho inactif : quasi-instant (aucun délai appliqué au signal).
  assert.equal(fxEchoDelayClipped('1/4', 120, false), 0.001);
  assert.equal(fxEchoDelayClipped('3/4', 90, false), 0.001);
  assert.equal(FX_ECHO_MIN_SECONDS, 0.11);
});

test('ALC-213 : préparation export / envoi vers Pad Live', () => {
  assert.equal(clampLivePadIndex(-3), 0);
  assert.equal(clampLivePadIndex(9), 7);
  assert.equal(clampLivePadIndex(4), 4);
  const name = fxRecordingFileName('B', 4);
  assert.match(name, /^RACKFX_B_.*_P4\.wav$/);
  const noPad = fxRecordingFileName('MASTER', null);
  assert.match(noPad, /^RACKFX_MASTER_.*\.wav$/);
  assert.ok(!noPad.includes('_P'), 'sans pad : aucun suffixe _P');
});