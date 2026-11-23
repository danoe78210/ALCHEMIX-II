// ALC-187-4 : tests `node --test` de la logique PURE du mix 4 Stems (module `$lib/audio/stemMix`).
// Lancement :  node --import ./tests/loader.mjs --test tests/stemsMix.test.ts
//
// Le store (`mixer.svelte.ts`) utilise des runes Svelte 5 non importables sous Node (voir
// headers de `stemsStop.test.ts`). La console centrale STEMS IA et les tiroirs latéraux lisent
// STRICTEMENT les mêmes objets `deckA`/`deckB` du store : ici on vérifie les LOIS de calcul
// (setDeckStemVolume, applyCrossDeckMashup, coherence) via le module pur que le store délègue, sur
// UN SEUL objet deck partagé entre les deux « vues ». La non-régression STOP / EJECT du Player est
// couverte par `tests/stemsStop.test.ts` (même commande `node --test tests/`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNormalizedTempoRatio } from '$lib/utils/tempo';
import {
  clampStemVolume,
  effectiveStemGain,
  applyStemPreset,
  freshStemMutes,
  unitStemGains,
  resolveCrossDeckMashup,
  stemActive,
  resolveStemHit,
  composeSelectedStemsEnvelope,
  isComplementaryMashup,
  resolveAutoMixTarget,
  detectFirstVocalEntrySeconds,
  detectActiveVocalZoneAt,
  computeAutoVocalPlan,
  resolveMashupRoles,
  vocalTriggerDue,
  vocalPhraseEnvelope,
  detectFirstVocalPhraseEndSeconds,
  extractVocalStanzas,
  findNextStanzaStartAfter,
  findFirstVocalStanzaStart,
  computeOstVocalMashupPlan,
  computeOstVocalEnergyRatio,
  computeOstMashupTempo,
  clampOstVocalPlaybackRate,
  playbackRateToCents,
  isStemsTelemetryBpmAcceptable, // ALC-251-2 : garde-fou BPM universel (testable pur)
  keyLockCompensationCents,
  needsKeyLock,
  computePhraseSyncedVocalPlan,
  computeContinuousOstMashupPlan,
  recommendMashupRecipe,
  genreHintsOstCinema,
  shouldSuggestOstCinema,
  STEMS_RESET_MESSAGE,
  TEMPO_PHASE_MESSAGE,
} from '$lib/audio/stemMix';

// Fausse platine reproduisant EXACTEMENT les champs partagés du store que lisent les deux vues.
function makeDeck() {
  return {
    filePath: 'C:/titre.mp3',
    stemsStatus: 'ready' as const,
    stemGains: { vocals: 1, drums: 0.8, bass: 1, other: 1 },
    stemMutes: { vocals: false, drums: false, bass: false, other: false },
  };
}

// Repli EXACT de mixer.svelte.ts (setDeckStemVolume + applyStemMutes) sur le module pur —
// garantit que le test valide le même contrat que la vraie action du store.
type StemCol = 'vocals' | 'drums' | 'bass' | 'other';
function setDeckStemVolume(deck: ReturnType<typeof makeDeck>, stem: StemCol, value: number): number {
  deck.stemGains[stem] = clampStemVolume(value);
  return effectiveStemGain(deck.stemMutes, deck.stemGains, stem);
}

test('setDeckStemVolume : volume borne (0..1), effective = muted ? 0 : volume', () => {
  const deck = makeDeck();
  // volume nominal appliqué → gain effectif identique (non muté)
  assert.equal(setDeckStemVolume(deck, 'vocals', 0.5), 0.5);
  assert.equal(deck.stemGains.vocals, 0.5, 'source voitus = volume utilisateur');
  // clamps
  assert.equal(setDeckStemVolume(deck, 'drums', 2), 1);
  assert.equal(setDeckStemVolume(deck, 'bass', -0.3), 0);
  assert.equal(setDeckStemVolume(deck, 'other', Number.NaN), 1, 'NaN -> 1 (défaut)');
  // un stem muté reste à 0 en effectif, mais son volume utilisateur est conservé
  deck.stemMutes.vocals = true;
  assert.equal(effectiveStemGain(deck.stemMutes, deck.stemGains, 'vocals'), 0, 'muted -> 0');
  assert.equal(deck.stemGains.vocals, 0.5, 'le volume utilisateur n est pas écrasé par le mute');
});

test('applyCrossDeckMashup : la platine porteuse de la voix en ACAPELLA, l autre en INST', () => {
  // vocalDeck = 'A'
  const targetsA = resolveCrossDeckMashup('A');
  assert.deepEqual(targetsA, { A: 'acapella', B: 'instrumental' });
  const mutesA = applyStemPreset({ vocals: false, drums: false, bass: false, other: false }, targetsA.A);
  const mutesB = applyStemPreset({ vocals: false, drums: false, bass: false, other: false }, targetsA.B);
  assert.equal(mutesA.vocals, false, 'A : voix audible');
  assert.equal(mutesA.drums, true, 'A : batterie coupée');
  assert.equal(mutesB.vocals, true, 'B : voix coupée (instrumental)');
  assert.equal(mutesB.drums, false, 'B : batterie audible');

  // vocalDeck = 'B' (symétrique)
  const targetsB = resolveCrossDeckMashup('B');
  assert.deepEqual(targetsB, { A: 'instrumental', B: 'acapella' });
  const bA = applyStemPreset({ vocals: false, drums: false, bass: false, other: false }, targetsB.A);
  const bB = applyStemPreset({ vocals: false, drums: false, bass: false, other: false }, targetsB.B);
  assert.equal(bA.vocals, true, 'Symétrie : A en instrumental (voix coupée)');
  assert.equal(bB.vocals, false, 'Symétrie : B en acapella (voix audible)');
});

test('cohérence état partagé : console centrale et platine latérale lisent le MÊME objet deck', () => {
  const deck = makeDeck();
  // Les deux vues détiennent la même référence (source unique de vérité).
  const lateralView = deck; // les boutons M/S + presets des tiroirs DeckA/DeckB
  const centralView = deck; // les faders + mutes de StemsMixerView
  assert.equal(lateralView, centralView, 'une seule source de vérité par deck');

  // Action latérale : Mute VOIX sur la platine
  lateralView.stemMutes.vocals = true;
  // Action centrale : fader VOIX sur la console centrale
  const effCentral = setDeckStemVolume(centralView, 'vocals', 0.33);
  // Les deux vues voient immédiatement le même état, sans recalcul
  assert.equal(centralView.stemMutes.vocals, true, 'le mute latéral est visible au centre');
  assert.equal(lateralView.stemGains.vocals, 0.33, 'le fader central est visible sous la platine');
  assert.equal(effCentral, 0, 'effectif mute pendant que la voix est coupée');

  // Un autre stem non muté conserve son niveau central → les presets ne touchent pas aux volumes
  const mutes = applyStemPreset(deck.stemMutes, 'acapella');
  assert.equal(mutes.vocals, false);
  assert.equal(deck.stemGains.vocals, 0.33, 'la volonté centrale n est pas écrasée par le preset');
});

test('preset TOUT (Reset 8 pistes) : aucun mute, volumes inchangés', () => {
  const deck = makeDeck();
  deck.stemGains.vocals = 0.4;
  deck.stemMutes.vocals = true;
  const reset = applyStemPreset(deck.stemMutes, 'all');
  for (const k of Object.keys(reset)) assert.equal(reset[k], false, `${k} réactivé`);
  assert.equal(deck.stemGains.vocals, 0.4, 'volumes préservés au reset');
});

// ── ALC-188-2/3 : aller-retour centre ⟷ latéral (état effectif & réactivation volume 1.0) ──

test('aller-retour : mute/volume au centre -> état effectif du deck latéral ; réactivation -> 1.0', () => {
  const deck = makeDeck();
  // 1) Volume baissé au centre (console centrale) → le deck latéral reste audible
  deck.stemGains.vocals = 0.5;
  assert.equal(stemActive(deck.stemMutes, deck.stemGains, 'vocals'), true, 'audible à 50%');
  // 2) Mute au centre → état effectif inactif sur le deck (même objet partagé)
  deck.stemMutes.vocals = true;
  assert.equal(stemActive(deck.stemMutes, deck.stemGains, 'vocals'), false, 'inactif quand muet');
  assert.equal(deck.stemGains.vocals, 0.5, 'le volume central est conservé pendant le mute');
  // 3) Clic sur le bouton sous le deck : réactivation restaure mute=false + volume=1.0
  const hit = resolveStemHit(deck.stemMutes, deck.stemGains, 'vocals');
  deck.stemMutes.vocals = hit.muted;
  deck.stemGains.vocals = hit.volume;
  assert.equal(deck.stemMutes.vocals, false, 'mute levé');
  assert.equal(deck.stemGains.vocals, 1, 'volume restauré à 1.0 (fader central remonte en miroir)');
  assert.equal(stemActive(deck.stemMutes, deck.stemGains, 'vocals'), true, 'audible après réactivation');
});

test('fader central à 0% + clic deck : réactivation -> volume 1.0 ; clic suivant -> mute (volume préservé)', () => {
  const deck = makeDeck();
  // DJ baisse un fader central à 0 % sans muter → le stem devient inactif
  deck.stemGains.drums = 0;
  assert.equal(stemActive(deck.stemMutes, deck.stemGains, 'drums'), false, 'inactif à 0%');
  // Clic sur le bouton BATT du deck → réactivation
  const hit = resolveStemHit(deck.stemMutes, deck.stemGains, 'drums');
  deck.stemMutes.drums = hit.muted;
  deck.stemGains.drums = hit.volume;
  assert.equal(deck.stemMutes.drums, false, 'mute levé');
  assert.equal(deck.stemGains.drums, 1, 'volume restauré à 100%');
  // Clic suivant (désormais audible) → mute, volume préservé à 1.0
  const hit2 = resolveStemHit(deck.stemMutes, deck.stemGains, 'drums');
  deck.stemMutes.drums = hit2.muted;
  deck.stemGains.drums = hit2.volume;
  assert.equal(deck.stemMutes.drums, true, 'audible -> mute');
  assert.equal(deck.stemGains.drums, 1, 'volume conservé au mute');
});

// ── ALC-190 : enveloppe par stem (Beatgrid) + complémentarité mashup (Auto-Mix) ──

const F = (v: number) => new Float32Array(512).fill(v);

test('composeSelectedStemsEnvelope : seuls les stems actifs composent l onde (pics instrumentaux disparaissent)', () => {
  // vocals faible vs instruments riches — simule un passage instrumental absent de la voix
  const ENV = { vocals: F(0.05), drums: F(0.9), bass: F(0.8), other: F(0.3) };
  const gains = { vocals: 1, drums: 1, bass: 1, other: 1 };
  const fallback = F(1);

  // seule vocals active → l'enveloppe filtrée ne garde QUE l'enveloppe vocale (≈ 0.05)
  const out = composeSelectedStemsEnvelope(ENV, gains, { vocals: false, drums: true, bass: true, other: true }, fallback);
  assert.ok(out instanceof Float32Array, 'retourne un Float32Array');
  assert.equal(out.length, 512, '512 bins');
  assert.ok(out[0] < 0.2, 'les pics instrumentaux (0.9) disparaissent quand seule vocals est active');
  assert.ok(out[200] <= 0.06, 'valeur ≈ enveloppe vocale (0.05)');

  // tous les stems actifs → retourne l'enveloppe globale (fallback), pas la somme filtrée
  const outAll = composeSelectedStemsEnvelope(ENV, gains, { vocals: false, drums: false, bass: false, other: false }, fallback);
  assert.equal(outAll[0], 1, 'tous actifs -> enveloppe globale');

  // aucun stem actif (tout muet) → repli enveloppe globale (jamais d onde vide)
  const outNone = composeSelectedStemsEnvelope(ENV, gains, { vocals: true, drums: true, bass: true, other: true }, fallback);
  assert.equal(outNone[0], 1, 'aucun actif -> enveloppe globale');
});

// Petite « platine » conforme à DeckState partielle (source unique stemMixed).
function stemDeck(stemsStatus: string, mutes: Record<string, boolean>, gains: Record<string, number>) {
  return { stemsStatus, stemMutes: mutes, stemGains: gains };
}
const INST_MUTES = { vocals: true, drums: false, bass: false, other: false };
const VOX_ONLY_MUTES = { vocals: false, drums: true, bass: true, other: true };
const ALL_GAINS = { vocals: 1, drums: 1, bass: 1, other: 1 };

test('isComplementaryMashup : vrai quand une platine est en acapella et l autre en instrumentale', () => {
  const instrA = stemDeck('ready', INST_MUTES, ALL_GAINS); // A : voix coupée, instruments actifs
  const vocalB = stemDeck('ready', VOX_ONLY_MUTES, ALL_GAINS); // B : voix seule
  assert.equal(isComplementaryMashup(instrA, vocalB), true, 'A instrumentale + B voix seule');
  assert.equal(isComplementaryMashup(vocalB, instrA), true, 'symétrique');

  // les deux avec voix → pas complémentaire
  const bothVocal = stemDeck('ready', { vocals: false, drums: false, bass: false, other: false }, ALL_GAINS);
  assert.equal(isComplementaryMashup(bothVocal, vocalB), false, 'deux voix -> non complémentaire');

  // stems pas prêts → false
  const idle = stemDeck('idle', INST_MUTES, ALL_GAINS);
  assert.equal(isComplementaryMashup(idle, vocalB), false, 'stems non extraits -> non complémentaire');
});

test('resolveAutoMixTarget : 50/50 en mashup complémentaire, transition 100/0 sinon', () => {
  assert.equal(resolveAutoMixTarget(true, 'A_TO_B'), 50, 'mashup -> 50');
  assert.equal(resolveAutoMixTarget(true, 'B_TO_A'), 50, 'mashup -> 50 (indépendant de la direction)');
  assert.equal(resolveAutoMixTarget(false, 'A_TO_B'), 100, 'standard A_TO_B -> 100');
  assert.equal(resolveAutoMixTarget(false, 'B_TO_A'), 0, 'standard B_TO_A -> 0');
  // cible réelle du startAutoMix sur un montage complémentaire (A instrumentale + B acapella)
  const target = resolveAutoMixTarget(
    isComplementaryMashup(stemDeck('ready', INST_MUTES, ALL_GAINS), stemDeck('ready', VOX_ONLY_MUTES, ALL_GAINS)),
    'A_TO_B'
  );
  assert.equal(target, 50, 'auto-mix sur setup complémentaire cible 50/50');
});

// ── ALC-196 : déclenchement mashup (entrée vocale auto + rôles A/B + trigger) ──

test('ALC-219 : retours UI reset / alignement tempo-phase (badges) — constantes stables', () => {
  assert.equal(STEMS_RESET_MESSAGE, 'STEMS RÉINITIALISÉS');
  assert.equal(TEMPO_PHASE_MESSAGE, 'TEMPO & PHASE ALIGNÉS');
  // Le reset repasse bien les 4 stems à mixture complète (audibles, actifs).
  const g = unitStemGains();
  const m = freshStemMutes();
  for (const s of ['vocals', 'drums', 'bass', 'other']) {
    assert.equal(m[s], false);
    assert.equal(g[s], 1);
    assert.equal(stemActive(m, g, s), true);
  }
});

test('ALC-219 : plan Auto Voix expose les repères temporels A→B (entrée vocale + départ B)', () => {
  // inst (A) a sa voix à 16 s ; la voix de B démarre à 12 s ; A est en amont (00:00).
  const plan = computeAutoVocalPlan({ entryA: 16, entryB: 12, vocNow: 0, instNow: 0, userInActiveVocalZone: false });
  assert.equal(plan.entryA, 16, 'repère d entrée vocale de A');
  assert.equal(plan.entryB, 12, 'point de départ calé sur B');
  assert.equal(plan.vocalStartSeconds, 12, 'B pré-positionné sur son départ vocal');
  assert.equal(plan.vocalTriggerTarget, 16, 'déclenchement B quand A franchit 16 s');
  assert.equal(plan.triggerVocalImmediately, false, 'inst en amont → mode attente');
  assert.ok(Number.isFinite(plan.vocalStartSeconds));
});

test('ALC-223 : relais vocal A→B — A complet / B acapella + fin de 1re phrase de A quantifiée + bascule', () => {
  // Armement : A TOUT (VOIX active), B VOIX SEULE (acapella : instruments coupés, voix active).
  const base = { vocals: false, drums: false, bass: false, other: false };
  const aMutes = applyStemPreset(base, 'all');
  assert.equal(aMutes.vocals, false, 'A complet : voix non coupée');
  assert.equal(aMutes.drums, false);
  const bMutes = applyStemPreset(base, 'acapella');
  assert.equal(bMutes.vocals, false, 'B acapella : voix ACTIVE');
  assert.equal(bMutes.drums, true, 'B : instruments coupés');
  assert.equal(bMutes.bass, true);
  assert.equal(bMutes.other, true);
  // Terminaison de la 1re phrase vocale de A, quantifiée sur le beat suivant.
  const env = new Float32Array(100).fill(0.05);
  env.fill(0.5, 20, 30); // phrase vocale A : bins 20..29 (durée 100 s, 120 BPM → beat 0.5 s)
  const end = detectFirstVocalPhraseEndSeconds(env, 100, 120, 0);
  assert.ok(Math.abs(end - 30) < 1e-6, `fin de phrase quantifiée au beat suivant (30 s), obtenu ${end}`);
  // BASCULE : la voix de B est lancée dès que A a franchi la fin de phrase (et VOIX A coupée).
  assert.equal(vocalTriggerDue(29.9, end), false, 'avant fin de phrase : pas de bascule');
  assert.equal(vocalTriggerDue(30, end), true, 'à la fin de phrase : bascule AUTO');
  // Après bascule : VOIX A OFF (aMutes.vocals=true simulé) ; B conserve sa voix seule → gain effectif 1.
  const afterHandoff = { ...aMutes, vocals: true };
  assert.equal(effectiveStemGain(afterHandoff, { vocals: 1, drums: 1, bass: 1, other: 1 }, 'vocals'), 0, 'VOIX A coupée');
  assert.equal(effectiveStemGain(bMutes, { vocals: 1, drums: 1, bass: 1, other: 1 }, 'vocals'), 1, 'VOIX B seule entendue');
});

test('ALC-227 : extractVocalStanzas — deux strophes distinctes (seuil adaptatif)', () => {
  const env = new Float32Array(100).fill(0.05);
  env.fill(0.6, 12, 18); // strophe 1 : bins 12..17 → [12 s, 18 s]
  env.fill(0.6, 24, 30); // strophe 2 : bins 24..29 → [24 s, 30 s]
  const stanzas = extractVocalStanzas(env, 100, 120, 0);
  assert.equal(stanzas.length, 2);
  assert.ok(Math.abs(stanzas[0].start - 12) < 1e-6 && Math.abs(stanzas[0].end - 18) < 1e-6);
  assert.ok(Math.abs(stanzas[1].start - 24) < 1e-6 && Math.abs(stanzas[1].end - 30) < 1e-6);
});

test('ALC-227 : findNextStanzaStartAfter — prochaine strophe après current+0.5, quantifiée au downbeat', () => {
  const env = new Float32Array(100).fill(0.05);
  env.fill(0.6, 12, 18);
  env.fill(0.6, 24, 30);
  // current=13.5 → strophe 1 (12) n est pas future (12 < 14) → prochaine = 24 s.
  assert.equal(findNextStanzaStartAfter(env, 100, 120, 0, 13.5), 24);
  // current=1 → première strophe future = 12 s (quantifiée au downbeat).
  assert.equal(findNextStanzaStartAfter(env, 100, 120, 0, 1), 12);
  // current déjà au-delà de la dernière strophe → repli 8 mesures (16 s après current).
  const late = findNextStanzaStartAfter(env, 100, 120, 0, 40);
  assert.ok(late >= 40, `repli 8 mesures (>= current) : ${late}`);
  assert.equal(findFirstVocalStanzaStart(env, 100, 120, 0), 12);
});

test('ALC-227 : cycle bidirectionnel A→B→A en 4 temps (mutation vocale + pending + strophe suivante)', () => {
  const envA = new Float32Array(100).fill(0.05);
  envA.fill(0.6, 12, 18); // A : strophes à 12 s puis 24 s
  envA.fill(0.6, 24, 30);
  const mutesA = { vocals: false, drums: false, bass: false, other: false }; // A INST+VOIX
  const mutesB = { vocals: false, drums: true, bass: true, other: true }; // B ACAPELLA
  let pending: 'A' | 'B' | null = null;
  let speaker: 'A' | 'B' = 'A';
  let trigger = 0;
  // 1) A chante, B attend → 1er clic : coupe A immédiatement + pending B à la prochaine strophe.
  mutesA.vocals = true;
  pending = 'B';
  trigger = findNextStanzaStartAfter(envA, 100, 120, 0, 13.5);
  assert.equal(mutesA.vocals, true, 'VOIX A coupée immédiatement');
  assert.equal(pending, 'B');
  assert.equal(trigger, 24, 'arrivée de B à la strophe suivante (24 s)');
  // 2) À trigger : ouvre VOIX B + activeSpeaker = B.
  mutesB.vocals = false;
  speaker = 'B';
  pending = null;
  assert.equal(mutesB.vocals, false, 'VOIX B ouverte à la strophe suivante');
  assert.equal(speaker, 'B');
  // 3) B chante → 2e clic : coupe B à la strophe suivante, pending A.
  mutesB.vocals = true;
  pending = 'A';
  trigger = findNextStanzaStartAfter(envA, 100, 120, 0, 24.5);
  assert.equal(mutesB.vocals, true, 'VOIX B coupée à la strophe suivante');
  assert.equal(pending, 'A');
  assert.ok(trigger >= 24.5);
  // 4) À trigger : ouvre VOIX A + activeSpeaker = A.
  mutesA.vocals = false;
  speaker = 'A';
  pending = null;
  assert.equal(mutesA.vocals, false, 'VOIX A rouverte');
  assert.equal(speaker, 'A');
});

test('ALC-223 : relais — repli de fin de phrase si aucune voix sur A (durée du morceau)', () => {
  const silent = new Float32Array(100).fill(0.05); // aucun bloc >= 0.18
  assert.equal(detectFirstVocalPhraseEndSeconds(silent, 100, 120, 0), 100);
});

test('ALC-214 : resetDeckStems — mutes à false et gains à 1.0 pour les 4 stems', () => {
  const mutes = freshStemMutes();
  const gains = unitStemGains();
  assert.deepEqual(mutes, { vocals: false, drums: false, bass: false, other: false });
  assert.deepEqual(gains, { vocals: 1, drums: 1, bass: 1, other: 1 });
  // Le preset TOUT repasse les mutes à false sans toucher aux gains.
  const applied = applyStemPreset(mutes, 'all');
  assert.equal(applied.vocals, false);
  assert.equal(applied.drums, false);
  // effectiveStemGain après reset = 1 pour chaque stem (audible, volume 100 %).
  for (const s of ['vocals', 'drums', 'bass', 'other']) {
    assert.equal(effectiveStemGain(mutes, gains, s), 1);
    assert.equal(stemActive(mutes, gains, s), true);
  }
});

test('detectFirstVocalEntrySeconds : premier créneau soutenu + quantification sur le temps fort', () => {
  const env = new Float32Array(100).fill(0.05);
  env.fill(0.5, 20); // voix qui démarre au bin 20 (soutenu ≥ 3 bins)
  // 100 s, 120 BPM (beat 0.5 s), offset grille 0
  assert.equal(detectFirstVocalEntrySeconds(env, 100, 120, 0), 20, 't=20 s quantifié sur le beat (multiple de 0.5)');
  // avec un offset de grille de 250 ms
  assert.equal(detectFirstVocalEntrySeconds(env, 100, 120, 250), 20.25, 'offset grille 250 ms respecté');
  // bruit d'intro : 2 bins seulement → non soutenu → 0
  const noise = new Float32Array(100).fill(0.05);
  noise.fill(0.5, 20, 22);
  assert.equal(detectFirstVocalEntrySeconds(noise, 100, 120, 0), 16, 'créneau < 3 bins sans voix → repli 8ᵉ mesure');
  // enveloppe vide → 0
  assert.equal(detectFirstVocalEntrySeconds(new Float32Array(0), 100, 120, 0), 0);
});

test('resolveMashupRoles : identifie instDeck (voix coupée) / vocalDeck (voix active)', () => {
  const instrA = stemDeck('ready', INST_MUTES, ALL_GAINS);
  const vocalB = stemDeck('ready', VOX_ONLY_MUTES, ALL_GAINS);
  assert.deepEqual(resolveMashupRoles(instrA, vocalB), { instDeck: 'A', vocalDeck: 'B' });
  assert.deepEqual(resolveMashupRoles(vocalB, instrA), { instDeck: 'B', vocalDeck: 'A' }, 'symétrique');
  // decks identiques (tous stems actifs) → défaut A instrumentale / B vocale
  const both = stemDeck('ready', { vocals: false, drums: false, bass: false, other: false }, ALL_GAINS);
  assert.deepEqual(resolveMashupRoles(both, both), { instDeck: 'A', vocalDeck: 'B' });
});

test('déclenchement auto/manuel du vocalDeck : vocalTriggerDue + rôle armé', () => {
  const roles = resolveMashupRoles(
    stemDeck('ready', INST_MUTES, ALL_GAINS),
    stemDeck('ready', VOX_ONLY_MUTES, ALL_GAINS)
  );
  assert.equal(roles.instDeck, 'A', 'platine instrumentale = A');
  assert.equal(roles.vocalDeck, 'B', 'platine vocale = B');
  // AUTO : la vocale démarre dès que l'instrumentale franchit l'entrée vocale cible.
  assert.equal(vocalTriggerDue(19, 20), false, 'pas encore au repère');
  assert.equal(vocalTriggerDue(20, 20), true, 'au repère → déclenchement');
  // MANUEL : le déclenchement cible bien le vocalDeck résolu (B).
  assert.equal(roles.vocalDeck, 'B', 'le déclencheur manuel vise la platine vocale B');
});

test('ALC-198-2 : les briques de phrase utilisent le STEM vocal (pondéré, 0 si voix coupée)', () => {
  const voc = new Float32Array([0.2, 0.3, 0.8, 0.5, 0.1]);
  const gains = { vocals: 0.5, drums: 1, bass: 1, other: 1 };
  // voix non coupée, gain 0.5 → enveloppe pondérée
  const w = vocalPhraseEnvelope(voc, { vocals: false, drums: false, bass: false, other: false }, gains);
  assert.ok(Math.abs(w[0] - 0.1) < 1e-5, '0.2 * 0.5 ≈ 0.1');
  assert.ok(Math.abs(w[2] - 0.4) < 1e-5, '0.8 * 0.5 ≈ 0.4');
  // voix coupée → toutes les valeurs à zéro (aucune brique vocale, espace libre)
  const m = vocalPhraseEnvelope(voc, { vocals: true, drums: false, bass: false, other: false }, gains);
  assert.equal(m[2], 0, 'voix coupée → zéro partout');
  assert.equal(m[0], 0);
});

test('auto-mix strict : les stems mutés ne sont JAMAIS réactivés (fonctions pures, entrées frozen)', () => {
  // vocals muté + drums à 0 → seuls bass & other restent dans le mix
  const frMutes = Object.freeze({ vocals: true, drums: false, bass: false, other: false });
  const frGains = Object.freeze({ vocals: 1, drums: 0, bass: 1, other: 1 });
  const ENV = { vocals: F(0.5), drums: F(0.7), bass: F(0.6), other: F(0.4) };
  // compose ne réactive pas un stem coupé : il lit seulement les états (aucune mutation → frozen OK).
  const out = composeSelectedStemsEnvelope(ENV, frGains, frMutes, F(1));
  assert.ok(Math.abs(out[0] - 0.6) < 1e-4, 'seuls bass(0.6)+other(0.4) composent → max≈0.6, vocals/drums exclus');
  // le mix n altère jamais l état du DJ
  assert.equal(frMutes.vocals, true, 'mute vocal strictement conservé');
  assert.equal(frGains.drums, 0, 'gain 0 strictement conservé');
});

// ── ALC-203 : pré-cue automatique du vocal B + synchro entrée vocale A ──
// Simule : Deck A (instrumentale) dont la voix originale commence à 16.0 s ; Deck B (vocal)
// dont l'intro dure 12.0 s avant le premier chant à 12.0 s.

test('ALC-226 : detectFirstVocalEntrySeconds — seuil ADAPTATIF (voix douces/réverb détectées) + repli 8ᵉ mesure (<3 bins)', () => {
  const bpm = 120; // beat 0.5 s
  // Voix douce soutenue (amplitude 0.16) : pic=0.16 → seuil adaptatif max(0.08, 0.04)=0.08 → détectée.
  const soft = new Float32Array(100).fill(0.05);
  soft.fill(0.16, 10, 18);
  assert.equal(detectFirstVocalEntrySeconds(soft, 100, bpm, 0), 10, 'voix douce soutenue détectée (seuil adaptatif)');
  // Créneau trop court (< 3 bins) sans vraie voix → repli garanti à la 8ᵉ mesure (16 s à 120 BPM).
  const tiny = new Float32Array(100).fill(0.05);
  tiny.fill(0.5, 10, 12);
  assert.equal(detectFirstVocalEntrySeconds(tiny, 100, bpm, 0), 16, 'repli 8ᵉ mesure (8×4×0.5)');
  // Stem totalement plat (0.05) → repli 8ᵉ mesure.
  assert.equal(detectFirstVocalEntrySeconds(new Float32Array(100).fill(0.05), 100, bpm, 0), 16);
});

test('ALC-203-1 : computeAutoVocalPlan — B pré-cue à 12 s (son propre chant), déclenché quand A franchit 16 s', () => {
  const envA = new Float32Array(100); // instrumentale : voix originale à 16 s (100 s, 120 BPM)
  envA.fill(0.5, 16);
  envA.fill(0.05, 0, 16);
  const envB = new Float32Array(100); // vocal : premier chant à 12 s (intro de 12 s)
  envB.fill(0.5, 12);
  envB.fill(0.05, 0, 12);
  const entryA = detectFirstVocalEntrySeconds(envA, 100, 120, 0);
  const entryB = detectFirstVocalEntrySeconds(envB, 100, 120, 0);
  assert.equal(entryA, 16, 'voix de A commence à 16 s');
  assert.equal(entryB, 12, 'voix de B commence à 12 s');

  // inst arrêtée à 00:00 → plan « attente » : inst maintenant, vocal au franchissement de 16 s.
  const plan = computeAutoVocalPlan({ entryA, entryB, instNow: 0, vocNow: 0, userInActiveVocalZone: false });
  assert.equal(plan.vocalStartSeconds, 12, 'B pré-positionné à 12 s (intro de 12 s sautée)');
  assert.equal(plan.instStartSeconds, 0, 'inst démarre à 00:00');
  assert.equal(plan.vocalTriggerTarget, 16, 'seuil de déclenchement = entrée vocale A');
  assert.equal(plan.triggerVocalImmediately, false, 'inst en amont → mode attente');
  // Le vocal décolle EXACTEMENT quand A franchit 16 s.
  assert.equal(vocalTriggerDue(15.9, plan.vocalTriggerTarget!), false, 'pas encore au repère');
  assert.equal(vocalTriggerDue(16, plan.vocalTriggerTarget!), true, 'A à 16 s → vocal B lancé');
});

test('ALC-203-1 : inst déjà passée entryA → vocal déclenché IMMÉDIATEMENT (toujours pré-cue sur 12 s)', () => {
  const plan = computeAutoVocalPlan({ entryA: 16, entryB: 12, instNow: 20, vocNow: 0, userInActiveVocalZone: false });
  assert.equal(plan.triggerVocalImmediately, true, 'inst à 20 s (déjà > 16) → immédiat');
  assert.equal(plan.vocalTriggerTarget, null);
  assert.equal(plan.vocalStartSeconds, 12, 'B reste pré-cue à sa propre entrée vocale');
});

test('ALC-203-1 : l utilisateur ayant déjà posé le curseur de B dans une zone vocale active est respecté', () => {
  // Curseur B dans une zone vocale active (amplitude > 0.18 soutenue) → on garde sa position.
  const zone = new Float32Array(100).fill(0.05);
  zone.fill(0.5, 30, 90); // zone vocale active soutenue
  assert.equal(detectActiveVocalZoneAt(zone, 100, 40), true, 'curseur dans la voix → zone active');
  assert.equal(detectActiveVocalZoneAt(zone, 100, 5), false, 'curseur en intro silencieuse → hors zone');
  const plan = computeAutoVocalPlan({ entryA: 16, entryB: 12, instNow: 0, vocNow: 40, userInActiveVocalZone: true });
  assert.equal(plan.vocalStartSeconds, 40, 'placement manuel de l utilisateur conservé');
});

// ── ALC-231 : Profil OST / Cinéma — ancrage de climax + replis 100 % instrumentaux + octave ──

test('ALC-231-1 : computeOstVocalMashupPlan — crescendo OST (calme → climax) + vocal couplet/refrain → rétro-calage downbeat', () => {
  const dur = 200;
  const bpm = 120; // beat = 0.5 s, 4 mesures = 8 s, 8 mesures = 16 s, 1 bin = 1 s

  const other = new Float32Array(200).fill(0.2);
  other.fill(0.5, 100, 150);
  other.fill(0.9, 150); // crescendo épique à partir de 150 s
  const drums = new Float32Array(200).fill(0.1);
  drums.fill(0.3, 100, 150);
  drums.fill(0.8, 150);
  const ostVocals = new Float32Array(200).fill(0.05); // quasi-instrumentale (chœur résiduel)
  const vocal = new Float32Array(200).fill(0.05);
  vocal.fill(0.35, 30, 70); // couplet : bins 30..69
  vocal.fill(0.9, 90, 150); // refrain : bins 90..149

  const plan = computeOstVocalMashupPlan(
    { other, drums, vocals: ostVocals, durationSeconds: dur, bpm, gridOffsetMs: 0 },
    { vocals: vocal, durationSeconds: dur, bpm, gridOffsetMs: 0 }
  );
  // Zone calme = 1re fenêtre 8 mesures (16 s) Em ∈ [0.15,0.45] → la toute première (E=(0.2+0.1)/2=0.15).
  assert.equal(plan.calmStartSeconds, 0);
  // Climax = 1re fenêtre 4 mesures (8 s) E >= 0.75 → [152,160) (E=(0.9+0.8)/2=0.85).
  assert.equal(plan.climaxSeconds, 152);
  // Couplet vocal = première entrée chantée soutenue → bin 30 (quantifiée au downbeat).
  assert.equal(plan.vocalVerseSeconds, 30);
  // Refrain = 1re fenêtre 8 mesures de densité vocale >= 0.8×pic après le couplet → [96,112).
  assert.equal(plan.vocalChorusSeconds, 96);
  // Rétro-calage : ΔT_voc = 96-30 = 66 → entrée OST = 152-66 = 86 (quantifié au downbeat).
  assert.equal(plan.ostEntrySeconds, 86);
  // Le refrain tombe EXACTEMENT sur le climax orchestral.
  assert.equal(plan.ostEntrySeconds + (plan.vocalChorusSeconds - plan.vocalVerseSeconds), plan.climaxSeconds);
  // Tous les repères finis et >= 0.
  for (const v of Object.values(plan)) {
    assert.ok(Number.isFinite(v) && v >= 0, 'repère fini >= 0 : ' + v);
  }
});

test('ALC-231-1 : repli garanti quand l OST est 100 % instrumentale (stem vocals muet)', () => {
  const other = new Float32Array(200).fill(0.8);
  const drums = new Float32Array(200).fill(0.7);
  const ostVocals = new Float32Array(200).fill(0.0); // aucune voix
  const vocal = new Float32Array(200).fill(0.05);
  vocal.fill(0.6, 20, 80);
  vocal.fill(0.9, 90, 150);

  const plan = computeOstVocalMashupPlan(
    { other, drums, vocals: ostVocals, durationSeconds: 200, bpm: 120, gridOffsetMs: 0 },
    { vocals: vocal, durationSeconds: 200, bpm: 120, gridOffsetMs: 0 }
  );
  assert.ok(plan !== null, 'plan jamais null');
  for (const v of Object.values(plan)) {
    assert.ok(Number.isFinite(v) && v >= 0, 'jamais NaN/Infinity : ' + v);
  }
  assert.ok(plan.vocalVerseSeconds > 0, 'couplet vocal détecté');
  // L énergie vocale de l OST est < 5 % → bascule OST suggérée.
  const ratio = computeOstVocalEnergyRatio(ostVocals, other, drums);
  assert.ok(ratio < 0.05, 'ratio vocal OST < 0.05, obtenu ' + ratio);
});

test('ALC-231-1 : ratio d octave 64 BPM ↔ 128 BPM (normalisation octave parfaitement calée)', () => {
  const a = computeNormalizedTempoRatio(64, 128);
  assert.equal(a.ratio, 1, 'source 64 → cible 128 : octave → ratio 1');
  assert.equal(a.effectiveSourceBpm, 128);
  const b = computeNormalizedTempoRatio(128, 64);
  assert.equal(b.ratio, 1, 'source 128 → cible 64 : octave → ratio 1');
  assert.equal(b.effectiveSourceBpm, 64);
});

test('ALC-233-1 : genreHintsOstCinema — mots-clés OST/Cinéma détectés, sans faux positifs', () => {
  const positives = ['OST', 'Soundtrack', 'Video Game Score', 'Cinema', 'Cinéma', 'OST / Cinéma', 'Game OST', 'ost-electronic', 'Film Score'];
  for (const g of positives) {
    assert.equal(genreHintsOstCinema(g), true, `devrait matcher le profil OST : "${g}"`);
  }
  const negatives = ['Ghost', 'House', 'Electro', 'Pop', 'Hip-Hop', '', '  '];
  for (const g of negatives) {
    assert.equal(genreHintsOstCinema(g), false, `ne devrait PAS matcher le profil OST : "${g}"`);
  }
  // Valeurs nulles / manquantes tolérées (repli sûr).
  assert.equal(genreHintsOstCinema(null as unknown as string), false);
  assert.equal(genreHintsOstCinema(undefined as unknown as string), false);
});

test('ALC-233-1 : shouldSuggestOstCinema — genre OST OU ratio vocal < 5 %', () => {
  assert.equal(shouldSuggestOstCinema('Soundtrack', 0.9), true, 'le genre OST suffit');
  assert.equal(shouldSuggestOstCinema('House', 0.01), true, 'ratio vocal quasi nul → suggère OST');
  assert.equal(shouldSuggestOstCinema('House', 0.5), false, 'ni genre OST ni ratio → profil club');
  assert.equal(shouldSuggestOstCinema('', 0.0), true, 'aucun genre mais ratio 0 → OST');
  assert.equal(shouldSuggestOstCinema('House', Number.NaN), false, 'ratio NaN → aucune suggestion');
});

// ── ALC-235 : protection du timbre vocal en Profil OST ──

test('ALC-235-1 : tempo maître sur le VOCAL — OST 131.2 + vocal 122.6 → cible 122.6, voix 1.0, OST 0.9344', () => {
  const p = computeOstMashupTempo(131.2, 122.6);
  assert.equal(p.targetBpm, 122.6, 'le BPM naturel du vocal devient la cible');
  assert.equal(p.vocalPlaybackRate, 1, 'playbackRate vocal 1.000 → timbre pur, clé intacte');
  const expected = 122.6 / 131.2; // ≈ 0.93445
  assert.ok(Math.abs(p.ostPlaybackRate - expected) < 1e-3, `OST glisse vers le vocal : ${p.ostPlaybackRate} ≈ ${expected}`);
  assert.equal(p.octaveMatched, false, 'pas de correspondance d octave nécessaire ici');
});

test('ALC-235-1 : cas d octave — 64/128 et 128/64 → vocalPlaybackRate reste 1.0', () => {
  const a = computeOstMashupTempo(64, 128);
  assert.equal(a.vocalPlaybackRate, 1, '64<->128 : la VOIX ne s étire jamais');
  assert.equal(a.targetBpm, 64);
  assert.ok(Math.abs(a.ostPlaybackRate - 1) < 1e-3, 'OST calée via octave');
  const b = computeOstMashupTempo(128, 64);
  assert.equal(b.vocalPlaybackRate, 1, '128<->64 : la VOIX ne s étire jamais');
  assert.equal(b.targetBpm, 128);
  assert.ok(Math.abs(b.ostPlaybackRate - 1) < 1e-3);
});

test('ALC-235 : garde-fou ±3 % + Key Lock (cents / detune)', () => {
  assert.equal(clampOstVocalPlaybackRate(1.07), 1.03, 'plafond vocal ±3 %');
  assert.equal(clampOstVocalPlaybackRate(0.9), 0.97);
  assert.equal(clampOstVocalPlaybackRate(1.0), 1.0);
  assert.ok(Math.abs(playbackRateToCents(1.07) - 117.26) < 0.5, `+1.07 → +117 cents (accélération) : ${playbackRateToCents(1.07)}`);
  assert.ok(Math.abs(keyLockCompensationCents(1.07) + 117.26) < 0.5, 'compensation detune ≈ -117 cents');
  assert.equal(needsKeyLock(1.07), true, 'plus de ±25 cents → Key Lock requis');
  assert.equal(needsKeyLock(1.01), false, 'moins de ±25 cents → pas de compensation');
  assert.equal(keyLockCompensationCents(1.0), 0);
});

test('ALC-237/238 : Phrase-Synced Vocal Slicing — OST 1.0x, vocal 1.0x, sous-phrases ≤ 4 mesures recalées sur les downbeats', () => {
  const plan = computePhraseSyncedVocalPlan({
    ostBpm: 131.2,
    vocalBpm: 122.6,
    stanzas: [
      { start: 0, end: 10 },
      { start: 14, end: 26 },
      { start: 30, end: 44 },
    ],
    baseEntrySeconds: 0,
    gridOffsetMs: 0,
    durationSeconds: 60,
  });
  assert.equal(plan.ostRate, 1, 'OST jouée à 1.0x — aucun ralentissement de la bande originale');
  assert.equal(plan.vocalRate, 1, 'vocal joué à 1.0x — timbre et clé 100 % préservés');
  assert.ok(plan.maxSliceDriftSeconds > 0, 'maxSliceDriftSeconds présent (ALC-238)');
  assert.ok(Array.isArray(plan.breathingWindows), 'breathingWindows présent (ALC-238)');
  // ALC-238 : 3 strophes longues sont subdivisées en sous-tranches fines ; ALC-244-3 : dérive > 2 %
  // (131,2 vs 122,6) → tranches maximales de 2 MESURES (jamais 4) pour éliminer le glissement résiduel.
  const sliceMax = 2 * 4 * (60 / 131.2); // 2 mesures = 8 temps de l OST
  assert.ok(plan.slices.length >= 10, `3 strophes longues subdivisées en sous-phrases fines (ALC-238) : ${plan.slices.length}`);
  assert.ok(Math.abs(plan.slices[0].vocalFileSeconds - 0) < 1e-6, '1re tranche démarre au début du vocal');
  assert.ok(Math.abs(plan.slices[plan.slices.length - 1].vocalEndSeconds - 44) < 1e-6, 'dernière tranche se termine à 44 s');
  const beat = 60 / 131.2; // downbeat de l'OST 1.0x
  for (const s of plan.slices) {
    const k = s.airSeconds / beat;
    assert.ok(
      Math.abs(k - Math.round(k)) < 1e-9,
      `airSeconds ${s.airSeconds}s est bien un temps fort de l OST 1.0x (${k.toFixed(3)} temps)`
    );
    assert.ok(s.vocalEndSeconds > s.vocalFileSeconds, `vocalEndSeconds ${s.vocalEndSeconds} > vocalFileSeconds ${s.vocalFileSeconds}`);
    assert.ok(s.vocalEndSeconds - s.vocalFileSeconds <= sliceMax + 1e-6, `jamais plus de 2 mesures par tranche (dérive > 2 %) via maxSliceBars=2 : ${s.vocalEndSeconds - s.vocalFileSeconds}s`);
    assert.equal(typeof s.mutedWindow, 'boolean', 'mutedWindow booléen (ALC-238)');
  }
  assert.ok(Math.abs(plan.slices[0].airSeconds - 0) < 1e-9, 'première tranche sur le downbeat initial');
  // Cas dégénérés : pas de strophe, BPM inconnus -> repli sûr, jamais de rate modifié.
  const empty = computePhraseSyncedVocalPlan({
    ostBpm: 131.2,
    vocalBpm: 122.6,
    stanzas: [],
    baseEntrySeconds: 12,
    gridOffsetMs: 0,
    durationSeconds: 60,
  });
  assert.equal(empty.ostRate, 1);
  assert.equal(empty.vocalRate, 1);
  assert.equal(empty.slices.length, 0);
});

test('ALC-238-4 : strophe vocale de 8 mesures découpée en sous-tranches d au plus 4 mesures (maxSliceBars=4)', () => {
  const bpm = 120; // tempo égal -> dérive nulle -> palier 4 mesures
  const measure = 4 * (60 / bpm); // 2 s
  const len = 8 * measure; // 8 mesures = 16 s
  const plan = computePhraseSyncedVocalPlan({
    ostBpm: bpm,
    vocalBpm: bpm,
    stanzas: [{ start: 0, end: len }],
    baseEntrySeconds: 0,
    gridOffsetMs: 0,
    durationSeconds: 40,
  });
  assert.equal(plan.slices.length, 2, '8 mesures -> 2 sous-tranches de 4 mesures');
  for (const s of plan.slices) {
    assert.ok(
      s.vocalEndSeconds - s.vocalFileSeconds <= 4 * measure + 1e-6,
      `sous-tranche jamais > 4 mesures (${s.vocalEndSeconds - s.vocalFileSeconds}s)`
    );
    assert.ok(
      Math.abs(s.vocalEndSeconds - s.vocalFileSeconds - 4 * measure) < 1e-6,
      'sous-tranche exactement 4 mesures'
    );
  }
  assert.ok(Math.abs(plan.slices[0].vocalFileSeconds - 0) < 1e-6 && Math.abs(plan.slices[0].vocalEndSeconds - 8) < 1e-6);
  assert.ok(Math.abs(plan.slices[1].vocalFileSeconds - 8) < 1e-6 && Math.abs(plan.slices[1].vocalEndSeconds - 16) < 1e-6);
});

test('ALC-238-4 : pic vocal / dialogue résiduel de l OST -> fenêtre de respiration (mutedWindow)', () => {
  const dur = 40;
  const env = new Float32Array(dur).fill(0);
  env.set([0.5, 0.6, 0.7, 0.5], 10); // dialogue résiduel OST : bins 10..13 -> [10 s, 14 s]
  const other = new Float32Array(dur).fill(0); // pas de thème cuivres -> seule la fenêtre dialogue compte
  const plan = computePhraseSyncedVocalPlan({
    ostBpm: 120,
    vocalBpm: 120,
    stanzas: [{ start: 0, end: 24 }],
    baseEntrySeconds: 0,
    gridOffsetMs: 0,
    durationSeconds: dur,
    ostVocals: env,
    ostOther: other,
    ostDurationSeconds: dur,
    chorusEndSeconds: 0,
  });
  assert.ok(
    plan.breathingWindows.some((w) => w.reason === 'dialogue'),
    'fenêtre de respiration dialogue détectée (stem vocals OST > 0.22)'
  );
  assert.ok(plan.slices.some((s) => s.mutedWindow), 'au moins une sous-tranche coupée (voix effacée) pendant la respiration');
});

test('ALC-239-1 : seuil dialogue abaissé (0.12) + fusion des fenêtres < 4 mesures couvrant tout le break', () => {
  const dur = 40;
  const vocals = new Float32Array(dur).fill(0);
  vocals.set([0.15, 0.17, 0.15], 5); // dialogue T1 [5..8]s — faible amplitude (parlé Demucs)
  vocals.set([0.14, 0.16], 14); // dialogue T2 [14..16]s — à ~6 s du 1er (< 4 mesures = 8 s @120)
  const other = new Float32Array(dur).fill(0);
  const plan = computePhraseSyncedVocalPlan({
    ostBpm: 120,
    vocalBpm: 120,
    stanzas: [{ start: 0, end: 24 }],
    baseEntrySeconds: 0,
    gridOffsetMs: 0,
    durationSeconds: dur,
    ostVocals: vocals,
    ostOther: other,
    ostDurationSeconds: dur,
    chorusEndSeconds: 0,
  });
  assert.ok(
    plan.breathingWindows.some((w) => w.reason === 'dialogue'),
    'ALC-239 : un dialogue parlé faible (0.15) déclenche la fenêtre de respiration (seuil abaissé à 0.12)'
  );
  const nonIntro = plan.breathingWindows.filter((w) => w.reason !== 'intro');
  const fused = nonIntro.reduce(
    (a, w) => ({ start: Math.min(a.start, w.startSeconds), end: Math.max(a.end, w.endSeconds) }),
    { start: Number.POSITIVE_INFINITY, end: Number.NEGATIVE_INFINITY }
  );
  // Les deux dialogues (5..8 et 14..16) sont FUSIONNÉS en un bloc continu couvrant [3..18]+ (padding ±1 mesure).
  assert.ok(fused.start <= 3 + 0.05, `marge avant : start=${fused.start.toFixed(2)} <= 3`);
  assert.ok(fused.end >= 18 - 0.05, `marge après : end=${fused.end.toFixed(2)} >= 18`);
  assert.ok(plan.slices.some((s) => s.mutedWindow), 'la voix est coupée pendant tout le break fusionné');
});

test('ALC-239-1 : break cinématographique par chute de batterie (drums < 0.20 × pic, other actif) -> THÈME OST SOLO', () => {
  const dur = 40;
  const drums = new Float32Array(dur).fill(0);
  drums.set([0.9, 0.9, 0.9, 0.9], 2); // premier drop : bins 2..5 (> 0.50 × pic)
  drums.set([0.05, 0.05, 0.05, 0.05], 6); // creux de batterie : bins 6..9 (< 0.20 × pic)
  const other = new Float32Array(dur).fill(0);
  other.fill(0.6, 6, 10); // nappe `other` active pendant le creux (break orchestral)
  const plan = computePhraseSyncedVocalPlan({
    ostBpm: 120,
    vocalBpm: 120,
    stanzas: [{ start: 0, end: 24 }],
    baseEntrySeconds: 0,
    gridOffsetMs: 0,
    durationSeconds: dur,
    ostVocals: new Float32Array(dur).fill(0),
    ostOther: other,
    ostDrums: drums,
    ostDurationSeconds: dur,
    chorusEndSeconds: 0,
  });
  const theme = plan.breathingWindows.find((w) => w.reason === 'theme');
  assert.ok(theme, 'la chute de batterie + nappe `other` active génère une fenêtre THÈME OST SOLO');
  assert.ok(
    theme!.startSeconds <= 4 + 0.05 && theme!.endSeconds >= 12 - 0.05,
    `break couvert intégralement avec marge ±1 mesure : [${theme!.startSeconds.toFixed(2)}, ${theme!.endSeconds.toFixed(2)}]`
  );
  assert.ok(plan.slices.some((s) => s.mutedWindow), 'la voix reste coupée pendant le break de batterie');
});

test('ALC-242-4 : recommendMashupRecipe — OST instrumentale (A) + chanson vocale (B)', () => {
  const rec = recommendMashupRecipe(
    { vocalActivityRatio: 0.02, midCongestionScore: 0.6, genre: 'Soundtrack' },
    { vocalActivityRatio: 0.6, midCongestionScore: 0.35, genre: 'Pop' }
  );
  assert.ok(rec, 'recommandation produite');
  assert.equal(rec!.mode, 'instA_vocB', 'B chante (> 0.25) vs A quasi instrumental (< 0.12) → INST A + VOIX B');
  assert.equal(rec!.profile, 'ost-cinema', 'genre Soundtrack → profil OST/Cinéma automatique');
  assert.ok(rec!.reason.includes('VOIX B'), `raison explicative : ${rec!.reason}`);
});

test('ALC-242-4 : recommendMashupRecipe — les deux platines chantent, contraste par encombrement médium', () => {
  // A : voix forte mais médium 1–3 kHz très dense (score inst = 0.50 − 0.4×0.80 = 0.18)
  // B : voix forte + médium dégagé (score inst = 0.55 − 0.4×0.20 = 0.47) → B meilleur instrumental → INST A + VOIX B.
  const rec = recommendMashupRecipe(
    { vocalActivityRatio: 0.5, midCongestionScore: 0.8, genre: 'Pop' },
    { vocalActivityRatio: 0.55, midCongestionScore: 0.2, genre: 'Pop' }
  );
  assert.ok(rec);
  assert.equal(rec!.mode, 'instA_vocB', 'meilleur contraste vocal/instrumental (1–3 kHz)');
  assert.equal(rec!.profile, 'standard', 'aucun genre OST → profil standard');
  assert.ok(rec!.reason.includes('contraste'), `raison : ${rec!.reason}`);
});

test('ALC-242-4 : recommendMashupRecipe — A chante seule → vocA_instB, et métadonnées absentes → null', () => {
  const rec = recommendMashupRecipe(
    { vocalActivityRatio: 0.32, midCongestionScore: 0.4, genre: null },
    { vocalActivityRatio: 0.05, midCongestionScore: 0.9, genre: null }
  );
  assert.ok(rec);
  assert.equal(rec!.mode, 'vocA_instB', 'A chante → VOIX A + INST B');
  assert.equal(rec!.profile, 'standard');
  assert.equal(recommendMashupRecipe({ vocalActivityRatio: 0.1, midCongestionScore: 0.2 }, null), null);
});

test('ALC-245-3 : vocal plus court que l OST — vocalFileSeconds strictement croissants, aucun recyclage en boucle', () => {
  // Une seule strophe de chant (12 → 40 s) sur un OST bien plus long : le plan doit subdiviser,
  // avancer TOUJOURS (jamais rejouer deux fois la même phrase de 2 mesures) et s arrêter en fin de
  // chant pour laisser l OST terminer en solo instrumental.
  const plan = computePhraseSyncedVocalPlan({
    ostBpm: 131.2,
    vocalBpm: 122.6,
    stanzas: [{ start: 12, end: 40 }],
    baseEntrySeconds: 8,
    gridOffsetMs: 0,
    durationSeconds: 40,
  });
  assert.ok(plan.slices.length >= 4, `strophe longue subdivisée en tranches fines : ${plan.slices.length}`);
  assert.ok(Math.abs(plan.slices[0].vocalFileSeconds - 12) < 1e-6, 'démarre au début de la première strophe');
  let prev = -1;
  const seen = new Set<number>();
  for (const s of plan.slices) {
    assert.ok(
      s.vocalFileSeconds > prev,
      `vocalFileSeconds STRICTEMENT croissants (zéro stutter) : ${prev} -> ${s.vocalFileSeconds}`
    );
    assert.ok(!seen.has(s.vocalFileSeconds), `jamais de duplication de tranche : ${s.vocalFileSeconds}`);
    seen.add(s.vocalFileSeconds);
    prev = s.vocalFileSeconds;
  }
  assert.ok(
    Math.abs(plan.slices[plan.slices.length - 1].vocalEndSeconds - 40) < 1e-6,
    'le plan s arrête en fin de chant (40 s) — aucun recyclage des phrases précédentes'
  );
  assert.equal(seen.size, plan.slices.length, 'autant de tranches que de positions distinctes');
});

test('ALC-246-4 : computeContinuousOstMashupPlan — Beatmatch continu deckA.effectiveBpm === deckB.effectiveBpm, zéro re-seek', () => {
  const plan = computeContinuousOstMashupPlan({
    ostBpm: 131.2,
    vocalBpm: 122.6,
    gridOffsetMs: 0,
    ostEntryHintSeconds: 60,
    vocalStartHintSeconds: 70,
    ostDurationSeconds: 180,
    vocalDurationSeconds: 160,
  });
  assert.ok(plan.targetBpm === 131.2, 'l OST reste à son tempo naturel (target)');
  assert.equal(plan.ostPlaybackRate, 1, 'OST à 1.0x');
  // La voix est pliée à l octave la plus proche dans [0.75..1.35] → BPM effectifs identiques.
  assert.ok(plan.vocalPlaybackRate >= 0.75 && plan.vocalPlaybackRate <= 1.35, 'ratio vocal borné');
  const effA = 131.2 * plan.ostPlaybackRate;
  const effB = 122.6 * plan.vocalPlaybackRate;
  assert.ok(Math.abs(effA - effB) < 0.05, `deckA.effectiveBpm (${effA.toFixed(3)}) === deckB.effectiveBpm (${effB.toFixed(3)}) — zéro dérive (tolérance arrondi ratio 1e-4)`);
  // AUCUNE découpe/re-seek : le plan continu n expose PAS de tranches ; entrée quantifiée au downbeat 4 mesures.
  assert.equal('slices' in plan, false, 'le plan continu ne contient pas de slices (aucun re-seek haché)');
  assert.ok(Array.isArray(plan.breathingWindows), 'fenêtres de respiration exposées');
  const bar4 = 16 * (60 / 131.2);
  const k = plan.ostEntrySeconds / bar4;
  assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `ostEntrySeconds quantifié au downbeat de 4 mesures (${plan.ostEntrySeconds} s)`);
});

test('ALC-246-4 : macro-fenêtres THÈME OST SOLO ≥ 8 mesures (break drums, ±1 mesure, downbeats)', () => {
  const dur = 60;
  const bpm = 120; // 1 mesure = 2 s → 8 mesures = 16 s
  const drums = new Float32Array(dur).fill(0);
  drums.fill(0.9, 8, 12); // premier drop (bins 8..11)
  drums.fill(0.03, 16, 40); // grand break cinématographique (24 s)
  const other = new Float32Array(dur).fill(0);
  other.fill(0.6, 16, 40); // nappe orchestrale active pendant le break
  const vocals = new Float32Array(dur).fill(0);
  const plan = computeContinuousOstMashupPlan({
    ostBpm: bpm,
    vocalBpm: bpm,
    gridOffsetMs: 0,
    ostEntryHintSeconds: 12,
    vocalStartHintSeconds: 12,
    ostDurationSeconds: dur,
    vocalDurationSeconds: dur,
    ostVocals: vocals,
    ostOther: other,
    ostDrums: drums,
    chorusEndSeconds: 4,
  });
  const solo = plan.breathingWindows.find((w) => w.label === 'THÈME OST SOLO');
  assert.ok(solo, 'macrof fenêtre THÈME OST SOLO détectée');
  assert.ok(
    solo!.endSeconds - solo!.startSeconds >= 8 * 4 * (60 / bpm) - 1e-6,
    `fenêtre ≥ 8 mesures (${(8 * 4 * (60 / bpm)).toFixed(1)} s), obtenu ${(solo!.endSeconds - solo!.startSeconds).toFixed(1)} s`
  );
  const beat = 60 / bpm;
  assert.ok(Math.abs(solo!.startSeconds / beat - Math.round(solo!.startSeconds / beat)) < 1e-6, 'début quantifié au downbeat');
  assert.ok(Math.abs(solo!.endSeconds / beat - Math.round(solo!.endSeconds / beat)) < 1e-6, 'fin quantifiée au downbeat');
});

test('ALC-247-3 : aucun THÈME OST SOLO pendant un drop actif (drums >= 0.35 × pic)', () => {
  const dur = 60;
  const bpm = 120;
  // Batterie / drop ACTIFS en permanence — le vocal doit TOUJOURS pouvoir chanter.
  const drums = new Float32Array(dur).fill(0.9);
  const other = new Float32Array(dur).fill(0.6);
  const vocals = new Float32Array(dur).fill(0);
  const plan = computeContinuousOstMashupPlan({
    ostBpm: bpm,
    vocalBpm: bpm,
    gridOffsetMs: 0,
    ostEntryHintSeconds: 12,
    vocalStartHintSeconds: 12,
    ostDurationSeconds: dur,
    vocalDurationSeconds: dur,
    ostVocals: vocals,
    ostOther: other,
    ostDrums: drums,
    chorusEndSeconds: 4,
  });
  assert.ok(
    !plan.breathingWindows.some((w) => w.label === 'THÈME OST SOLO'),
    'la batterie active (drums ≥ 0.35 × pic) ne doit JAMAIS couper le vocal en THÈME OST SOLO'
  );
});

test('ALC-247-3 : plafond de 8 mesures sur les fenêtres THÈME OST SOLO (fin de break garantie)', () => {
  const dur = 90;
  const bpm = 120; // 8 mesures = 32 temps = 16 s
  const drums = new Float32Array(dur).fill(0);
  drums.fill(0.9, 8, 12); // premier drop
  drums.fill(0.03, 16, 60); // creux TRÈS long (44 s) — la fenêtre doit être plafonnée à 8 mesures
  const other = new Float32Array(dur).fill(0);
  other.fill(0.6, 16, 60);
  const vocals = new Float32Array(dur).fill(0);
  const plan = computeContinuousOstMashupPlan({
    ostBpm: bpm,
    vocalBpm: bpm,
    gridOffsetMs: 0,
    ostEntryHintSeconds: 12,
    vocalStartHintSeconds: 12,
    ostDurationSeconds: dur,
    vocalDurationSeconds: dur,
    ostVocals: vocals,
    ostOther: other,
    ostDrums: drums,
    chorusEndSeconds: 4,
  });
  const solo = plan.breathingWindows.filter((w) => w.label === 'THÈME OST SOLO');
  assert.ok(solo.length >= 1, 'fenêtre THÈME détectée sur le creux long');
  const maxBreath = 8 * 4 * (60 / bpm);
  for (const w of solo) {
    assert.ok(
      w.endSeconds - w.startSeconds <= maxBreath + 1e-6,
      `fenêtre ≤ 8 mesures (${maxBreath.toFixed(1)} s), obtenu ${(w.endSeconds - w.startSeconds).toFixed(1)} s`
    );
  }
});

test('ALC-235-3 : dialogueRisk du plan OST — voix résiduelle de la B.O. détectée', () => {
  const mk = (vocVal: number, otherVal: number) =>
    computeOstVocalMashupPlan(
      {
        other: new Float32Array(200).fill(otherVal),
        drums: new Float32Array(200).fill(0.3),
        vocals: new Float32Array(200).fill(vocVal),
        durationSeconds: 200,
        bpm: 120,
        gridOffsetMs: 0,
      },
      { vocals: new Float32Array(200).fill(0.5), durationSeconds: 200, bpm: 120, gridOffsetMs: 0 }
    );
  // OST purement instrumentale : vocals muet → dialogueRisk 0.
  assert.equal(mk(0, 0.8).dialogueRisk, 0);
  // OST avec dialogues/cuivres résiduels marqués → risque élevé (≥ 0.35) → ducking -6.5 dB.
  const withTalk = mk(0.6, 0.4);
  assert.ok(withTalk.dialogueRisk > 0.5, `dialogues résiduels détectés : ${withTalk.dialogueRisk}`);
});
// ── ALC-248-4 : saut des longs ponts instrumentaux du vocal + intégrité des 3 stems instrumentaux ──
test('ALC-248-4 : pont vocal vide de 16 mesures entre deux couplets → vocalBridgeSkips quantifié au downbeat 4 mesures', () => {
  const dur = 200; // bins = 1 s
  const bpm = 120; // 4 mesures = 16 temps = 8 s ; 8 mesures = 16 s
  const v = new Float32Array(dur).fill(0);
  v.fill(0.5, 0, 42); // couplet 1 (0..42 s)
  v.fill(0.5, 60, 101); // couplet 2 (60..101 s) → pont instrumental de 18 s (≥ 8 mesures) entre les deux
  const plan = computeContinuousOstMashupPlan({
    ostBpm: bpm,
    vocalBpm: bpm,
    gridOffsetMs: 0,
    ostEntryHintSeconds: 50,
    vocalStartHintSeconds: 12,
    ostDurationSeconds: dur,
    vocalDurationSeconds: dur,
    vocals: v,
  });
  assert.ok(
    plan.vocalBridgeSkips.length >= 1,
    `un pont vocal vide ≥ 8 mesures doit générer au moins un vocalBridgeSkips (${plan.vocalBridgeSkips.length})`
  );
  const skip = plan.vocalBridgeSkips[0];
  // Déclencheur quantifié au downbeat de 4 mesures OST.
  const bar4 = 16 * (60 / bpm);
  assert.ok(Math.abs(skip.triggerOstSeconds % bar4) < 1e-6, `triggerOstSeconds (${skip.triggerOstSeconds}) sur downbeat 4 mesures (${bar4}s)`);
  // Saut quantifié au downbeat de 4 mesures du vocal (grille file-time 1.0x).
  const bar4V = 16 * (60 / bpm);
  assert.ok(Math.abs(skip.jumpToVocalSeconds % bar4V) < 1e-6, `jumpToVocalSeconds (${skip.jumpToVocalSeconds}) sur downbeat 4 mesures vocals`);
  // Le saut doit enchaîner DIRECTEMENT sur le couplet suivant (après le pont, avant la fin du chant).
  const vSt = extractVocalStanzas(v, dur, bpm, 0);
  assert.ok(
    skip.jumpToVocalSeconds >= vSt[1].start - 1e-6,
    `le saut (${skip.jumpToVocalSeconds}s) atteint le couplet suivant (${vSt[1].start}s)`
  );
  assert.ok(skip.jumpToVocalSeconds < vSt[vSt.length - 1].end, 'le saut reste dans le chant (jamais de vide en fin)');
});

test('ALC-248-4 : mode INSTRUMENTAL — drums/bass/other actifs (!muted, gain 1.0) et vocals muet (muted + gain 0)', () => {
  const mutes = applyStemPreset(
    { vocals: false, drums: false, bass: false, other: false },
    'instrumental'
  );
  assert.equal(mutes.vocals, true, 'vocals muet en INSTRUMENTAL');
  for (const s of ['drums', 'bass', 'other'] as const) {
    assert.equal(mutes[s], false, `${s} actif (!muted) en INSTRUMENTAL`);
    assert.equal(effectiveStemGain(mutes, unitStemGains(), s), 1, `${s} gain effectif 1.0`);
  }
  assert.equal(effectiveStemGain(mutes, unitStemGains(), 'vocals'), 0, 'vocals gain effectif 0');
  assert.equal(clampStemVolume(unitStemGains().vocals ?? 1), 1, 'le gain central reste 1.0 (c est le mute qui isole)');
// ── ALC-251-2 : auto-guérison universelle des caches stems_meta.json au BPM biaisé (×5/4) ──
test('ALC-251-2 : rejet automatique d un cache stems_meta.json biaisé ×1,25 (163,4 vs 130,3)', () => {
  // Ratio d un vieux cache ×5/4 : 163,4 / 130,3 ≈ 1,2536 → REJETÉ (purge + recalcul).
  assert.equal(isStemsTelemetryBpmAcceptable(163.4, 130.3), false, '×1,25 biaisé rejeté');
  assert.equal(isStemsTelemetryBpmAcceptable(130.3, 163.4), false, '÷1,25 (≈0,80) rejeté');
  // Tempo analysé ou octaves binaires (±8 %) → acceptés.
  assert.equal(isStemsTelemetryBpmAcceptable(130.3, 130.3), true, 'référence identique');
  assert.equal(isStemsTelemetryBpmAcceptable(131.2, 130.3), true, '≈1,0069 (analyse affinée)');
  assert.equal(isStemsTelemetryBpmAcceptable(260.6, 130.3), true, 'octave ×2');
  assert.equal(isStemsTelemetryBpmAcceptable(65.15, 130.3), true, 'octave ÷2');
  // Sans référence exploitable → non bloquant.
  assert.equal(isStemsTelemetryBpmAcceptable(163.4, 0), true, 'référence inconnue → laisse passer');
  assert.equal(isStemsTelemetryBpmAcceptable(NaN, 130.3), true, 'bpm absent → laisse passer');
});
});
// ── ALC-253-4 : calage de phase sur les downbeats percussifs + entrée OST rapide (≤ 8 mesures) ──
test('ALC-253-4 : grilles ancrées sur firstDownbeatSeconds (0,18 vs 0,42 s) et ostEntrySeconds ≤ 8 mesures', () => {
  const bpm = 120;
  const bar4 = 16 * (60 / bpm); // 4 mesures = 8 s
  const plan = computeContinuousOstMashupPlan({
    ostBpm: bpm,
    vocalBpm: bpm,
    gridOffsetMs: 0,
    ostEntryHintSeconds: 60,
    vocalStartHintSeconds: 30,
    ostDurationSeconds: 200,
    vocalDurationSeconds: 200,
    vocals: new Float32Array(200).fill(0),
    ostFirstDownbeatSeconds: 0.18,
    vocalFirstDownbeatSeconds: 0.42,
  });
  // 1) Entrée OST plafonnée à 8 mesures APRÈS le downbeat de A (0,18 s) — plus jamais M33 après 1 min.
  assert.ok(plan.ostEntrySeconds - 0.18 <= 8 * bar4 + 1e-6, `ostEntry (${plan.ostEntrySeconds}) ≤ 8 mesures après fdbA (${plan.ostEntrySeconds - 0.18} s)`);
  // 2) (ostEntry − fdbA) = multiple entier exact de 4 mesures (calé sur le premier drop).
  const ka = (plan.ostEntrySeconds - 0.18) / bar4;
  assert.ok(Math.abs(ka - Math.round(ka)) < 1e-6, `(ostEntry − fdbA)/bar4 entier (${ka})`);
  // 3) (vocalStart − fdbB)·rate = multiple entier exact de bar4A → la phrase entre PILE sur le temps 1
  //    du bloc de 4 mesures (jamais à contre-temps, même en anacrouse).
  const kv = ((plan.vocalStartSeconds - 0.42) * plan.vocalPlaybackRate) / bar4;
  assert.ok(Math.abs(kv - Math.round(kv)) < 1e-6, `(vocalStart − fdbB)·rate/bar4A entier (${kv})`);
  // 4) Le vocal n entre jamais avant le downbeat percussif de B.
  assert.ok(plan.vocalStartSeconds >= 0.42 - 1e-6, `vocalStart (${plan.vocalStartSeconds}) ≥ fdbB (0.42 s)`);
});