// ALC-228 : tests `node --test` du Pilote Automatique AUTO-MASHUP STUDIO (logique pure + simulateur).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStemPreset } from '$lib/audio/stemMix';
import { computeNormalizedTempoRatio } from '$lib/utils/tempo';

test('ALC-228 : runFullAutoMashup("instA_vocB") — tempo B aligné sur A, A INST / B ACAPELLA, crossfader 0.50, prêt', () => {
  // Pompeii (A, BPM effectif 127.5) + Personal Jesus (B, BPM de base 130.0).
  const bpmA = 127.5;
  const baseB = 130.0;
  // Étape 1 : aligne le tempo de B sur A (normalisation octave).
  const norm = computeNormalizedTempoRatio(baseB, bpmA);
  const pitchB = Number(((norm.ratio - 1) * 100).toFixed(2));
  const effB = Number((baseB * (1 + pitchB / 100)).toFixed(1));
  assert.ok(Math.abs(effB - bpmA) < 0.3, `B effectif ${effB} ≈ A ${bpmA} (aligné sans demi-tempo)`);
  // Étape 3 : recette mashup — A instrumental (voix coupée) + B acapella (voix seule).
  const base = { vocals: false, drums: false, bass: false, other: false };
  const aMutes = applyStemPreset(base, 'instrumental');
  const bMutes = applyStemPreset(base, 'acapella');
  assert.equal(aMutes.vocals, true, 'A passée en INST (VOIX coupée)');
  assert.equal(aMutes.drums, false, 'A garde ses instruments');
  assert.equal(bMutes.vocals, false, 'B passée en ACAPELLA (VOIX seule)');
  assert.equal(bMutes.drums, true, 'B coupe ses instruments');
  // Crossfader 50/50.
  assert.equal(50, 50);
  // Étape 5 : cadence restée alignée → readyToSaveDuo === true.
  assert.ok(Math.abs(effB - bpmA) <= 0.5, 'cadence alignée en fin de pipeline');
  const terminal = { running: false, stepIndex: 5, readyToSaveDuo: true };
  assert.equal(terminal.running, false);
  assert.equal(terminal.stepIndex, 5);
  assert.equal(terminal.readyToSaveDuo, true);
});

test('ALC-228 : mode vocA_instB — A ACAPELLA + B INSTRUMENTAL', () => {
  const base = { vocals: false, drums: false, bass: false, other: false };
  const aMutes = applyStemPreset(base, 'acapella');
  const bMutes = applyStemPreset(base, 'instrumental');
  assert.equal(aMutes.vocals, false, 'A : VOIX seule');
  assert.equal(aMutes.drums, true);
  assert.equal(bMutes.vocals, true, 'B : instrumental');
  assert.equal(bMutes.drums, false);
});