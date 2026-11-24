import { mimeFromPath, Player, type StemName, STEM_NAMES } from '$lib/audio/player';
import { Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  guideTransition,
  CENTER_MODULES,
  nextCenterModule as nextCenterModuleId,
  prevCenterModule as prevCenterModuleId,
  setCenterModule as setCenterModuleId,
  moduleStepDelta as computeModuleStepDelta,
  type CenterView,
  type CenterModuleId,
} from '$lib/utils/viewNav';
export { CENTER_MODULES };
import { computeNormalizedTempoRatio } from '$lib/utils/tempo'; // ALC-212 : ratio octave centralisé
import {
  defaultFxRackState,
  fxRecordingFileName,
  clampLivePadIndex,
  type FxRackState,
  type FxDeckTarget,
  type FxStemTarget,
} from '$lib/audio/fxRack'; // ALC-213 : Rack FX
import { audioIpc, libraryIpc, type StemPaths, type TrackData, type KeySeg, type TrackSegment, type LibraryTrack, type LibraryTrackTagPayload } from '$lib/ipc/client';
import { isSameTrack } from '$lib/utils/mashupMatcher'; // ALC-232 : synchro platines A/B
import { searchMusicBrainz, fetchCoverArtArchive, fetchAcousticBrainzKey } from '$lib/ipc/meta';
import { resolveHybridCamelotKey } from '$lib/audio/hybridKey';
import { camelotLabelFromKey, parseCamelot, relationFrom } from '$lib/audio/harmony';
import { effectiveBpmDelta } from '$lib/utils/tempo'; // ALC-222 : Δ BPM effectifs normalisés octave
import { swapDeckState } from '$lib/utils/deckSwap'; // ALC-225 : échange A <-> B
import { encodeWav16Stereo, mashupWavFilename } from '$lib/utils/wavEncoder'; // ALC-226 : REC mashup WAV
import {
  computeOracleAdvice,
  oracleAdviceSummary,
  captureOracleSnapshot,
  type OracleSnapshot,
} from '$lib/audio/oracleAdvice'; // ALC-221 : APPLIQUER LES CONSEILS
import { findNextStanzaStartAfter, findFirstVocalStanzaStart } from '$lib/audio/stemMix'; // ALC-227 : strophes
import {
  clampStemVolume,
  applyStemPreset,
  freshStemMutes,
  unitStemGains,
  resolveCrossDeckMashup,
  resolveCrossoverStems,
  resolveMashupSpecialty,
  computeOstMedleyPlan,
  type OstMedleyPlan,
  resolveStemHit,
  isComplementaryMashup,
  resolveAutoMixTarget,
  detectFirstVocalEntrySeconds,
  detectActiveVocalZoneAt,
  computeAutoVocalPlan,
  computeOstVocalMashupPlan,
  computeOstVocalEnergyRatio,
  genreHintsOstCinema,
  shouldSuggestOstCinema,
  resolveMashupRoles,
  vocalTriggerDue,
  computeContinuousOstMashupPlan,
  type PhraseSlice,
  type PhraseSyncedBreathingWindow,
  recommendMashupRecipe,
  type MashupStemsMeta,
  type StemMixPreset,
  isStemsTelemetryBpmAcceptable, // ALC-251-2 : garde-fou BPM universel (octaves binaires vs ~1,25/~0,80)
  parseAndValidateArrangementScore,
  resolveArrangementStateAtBar,
  type MashupArrangementScore,
  type ArrangementStemName,
  type ArrangementResolvedState,
} from '$lib/audio/stemMix';

export type DeckId = 'A' | 'B';
export type DeckTheme = 'emerald' | 'blue';
export type TransportMode = 'playing' | 'paused' | 'stopped';
export type MashupLaunchMode = 'idle' | 'simultaneous' | 'auto-vocal-wait' | 'manual-vocal-wait' | 'playing';
export interface MashupLaunchState {
  mode: MashupLaunchMode;
  instDeck: DeckId;
  vocalDeck: DeckId;
  targetEntrySeconds: number | null;
  /** ALC-203 : position de pré-cue du vocal B (début de sa propre voix) — pour le retour visuel Beatgrid. */
  vocalStartSeconds: number | null;
}

export interface DeckState {
  id: DeckId;
  theme: DeckTheme;
  channelTitle: string;
  channelSub: string;
  perimeterLabel: string;
  sideLetter: 'A' | 'B';
  opusLabel: string;
  trackTitle: string;
  artist: string;
  /** ALC-157 : album extrait des tags (vide si absent). */
  album: string;
  genre: string;
  year: string;
  coverUrl: string;
  coverAlt: string;
  serialCode: string;
  camelotKey: string;
  camelotLabel: string;
  keyConfidence: number;
  keySource: string;
  externalKey: string;
  hotCues: number[];
  loopBeats: number | null;
  gridOffsetMs: number;
  gridOctave: number;
  waveformPeaks: number[];
  keyTimeline: KeySeg[];
  /** ALC-146 : segments sonores (RMS 3 bandes + tempo/clé locaux), $state.raw — sous-tableau hors proxy profond. */
  segments: TrackSegment[];
  baseBpm: number;
  pitchPercent: number;
  volumeDb: number;
  lowEqDb: number;
  highEqDb: number;
  elapsedSeconds: number;
  durationSeconds: number;
  transport: TransportMode;
  cueActive: boolean;
  codec: string;
  sampleRate: string;
  bitrate: string;
  stereoMode: string;
  freqResponse: string;
  peakVuDb: string;
  filePath: string | null;
  stems: StemPaths | null;
  /** ALC-242 : la piste bénéficie de la télémétrie HTDemucs (`stems_meta.json`). */
  stemsCalibrated: boolean;
  /** ALC-242 : ratios HTDemucs exploités pour le choix intelligent de la recette Mashup. */
  stemsMeta: { vocalActivityRatio: number; midCongestionScore: number } | null;
  /** ALC-253-1 : downbeat percussif (kick) du stem drums en secondes — ancre le calage de phase. */
  firstDownbeatSeconds: number | null;
  isExtractingStems: boolean;
  // ALC-174-3 : séparation 4 Stems IA (HTDemucs / ONNX local).
  stemsStatus: 'idle' | 'separating' | 'ready' | 'error';
  stemsProgress: number;
  stemGains: Record<StemName, number>;
  stemMutes: Record<StemName, boolean>;
  stemsExported: boolean; // ALC-177 : confirmation visuelle temporaire après export (3 s).
  isAnalyzing: boolean;
  lastError: string | null;
}

export function formatTime(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function computeEffectiveBpm(baseBpm: number, pitchPercent: number): number {
  return Number((baseBpm * (1 + pitchPercent / 100)).toFixed(1));
}

/** Convertit un niveau en dB vers un gain linéaire (helper crossfader égal-puissance). */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** ALC-137-5 : normalise les tirets des titres extraits (`--` → `—`). */
export function normalizeTitle(s: string): string {
  return (s || '')
    .replace(/\s*--\s*/g, ' — ')
    .replace(/\s*–\s*/g, ' — ')
    .replace(/--+/g, '—')
    .replace(/\s+/g, ' ')
    .trim();
}

class AlchemixMixerStore {
  deckA = $state<DeckState>({
    id: 'A',
    theme: 'emerald',
    channelTitle: 'TAPE A • CANAL VERT ÉMERAUDE',
    stemsExported: false,
    stemsStatus: 'idle',
    stemsProgress: 0,
    stemGains: { vocals: 1, drums: 1, bass: 1, other: 1 },
    stemMutes: { vocals: false, drums: false, bass: false, other: false },
    channelSub: 'DECK A • CANAL PRIMAIRE',
    perimeterLabel: 'CHRONO-PÉRIMÈTRE 01',
    sideLetter: 'A',
    opusLabel: 'OPUS 89',
    trackTitle: '',
    artist: '',
    album: '',
    genre: '',
    year: '',
    coverUrl: '',
    coverAlt: 'Vide — aucune piste chargée',
    serialCode: 'SAN MARCO-89',
    camelotKey: '4B',
    camelotLabel: '4B (Mi Maj)',
    keyConfidence: 0,
    keySource: 'dsp',
    externalKey: '',
    hotCues: [-1, -1, -1, -1],
    loopBeats: null,
    gridOffsetMs: 0,
    gridOctave: 1,
    waveformPeaks: [],
    keyTimeline: [],
    segments: [],
    baseBpm: 122.5,
    pitchPercent: 0.0,
    volumeDb: 0.0,
    lowEqDb: 0,
    highEqDb: 0,
    elapsedSeconds: 0,
    durationSeconds: 0,
    transport: 'stopped',
    cueActive: false,
    codec: '—',
    sampleRate: '—',
    bitrate: '—',
    stereoMode: '—',
    freqResponse: '—',
    peakVuDb: '—',
    filePath: null,
    stems: null,
    stemsCalibrated: false,
    stemsMeta: null,
firstDownbeatSeconds: null, // ALC-253-1
    isExtractingStems: false,
    isAnalyzing: false,
    lastError: null,
  });

  deckB = $state<DeckState>({
    id: 'B',
    theme: 'blue',
    channelTitle: 'TAPE B • CANAL BLEU ÉLECTRIQUE',
    stemsExported: false,
    stemsStatus: 'idle',
    stemsProgress: 0,
    stemGains: { vocals: 1, drums: 1, bass: 1, other: 1 },
    stemMutes: { vocals: false, drums: false, bass: false, other: false },
    channelSub: 'DECK B • CANAL SECONDAIRE',
    perimeterLabel: 'CHRONO-PÉRIMÈTRE 02',
    sideLetter: 'B',
    opusLabel: 'OPUS 92',
    trackTitle: '',
    artist: '',
    album: '',
    genre: '',
    year: '',
    coverUrl: '',
    coverAlt: 'Vide — aucune piste chargée',
    serialCode: 'DORSODURO-1889',
    camelotKey: '8B',
    camelotLabel: '8B (Do Maj)',
    keyConfidence: 0,
    keySource: 'dsp',
    externalKey: '',
    hotCues: [-1, -1, -1, -1],
    loopBeats: null,
    gridOffsetMs: 0,
    gridOctave: 1,
    waveformPeaks: [],
    keyTimeline: [],
    segments: [],
    baseBpm: 126.0,
    pitchPercent: 0.0,
    volumeDb: 0.0,
    lowEqDb: 0,
    highEqDb: 0,
    elapsedSeconds: 0,
    durationSeconds: 0,
    transport: 'stopped',
    cueActive: false,
    codec: '—',
    sampleRate: '—',
    bitrate: '—',
    stereoMode: '—',
    freqResponse: '—',
    peakVuDb: '—',
    filePath: null,
    stems: null,
    stemsCalibrated: false,
firstDownbeatSeconds: null, // ALC-253-1
    stemsMeta: null,
    isExtractingStems: false,
    isAnalyzing: false,
    lastError: null,
  });

  crossfader = $state<number>(50);
  // ALC-105-2 : position normalisée [0,1] + loi de puissance égale (gainA=cos, gainB=sin).
  crossfaderX = $derived(this.crossfader / 100);
  gainCrossA = $derived(Math.cos((this.crossfaderX * Math.PI) / 2));
  gainCrossB = $derived(Math.sin((this.crossfaderX * Math.PI) / 2));

  // ── ALC-269 : Mode Chef d'Orchestre — partition d'arrangement JSON ──────────
  activeArrangementScore = $state<MashupArrangementScore | null>(null);
  arrangementScorePlaying = $state(false);
  arrangementCurrentCueLabel = $state<string | null>(null);
  arrangementError = $state<string | null>(null);
  /** BPM maître effectif verrouillé par `launchArrangementScore` (durée de mesure). */
  private _arrMasterBpm = 120;
  /** Downbeat réel de la platine maître (drums.wav) pour `currentBar`. */
  private _arrDownbeatA = 0;
  /** Config ducking issue de `score.eq` (appliquée à chaque trame 60 fps). */
  private _arrDuck = { target: null as 'A.other' | 'B.other' | 'none' | null, freqHz: 1800, gainDb: -4.5 };

  // ── ALC-170 A/B : AUTO-MIX 8/16 mesures — moteur d'auto-transition & Bass-Swap automatique ──
  autoMixActive = $state(false);
  autoMixBars = $state<8 | 16>(16);
  autoMixDirection = $state<'A_TO_B' | 'B_TO_A'>('A_TO_B');
  /** Progression $p ∈ [0,1] de l'auto-mix courant (0 quand inactif). */
  autoMixProgress = $state(0);
  /** Réduction grave (dB) pilotée par l'AUTO-MIX sur chaque platine (0 = EQ neutre). */
  autoBassA = $state(0);
  autoBassB = $state(0);
  /** ALC-190-3 : vrai quand l'AUTO-MIX court en mode fusion mashup complémentaire (cible 50/50). */
  autoMashupActive = $state(false);
  /** ALC-196 : automate des 3 modes de déclenchement Mashup (simultané / entrée vocale auto / manuel). */
  mashupLaunchState = $state<MashupLaunchState>({
    mode: 'idle',
    instDeck: 'A',
    vocalDeck: 'B',
    targetEntrySeconds: null,
    vocalStartSeconds: null,
  });

  /**
   * ALC-231 : profil de style du mashup auto (« 1 clic »).
   * - `'standard'` : recette inst/acapella classique.
   * - `'ost-cinema'` : bande originale instrumentale + vocal pop — alignement par ancrage de climax
   *   (`computeOstVocalMashupPlan`) + Dynamic Orchestral Ducking à 1,8 kHz.
   */
  mashupStyleProfile = $state<'standard' | 'ost-cinema'>('standard');
  /** ALC-242 : l'utilisateur a verrouillé manuellement la recette Mashup (sélecteur Beatgrid). */
  mashupRecipeManual = $state(false);
  /** ALC-242 : raison de la recommandation automatique de recette (infobulle Beatgrid). */
  mashupRecipeReason = $state('');
  /** ALC-233 : le DJ a-t-il FORCÉ manuellement le profil via la bascule [CLUB | OST] ? Tant que vrai,
   *  la détection automatique par genre (ou par ratio d'énergie vocale) reste silencieuse. */
  ostProfileManual = $state(false);
  /** ALC-231 : dernier plan OST calculé (repère doré « CLIMAX OST » sur la waveform instrumentale). */
  ostPlan = $state<{
    ostDeckId: DeckId;
    climaxSeconds: number;
    ostEntrySeconds: number;
    vocalVerseSeconds: number;
    /** ALC-235 : risque de dialogue/résidu vocal de l'OST (0..1) — pilote le creux de ducking. */
    dialogueRisk: number;
  } | null>(null);

  /**
   * ALC-234 : cache Store des enregistrements de la Librairie — applique les métadonnées éditées par
   * le DJ lors du chargement d'une piste (prioritaires sur les tags bruts du fichier, indispensable
   * pour les `.wav` qui ne stockent pas de tags ID3). Hydraté par LibraryView (`setLibraryTracks`) et
   * par `updateLibraryTrackTags` (remplacement immédiat de la ligne éditée).
   */
  libraryTracks = $state<LibraryTrack[]>([]);
  private _libraryTracksLoaded = false;

  /** ALC-234 : remplace le cache Librairie du Store (source = LibraryView, après chaque chargement). */
  setLibraryTracks(list: LibraryTrack[]) {
    this.libraryTracks = list || [];
    this._libraryTracksLoaded = true;
  }

  /** ALC-234 : recharge le cache depuis SQLite (repli sûr si la Librairie n'a pas encore été ouverte). */
  async reloadLibraryTracks() {
    try {
      this.libraryTracks = await libraryIpc.listTracks();
    } catch {
      /* lecture du catalogue non bloquante */
    }
    this._libraryTracksLoaded = true;
  }

  private async ensureLibraryTracks() {
    if (!this._libraryTracksLoaded) await this.reloadLibraryTracks();
  }

  /** Normalise un chemin audio (antislashs → '/', minuscules) — même règle que `isSameTrack`. */
  private normFilePath(p?: string | null): string {
    return (p || '').replace(/\\/g, '/').toLowerCase();
  }

  /** ALC-236 : applique un pitch (%) à une platine et synchronise immédiatement son Player. */
  setDeckPitch(id: DeckId, pitchPercent: number) {
    const d = this.getDeck(id);
    d.pitchPercent = pitchPercent;
    this.getPlayer(id)?.setPlaybackRate(pitchPercent);
  }

  setMashupStyleProfile(profile: 'standard' | 'ost-cinema') {
    this.mashupStyleProfile = profile;
    // ALC-233 : le DJ a FORCÉ le profil manuellement → prioritaire sur l'auto-détection par genre.
    this.ostProfileManual = true;
    if (profile === 'standard') this.ostPlan = null;
  }

  /**
   * ALC-233 : détection automatique du profil OST — bascule vers `'ost-cinema'` si le genre d'une
   * platine chargée évoque une bande originale / un film (`ost`, `cinéma`, `cinema`, `soundtrack`,
   * `score`, insensible à la casse). Jamais si le DJ a forcé manuellement (`ostProfileManual`).
   */
  refreshOstProfileSuggestion() {
    if (this.ostProfileManual) return;
    if (genreHintsOstCinema(this.deckA.genre) || genreHintsOstCinema(this.deckB.genre)) {
      this.mashupStyleProfile = 'ost-cinema';
    }
  }

  /** ALC-245-2 : activateur fiable de la bascule 🎬 OST — appelle `refreshOstProfileSuggestion()`
   * après chargement d'une piste, édition de tags ou bascule d'onglet vers le Beatgrid : si le genre
   * de deckA ou deckB évoque une bande originale (`ost`, `cinéma`, `cinema`, `soundtrack`, `score`,
   * insensible à la casse) et que le DJ n'a pas verrouillé manuellement le profil (« club » forcé),
   * `mashupStyleProfile` passe automatiquement à `'ost-cinema'`. */
  syncStyleProfileFromLoadedDecks() {
    this.refreshOstProfileSuggestion();
  }

  /**
   * ALC-232 : édition manuelle des tags d'une piste de la Librairie (SQLite + réécriture fichier
   * en option). Renvoie la piste mise à jour ; l'appelant (LibraryView) la remplace immédiatement
   * dans `tracks` (ce qui recalcule instantanément tous les $derived : scores d'affinité mashup,
   * filtres COMPATIBLE A/B, Oracle Acoustique, Pistes Ponts). Si la piste est actuellement chargée
   * sur la Platine A ou B (`isSameTrack` : filePath normalisé, repli titre+artiste), synchronise
   * aussi les métadonnées affichées sur la platine active.
   */
  async updateLibraryTrackTags(
    id: number,
    payload: LibraryTrackTagPayload
  ): Promise<LibraryTrack> {
    const updated = await libraryIpc.updateLibraryTrackTags(id, payload);
    // ALC-234 : met à jour le cache Librairie du Store (source pour le chargement prioritaire).
    this._libraryTracksLoaded = true;
    this.libraryTracks = this.libraryTracks.map((tr) => (tr.id === updated.id ? updated : tr));
    for (const side of ['A', 'B'] as DeckId[]) {
      const d = this.getDeck(side);
      if (!d.filePath) continue;
      if (!isSameTrack(updated, { filePath: d.filePath, title: d.trackTitle, artist: d.artist })) continue;
      if (payload.title !== undefined) d.trackTitle = updated.title;
      if (payload.artist !== undefined) d.artist = updated.artist;
      if (payload.genre !== undefined) d.genre = updated.genre;
      if (payload.camelotKey !== undefined) {
        d.camelotKey = updated.camelotKey;
        // ALC-234 : libellé lisible dérivé de la clé (table CAMELOT_LABELS, source unique).
        d.camelotLabel = camelotLabelFromKey(updated.camelotKey);
      }
      if (payload.bpm !== undefined && updated.bpm > 0) {
        // effectiveBpm est un $derived recalculé immédiatement avec le pitchPercent actuel.
        d.baseBpm = updated.bpm;
      }
    }
    // ALC-233/245 : le genre d'une platine a pu changer (édition des tags en Librairie) → on ré-évalue
    // la détection automatique du profil OST (le verrou manuel du DJ reste respecté).
    this.syncStyleProfileFromLoadedDecks();
    return updated;
  }

  private _autoRaf = 0;
  private _autoStart = 0;
  private _autoDur = 0;
  private _autoFromCross = 50;
  private _autoToCross = 100;
  private _autoOut: DeckId = 'A';
  private _autoIn: DeckId = 'B';
  private _autoInLowStart = 0;
  private _autoMashup = false;

  /** Durée exacte de l'auto-transition (s) : bars × 4 × 60 / BPM effectif de la platine maître, repli 120 BPM. */
  autoMixDuration = $derived(
    this.autoMixActive && this._autoDur > 0 ? this._autoDur : 0
  );

  setAutoMixBars(bars: 8 | 16) {
    if (!this.autoMixActive) this.autoMixBars = bars;
  }

  /** Lance l'AUTO-MIX : transition assistée du crossfader + Bass-Swap sur les LOW EQ + pitch glide. */
  startAutoMix(bars: 8 | 16, direction: 'A_TO_B' | 'B_TO_A') {
    this.cancelAutoMix();
    const outId: DeckId = direction === 'A_TO_B' ? 'A' : 'B';
    const inId: DeckId = direction === 'A_TO_B' ? 'B' : 'A';
    const outDeck = this.getDeck(outId);
    const inDeck = this.getDeck(inId);
    if (!outDeck.filePath || !inDeck.filePath || !this.getPlayer(outId) || !this.getPlayer(inId)) return;
    const masterBpm = outId === 'A' ? this.effectiveBpmA : this.effectiveBpmB;
    const duration = bars * 4 * (60 / (masterBpm > 0 ? masterBpm : 120));
    this.autoMixBars = bars;
    this.autoMixDirection = direction;
    this.autoMixProgress = 0;
    this.autoBassA = 0;
    this.autoBassB = 0;
    this._autoOut = outId;
    this._autoIn = inId;
    this._autoFromCross = this.crossfader;
    // ALC-190-3 : mashup complémentaire (voix seule vs instrumentale) → cible 50/50, jamais mono,
    // jamais de mutation des stems du DJ ; sinon transition standard vers la platine entrante.
    this._autoMashup = isComplementaryMashup(this.deckA, this.deckB);
    this.autoMashupActive = this._autoMashup;
    this._autoToCross = resolveAutoMixTarget(this._autoMashup, direction);
    this._autoInLowStart = inDeck.lowEqDb;
    this._autoDur = duration;
    this._autoStart = performance.now();
    this.autoMixActive = true;
    const tick = (now: number) => {
      if (!this.autoMixActive) return;
      const p = Math.min(1, Math.max(0, (now - this._autoStart) / this._autoDur));
      this.stepAutoMix(p);
      if (p >= 1) { this.finishAutoMix(); return; }
      this._autoRaf = requestAnimationFrame(tick);
    };
    this._autoRaf = requestAnimationFrame(tick);
  }

  private stepAutoMix(p: number) {
    // 1) Crossfader Master : déplacement fluide vers la platine cible (0 pour A, 100 pour B).
    this.crossfader = this._autoFromCross + (this._autoToCross - this._autoFromCross) * p;
    // 2) Bass-Swap : coupe progressive du grave sortant, neutralisation du grave entrant, puis restauration.
    const inn = this.getDeck(this._autoIn);
    // ALC-190-3 : en mashup complémentaire, PAS de Bass-Swap → on garde le grave de la platine
    // instrumentale pour que l'acapella se pose dessus en continu (fusion 50/50).
    if (!this._autoMashup) {
      const OUT_CUT = -20; // atténuation profonde (évite annulation de phase / surcharge sub-bass)
      const ATTACK = 0.45; // pleine coupe atteinte à 45 % du parcours
      const RESTORE = 0.9; // restauration propre dès que le volume sortant est coupé
      const outCut = p < RESTORE ? Math.round(Math.min(1, p / ATTACK) * OUT_CUT * 10) / 10 : 0;
      const inTotalZero = Math.round(-this._autoInLowStart * Math.min(1, p / ATTACK) * 10) / 10; // grave entrant → 0.0 dB
      if (this._autoOut === 'A') { this.autoBassA = outCut; this.autoBassB = inTotalZero; }
      else { this.autoBassB = outCut; this.autoBassA = inTotalZero; }
    }
    // 3) Pitch glide : pendant la première moitié, glisse le pitch entrant vers le tempo maître si écart ≤ 6 %.
    const masterBpm = this._autoOut === 'A' ? this.effectiveBpmA : this.effectiveBpmB;
    const targetPitch = Number((computeNormalizedTempoRatio(inn.baseBpm || 120, masterBpm).ratio - 1) * 100)
    if (Math.abs(targetPitch - inn.pitchPercent) <= 6) {
      inn.pitchPercent = Number((inn.pitchPercent + (targetPitch - inn.pitchPercent) * Math.min(1, p / 0.5)).toFixed(2));
    }
    this.autoMixProgress = p;
  }

  private finishAutoMix() {
    this.autoBassA = 0;
    this.autoBassB = 0;
    cancelAnimationFrame(this._autoRaf);
    this.autoMixActive = false;
    this.autoMashupActive = false;
    this.autoMixProgress = 0;
  }

  /** Arrêt immédiat : restaure l'EQ grave et stoppe l'automate (appelé sur intervention manuelle du DJ). */
  cancelAutoMix() {
    const wasActive = this.autoMixActive;
    if (this._autoRaf) cancelAnimationFrame(this._autoRaf);
    this.autoBassA = 0;
    this.autoBassB = 0;
    this.autoMixActive = false;
    this.autoMashupActive = false;
    this.autoMixProgress = 0;
    void wasActive;
  }

  // ── ALC-171 : pré-écoute audio locale UNIFIÉE — read_audio_file_bytes → Blob URL ──
  /** Chemin du fichier actuellement en pré-écoute (source de vérité pour l'icône ▶/❚❚). */
  previewPath = $state<string | null>(null);
  previewKey = $state<string | null>(null);
  private _previewAudio: HTMLAudioElement | null = null;
  private _previewUrl: string | null = null;

  isPreviewingFile(path: string): boolean {
    return this.previewPath === path && !!this._previewAudio;
  }

  stopFilePreview() {
    if (this._previewAudio) {
      this._previewAudio.pause();
      this._previewAudio = null;
    }
    if (this._previewUrl) {
      URL.revokeObjectURL(this._previewUrl);
      this._previewUrl = null;
    }
    this.previewPath = null;
    this.previewKey = null;
  }

  /**
   * Prée-écoute une piste locale via le pipeline éprouvé read_audio_file_bytes → Blob URL
   * (mimeFromPath), comme Player.ts — évite le blocage asset:// / CORS de WebView2.
   * Bascule (stop) si le même fichier est déjà en lecture ; révocation de l'ancienne URL blob.
   */
  async toggleFilePreview(filePath: string, key: string | null = null) {
    if (this.isPreviewingFile(filePath)) {
      this.stopFilePreview();
      return;
    }
    this.stopFilePreview();
    try {
      const bytes: number[] = await audioIpc.readAudioFileBytes(filePath);
      const mime = mimeFromPath(filePath);
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
      const audio = new Audio(url);
      audio.volume = 0.8;
      audio.addEventListener('ended', () => this.stopFilePreview());
      audio.addEventListener('error', () => {
        console.error('[Pré-écoute] décodage impossible :', filePath);
        this.stopFilePreview();
      });
      this._previewUrl = url;
      this._previewAudio = audio;
      this.previewPath = filePath;
      this.previewKey = key;
      try {
        await audio.play();
      } catch (err) {
        console.error('[Pré-écoute] lecture impossible :', filePath, err);
        this.stopFilePreview();
      }
    } catch (err) {
      console.error('[Pré-écoute] lecture des octets impossible :', filePath, err);
    }
  }
  centerView = $state<CenterView>('camelot');
  /** ALC-191-1 : mémorise la vue centrale active AVANT l'ouverture du guide Mashup. */
  previousCenterView = $state<CenterView>('camelot');

  /** ALC-191-1 : ouvre/ferme le guide Mashup — la fermeture restaure exactement la vue précédente. */
  toggleMashupGuide() {
    const r = guideTransition(this.centerView, this.previousCenterView);
    this.previousCenterView = r.memorize;
    this.centerView = r.view;
  }
  /** ALC-191-1 : ferme l'aide et bascule directement sur l'onglet demandé. */
  openTabFromGuide(tab: 'camelot' | 'beatgrid' | 'library' | 'stems') {
    this.centerView = tab;
    if (tab === 'beatgrid') this.syncStyleProfileFromLoadedDecks(); // ALC-245-2 : auto-profil 🎬 OST
  }

  /** ALC-206-2 : écart signé du dernier pas de Barillet (+1 suivant / -1 précédent / écart court d'un rivet), source de la synchro roue ↔ chariot central. */
  moduleStepDelta = $state(0);

  /** ALC-206-2 : efface l'écart après la course mécanique (les roues/chariot ont déjà capturé la direction). */
  private _stepResetTimer: ReturnType<typeof setTimeout> | null = null;
  private _publishStepDelta(delta: number) {
    this.moduleStepDelta = delta;
    if (this._stepResetTimer) clearTimeout(this._stepResetTimer);
    this._stepResetTimer = setTimeout(() => {
      this.moduleStepDelta = 0;
    }, 430);
  }

  /** ALC-205-1 : Barillet Horloger — cran suivant (bouclage 06 → 01). */
  nextCenterModule() {
    const next = nextCenterModuleId(this.centerView);
    this._publishStepDelta(computeModuleStepDelta(this.centerView, next));
    this.centerView = next;
    if (this.centerView === 'beatgrid') this.syncStyleProfileFromLoadedDecks(); // ALC-245-2
  }
  /** ALC-205-1 : cran précédent (bouclage 01 → 06). */
  prevCenterModule() {
    const next = prevCenterModuleId(this.centerView);
    this._publishStepDelta(computeModuleStepDelta(this.centerView, next));
    this.centerView = next;
    if (this.centerView === 'beatgrid') this.syncStyleProfileFromLoadedDecks(); // ALC-245-2
  }
  /** ALC-205-1 : accès direct à un module précis (rivets / raccourcis clavier). */
  setCenterModule(id: CenterModuleId) {
    const next = setCenterModuleId(this.centerView, id);
    this._publishStepDelta(computeModuleStepDelta(this.centerView, next));
    this.centerView = next;
    if (this.centerView === 'beatgrid') this.syncStyleProfileFromLoadedDecks(); // ALC-245-2
  }

  // ── ALC-213 : RACK FX — état réactif + synchronisation immédiate vers le Player ──
  fxRack: FxRackState = $state(defaultFxRackState());

  private _fxTimer: ReturnType<typeof setInterval> | null = null;

  /** Applique l'état fxRack au(x) Player(s) ciblé(s) par le routage A / B / MASTER (chacun avec son BPM). */
  syncFxToPlayers() {
    const d = this.fxRack.deck;
    const bypass = defaultFxRackState();
    if (d === 'A') {
      this.getPlayer('A')?.applyFxRack(this.fxRack, this.effectiveBpmA);
      this.getPlayer('B')?.applyFxRack(bypass, this.effectiveBpmB);
    } else if (d === 'B') {
      this.getPlayer('B')?.applyFxRack(this.fxRack, this.effectiveBpmB);
      this.getPlayer('A')?.applyFxRack(bypass, this.effectiveBpmA);
    } else {
      this.getPlayer('A')?.applyFxRack(this.fxRack, this.effectiveBpmA);
      this.getPlayer('B')?.applyFxRack(this.fxRack, this.effectiveBpmB);
    }
  }

  /** Cible de routage DSP (deck + stem). */
  setFxTarget(deck: FxDeckTarget, stemTarget: FxStemTarget) {
    this.fxRack.deck = deck;
    this.fxRack.stemTarget = stemTarget;
    this.syncFxToPlayers();
  }

  /** Active / désactive un slot d'effet. */
  toggleFxSlot(slot: 'slot1' | 'slot2' | 'slot3') {
    const s = this.fxRack[slot] as { active: boolean };
    s.active = !s.active;
    this.syncFxToPlayers();
  }

  /** Met à jour les paramètres d'un slot (fusion partielle) et l'AUTO-ACTIVE si un réglage est touché. */
  setFxSlot(
    slot: 'slot1' | 'slot2' | 'slot3',
    partial: Record<string, number | string | boolean>
  ) {
    const s = this.fxRack[slot] as { active: boolean } & object;
    Object.assign(s as object, partial as object);
    // ALC-217 : régler un curseur dans un slot inactif l'enclenche automatiquement (jamais de curseur « mort »).
    s.active = true;
    this.syncFxToPlayers();
  }

  /** Lance / arrête l'enregistrement du flux traité et capture le blob URL + nom d'export. */
  setFxRecording(active: boolean) {
    const players = [this.getPlayer('A'), this.getPlayer('B')].filter((p): p is Player => !!p);
    if (active) {
      players.forEach((p) => p.startFxRecording());
      this.fxRack.isRecordingFx = true;
      this.fxRack.fxRecordingDurationSec = 0;
      if (this._fxTimer) clearInterval(this._fxTimer);
      this._fxTimer = setInterval(() => {
        this.fxRack.fxRecordingDurationSec += 0.1;
      }, 100);
    } else {
      players.forEach((p) => p.stopFxRecording());
      if (this._fxTimer) {
        clearInterval(this._fxTimer);
        this._fxTimer = null;
      }
      const url = players.find((p) => p.getLastFxRecordingUrl())?.getLastFxRecordingUrl() ?? null;
      this.fxRack.lastRecordedFxBlobUrl = url;
      this.fxRack.lastRecordedFxName = url ? fxRecordingFileName(this.fxRack.deck, this.fxRack.livePadIndex) : null;
      this.fxRack.isRecordingFx = false;
    }
  }

  /** Prépare l'envoi de la dernière capture vers un Pad du Mix Live (0..7). */
  sendLastFxRecordingToLivePad(padIndex?: number) {
    this.fxRack.livePadIndex = padIndex == null ? (this.fxRack.livePadIndex ?? 0) : clampLivePadIndex(padIndex);
    if (this.fxRack.lastRecordedFxBlobUrl) {
      this.fxRack.lastRecordedFxName = fxRecordingFileName(this.fxRack.deck, this.fxRack.livePadIndex);
    }
  }

  /** ALC-215 : réinitialise le Rack FX (3 slots en bypass / état par défaut) SANS toucher aux stems ni à la lecture. */
  resetFxRack() {
    this.fxRack = defaultFxRackState();
    this.syncFxToPlayers();
  }
  isAnalyzing = $state<boolean>(false);
  /** Indicateur d'analyse MIR en cours sur l'un des deux platines (Deck A ou B). */
  anyAnalyzing = $derived(this.deckA.isAnalyzing || this.deckB.isAnalyzing);

  // ALC-146 : segments sonores par platine en $state.raw<TrackSegment[]> — tableaux volumineux
  // (RMS 3 bandes + tempo/clé locaux) hors du proxy profond pour zéro overhead d'observation.
  deckSegmentsA = $state.raw<TrackSegment[]>([]);
  deckSegmentsB = $state.raw<TrackSegment[]>([]);
  /** ALC-146 : sélecteur de calque de la waveform — 'tempo' (dérive locale) ou 'camelot' (clés locales). */
  beatgridOverlayMode = $state<'tempo' | 'camelot'>('tempo');
  // ALC-224 : sélecteur des 2 espaces télémétriques dédiés sous les waveforms (COURBE TEMPO / CLÉ).
  beatgridTelemetryMode = $state<'tempo' | 'key'>('tempo');
  setBeatgridTelemetryMode(m: 'tempo' | 'key') {
    this.beatgridTelemetryMode = m;
  }
  toggleBeatgridTelemetryMode() {
    this.beatgridTelemetryMode = this.beatgridTelemetryMode === 'tempo' ? 'key' : 'tempo';
  }

  // ALC-102-1 : télémétrie VU temps réel (RMS / Peak en dBFS) par platine.
  rmsDbA = $state(-20);
  peakDbA = $state(-20);
  rmsDbB = $state(-20);
  peakDbB = $state(-20);
  isClipping = $state(false);

  setLevels(id: DeckId, rmsDb: number, peakDb: number) {
    if (id === 'A') {
      this.rmsDbA = rmsDb;
      this.peakDbA = peakDb;
    } else {
      this.rmsDbB = rmsDb;
      this.peakDbB = peakDb;
    }
    this.isClipping = this.peakDbA >= 0 || this.peakDbB >= 0;
  }

  resetLevels(id: DeckId) {
    this.setLevels(id, -20, -20);
    this.isClipping = this.peakDbA >= 0 || this.peakDbB >= 0;
  }

  effectiveBpmA = $derived(computeEffectiveBpm(this.deckA.baseBpm, this.deckA.pitchPercent));
  effectiveBpmB = $derived(computeEffectiveBpm(this.deckB.baseBpm, this.deckB.pitchPercent));

  /** Écart de BPM calculé réactivement entre Deck B et Deck A — sur les BPM EFFECTIFS, normalisé octave. */
  bpmDelta = $derived(effectiveBpmDelta(this.effectiveBpmA, this.effectiveBpmB));
  isBpmLocked = $derived(Math.abs(this.bpmDelta) <= 0.15);

  // ALC-143 : conflit harmonique réactif (source unique harmony.ts) + mode Smart Filter.
  private harmonyRel = $derived(
    relationFrom(
      this.deckA.filePath ? parseCamelot(this.deckA.camelotKey) : null,
      this.deckB.filePath ? parseCamelot(this.deckB.camelotKey) : null
    )
  );
  isHarmonyDissonant = $derived(!!this.harmonyRel && !this.harmonyRel.rel && this.harmonyRel.ring >= 3);
  smartFilterActive = $state(false);
  /** Réduction auto (dB) appliquée aux graves & médiums tant que Smart Filter actif + clés incompatibles. */
  smartFilterDb = $derived(this.smartFilterActive && this.isHarmonyDissonant ? -6 : 0);
  toggleSmartFilter() {
    this.smartFilterActive = !this.smartFilterActive;
  }

  getDeck(id: DeckId): DeckState {
    return id === 'A' ? this.deckA : this.deckB;
  }

  // ALC-142 : registre des lecteurs (BeatgridView accède aux Player pour hot cues / loops / phase).
  private _players: Record<DeckId, Player | null> = { A: null, B: null };
  /** ALC-193-1 : verrou anti-réentrance du chargement stems (évite 2 décodages de 250 Mo simultanés). */
  private _loadingStems: Record<DeckId, Promise<void> | null> = { A: null, B: null };
  /** ALC-196 : handle requestAnimationFrame de l'automate « entrée vocale auto ». */
  private _mashupRaf = 0;
  /** ALC-231 : handle requestAnimationFrame (60 fps) du Dynamic Orchestral Ducking. */
  private _ostDuckRaf = 0;
  /** ALC-237 : handle requestAnimationFrame du Phrase-Synced Vocal Slicing (seek aux frontières). */
  private _sliceRaf = 0;
  /** ALC-246-2 : handle requestAnimationFrame du fondeur de respiration OST (THÈME OST SOLO). */
  private _breathRaf = 0;
  private _lastBreathIn = false;
  /** ALC-269 : handle requestAnimationFrame (60 fps) de l'exécution de partition. */
  private _arrangementRaf = 0;
  /** ALC-269 : dernier état résolu appliqué (évite de re-muter les mêmes stems à chaque trame). */
  private _arrAppliedKey = '';
  registerPlayer(id: DeckId, p: Player | null) { this._players[id] = p; }
  getPlayer(id: DeckId): Player | null { return this._players[id]; }

  /** ALC-193-1 : crée/adopte le Player d'une platine (sans lecture) — utilisé pour le pré-chauffage. */
  ensureDeckPlayer(id: DeckId): Player {
    let p = this.getPlayer(id);
    if (!p) {
      p = new Player(id);
      p.onTime = (c) => this.syncPlayback(id, c, 0);
      p.onDuration = (d) => this.syncPlayback(id, 0, d);
      this.registerPlayer(id, p);
    }
    return p;
  }

  // ALC-142 : hot cues (4) — poser / rappeler des positions temporelles.
  setHotCue(id: DeckId, idx: number) {
    this.getDeck(id).hotCues[idx] = Number(this.getDeck(id).elapsedSeconds.toFixed(2));
  }
  clearHotCue(id: DeckId, idx: number) { this.getDeck(id).hotCues[idx] = -1; }
  recallHotCue(id: DeckId, idx: number) {
    const d = this.getDeck(id);
    if (d.hotCues[idx] >= 0) this.getPlayer(id)?.seek(d.hotCues[idx]);
  }
  // ALC-142 : auto-loop quantifié (T_beat = 60 / BPM effectif) via le Player.
  setLoop(id: DeckId, beats: number | null) {
    const d = this.getDeck(id);
    d.loopBeats = beats;
    const p = this.getPlayer(id);
    if (!p) return;
    if (beats) p.setQuantizedLoop(beats, id === 'A' ? this.effectiveBpmA : this.effectiveBpmB);
    else p.clearLoop();
  }
  // ALC-142 : édition de grille.
  nudgeGrid(id: DeckId, ms: number) {
    const d = this.getDeck(id);
    d.gridOffsetMs = Math.round((d.gridOffsetMs || 0) + ms);
  }
  anchorGrid(id: DeckId) {
    this.getDeck(id).gridOffsetMs = Math.round(this.getDeck(id).elapsedSeconds * 1000);
  }
  // ALC-142 : correcteur d'octave de grille (÷2 / ×2) — double/halve la résolution rythmique de la grille.
  octaveGrid(id: DeckId, factor: 0.5 | 2) {
    const d = this.getDeck(id);
    const v = Math.max(0.25, Math.min(4, (d.gridOctave || 1) * factor));
    d.gridOctave = v === 1 ? 1 : Math.round(v * 100) / 100;
  }
  // ALC-142/ALC-212 : ALIGNER TEMPO & PHASE — deck B calé sur deck A (pitch + position),
  // via le helper unique de normalisation d'octave BPM (×2 / ÷2) avant de poser le playbackRate.
  alignTempoAndPhase() {
    const bpmA = this.effectiveBpmA;
    const baseB = this.deckB.baseBpm || 120;
    const norm = computeNormalizedTempoRatio(baseB, bpmA);
    this.deckB.pitchPercent = Number(((norm.ratio - 1) * 100).toFixed(2));
    // ALC-248-3 : pendant un AUTO-MASHUP OST actif, conserver l'offset d'alignement vocal
    // (vocalStartSeconds − ostEntrySeconds) au lieu de remettre deckB sur deckA (00:00).
    const mls = this.mashupLaunchState;
    if ((mls.mode === 'playing' || mls.mode === 'auto-vocal-wait') && this.ostPlan) {
      const off = mls.vocalStartSeconds ?? this.ostPlan.vocalVerseSeconds;
      const base = Math.max(0, this.deckA.elapsedSeconds - this.ostPlan.ostEntrySeconds + off);
      // ALC-251-3 : phasage rythmique fin (±0.5 temps sur la grille de A) — l'offset STRUCTUREL
      // est préservé, deckB n'est JAMAIS ramené à 00:00 pendant un automate Auto-Mashup actif.
      const beatA = 60 / Math.max(1, bpmA > 0 ? bpmA : 120);
      this.deckB.elapsedSeconds = Math.round(base / beatA) * beatA;
    } else {
      this.deckB.elapsedSeconds = this.deckA.elapsedSeconds;
    }
  }

  /** ALC-253-3 : Beat Nudge ±1 temps — décale INSTANTANÉMENT la position de la platine vocale
   * (±1 beat = 60/BPM s) sans interrompre la lecture (seek échantillon-près : les 4 stems
   * redémarrent au même instant futur, aucun bouton pause/appui nécessaire). Combat les voix à
   * contre-temps en direct (grande sœur du calage de phase downbeat d'ALC-253-2). */
  nudgeVocalPhaseBeats(beats: number) {
    if (!Number.isFinite(beats) || beats === 0) return;
    const mls = this.mashupLaunchState;
    const voc =
      mls.mode === 'playing' || mls.mode === 'auto-vocal-wait' ? mls.vocalDeck : 'B';
    const d = this.getDeck(voc);
    const bpm = voc === 'A' ? this.effectiveBpmA : this.effectiveBpmB;
    const beatDur = 60 / Math.max(1, bpm > 0 ? bpm : 120);
    const target = Math.max(
      0,
      Math.min(d.durationSeconds || Number.MAX_SAFE_INTEGER, (d.elapsedSeconds || 0) + beats * beatDur)
    );
    d.elapsedSeconds = target;
    this.getPlayer(voc)?.seek(target); // déplacement sans couper le son (transport conservé)
  }

  // ALC-221 : APPLIQUER LES CONSEILS de l'Oracle — état réactif (appliqué / summary / snapshot) + revert.
  oracleApplyState = $state<{ applied: boolean; summary: string; snapshot: OracleSnapshot | null }>({
    applied: false,
    summary: '',
    snapshot: null,
  });

  /** Applique en un clic les conseils de l'Oracle (pitch B cadencé sur A, LOW EQ B, durée Auto-Mix). */
  applyOracleAdvice() {
    if (!this.deckA.filePath || !this.deckB.filePath) return; // exige les deux platines chargées.
    const rel = relationFrom(
      parseCamelot(this.deckA.camelotKey),
      parseCamelot(this.deckB.camelotKey)
    );
    const advice = computeOracleAdvice({
      baseBpmB: this.deckB.baseBpm || 120,
      masterBpmA: this.effectiveBpmA,
      ring: rel?.ring ?? 99,
      rel: !!rel?.rel,
    });
    // Snapshot de l'état PRÉCÉDENT (pour revert exact).
    const snapshot = captureOracleSnapshot(
      this.deckB.pitchPercent,
      this.deckA.lowEqDb,
      this.deckB.lowEqDb,
      this.autoMixBars
    );
    // 1) Ajustement de cadence : pitch B calé sur le tempo effectif de A (normalisé octave).
    this.deckB.pitchPercent = advice.targetPitchB;
    if (this.deckA.transport === 'playing' && this.deckB.transport === 'playing') {
      this.deckB.elapsedSeconds = this.deckA.elapsedSeconds; // synchronise la phase en lecture.
    }
    // 2) Préparation des fréquences basses (LOW EQ 120 Hz).
    this.deckA.lowEqDb = advice.lowEqA;
    this.deckB.lowEqDb = advice.lowEqB;
    // 3) Calibrage de la durée Auto-Mix.
    this.autoMixBars = advice.autoMixBars;
    this.oracleApplyState.applied = true;
    this.oracleApplyState.summary = oracleAdviceSummary(advice);
    this.oracleApplyState.snapshot = snapshot;
  }

  /** Restaure immédiatement les valeurs EXACTES du snapshot et remet `applied = false`. */
  revertOracleAdvice() {
    const s = this.oracleApplyState.snapshot;
    if (!s) return;
    const restored = captureOracleSnapshot(s.pitchB, s.lowEqA, s.lowEqB, s.autoMixBars);
    this.deckB.pitchPercent = restored.pitchB;
    this.deckA.lowEqDb = restored.lowEqA;
    this.deckB.lowEqDb = restored.lowEqB;
    this.autoMixBars = restored.autoMixBars;
    this.oracleApplyState.applied = false;
    this.oracleApplyState.summary = '';
    this.oracleApplyState.snapshot = null;
  }

  setTransport(id: DeckId, mode: TransportMode) {
    const deck = this.getDeck(id);
    deck.transport = mode;
    if (mode === 'playing') this.ensureMixClock(); // ALC-226 : démarre le chrono global dès qu'une platine joue
    if (mode !== 'paused') deck.cueActive = false;
    if (mode === 'stopped') {
      deck.elapsedSeconds = 0;
      this.resetVocalRelay(); // ALC-223 : STOP → relais vocal désarmé
    }
  }

  /** ALC-184 : coupure audio DIRECTE (récupère l'unique Player enregistré) puis transport 'stopped'. */
  stopDeck(id: DeckId) {
    this.getPlayer(id)?.stop(); // coupure matérielle : stems + mono + AudioContext.suspend().
    this.setTransport(id, 'stopped');
  }

  /** Navigation rapide ±20 s (REW / FFWD) — renvoie la nouvelle position pour synchroniser le Player. */
  seek(id: DeckId, delta: number) {
    const deck = this.getDeck(id);
    deck.elapsedSeconds = Math.max(0, Math.min(deck.durationSeconds, deck.elapsedSeconds + delta));
    return deck.elapsedSeconds;
  }

  /** ALC-136-3 : synchronise position/durée du ROLL depuis l'élément <audio> (source de vérité lecture). */
  syncPlayback(id: DeckId, current: number, duration: number) {
    const deck = this.getDeck(id);
    // ALC-223 : relais vocal — déclenchement AUTO dès que A franchit la fin de sa 1re phrase vocale.
    if (
      this.vocalRelayState.pendingTarget !== null &&
      id === 'A' &&
      deck.transport === 'playing' &&
      Number.isFinite(current) &&
      current >= (this.vocalRelayState.triggerAtSeconds ?? Number.POSITIVE_INFINITY)
    ) {
      void this.advancePendingTarget();
    }
    if (duration > 0) deck.durationSeconds = duration;
    if (deck.transport === 'playing' && Number.isFinite(current)) deck.elapsedSeconds = current;
  }

  triggerCue(id: DeckId) {
    const deck = this.getDeck(id);
    deck.cueActive = !deck.cueActive;
    if (deck.cueActive) {
      deck.transport = 'paused';
    }
  }

  async loadTrackFromPath(id: DeckId, path: string) {
    this.oracleApplyState.applied = false; // ALC-221 : nouvelle piste → conseils réinitialisés
    const deck = this.getDeck(id);
    let loadedPath: string | null = null; // ALC-234 : chemin réellement chargé (pour la priorité Librairie)
    deck.lastError = null;
    // ALC-124 : active l'indicateur d'analyse MIR en cours pour ce platine.
    deck.isAnalyzing = true;
    try {
      const data: TrackData = await audioIpc.loadAudioFile(path);
      loadedPath = data.path;
      deck.filePath = data.path;
      deck.trackTitle = normalizeTitle(data.title);
      // ALC-157 : métadonnées réelles extraites des tags (aucune valeur de test).
      deck.album = data.album || '';
      deck.genre = data.genre || '';
      deck.artist = data.artist || '';
      deck.year = data.year || '';
      deck.serialCode = data.serialCode;
      deck.baseBpm = data.bpm;
      deck.pitchPercent = 0;
      deck.camelotKey = data.camelotKey;
      deck.camelotLabel = data.camelotKey;
      deck.keyConfidence = data.keyConfidence || 0;
      deck.keySource = 'dsp';
      deck.externalKey = '';
      deck.waveformPeaks = data.waveformPeaks || [];
      deck.keyTimeline = data.keyTimeline || [];
      deck.segments = data.segments || [];
      // ALC-146 : segments ultra-légers en $state.raw, remplacés par référence (pas de mutation profonde).
      if (id === 'A') this.deckSegmentsA = data.segments || [];
      else this.deckSegmentsB = data.segments || [];
      deck.durationSeconds = data.durationSeconds;
      deck.elapsedSeconds = 0;
      // ALC-122-1 : réinitialise explicitement l'état de lecture (isPlaying=false) au chargement
      // afin que PLAY ne reste pas « enfoncé » et puisse lancer la lecture dès le premier clic.
      deck.transport = 'stopped';
      deck.cueActive = false;
      deck.codec = data.codec;
      // ALC-255 WP16 : formats avec perte (MP3/AAC/OGG) → profondeur de bits hors spec (PCM décodé) ;
      // on l'affiche uniquement pour les formats sans perte (FLAC/WAV/AIFF). Débit réel via lofty, sinon —.
      const lossy = /^(MP3|AAC|M4A|OGG|OPUS|VORBIS)$/i.test(data.codec);
      deck.sampleRate = `${(data.sampleRate / 1000).toFixed(1)} kHz${lossy ? '' : ` / ${data.bitDepth}-bit`}`;
      deck.bitrate = data.bitrateKbps != null ? `${data.bitrateKbps} kbps` : '—';
      // ALC-127-2 : pochette embarquée (extraction Rust) → coverUrl
      deck.coverUrl = data.coverData || '';
      // ALC-134 : enrichissement MusicBrainz / Cover Art Archive si les tags lofty sont génériques.
      await this.enrichMetadataFromExternal(id, data);
      // Actualise immédiatement le BPM effectif & la clé Camelot via le pont IPC (ALC-006-3)
      await this.refreshTempoCamelot(id);
      // ALC-174-3 : active instantanément les 4 stems déjà séparés (cache disque) si présents.
      // ALC-175 : remise à zéro du mode stems avant (re)chargement — source mono réactivée.
      this.getPlayer(id)?.setStemMode(false);
      this.getPlayer(id)?.disposeStems();
      await this.applyCachedStems(id, data.path);
    } catch (err) {
      deck.lastError = err instanceof Error ? err.message : 'Échec de chargement audio';
    } finally {
      deck.isAnalyzing = false; // ALC-124 : libère l'indicateur dès que le backend a répondu.
    }
    // ALC-234 : métadonnées éditées par le DJ dans la Librairie → prioritaires sur les tags bruts du
    // fichier (indispensable pour les `.wav` qui ne stockent pas de tags ID3 — Artiste/Genre vides).
    if (loadedPath) {
      await this.ensureLibraryTracks();
      const libTrack = this.libraryTracks.find(
        (l) => this.normFilePath(l.filePath) === this.normFilePath(loadedPath)
      );
      if (libTrack) {
        if (libTrack.title) deck.trackTitle = libTrack.title;
        if (libTrack.artist) deck.artist = libTrack.artist;
        if (libTrack.genre) deck.genre = libTrack.genre;
        if (Number.isFinite(libTrack.bpm) && libTrack.bpm > 0) {
          deck.baseBpm = libTrack.bpm; // effectiveBpm recalculé ($derived) avec le pitchPercent actuel
        }
        if (libTrack.camelotKey) {
          deck.camelotKey = libTrack.camelotKey;
          deck.camelotLabel = camelotLabelFromKey(libTrack.camelotKey);
        }
      }
    }
    // ALC-233 : nouveau contexte audio → la détection automatique du profil OST est ré-évaluée
    // (un choix manuel précédent est libéré, sans jamais toucher aux profils forcés juste après).
    this.ostProfileManual = false;
    this.syncStyleProfileFromLoadedDecks();
  }

  async extractStems(id: DeckId) {
    const deck = this.getDeck(id);
    const targetPath = deck.filePath ?? `/audio/${deck.serialCode.toLowerCase()}.flac`;
    deck.isExtractingStems = true;
    deck.lastError = null;
    try {
      deck.stems = await audioIpc.extractStemsOnnx(targetPath);
    } catch (err) {
      deck.lastError = err instanceof Error ? err.message : 'Échec extraction ONNX';
    } finally {
      deck.isExtractingStems = false;
    }
  }

  // ── ALC-174-3 : séparation 4 Stems IA (cache + Mute / Solo / Presets) ──

  /** Au chargement d'une piste : active instantanément les stems déjà séparés (cache disque). */
  async applyCachedStems(id: DeckId, path: string) {
    const deck = this.getDeck(id);
    try {
      const cached = await audioIpc.checkCachedStems(path);
      if (cached) {
        deck.stemsStatus = 'ready';
        deck.stems = cached;
        deck.stemsProgress = 100;
        // ALC-193-1 : pré-chauffe en arrière-plan — les 4 AudioBuffer sont décodés dès le cache trouvé,
        // pour un démarrage ▶ PLAY / ▶ LANCER A + B instantané (< 50 ms).
        this.ensureDeckPlayer(id);
        void this.ensureStemsLoaded(id);
        void this.applyStemsTelemetry(id); // ALC-242 : recalibration BPM/clé via stems_meta.json
      } else {
        deck.stemsStatus = 'idle';
      }
    } catch (err) {
      deck.stemsStatus = 'idle';
      deck.lastError = err instanceof Error ? err.message : 'Vérification du cache stems échouée';
    }
  }

  /** ALC-242 : applique la télémétrie HTDemucs (`stems_meta.json`) au deck + rétro-alimentation. */
  async applyStemsTelemetry(id: DeckId) {
    const deck = this.getDeck(id);
    const path = deck.filePath;
    if (!path || deck.stemsStatus !== 'ready') return;
    try {
      const knownBpm = Number.isFinite(deck.baseBpm) && deck.baseBpm > 0 ? deck.baseBpm : null;
      // ALC-243 : le BPM référence borne les sauts non-binaires (×1,25/×1,33) du stem drums.
      let tel = await audioIpc.stemsTelemetry(path, knownBpm, false);
      // ALC-251-2 : garde-fou universel (helper pur) — rejet des ratios biaisés ~1,25 / ~0,80
      // (anciens caches stems_meta ×5/4) → purge + recalcul ; seuls le tempo analysé ou ses
      // octaves binaires (±8 %) passent ; le bpm biaisé n'est JAMAIS appliqué au deck.
      if (knownBpm && tel?.bpm != null && !isStemsTelemetryBpmAcceptable(tel.bpm, knownBpm)) {
        tel = await audioIpc.stemsTelemetry(path, knownBpm, true); // purge + recalcul propre (réf. écrite)
      }
      if (!tel) return;
      deck.stemsCalibrated = true;
      deck.stemsMeta = {
        vocalActivityRatio: tel.vocalActivityRatio,
        midCongestionScore: tel.midCongestionScore,
      };
      deck.firstDownbeatSeconds =
        tel.firstDownbeatSeconds != null && Number.isFinite(tel.firstDownbeatSeconds)
          ? Math.max(0, tel.firstDownbeatSeconds)
          : null; // ALC-253-1
      // BPM recalibré sur `drums` (validé par la référence binaire) et clé sur `other+bass`.
      // ALC-251-2 : garde finale — un bpm biaisé ~1,25 / ~0,80 n'est jamais appliqué au deck.
      if (tel.bpm != null && Number.isFinite(tel.bpm) && tel.bpm > 0 && isStemsTelemetryBpmAcceptable(tel.bpm, knownBpm || 0)) {
        deck.baseBpm = Number(tel.bpm.toFixed(1));
      }
      if (tel.camelotKey) {
        deck.camelotKey = tel.camelotKey;
        deck.camelotLabel = camelotLabelFromKey(tel.camelotKey);
        if (Number.isFinite(tel.camelotConfidence)) deck.keyConfidence = tel.camelotConfidence;
        deck.keySource = 'stems';
      }
      // Rétro-alimentation Librairie (ignorée si le DJ a verrouillé ses tags via ALC-232).
      const upd = await libraryIpc.applyStemsTelemetry(path, tel.bpm, tel.camelotKey).catch(() => null);
      if (upd) {
        const idx = this.libraryTracks.findIndex((t) => isSameTrack(t, deck));
        if (idx >= 0) {
          this.libraryTracks[idx] = { ...this.libraryTracks[idx], bpm: upd.bpm, camelotKey: upd.camelotKey };
        }
      }
    } catch (err) {
      deck.lastError = err instanceof Error ? err.message : 'Télémétrie stems indisponible';
    }
  }

  /** ALC-242 : métadonnées stems d'une platine pour `recommendMashupRecipe`. */
  private toStemsMeta(id: DeckId): MashupStemsMeta | null {
    const d = this.getDeck(id);
    if (!d.stemsMeta || !d.filePath) return null;
    return {
      vocalActivityRatio: d.stemsMeta.vocalActivityRatio,
      midCongestionScore: d.stemsMeta.midCongestionScore,
      genre: d.genre || null,
      camelotKey: d.camelotKey || null,
      bpm: d.baseBpm,
      // Crossover OST × OST : énergie percussive RMS du stem drums → désigne la Platine Rythmique.
      drumsRms: (() => {
        const env = this.getPlayer(id)?.getStemEnvelopes()?.drums;
        if (!env || env.length === 0) return undefined;
        let sum = 0;
        for (let i = 0; i < env.length; i++) sum += env[i] * env[i];
        return Math.sqrt(sum / env.length);
      })(),
    };
  }

  /** Lance la séparation 4 Stems (HTDemucs / ONNX local) avec progression en direct. */
  async extractDeckStems(id: DeckId) {
    const deck = this.getDeck(id);
    const path = deck.filePath;
    if (!path) return;
    deck.stemsStatus = 'separating';
    deck.stemsProgress = 0;
    const ch = new Channel<number>();
    ch.onmessage = (p: number) => {
      deck.stemsProgress = Math.round(Math.max(0, Math.min(1, p)) * 100);
    };
    try {
      const r = await audioIpc.separateStems(path, ch);
      deck.stemsStatus = 'ready';
      deck.stems = r;
      deck.stemsProgress = 100;
      // ALC-193-1 : pré-chauffe silencieuse (sans lecture) — décodage immédiat des 4 stems en arrière-plan.
      this.ensureDeckPlayer(id);
      void this.ensureStemsLoaded(id);
      void this.applyStemsTelemetry(id); // ALC-242 : recalibration BPM/clé via stems_meta.json
    } catch (err) {
      deck.stemsStatus = 'error';
      deck.lastError = err instanceof Error ? err.message : 'Séparation des stems échouée';
    }
  }

  /**
   * ALC-175 : active le mode stems EXCLUSIF (mono déconnecté) après chargement des 4 buffers ;
   * si le deck jouait déjà, reprend instantanément via les stems à la position courante.
   */
  activateStems(id: DeckId) {
    const p = this.getPlayer(id);
    const d = this.getDeck(id);
    if (!p) return;
    p.setStemMode(true);
    this.applyStemMutes(id);
    if (d.transport === 'playing') void p.play();
  }

  /**
   * Applique les gains EFFECTIFS dérivés des mutismes ET des volumes utilisateur
   * (ALC-187-1) : `effectiveGain = muted ? 0 : volume`. `stemGains` devient la source
   * unique de vérité des volumes (0..1) ; la rampe 15 ms (`setStemVolume`) évite tout clic.
   */
  applyStemMutes(id: DeckId) {
    const d = this.getDeck(id);
    const p = this.getPlayer(id);
    for (const s of STEM_NAMES) {
      const eff = d.stemMutes[s] ? 0 : clampStemVolume(d.stemGains[s] ?? 1);
      p?.setStemVolume(s, eff);
    }
    // ALC-178 : diagnostic console — Player réel + gains RÉELS des 4 GainNode stems.
    const diag = Object.fromEntries(
      STEM_NAMES.map((s) => [s, p ? p.stemGainValue(s) : null])
    ) as Record<StemName, number | null>;
    console.log(
      `[STEMS-DEBUG] MUTE deck=${id} player=${p ? `#${p.id}` : 'NULL'} stemModeActive=${p?.isStemModeActive() ?? false} mutes=${JSON.stringify(d.stemMutes)} vols=${JSON.stringify(d.stemGains)} gains=${JSON.stringify(diag)}`
    );
  }

  /**
   * ALC-178 : re-synchronise les stems dans le Player RÉEL que s'ils n'y sont pas encore.
   * Cause racine du bug « ✓ STEMS PRÊTS mais voix audible » : à l'instant où applyCachedStems()
   * s'exécutait (au chargement d'une piste), getPlayer(id) était NULL (le Player n'est créé
   * que lazyment sur le 1er PLAY) → loadStems était un no-op, le store affichait 'ready' mais le
   * Player n'avait ni buffers ni GainNode → PLAY jouait le mix mono complet (voix incluse).
   */
  async ensureStemsLoaded(id: DeckId): Promise<void> {
    const d = this.getDeck(id);
    const p = this.getPlayer(id);
    const paths = d.stems;
    if (!p || d.stemsStatus !== 'ready' || !paths) return;
    if (p.isStemModeActive()) return; // déjà chargées sur CE Player — pas de re-décodage à chaque PLAY.
    // ALC-193-1 : verrou anti-réentrance — un appel concurrent réutilise la même promesse
    // (épargne 2 décodeurs de 250 Mo en parallèle sur la même platine).
    if (this._loadingStems[id]) return this._loadingStems[id]!;
    const job = (async () => {
      // ALC-176 : repartir du mode mono (reconnexion propre) avant de charger les stems.
      p.setStemMode(false);
      p.disposeStems();
      await p.loadStems(paths);
      // Verrou exclusif stems + application des mutes COURANTES (premier PLAY inclus, donc un
      // VOIX coupé avant PLAY est respecté). PAS d'auto-play ici : startPlayer() gère play().
      p.setStemMode(true);
      this.applyStemMutes(id);
    })().finally(() => {
      this._loadingStems[id] = null;
    });
    this._loadingStems[id] = job;
    return job;
  }

  /**
   * ALC-192-2 : prépare le Player d'une platine pour un démarrage IMMÉDIAT (ex. Beatgrid
   * ▶ LANCER A + B) AVANT `setTransport('playing')` — crée/adopte le Player, réveille son
   * AudioContext (sortie de l'état 'suspended' après un STOP), charge les stems choisis par le DJ
   * et pose le pitch/la position. N'appelle PAS play() (laissé à l'appelant, dans le même geste).
   */
  async prepareDeckPlayback(id: DeckId): Promise<Player> {
    const p = this.ensureDeckPlayer(id);
    await p.resume();
    await this.ensureStemsLoaded(id);
    const d = this.getDeck(id);
    if (d.filePath && p.sourcePath !== d.filePath) {
      try {
        const bytes = await audioIpc.readAudioFileBytes(d.filePath);
        p.setSource(bytes, mimeFromPath(d.filePath), d.filePath);
      } catch (err) {
        console.error(`[Player] chargement de la source échoué (${id})`, err);
      }
    }
    p.setPlaybackRate(d.pitchPercent);
    p.seek(d.elapsedSeconds);
    return p;
  }

  /** ALC-225 : ⇄ INVERSER A ↔ B — échange intégral des platines (état + playback audio + réglages). */
  async swapDecks() {
    if (!this.deckA.filePath && !this.deckB.filePath) return; // au moins une platine chargée
    // Pause propre des deux lecteurs.
    this.getPlayer('A')?.pause();
    this.getPlayer('B')?.pause();
    // Échange intégral de l'état (toutes propriétés sauf id) — helper pur testable.
    const s = swapDeckState(this.deckA as any, this.deckB as any);
    Object.assign(this.deckA, s.a);
    Object.assign(this.deckB, s.b);
    // Cohérence des segments bruts hors-proxy (store-level) avec deck.segments échangés.
    const rawA = this.deckSegmentsA;
    this.deckSegmentsA = this.deckSegmentsB;
    this.deckSegmentsB = rawA;
    // Reset des conseils / relais vocaux devenus obsolètes.
    this.oracleApplyState.applied = false;
    this.resetVocalRelay();
    // Recharge chaque player sur sa nouvelle piste (mono + stems si prêts) avec pitch/position.
    await this.prepareDeckPlayback('A');
    await this.prepareDeckPlayback('B');
  }

  // ── ALC-196 : 3 modes de déclenchement Mashup ──

  /** ALC-196-2 : ▶ LANCER A + B — démarre les deux platines simultanément (stems respectés). */
  async launchSimultaneous() {
    // ALC-231 : reset des rôles WebAudio (aucun ducking résiduel) en lancement libre.
    this.getPlayer('A')?.setMashupRole('none');
    this.getPlayer('B')?.setMashupRole('none');
    this.ostPlan = null;
    this.stopOstDucking();
    const [pa, pb] = await Promise.all([this.prepareDeckPlayback('A'), this.prepareDeckPlayback('B')]);
    pa.seek(this.getDeck('A').elapsedSeconds);
    pb.seek(this.getDeck('B').elapsedSeconds);
    this.setTransport('A', 'playing');
    this.setTransport('B', 'playing');
    await Promise.all([pa.play(), pb.play()]);
    this.mashupLaunchState = { ...this.mashupLaunchState, mode: 'playing' };
    this._mashupRaf = 0;
  }

  /** ALC-196-2 : ⚡ ENTRÉE VOCALE AUTO — lance l'instrumentale et démarre la vocale au repère. */
  async launchAutoVocalSync() {
    // ALC-231 : profil OST / Cinéma → plan à ancrage de climax + ducking orchestral dédié.
    if (this.mashupStyleProfile === 'ost-cinema') return this.launchAutoVocalSyncOst();
    // Reset des rôles WebAudio du profil OST éventuellement précédent (creux ramené à 0 dB).
    this.getPlayer('A')?.setMashupRole('none');
    this.getPlayer('B')?.setMashupRole('none');
    this.ostPlan = null;
    // ALC-226 : auto-préparation — si les deux platines sont encore en MIXTE (4 stems actifs),
    // bascule automatiquement A -> INST (voix coupée) et B -> ACAPELLA (voix seule), aligne
    // tempo/phase et pose le crossfader 50/50 AVANT de calculer l'entrée vocale.
    if (this.deckA.stemsStatus === 'ready' && this.deckB.stemsStatus === 'ready') {
      const mixed = (d: typeof this.deckA) =>
        !d.stemMutes.vocals &&
        (['drums', 'bass', 'other'] as StemName[]).some((s) => !d.stemMutes[s]);
      if (mixed(this.deckA) && mixed(this.deckB)) {
        this.deckA.stemMutes = applyStemPreset(this.deckA.stemMutes, 'instrumental');
        this.deckB.stemMutes = applyStemPreset(this.deckB.stemMutes, 'acapella');
        this.applyStemMutes('A');
        this.applyStemMutes('B');
        this.crossfader = 50;
      }
    }
    const roles = resolveMashupRoles(this.deckA, this.deckB);
    const inst = roles.instDeck;
    const voc = roles.vocalDeck;
    const instDeck = this.getDeck(inst);
    const vocDeck = this.getDeck(voc);
    // ALC-214 : alignement de tempo/phase du vocal sur l'instrumentale (octave normalisée) AVANT play.
    const instBpm = inst === 'A' ? this.effectiveBpmA : this.effectiveBpmB;
    const vocNorm = computeNormalizedTempoRatio(vocDeck.baseBpm || 120, instBpm);
    vocDeck.pitchPercent = Number(((vocNorm.ratio - 1) * 100).toFixed(2));
    const bpm = inst === 'A' ? this.effectiveBpmA : this.effectiveBpmB;
    const pi0 = this.getPlayer(inst);
    const pv0 = this.getPlayer(voc);
    const instEnv = pi0?.getStemEnvelopes()?.vocals ?? null;
    const vocalEnv = pv0?.getStemEnvelopes()?.vocals ?? null;
    // ALC-203-1 : entrée vocale de l'instrumentale (repère de déclenchement) ✚ entrée vocale du
    // vocal (pré-cue B) — l'index exact `measureIndex=floor(t/(4*beat))+1` est rendu robuste via
    // detectFirstVocalEntrySeconds (ignorance des micro-résidus Demucs < 0.18 / < 4 bins).
    let entryA = instEnv
      ? detectFirstVocalEntrySeconds(instEnv, instDeck.durationSeconds, bpm, instDeck.gridOffsetMs)
      : instDeck.elapsedSeconds;
    let entryB = vocalEnv
      ? detectFirstVocalEntrySeconds(vocalEnv, vocDeck.durationSeconds, bpm, vocDeck.gridOffsetMs)
      : 0;
    if (!(entryA > 0)) entryA = Math.max(0, instDeck.elapsedSeconds || 0);
    const plan = computeAutoVocalPlan({
      entryA,
      entryB,
      instNow: instDeck.elapsedSeconds || 0,
      vocNow: vocDeck.elapsedSeconds || 0,
      userInActiveVocalZone: vocalEnv
        ? detectActiveVocalZoneAt(vocalEnv, vocDeck.durationSeconds, vocDeck.elapsedSeconds || 0)
        : false,
    });
    // État publié pour le retour visuel Beatgrid (ALC-203-2).
    this.mashupLaunchState = {
      mode: plan.triggerVocalImmediately ? 'playing' : 'auto-vocal-wait',
      instDeck: inst,
      vocalDeck: voc,
      targetEntrySeconds: plan.vocalTriggerTarget,
      vocalStartSeconds: plan.vocalStartSeconds,
    };
    this.setTransport(voc, 'stopped');
    const [pi, pv] = await Promise.all([this.prepareDeckPlayback(inst), this.prepareDeckPlayback(voc)]);
    // L'instrumentale ne repart que si elle était arrêtée (sinon on la laisse tourner telle quelle).
    const instAlreadyPlaying = instDeck.transport === 'playing';
    if (!instAlreadyPlaying) {
      pi.seek(plan.instStartSeconds);
      this.setTransport(inst, 'playing');
      await pi.play();
    }
    if (plan.triggerVocalImmediately) {
      // ALC-203-1 : inst déjà passée entryA → vocal IMMÉDIAT (déjà pré-cue sur son downbeat).
      vocDeck.elapsedSeconds = plan.vocalStartSeconds;
      pv.seek(plan.vocalStartSeconds);
      this.setTransport(voc, 'playing');
      await pv.play();
      this.mashupLaunchState = { ...this.mashupLaunchState, mode: 'playing' };
      this._mashupRaf = 0;
      return;
    }
    const check = () => {
      const st = this.mashupLaunchState;
      if (st.mode !== 'auto-vocal-wait' || st.instDeck !== inst) return;
      if (vocalTriggerDue(this.getDeck(inst).elapsedSeconds || 0, st.targetEntrySeconds ?? Number.MAX_SAFE_INTEGER)) {
        // ALC-203-1 : pré-cue — B part à sa PROPRE entrée vocale, synchrone avec la voix de A
        // (fini le départ à 00:00 qui subissait l'intro silencieuse de B).
        vocDeck.elapsedSeconds = plan.vocalStartSeconds;
        pv.seek(plan.vocalStartSeconds);
        this.setTransport(voc, 'playing');
        void pv.play();
        this.mashupLaunchState = { ...st, mode: 'playing' };
        this._mashupRaf = 0;
        return;
      }
      this._mashupRaf = requestAnimationFrame(check);
    };
    this._mashupRaf = requestAnimationFrame(check);
  }

  /**
   * ALC-231 : AUTO VOIX « Profil OST / Cinéma » — alignement par ancrage de climax orchestral +
   * Dynamic Orchestral Ducking. Normalise le tempo en octave (64 ↔ 128 BPM), calcule le plan
   * `computeOstVocalMashupPlan` (le refrain vocal tombe sur le climax), pré-cue le vocal sur SON
   * couplet (`vocalVerseSeconds`) et arme le déclenchement quand l'OST franchit `ostEntrySeconds`.
   */
  private async launchAutoVocalSyncOst(): Promise<void> {
    const roles = resolveMashupRoles(this.deckA, this.deckB);
    const inst = roles.instDeck;
    const voc = roles.vocalDeck;
    const instDeck = this.getDeck(inst);
    const vocDeck = this.getDeck(voc);
    // (1) ALIGNEMENT 1.0x + PHRASE-SYNCED VOCAL SLICING (ALC-237) : l'OST ET le vocal jouent à 1.0x —
    // aucun pitch-shift, timbre/clé 100 % préservés ; la dérive rythmique (122.6 vs 131.2 BPM) est
    // absorbée en découpant le vocal strophe par strophe et en le recalant sur les downbeats de l'OST.
    const ostBaseBpm = computeEffectiveBpm(instDeck.baseBpm || 120, 0);
    const vocBaseBpm = computeEffectiveBpm(vocDeck.baseBpm || 120, 0);
    this.setDeckPitch(inst, 0); // OST à 1.0x
    this.setDeckPitch(voc, 0); // vocal à 1.0x
    const bpm = ostBaseBpm; // grille file-time de l'OST pour le plan
    // (2) Plan OST / vocal — repli sûr si le calcul est impossible (stems absents).
    const pi0 = this.getPlayer(inst);
    const pv0 = this.getPlayer(voc);
    const oEnv = pi0?.getStemEnvelopes() ?? null;
    const vEnv = pv0?.getStemEnvelopes()?.vocals ?? null;
    if (!oEnv || !vEnv || !vEnv.length || !(instDeck.durationSeconds > 0) || !(vocDeck.durationSeconds > 0)) {
      this.mashupStyleProfile = 'standard';
      this.ostPlan = null;
      return this.launchAutoVocalSync();
    }
    const plan = computeOstVocalMashupPlan(
      {
        other: oEnv.other ?? new Float32Array(0),
        drums: oEnv.drums ?? new Float32Array(0),
        vocals: oEnv.vocals ?? new Float32Array(0),
        durationSeconds: instDeck.durationSeconds,
        bpm,
        gridOffsetMs: instDeck.gridOffsetMs,
      },
      {
        vocals: vEnv,
        durationSeconds: vocDeck.durationSeconds,
        bpm,
        gridOffsetMs: vocDeck.gridOffsetMs,
      }
    );
    // ALC-246-2 : plan CONTINU — Beatmatch verrouillé (octave [0.75..1.35]) : l'OST reste à 1.0x,
    // le vocal joue au playbackRate cont.vocalPlaybackRate avec `preservesPitch` natif (timbre et
    // clé 100 % intacts), deckA.effectiveBpm === deckB.effectiveBpm de bout en bout — AUCUN découpage
    // ni re-seek périodique. Le vocal démarre sur le downbeat et joue EN CONTINU d'un seul tenant.
    const vWin8 = 8 * 4 * (60 / (vocBaseBpm > 0 ? vocBaseBpm : 120));
    const cont = computeContinuousOstMashupPlan({
      ostBpm: ostBaseBpm,
      vocalBpm: vocBaseBpm,
      gridOffsetMs: instDeck.gridOffsetMs,
      ostEntryHintSeconds: plan.ostEntrySeconds,
      vocalStartHintSeconds: plan.vocalVerseSeconds,
      ostDurationSeconds: instDeck.durationSeconds,
      vocalDurationSeconds: vocDeck.durationSeconds,
      ostVocals: oEnv.vocals && oEnv.vocals.length ? oEnv.vocals : undefined,
      ostOther: oEnv.other && oEnv.other.length ? oEnv.other : undefined,
      ostDrums: oEnv.drums && oEnv.drums.length ? oEnv.drums : undefined,
      vocals: vEnv && vEnv.length ? vEnv : undefined,
      ostFirstDownbeatSeconds: instDeck.firstDownbeatSeconds ?? undefined, // ALC-253-1/2
      vocalFirstDownbeatSeconds: vocDeck.firstDownbeatSeconds ?? undefined, // ALC-253-1/2
      chorusEndSeconds: Number.isFinite(plan.vocalChorusSeconds) ? plan.vocalChorusSeconds + vWin8 : 0,
      ostDrumsRms: this.toStemsMeta(inst)?.drumsRms, // Clause 7 : relais rythmique hybride
      vocalDrumsRms: this.toStemsMeta(voc)?.drumsRms,
    });
    this.ostPlan = {
      ostDeckId: inst,
      climaxSeconds: plan.climaxSeconds,
      ostEntrySeconds: cont.ostEntrySeconds,
      vocalVerseSeconds: cont.vocalStartSeconds,
      dialogueRisk: plan.dialogueRisk,
    };
    // Applique le Beatmatch continu verrouillé : OST 1.0x, vocal au ratio plié à l'octave.
    this.setDeckPitch(inst, 0);
    this.setDeckPitch(voc, Number(((cont.vocalPlaybackRate - 1) * 100).toFixed(3)));
    // (3) Recette stems (OST instrumentale, vocal acapella) + rôles WebAudio (ducking 1,8 kHz).
    this.setStemPreset(inst, 'instrumental');
    this.setStemPreset(voc, 'acapella');
    pi0?.setMashupRole('ost-instrumental');
    pv0?.setMashupRole('vocal');
    pi0?.setKeyLock(true); // Key Lock natif (preservesPitch) — conservé par défaut
    pv0?.setKeyLock(true);
    // ALC-250-1 : démarrage des DEUX platines dans le MÊME geste utilisateur (clic AUTO-MASHUP) —
    // plus AUCUN `el.play()`/seek() différés au franchissement d'ENTRÉE VOIX (bloqués par la
    // politique d'autoplay de WebView2 → platine B muette / galvanomètre-mort pendant que le mute
    // stems de A coupe la sortie). La voix de B est simplement fermée (gain 0) pendant l'intro de
    // A puis remontée à 1.0 par le fondeur de respiration (gate vocalGateSeconds) AU franchissement.
    this.mashupLaunchState = {
      mode: 'playing',
      instDeck: inst,
      vocalDeck: voc,
      targetEntrySeconds: cont.ostEntrySeconds,
      vocalStartSeconds: cont.vocalStartSeconds,
    };
    this.setTransport(voc, 'stopped');
    const [piR, pvR] = await Promise.all([this.prepareDeckPlayback(inst), this.prepareDeckPlayback(voc)]);
    // ALC-251-1 : DÉMARRAGE SIMULTANÉ A+B dans le MÊME geste utilisateur (Promise.all) — les deux
    // `Player` sont joués immédiatement au clic AUTO-MASHUP (aucun play()/seek() différé au
    // franchissement d'ENTRÉE VOIX : l'autoplay WebView2 les bloquerait → platine muette).
    const aWasPlaying = instDeck.transport === 'playing';
    // B démarre IMMÉDIATEMENT à `vocalStart − (ostEntry − A.position)` : quand A franchit
    // ostEntrySeconds, B est pile sur son downbeat d'entrée (aucun re-seek, aucun re-play tardif).
    const aNow = Math.max(0, instDeck.elapsedSeconds || 0);
    const lead = Math.max(0, cont.ostEntrySeconds - aNow);
    const bStart = Math.max(0, cont.vocalStartSeconds - lead);
    vocDeck.elapsedSeconds = bStart;
    if (!aWasPlaying) piR.seek(instDeck.elapsedSeconds);
    pvR.seek(bStart);
    this.setTransport(inst, 'playing');
    this.setTransport(voc, 'playing');
    // Voix de B fermée pendant l'intro de A — le gate (vocalGateSeconds) l'ouvre en fondu 60 ms
    // EXACTEMENT au franchissement d'ostEntrySeconds, sans toucher A ni rejouer quoi que ce soit.
    pvR.setStemVolume('vocals', 0, 1);
    // ALC-251-1 : ré-affirmation — drums/bass/other (A) conservent leur gain nominal 1.0 et
    // el.muted=false à l'ENTRÉE VOIX (jamais de cut silencieux sur la platine porteuse).
    this.applyStemMutes(inst);
    const plays: Promise<unknown>[] = [];
    if (!aWasPlaying) plays.push(piR.play());
    plays.push(pvR.play());
    await Promise.all(plays); // A + B audibles dès la même trame (galvanomètres A et B actifs)
    this._mashupRaf = 0;
    this.startOstDucking(inst, voc);
    this.startOstBreathingFader(inst, voc, cont.breathingWindows, cont.vocalBridgeSkips, cont.ostEntrySeconds);
    this.logAudioWatchdog('ENTREE-VOIX immediat-geste', inst, voc); // ALC-249-2
    return;
  }

  /**
   * ALC-231 : pilote à 60 fps le Dynamic Orchestral Ducking — le creux à 1 800 Hz de l'OST suit
   * l'amplitude instantanée (0..1) du stem vocal opposé, lu à la position courante du lecteur vocal.
   */
  private startOstDucking(ostDeck: DeckId, vocDeck: DeckId) {
    this.stopOstDucking();
    const tick = () => {
      const po = this.getPlayer(ostDeck);
      const pv = this.getPlayer(vocDeck);
      if (!po || !pv || po.getMashupRole() !== 'ost-instrumental') {
        this.stopOstDucking();
        return;
      }
      const stillPlaying =
        this.getDeck(ostDeck).transport === 'playing' || this.getDeck(vocDeck).transport === 'playing';
      if (!stillPlaying) {
        po.updateDynamicOrchestralDucking(0);
        this.stopOstDucking();
        return;
      }
      const env = pv.getStemEnvelopes()?.vocals;
      const dur = this.getDeck(vocDeck).durationSeconds || 0;
      let value = 0;
      if (env && env.length && dur > 0) {
        const idx = Math.max(0, Math.min(env.length - 1, Math.floor((pv.position / dur) * env.length)));
        value = env[idx] ?? 0;
      }
      po.updateDynamicOrchestralDucking(
        value,
        // ALC-248-2 : plafond −3.0 dB — la richesse des cuivres/cordes/guitares de l'instrumental
        // est toujours conservée (plus d'étouffement ∕ creux).
        -3.0
      );
      this._ostDuckRaf = requestAnimationFrame(tick);
    };
    this._ostDuckRaf = requestAnimationFrame(tick);
  }

  /** Arrête la boucle de ducking et remet les creux à 0 dB (rôles conservés, repli silencieux). */
  private stopOstDucking() {
    if (this._ostDuckRaf) cancelAnimationFrame(this._ostDuckRaf);
    this._ostDuckRaf = 0;
    for (const id of ['A', 'B'] as DeckId[]) {
      this.getPlayer(id)?.updateDynamicOrchestralDucking(0);
    }
  }

  /**
   * ALC-249-2 : [AUDIO-WATCHDOG] — au franchissement d'ENTRÉE VOIX, logge l'état RÉEL
   * (muted/paused des <audio> + gain des GainNode + mutes/volumes du store) des 4 stems de A et B :
   * A doit garder `drums`+`bass`+`other` actifs, B doit garder `vocals` actif. Confirme sur la
   * vidéo qu'aucun mute stale / ducking n'a coupé une platine au déclenchement EXACT.
   */
  private logAudioWatchdog(what: string, inst: DeckId, voc: DeckId) {
    const snap = (id: DeckId) => {
      const d = this.getDeck(id);
      const p = this.getPlayer(id);
      return {
        mutes: d.stemMutes,
        vols: d.stemGains,
        els: p?.getStemMediaState() ?? null,
        gains: p ? Object.fromEntries(STEM_NAMES.map((n) => [n, p.stemGainValue(n)])) : null,
      };
    };
    console.log(
      `[AUDIO-WATCHDOG] ${what} · ${inst}=${JSON.stringify(snap(inst))} · ${voc}=${JSON.stringify(snap(voc))}`
    );
  }

  /**
   * ALC-237 / ALC-238-2 : Phrase-Synced Vocal Slicing — re-cale le lecteur vocal (seek) sur chaque
   * downbeat de l'OST jouée à 1.0x. Aucun pitch-shift : timbre et clé du vocal restent intacts.
   * ALC-238-2 : exécution fluide des silences — anti-clic 15 ms avant chaque seek, et quand
   * `ostElapsed` entre dans une fenêtre de respiration orchestrale (`mutedWindow === true`) OU que
   * `vocElapsed` atteint `slice.vocalEndSeconds` avant le prochain airSeconds : fondu SORTIE 30 ms
   * jusqu'à la prochaine tranche chantée active, puis fondu ENTREE 15 ms pile au seek sur le temps fort.
   */
  private startPhraseSyncSlicing(
    ostDeck: DeckId,
    vocDeck: DeckId,
    slices: PhraseSlice[],
    airOriginSeconds: number,
    breathingWindows: PhraseSyncedBreathingWindow[] = []
  ) {
    this.stopPhraseSyncSlicing();
    if (slices.length < 2) return;
    const startReal = performance.now();
    let idx = 1; // la slice 0 est la position initiale (pré-cue sur le couplet)
    let muted = false; // ALC-238-2 : vrai quand le vocal est atténué (respiration / fin de strophe)
    const vocalTarget = () => {
      const vs = this.getDeck(vocDeck);
      return vs.stemMutes.vocals ? 0 : clampStemVolume(vs.stemGains.vocals ?? 1);
    };
    const isMw = (i: number) => (i >= 0 && i < slices.length ? slices[i].mutedWindow : false);
    const inBreathing = (t: number) =>
      breathingWindows.some((w) => t >= w.startSeconds && t < w.endSeconds);
    const tick = () => {
      const pv = this.getPlayer(vocDeck);
      if (!pv) {
        this.stopPhraseSyncSlicing();
        return;
      }
      const still =
        this.getDeck(ostDeck).transport === 'playing' || this.getDeck(vocDeck).transport === 'playing';
      if (!still) {
        this.stopPhraseSyncSlicing();
        return;
      }
      // Air courant = entrée vocale (temps fichier OST à 1.0x) + temps réel écoulé depuis le départ :
      // à 1.0x, `air` est aussi l'ostElapsed utilisé pour les fenêtres de respiration.
      const air = airOriginSeconds + (performance.now() - startReal) / 1000;
      // (i) Frontières de phrase : micro-fondu anti-clic 15 ms AVANT le seek ; on ne rouvre le
      //     vocal (fondu 15 ms) que si la tranche suivante est CHANTÉE et hors respiration.
      while (idx < slices.length && air >= slices[idx].airSeconds) {
        const nextMuted = isMw(idx) || inBreathing(air);
        pv.setStemVolume('vocals', 0.0001, 15); // fondu quasi-silence : plus aucun clic de seek
        pv.seek(slices[idx].vocalFileSeconds); // tranche recalée sur le temps fort (1.0x, pitch intact)
        const restore = vocalTarget();
        if (restore > 0 && !nextMuted) {
          setTimeout(() => this.getPlayer(vocDeck)?.setStemVolume('vocals', restore, 15), 25);
          muted = false;
        } else {
          muted = true; // restera muette pendant la respiration / la tranche mutedWindow
        }
        idx++;
      }
      // (ii) Respiration orchestrale / fin acoustique de tranche dépassée avant la frontière :
      //      fondu SORTIE 30 ms. La RÉOUVERTURE (fade 15 ms) n'est JAMAIS faite ici — elle a lieu
      //      exclusivement au franchissement EXACT du `airSeconds` de la prochaine tranche (ALC-239-2),
      //      dans la boucle de frontières ci-dessus (le `seek` = downbeat post-break).
      const current = slices[idx - 1];
      const vocPos = pv.position;
      const nextAir = idx < slices.length ? slices[idx].airSeconds : Number.POSITIVE_INFINITY;
      const atEnd =
        !!current && current.vocalEndSeconds > 0 && air < nextAir && vocPos > current.vocalEndSeconds + 0.02;
      const mustMute = inBreathing(air) || isMw(idx - 1) || atEnd;
      if (mustMute && !muted) {
        pv.setStemVolume('vocals', 0, 30); // gating 30 ms jusqu'à la prochaine tranche chantée
        muted = true;
      }
      this._sliceRaf = requestAnimationFrame(tick);
    };
    this._sliceRaf = requestAnimationFrame(tick);
  }

  private stopPhraseSyncSlicing() {
    if (this._sliceRaf) cancelAnimationFrame(this._sliceRaf);
    this._sliceRaf = 0;
  }

  /**
   * ALC-246-2 : respiration macro de l'OST — le vocal reste EN CONTINU (aucun seek), seul son gain
   * est fondu en douceur (fade 180 ms out/in) pendant les fenêtres `breathingWindows` (INTRO /
   * DIALOGUE / THÈME OST SOLO). Le lecteur vocal avance en phase en arrière-plan.
   */
  private startOstBreathingFader(
    ostDeck: DeckId,
    vocDeck: DeckId,
    windows: { startSeconds: number; endSeconds: number }[],
    skips: { triggerOstSeconds: number; jumpToVocalSeconds: number }[] = [],
    vocalGateSeconds = 0
  ) {
    this.stopOstBreathingFader();
    if (!windows.length && !skips.length && !(vocalGateSeconds > 0)) return;
    const startReal = performance.now();
    const airOrigin = this.getDeck(ostDeck).elapsedSeconds || 0;
    this._lastBreathIn = false;
    let skipIdx = 0; // ALC-248-3 : ponts instrumentaux du vocal à sauter (fondu 40 ms + seek)
    const tick = () => {
      const pv = this.getPlayer(vocDeck);
      if (!pv) {
        this.stopOstBreathingFader();
        return;
      }
      const still =
        this.getDeck(ostDeck).transport === 'playing' || this.getDeck(vocDeck).transport === 'playing';
      if (!still) {
        this.stopOstBreathingFader();
        return;
      }
      // Air = temps OST réel (1.0x) depuis le déclenchement.
      const air = airOrigin + (performance.now() - startReal) / 1000;
      const vs = this.getDeck(vocDeck);
      // ALC-250-1 : gate d'entrée — la voix de B reste FERMÉE jusqu'au downbeat ENTRÉE VOIX
      // (vocalGateSeconds) même si aucune fenêtre de respiration ne couvre l'intro (aucune fuite).
      const gateOpen = air >= vocalGateSeconds;
      const target = vs.stemMutes.vocals ? 0 : clampStemVolume(vs.stemGains.vocals ?? 1);
      // ALC-248-3 : dès l'entrée d'un pont vocal vide (≥ 8 mesures), fondu 40 ms + avance du vocal
      // au downbeat (4 mesures) du couplet/refrain suivant — plus jamais 45 s de vide vocal.
      // ALC-249-2 : garde-fou de lancement — on ne saute JAMAIS un pont si la platine vocale est
      // déjà à/après la cible (démarrage de B à vocalStartSeconds == cible → pas de saut inutile
      // qui reprogrammerait un muting 40 ms sur une voix à peine lancée).
      if (
        gateOpen &&
        skipIdx < skips.length &&
        air >= skips[skipIdx].triggerOstSeconds &&
        this.getDeck(vocDeck).elapsedSeconds < skips[skipIdx].jumpToVocalSeconds - 0.01
      ) {
        pv.setStemVolume('vocals', 0, 40);
        pv.seek(skips[skipIdx].jumpToVocalSeconds);
        const restore = target;
        setTimeout(() => this.getPlayer(vocDeck)?.setStemVolume('vocals', restore, 40), 80);
        skipIdx++;
      }
      const inWindow = windows.some((w) => air >= w.startSeconds && air < w.endSeconds);
      const audible = gateOpen && !inWindow;
      if (audible !== this._lastBreathIn || audible) {
        // ALC-251-1 : ouverture de la voix EXACTEMENT au franchissement d'ENTRÉE VOIX en fondu
        // **60 ms** (0 → 1), jamais de coupure sèche ; fenêtres de respiration conservées en 180 ms.
        const opening = audible && !this._lastBreathIn;
        pv.setStemVolume('vocals', audible ? target : 0, opening && gateOpen ? 60 : 180);
        this._lastBreathIn = audible;
      }
      this._breathRaf = requestAnimationFrame(tick);
    };
    this._breathRaf = requestAnimationFrame(tick);
  }

  private stopOstBreathingFader() {
    if (this._breathRaf) cancelAnimationFrame(this._breathRaf);
    this._breathRaf = 0;
    this._lastBreathIn = false;
  }

  /** ALC-196-2 : 🎛 INST SEUL — lance l'instrumentale et arme la vocale (déclenchement manuel). */
  async launchInstWaitManualVocal() {
    // ALC-231 : reset des rôles WebAudio du profil OST éventuellement précédent.
    this.getPlayer('A')?.setMashupRole('none');
    this.getPlayer('B')?.setMashupRole('none');
    this.ostPlan = null;
    this.stopOstDucking();
    const roles = resolveMashupRoles(this.deckA, this.deckB);
    const inst = roles.instDeck;
    const voc = roles.vocalDeck;
    this.mashupLaunchState = { mode: 'manual-vocal-wait', instDeck: inst, vocalDeck: voc, targetEntrySeconds: null, vocalStartSeconds: null };
    const instDeck = this.getDeck(inst);
    const [pi] = await Promise.all([this.prepareDeckPlayback(inst), this.prepareDeckPlayback(voc)]);
    pi.seek(instDeck.elapsedSeconds);
    this.setTransport(inst, 'playing');
    await pi.play();
  }

  /** ALC-196-2 : 🎤 LANCER VOCAL MAINTENANT — démarre la platine vocale à la milliseconde du clic. */
  async triggerManualVocalNow() {
    const st = this.mashupLaunchState;
    if (st.mode !== 'manual-vocal-wait') return;
    const voc = st.vocalDeck;
    const pv = this.getPlayer(voc);
    if (!pv) return;
    pv.seek(this.getDeck(voc).elapsedSeconds);
    this.setTransport(voc, 'playing');
    await pv.play();
    this.mashupLaunchState = { ...st, mode: 'playing' };
  }

  /** ALC-196-2 : ⏸ PAUSE — coupe proprement les deux platines (pause + suspend) et remet à zéro. */
  pauseMashupLaunch() {
    if (this._mashupRaf) cancelAnimationFrame(this._mashupRaf);
    this._mashupRaf = 0;
    this.stopOstDucking(); // ALC-231 : coupure du ducking orchestral (creux ramené à 0 dB)
    this.stopPhraseSyncSlicing(); // ALC-237 : coupure du re-cale strophe par strophe
    this.stopOstBreathingFader(); // ALC-246-2 : coupure du fondeur de respiration (gain vocal restauré)
    const pa = this.getPlayer('A');
    const pb = this.getPlayer('B');
    pa?.pause();
    pb?.pause();
    this.setTransport('A', 'paused');
    this.setTransport('B', 'paused');
    this.mashupLaunchState = { mode: 'idle', instDeck: 'A', vocalDeck: 'B', targetEntrySeconds: null, vocalStartSeconds: null };
  }

  // ALC-227 : ⇄ RELAIS A ↔ B — relais vocal BIDIRECTIONNEL quantifié à la strophe suivante.
  vocalRelayState = $state<{
    activeSpeaker: 'A' | 'B';
    pendingTarget: 'A' | 'B' | null;
    triggerAtSeconds: number | null;
  }>({
    activeSpeaker: 'A',
    pendingTarget: null,
    triggerAtSeconds: null,
  });

  /** Réinitialise l'état du relais (STOP / EJECT / swap). */
  resetVocalRelay() {
    this.vocalRelayState = { activeSpeaker: 'A', pendingTarget: null, triggerAtSeconds: null };
  }

  private stanzasOf(id: DeckId): Float32Array | null {
    const env = this.getPlayer(id)?.getStemEnvelopes()?.vocals ?? null;
    return env && env.length ? env : null;
  }

  private triggerStanzaFor(deckId: DeckId): number {
    const d = this.getDeck(deckId);
    const cur = d.elapsedSeconds || 0;
    const env = this.stanzasOf(deckId);
    if (env) {
      return findNextStanzaStartAfter(
        env,
        d.durationSeconds || 0,
        deckId === 'A' ? this.effectiveBpmA : this.effectiveBpmB,
        d.gridOffsetMs || 0,
        cur
      );
    }
    const beat = 60 / (deckId === 'A' ? this.effectiveBpmA || 120 : this.effectiveBpmB || 120);
    return cur + 8 * 4 * beat;
  }

  /** Un clic bascule : coupe la voix active, arme la cible pour sa prochaine strophe. */
  toggleVocalRelayStep() {
    if (!this.deckA.filePath || !this.deckB.filePath) return;
    if (this.deckA.stemsStatus !== 'ready' || this.deckB.stemsStatus !== 'ready') return;
    const s = this.vocalRelayState;
    // Re-clic pendant l'attente → force maintenant (sécurité live).
    if (s.pendingTarget !== null) {
      void this.advancePendingTarget();
      return;
    }
    const aVoc = !this.deckA.stemMutes.vocals;
    if (aVoc) {
      // Voix A active → coupe A immédiatement, prépare B ACAPELLA, arme B.
      this.deckA.stemMutes.vocals = true;
      this.applyStemMutes('A');
      this.deckB.stemMutes = applyStemPreset(this.deckB.stemMutes, 'acapella');
      this.applyStemMutes('B');
      this.vocalRelayState = { activeSpeaker: 'A', pendingTarget: 'B', triggerAtSeconds: this.triggerStanzaFor('A') };
    } else {
      // Voix B active (ou A déjà muet) → coupe B, arme A.
      this.deckB.stemMutes.vocals = true;
      this.applyStemMutes('B');
      this.vocalRelayState = { activeSpeaker: 'B', pendingTarget: 'A', triggerAtSeconds: this.triggerStanzaFor('A') };
    }
  }

  /** Ouvre la voix cible en phase à sa strophe, pose activeSpeaker et annule pending. */
  private async advancePendingTarget() {
    const s = this.vocalRelayState;
    const target = s.pendingTarget;
    if (!target) return;
    if (target === 'B') {
      this.deckB.stemMutes.vocals = false;
      this.applyStemMutes('B');
      const pb = this.getPlayer('B');
      if (pb && this.deckB.transport !== 'playing') {
        // Positionne B sur sa première strophe active puis le lance en phase.
        const env = this.stanzasOf('B');
        const start = env
          ? findFirstVocalStanzaStart(env, this.deckB.durationSeconds || 0, this.effectiveBpmB, this.deckB.gridOffsetMs || 0)
          : 0;
        this.deckB.elapsedSeconds = start;
        pb.seek(start);
        this.setTransport('B', 'playing');
        await pb.play();
      }
      this.vocalRelayState = { activeSpeaker: 'B', pendingTarget: null, triggerAtSeconds: null };
    } else {
      this.deckA.stemMutes.vocals = false;
      this.applyStemMutes('A');
      this.vocalRelayState = { activeSpeaker: 'A', pendingTarget: null, triggerAtSeconds: null };
    }
  }

  // ALC-226 : Timer Global de Mix + Enregistrement WAV du mashup (Blob download fallback).
  globalMixElapsedSeconds = $state(0);
  isRecordingMashup = $state(false);
  lastMashupRecordingName: string | null = $state(null);
  private _mixClock: number | null = null;

  /** Démarre le chronomètre global de mix (tick 1 s, incrément que si lecture/env—), une seule fois. */
  ensureMixClock() {
    if (typeof window === 'undefined' || this._mixClock != null) return;
    this._mixClock = window.setInterval(() => {
      const playing =
        this.deckA.transport === 'playing' ||
        this.deckB.transport === 'playing' ||
        this.isRecordingMashup;
      if (playing) this.globalMixElapsedSeconds += 1;
    }, 1000);
  }
  resetGlobalMixClock() {
    this.globalMixElapsedSeconds = 0;
  }

  private activeDeckForCapture(): DeckId {
    if (this.deckA.transport === 'playing') return 'A';
    if (this.deckB.transport === 'playing') return 'B';
    return 'A';
  }

  /** Démarre l'enregistrement WAV du mix Master (platine active, post-crossfader). */
  startMashupRecording() {
    if (this.isRecordingMashup) return;
    this.ensureMixClock();
    this.getPlayer(this.activeDeckForCapture())?.startWavCapture();
    this.isRecordingMashup = true;
  }

  /** Arrête, encode en WAV 16-bit stéréo et sauvegarde (Blob download fallback + toast chemin). */
  async stopAndSaveMashupRecording() {
    if (!this.isRecordingMashup) return;
    const cap = this.getPlayer(this.activeDeckForCapture())?.stopWavCapture() ?? null;
    this.isRecordingMashup = false;
    if (!cap || !cap.samples.length) return;
    const name = mashupWavFilename(new Date());
    const blob = encodeWav16Stereo(cap.samples, cap.sampleRate);
    this.lastMashupRecordingName = name;
    this.saveBlobDownload(blob, name);
  }

  private saveBlobDownload(blob: Blob, name: string) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      console.error('[MashupRec] sauvegarde impossible', err);
    }
  }

  // ALC-228 : 🎛 Pilote Automatique de Mashup (AUTO-MASHUP STUDIO) — orchestrateur 5 étapes + progression.
  autoMashupPipelineState = $state<{
    running: boolean;
    stepLabel: string;
    stepIndex: number;
    totalSteps: number;
    readyToSaveDuo: boolean;
  }>({
    running: false,
    stepLabel: 'INACTIF',
    stepIndex: 0,
    totalSteps: 5,
    readyToSaveDuo: false,
  });

  /** Valide le duo courant (readyToSaveDuo) — sauvegarde dans les duos validés de la Librairie. */
  saveCurrentAutoMashupDuo() {
    const st = this.autoMashupPipelineState;
    if (!st.readyToSaveDuo) return;
    this.autoMashupPipelineState = { ...st, readyToSaveDuo: false, stepLabel: 'DUO VALIDÉ ✓' };
  }

  /** Interrompt proprement le pipeline à tout moment. */
  cancelFullAutoMashup() {
    this.autoMashupPipelineState = {
      running: false,
      stepLabel: 'ANNULÉ',
      stepIndex: 0,
      totalSteps: 5,
      readyToSaveDuo: false,
    };
  }

  /**
   * Pilote complet en 1 clic : alignement tempo, extraction/chargement stems A+B,
   * recette mashup (mode), crossfader 50/50, launchAutoVocalSync, éventuel enregistrement WAV.
   */
  async runFullAutoMashup(mode: 'instA_vocB' | 'vocA_instB' | 'crossover' = 'instA_vocB', recordWav = false) {
    if (!this.deckA.filePath || !this.deckB.filePath) return;
    // ALC-242 : choix intelligent de la recette via la télémétrie HTDemucs des deux platines
    // (sauf si l'utilisateur a verrouillé la recette dans le sélecteur Beatgrid).
    let crossoverRhythm: 'A' | 'B' = 'A';
    if (!this.mashupRecipeManual) {
      const rec = recommendMashupRecipe(this.toStemsMeta('A'), this.toStemsMeta('B'));
      if (rec) {
        mode = rec.mode;
        this.mashupRecipeReason = rec.reason;
        if (rec.mode === 'crossover' && rec.crossover) crossoverRhythm = rec.crossover.rhythm;
        if (rec.profile === 'ost-cinema' && !this.ostProfileManual) {
          this.mashupStyleProfile = 'ost-cinema';
        }
      }
    }
    this.autoMashupPipelineState = {
      running: true,
      stepLabel: 'ALIGNEMENT HARMONIQUE & TEMPO',
      stepIndex: 1,
      totalSteps: 5,
      readyToSaveDuo: false,
    };
    // Étape 1/5 — alignement tempo & PROTECTION DU TIMBRE (ALC-237).
    if (mode === 'crossover') {
      // Crossover OST × OST : les deux platines instrumentales restent à 1.0x (Key Lock, timbre/clé intacts).
      this.setDeckPitch('A', 0);
      this.setDeckPitch('B', 0);
      this.deckB.elapsedSeconds = this.deckA.elapsedSeconds;
    } else if (this.mashupStyleProfile === 'ost-cinema') {
      // ALC-237 : profil OST en 1.0x — l'OST ET le vocal restent à leur tempo naturel (aucun
      // pitch-shift, timbre/clé 100 % préservés) ; la dérive rythmique est absorbée strophe par
      // strophe par le Phrase-Synced Vocal Slicing (launchAutoVocalSyncOst → seek aux downbeats).
      const ostId: DeckId = mode === 'instA_vocB' ? 'A' : 'B';
      const vocId: DeckId = mode === 'instA_vocB' ? 'B' : 'A';
      this.setDeckPitch(ostId, 0); // OST à 1.0x
      this.setDeckPitch(vocId, 0); // vocal à 1.0x
      this.getDeck(vocId).elapsedSeconds = this.getDeck(ostId).elapsedSeconds;
    } else {
      // Standard : aligne le tempo effectif de B sur A (normalisation octave).
      const norm = computeNormalizedTempoRatio(this.deckB.baseBpm || 120, this.effectiveBpmA);
      this.deckB.pitchPercent = Number(((norm.ratio - 1) * 100).toFixed(2));
      this.deckB.elapsedSeconds = this.deckA.elapsedSeconds;
    }
    // Étape 2/5 — extraction / chargement des stems A et B (Promise.all, abandon si erreur).
    this.autoMashupPipelineState = {
      ...this.autoMashupPipelineState,
      stepLabel: 'EXTRACTION STEMS IA',
      stepIndex: 2,
    };
    const needs = (['A', 'B'] as DeckId[]).filter((id) => this.getDeck(id).stemsStatus !== 'ready');
    try {
      if (needs.length) await Promise.all(needs.map((id) => this.extractDeckStems(id)));
    } catch (err) {
      console.error('[AutoMashup] extraction stems échouée', err);
      this.autoMashupPipelineState = {
        running: false,
        stepLabel: 'ÉCHEC EXTRACTION STEMS',
        stepIndex: 0,
        totalSteps: 5,
        readyToSaveDuo: false,
      };
      return;
    }
    // Étape 3/5 — recette mashup selon le mode + sculpture spectrale + crossfader 50/50.
    this.autoMashupPipelineState = {
      ...this.autoMashupPipelineState,
      stepLabel: 'RECETTE MASHUP & SCULPTURE SPECTRALE',
      stepIndex: 3,
    };
    if (mode === 'crossover') {
      this.applyCrossoverMashup(crossoverRhythm);
    } else if (mode === 'instA_vocB') {
      this.setStemPreset('A', 'instrumental');
      this.setStemPreset('B', 'acapella');
    } else {
      this.setStemPreset('A', 'acapella');
      this.setStemPreset('B', 'instrumental');
    }
    // Routeur unifié des 3 spécialités (règles métier `.clinerules/04 • 05 • 06`) : creux médium
    // **Guitar Pocket** sur l'instrumentale Pop × Rock (2 200 Hz si Rock, 1 250 Hz si Pop) — n'altère
    // pas les modes OST/Cinéma (`ost-vocal` garde son ducking 1 800 Hz) ni crossover (1 500 Hz).
    const specialty = resolveMashupSpecialty(this.toStemsMeta('A'), this.toStemsMeta('B'));
    if (specialty.specialty === 'pop-rock' && specialty.midNotchHz > 0 && mode !== 'crossover') {
      const instDeck: DeckId = mode === 'instA_vocB' ? 'A' : 'B';
      this.getPlayer(instDeck)?.setStemMidNotch('other', specialty.midNotchHz, -3);
    }
    this.crossfader = 50; // 50/50
    // ALC-233 : suggestion automatique du profil OST — genre de la platine porteuse du mode
    // (`ost`, `cinéma`, `cinema`, `soundtrack`, `score`) OU ratio d'énergie vocale < 5 %.
    // Jamais si le DJ a forcé manuellement la bascule [CLUB | OST].
    if (!this.ostProfileManual && this.mashupStyleProfile === 'standard') {
      const instId: DeckId = mode === 'instA_vocB' ? 'A' : 'B';
      const carrierGenre = this.getDeck(instId).genre;
      const iEnv = this.getPlayer(instId)?.getStemEnvelopes();
      const ratio = iEnv
        ? computeOstVocalEnergyRatio(
            iEnv.vocals ?? new Float32Array(0),
            iEnv.other ?? new Float32Array(0),
            iEnv.drums ?? new Float32Array(0)
          )
        : 1;
      if (shouldSuggestOstCinema(carrierGenre, ratio)) this.mashupStyleProfile = 'ost-cinema';
    }
    // Étape 4/5 — calage phrasé + lancement synchronisé (AUTO VOIX) + enregistrement optionnel.
    this.autoMashupPipelineState = {
      ...this.autoMashupPipelineState,
      stepLabel: 'CALAGE PHRASÉ & LANCEMENT SYNCHRONISÉ',
      stepIndex: 4,
    };
    if (recordWav) this.startMashupRecording();
    // ALC-243-1 : try/finally — le pipeline ne doit JAMAIS rester figé sur ÉTAPE 4/5 (si
    // launchAutoVocalSync rejette une promesse ou n'aboutit pas : accro affiché + remontée erreur).
    let launchError: unknown = null;
    if (mode === 'crossover') {
      // Crossover OST × OST : aucune voix à caler — les deux platines sont déjà synchronisées (étapes 1→3).
      this.autoMashupPipelineState = { ...this.autoMashupPipelineState, running: false };
    } else {
      try {
        await this.launchAutoVocalSync();
      } catch (err) {
        launchError = err;
        console.error('[AutoMashup] échec du lancement (étape 4/5)', err);
      } finally {
        this.autoMashupPipelineState = { ...this.autoMashupPipelineState, running: false };
      }
    }
    if (launchError) {
      const msg = launchError instanceof Error ? launchError.message : 'Échec du lancement automatique';
      this.deckA.lastError = msg;
      this.deckB.lastError = msg;
      this.autoMashupPipelineState = {
        running: false,
        stepLabel: `ÉCHEC LANCEMENT • ${msg}`,
        stepIndex: 0,
        totalSteps: 5,
        readyToSaveDuo: false,
      };
      return;
    }
    // Étape 5/5 — mashup actif, prêt à sauvegarder le duo.
    this.autoMashupPipelineState = {
      running: false,
      stepLabel: 'MASHUP EN COURS • PRÊT À SAUVEGARDER',
      stepIndex: 5,
      totalSteps: 5,
      readyToSaveDuo: true,
    };
  }

  toggleStemMute(id: DeckId, stem: StemName) {
    if (this.arrangementScorePlaying) this.stopArrangementScore(); // ALC-269 : le DJ reprend la main
    const d = this.getDeck(id);
    d.stemMutes[stem] = !d.stemMutes[stem];
    this.applyStemMutes(id);
  }

  /**
   * ALC-188-2 : clic sur un bouton de stem (tiroir latéral) — synchro avec l'état central.
   * Audible (etat effectif) → mute ; inactif/muet/fader à 0 % → lève le mute ET restaure volume 1.0.
   */
  hitStem(id: DeckId, stem: StemName) {
    if (this.arrangementScorePlaying) this.stopArrangementScore(); // ALC-269
    const d = this.getDeck(id);
    const hit = resolveStemHit(d.stemMutes, d.stemGains, stem);
    d.stemMutes[stem] = hit.muted;
    d.stemGains[stem] = hit.volume;
    this.applyStemMutes(id);
  }

  /** ALC-177 : exporte les 4 WAV stems vers un dossier choisi via le sélecteur natif. */
  async exportDeckStems(id: DeckId) {
    const d = this.getDeck(id);
    if (!d.filePath || d.stemsStatus !== 'ready') return;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Choisir le dossier d’export des 4 Stems',
      });
      if (typeof selected !== 'string' || !selected) return; // annulé par l'utilisateur
      const prefix = [d.artist, d.trackTitle].filter((x) => x && x.trim()).join(' - ');
      await audioIpc.exportStemsToFolder(d.filePath, selected, prefix || null);
      d.stemsExported = true;
      window.setTimeout(() => {
        d.stemsExported = false;
      }, 3000);
    } catch (err) {
      d.lastError = err instanceof Error ? err.message : 'Export des stems échoué';
    }
  }

  soloStem(id: DeckId, stem: StemName) {
    if (this.arrangementScorePlaying) this.stopArrangementScore(); // ALC-269
    const d = this.getDeck(id);
    for (const s of STEM_NAMES) d.stemMutes[s] = s !== stem;
    this.applyStemMutes(id);
  }

  setStemPreset(id: DeckId, preset: StemMixPreset) {
    if (this.arrangementScorePlaying) this.stopArrangementScore(); // ALC-269
    const d = this.getDeck(id);
    d.stemMutes = applyStemPreset(d.stemMutes, preset);
    this.applyStemMutes(id);
  }

  /** ALC-187-1 : volume individuel d'un stem (0..1) — source unique `stemGains`, appliqué au Player. */
  setDeckStemVolume(id: DeckId, stem: StemName, value: number) {
    if (this.arrangementScorePlaying) this.stopArrangementScore(); // ALC-269 : le DJ reprend la main
    const d = this.getDeck(id);
    d.stemGains[stem] = clampStemVolume(value);
    this.applyStemMutes(id);
  }

  /** ALC-187-1 : Pont Mashup en un clic — la platine porteuse de la voix passe en ACAPELLA, l'autre en INST. */
  applyCrossDeckMashup(vocalDeck: DeckId) {
    const targets = resolveCrossDeckMashup(vocalDeck);
    this.setStemPreset('A', targets.A);
    this.setStemPreset('B', targets.B);
  }

  /** Crossover OST × OST : routage complémentaire des stems (Rythmique drums+bass+other / Thème other seul)
   * + creux médium −3 dB @ 1500 Hz (Q=1.0) sur le stem `other` de la Platine Rythmique. */
  applyCrossoverMashup(rhythm: 'A' | 'B') {
    const targets = resolveCrossoverStems(rhythm);
    this.setStemPreset('A', targets.A);
    this.setStemPreset('B', targets.B);
    this.getPlayer(rhythm)?.setStemMidNotch('other', 1500, -3);
  }

  /** Medley OST ↔ OST — applique une phase du plan thématique (gains stems + pitch A/B 1.0x + séparation grave/aigu). */
  applyOstMedleyPlan(plan: OstMedleyPlan | null, phaseIndex = 0) {
    if (!plan) return;
    const phase = plan.phases[Math.max(0, Math.min(phaseIndex, plan.phases.length - 1))];
    if (!phase) return;
    // Beatmatch continu : Key Lock 1.0x sur les deux platines + crossfader 50/50.
    this.setDeckPitch('A', 0);
    this.setDeckPitch('B', 0);
    this.crossfader = 50;
    (Object.entries(phase.A) as [StemName, number][]).forEach(([s, g]) => this.setDeckStemVolume('A', s, g));
    (Object.entries(phase.B) as [StemName, number][]).forEach(([s, g]) => this.setDeckStemVolume('B', s, g));
    if (phase.bandSplit) {
      this.getPlayer(phase.bandSplit.grave)?.setStemBandFilter('other', 'lowpass', phase.bandSplit.lowHz);
      this.getPlayer(phase.bandSplit.aigu)?.setStemBandFilter('other', 'highpass', phase.bandSplit.highHz);
    }
  }

  /** Medley OST ↔ OST — calcule le plan (grille 8 mesures, downbeat/200BPM des platines) et applique la phase demandée (0=intro). */
  startOstMedley(phaseIndex = 0, durationSeconds = 192) {
    const mA = this.toStemsMeta('A');
    const mB = this.toStemsMeta('B');
    const plan = computeOstMedleyPlan(
      { bpm: this.effectiveBpmA || 120, drumsRms: mA?.drumsRms },
      { bpm: this.effectiveBpmB || 120, drumsRms: mB?.drumsRms },
      durationSeconds,
      0
    );
    this.applyOstMedleyPlan(plan, phaseIndex);
  }

  // ── ALC-269 : Mode Chef d'Orchestre — exécution temps-réel des partitions ─────

  /** Parse & valide le JSON collé puis renseigne `activeArrangementScore` SANS lancer la lecture. */
  importArrangementScoreText(rawText: string) {
    const r = parseAndValidateArrangementScore(rawText);
    if (!r.ok) {
      this.arrangementError = r.error;
      return;
    }
    if (this.arrangementScorePlaying) this.stopArrangementScore();
    this.activeArrangementScore = r.score;
    this.arrangementError = null;
    this.arrangementCurrentCueLabel = null;
  }

  /** Applique les stems (mutes) d'un état résolu aux deux platines + filtres du repère. */
  private applyArrangementStems(state: ArrangementResolvedState) {
    this.applyDeckArrangementMutes('A', state.stemsA);
    this.applyDeckArrangementMutes('B', state.stemsB);
    const c = state.cue;
    if (c) {
      if (c.filterA) {
        this.getPlayer('A')?.setStemBandFilter('other', c.filterA.type === 'lpf' ? 'lowpass' : 'highpass', c.filterA.freqHz);
      }
      if (c.filterB) {
        this.getPlayer('B')?.setStemBandFilter('other', c.filterB.type === 'lpf' ? 'lowpass' : 'highpass', c.filterB.freqHz);
      }
    }
  }

  private applyDeckArrangementMutes(id: DeckId, stems: ArrangementStemName[]) {
    const d = this.getDeck(id);
    const want: ArrangementStemName[] = ['vocals', 'drums', 'bass', 'other'];
    for (const s of want) d.stemMutes[s] = !stems.includes(s);
    this.applyStemMutes(id); // fondu setTargetAtTime (15 ms) + syncStemMediaState
  }

  /** Arrête l'automatisation de partition SANS couper brusquement l'audio en cours. */
  stopArrangementScore() {
    if (this._arrangementRaf) {
      cancelAnimationFrame(this._arrangementRaf);
      this._arrangementRaf = 0;
    }
    this.arrangementScorePlaying = false;
    this._arrAppliedKey = '';
  }

  /** Efface la partition chargée et son état de lecture (audio non coupé). */
  clearArrangementScore() {
    this.stopArrangementScore();
    this.activeArrangementScore = null;
    this.arrangementCurrentCueLabel = null;
    this.arrangementError = null;
    this._arrDuck.target = null;
  }

  /** Crossfader piloté par le DJ — toute intervention manuelle arrête l'orchestration. */
  setCrossfader(value: number) {
    if (this.arrangementScorePlaying) this.stopArrangementScore();
    this.crossfader = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 50));
  }

  /**
   * Lance l'exécution d'une partition chargée : stems prêts, tempo maître en octave
   * normalisée (effectiveBpmA === effectiveBpmB, preservesPitch), rôles EQ/ducking,
   * positions de départ quantifiées puis démarrage SIMULTANÉ des deux platines dans
   * le geste utilisateur (Promise.all — aucun play()/re-seek différé).
   */
  async launchArrangementScore() {
    const score = this.activeArrangementScore;
    if (!score) {
      this.arrangementError = "Aucune partition chargée — collez d'abord une partition JSON";
      return;
    }
    if (!this.deckA.filePath || !this.deckB.filePath) {
      this.arrangementError = 'Les platines A et B doivent être chargées';
      return;
    }
    this.arrangementError = null;
    this.stopArrangementScore();

    // 1) Extraction / chargement des stems A et B (Promise.all, abandon si erreur).
    const needs = (['A', 'B'] as DeckId[]).filter((id) => this.getDeck(id).stemsStatus !== 'ready');
    try {
      if (needs.length) await Promise.all(needs.map((id) => this.extractDeckStems(id)));
    } catch (err) {
      this.arrangementError = err instanceof Error ? err.message : 'Extraction des stems échouée';
      return;
    }

    // 2) Tempo maître (score.masterBpm ou BPM effectif de A) — octave normalisée.
    const target = Number.isFinite(score.masterBpm) && (score.masterBpm ?? 0) > 0 ? score.masterBpm! : this.effectiveBpmA || 120;
    this._arrMasterBpm = target;
    for (const id of ['A', 'B'] as DeckId[]) {
      const base = this.getDeck(id).baseBpm || target;
      const norm = computeNormalizedTempoRatio(base, target);
      this.setDeckPitch(id, Number(((norm.ratio - 1) * 100).toFixed(2)));
    }

    // 3) Rôles EQ / ducking + HPF (score.eq).
    const eq = score.eq;
    this._arrDuck.target = eq?.duckTarget ?? null;
    this._arrDuck.freqHz = eq?.duckFreqHz ?? 1800;
    this._arrDuck.gainDb = eq?.duckGainDb ?? -4.5;
    this.getPlayer('A')?.setMashupRole(this._arrDuck.target === 'A.other' ? 'ost-instrumental' : 'none');
    this.getPlayer('B')?.setMashupRole(this._arrDuck.target === 'B.other' ? 'ost-instrumental' : 'none');
    if (eq?.hpfHz?.A) this.getPlayer('A')?.setStemBandFilter('drums', 'highpass', eq.hpfHz.A);
    else this.getPlayer('A')?.setStemBandFilter('drums', 'lowpass', 20000);
    if (eq?.hpfHz?.B) this.getPlayer('B')?.setStemBandFilter('drums', 'highpass', eq.hpfHz.B);
    else this.getPlayer('B')?.setStemBandFilter('drums', 'lowpass', 20000);

    // 4) Positions de départ quantifiées sur la grille réelle (drums.wav / firstDownbeat).
    const barDur = 4 * (60 / Math.max(1, target));
    const dA = this.getDeck('A');
    const dB = this.getDeck('B');
    this._arrDownbeatA = dA.firstDownbeatSeconds ?? 0;
    const startA = Math.max(1, score.deckA?.startBar ?? 1);
    const entryBar = Math.max(1, score.deckB?.entryBar ?? 1);
    dA.elapsedSeconds = this._arrDownbeatA + Math.max(0, startA - 1) * barDur;
    dB.elapsedSeconds = (dB.firstDownbeatSeconds ?? 0) + Math.max(0, entryBar - 1) * barDur;

    // 5) Préparation (charge + pitch + seek) puis démarrage SIMULTANÉ dans le geste.
    const [pa, pb] = await Promise.all([this.prepareDeckPlayback('A'), this.prepareDeckPlayback('B')]);

    // 6) État initial de stems / crossfader au premier repère.
    const initState = resolveArrangementStateAtBar(score, startA);
    this._arrAppliedKey = '';
    this.applyArrangementStems(initState);
    this.crossfader =
      initState.cue && initState.cue.crossfader !== undefined
        ? Math.round(initState.cue.crossfader * 100)
        : score.crossfader != null
          ? Math.round(score.crossfader * 100)
          : 50;
    this.arrangementCurrentCueLabel = initState.cue?.label ?? null;

    this.setTransport('A', 'playing');
    this.setTransport('B', 'playing');
    this.arrangementScorePlaying = true;
    await Promise.all([pa.play(), pb.play()]);

    // 7) Boucle rAF 60 fps : convertit la position maîtresse en numéro de mesure et
    //    applique les changements de stems / crossfader / filters aux frontières.
    cancelAnimationFrame(this._arrangementRaf);
    this._arrangementRaf = requestAnimationFrame(() => this.arrangementTick());
  }

  private arrangementTick() {
    if (!this.arrangementScorePlaying || !this.activeArrangementScore) {
      this.stopArrangementScore();
      return;
    }
    const score = this.activeArrangementScore;
    const barDur = 4 * (60 / Math.max(1, this._arrMasterBpm));
    const posA = this.getDeck('A').elapsedSeconds || 0;
    const bar = 1 + Math.floor(Math.max(0, posA - this._arrDownbeatA) / barDur);
    const state = resolveArrangementStateAtBar(score, bar);
    const key = `${state.cue ? state.cue.bar : 0}|${state.stemsA.join(',')}|${state.stemsB.join(',')}|${state.crossfader}`;
    if (key !== this._arrAppliedKey) {
      this._arrAppliedKey = key;
      this.applyArrangementStems(state);
      if (state.cue && state.cue.crossfader !== undefined) {
        this.crossfader = Math.round(state.cue.crossfader * 100);
      }
    }
    this.arrangementCurrentCueLabel = state.cue?.label ?? null;
    this._applyArrangementDuck();

    // Auto-stop quand plus rien ne joue (fin de morceau / intervention transport).
    if (this.deckA.transport !== 'playing' && this.deckB.transport !== 'playing') {
      this.stopArrangementScore();
      return;
    }
    this._arrangementRaf = requestAnimationFrame(() => this.arrangementTick());
  }

  /** Ducking orchestral dynamique du repère (score.eq.duckTarget), asservi à l'enveloppe vocale opposée. */
  private _applyArrangementDuck() {
    const t = this._arrDuck.target;
    if (!t || t === 'none') return;
    const duckDeck: DeckId = t === 'A.other' ? 'A' : 'B';
    const opp: DeckId = duckDeck === 'A' ? 'B' : 'A';
    const deck = this.getDeck(opp);
    const env = this.getPlayer(opp)?.getStemEnvelopes()?.vocals;
    let val = 0;
    if (env && env.length && deck.durationSeconds > 0) {
      const idx = Math.max(
        0,
        Math.min(env.length - 1, Math.round(((deck.elapsedSeconds || 0) / Math.max(0.001, deck.durationSeconds)) * (env.length - 1)))
      );
      val = env[idx] || 0;
    }
    this.getPlayer(duckDeck)?.updateDynamicOrchestralDucking(val, this._arrDuck.gainDb);
  }

  /** ALC-187-2 : RESET 8 PISTES — mixture complète sur les deux platines (délègue à resetDeckStems). */
  resetAllStemMutes() {
    this.resetDeckStems('BOTH');
  }

  /**
   * ALC-214 : remise à zéro des stems sur une platine précise (ou les deux) — mutes à false,
   * gains à 1.0, preset TOUT, synchronisation du moteur audio. N'relance JAMAIS l'extraction ONNX.
   */
  resetDeckStems(deck: 'A' | 'B' | 'BOTH') {
    const ids: DeckId[] = deck === 'BOTH' ? ['A', 'B'] : [deck];
    for (const id of ids) {
      const d = this.getDeck(id);
      d.stemMutes = freshStemMutes();
      d.stemGains = unitStemGains();
      this.applyStemMutes(id);
    }
  }

  /**
   * Interroge le pont IPC Rust (detect_tempo_camelot) pour actualiser en temps réel
   * le BPM effectif et la clé Camelot d'un deck, puis la Roue réagit (ALC-006-3).
   */
  /** Fallback API iTunes Search pour la pochette d'album (ALC-127-3). */
  async fetchCoverFallback(id: DeckId, title: string, artist: string) {
    try {
      const term = encodeURIComponent(`${artist} ${title}`.trim());
      const res = await fetch(`https://itunes.apple.com/search?term=${term}&media=music&limit=1`);
      const json = await res.json();
      const artwork: string | undefined = json?.results?.[0]?.artworkUrl100;
      if (artwork) {
        // Upgrade vers 600×600 (artworkUrl100 → remplacement du suffixe).
        this.getDeck(id).coverUrl = artwork
          .replace('100x100bb', '600x600bb')
          .replace('100x100', '600x600');
      }
    } catch { /* le réseau peut être indisponible — on garde l'absence de pochette */ }
  }

  /**
   * ALC-157 : si les tags lofty locaux sont absents ou réduits au nom de fichier, interroge
   * MusicBrainz (titre, artiste, année, genre, MBID) et ajoute la pochette Cover Art Archive.
   */
  async enrichMetadataFromExternal(id: DeckId, data: TrackData) {
    const deck = this.getDeck(id);
    const hasRealTags = !!(
      data.title &&
      (data.artist || data.genre || data.album) &&
      !/[_\[\(]/.test(data.title));

    if (hasRealTags) {
      // Tags réels : on conserve le fallback pochette iTunes historique (ALC-127-3).
      if (!deck.coverUrl && (data.title || data.artist)) this.fetchCoverFallback(id, data.title, data.artist);
      return;
    }

    const mb = await searchMusicBrainz(data.artist, data.title);
    if (mb) {
      deck.trackTitle = normalizeTitle(mb.title || deck.trackTitle);
      deck.artist = mb.artist || deck.artist;
      deck.genre = mb.genre || deck.genre;
      deck.year = mb.year || '';
      if (!deck.coverUrl) {
        const caa = fetchCoverArtArchive(mb.releaseMbid);
        if (mb.releaseMbid && caa) deck.coverUrl = caa;
        else if (mb.title || mb.artist) this.fetchCoverFallback(id, mb.title, mb.artist);
      }
      // ALC-141 : arbitrage harmonique hybride — croise la clé DSP locale avec AcousticBrainz.
      if (mb.recordingMbid) {
        const ext = await fetchAcousticBrainzKey(mb.recordingMbid);
        if (ext) {
          const res = resolveHybridCamelotKey({ camelotKey: deck.camelotKey, confidence: deck.keyConfidence }, ext);
          deck.camelotKey = res.camelotKey;
          deck.camelotLabel = res.camelotKey;
          deck.keySource = res.source;
          deck.externalKey = res.externalKey;
        }
      }
    } else if (!deck.coverUrl && (data.title || data.artist)) {
      this.fetchCoverFallback(id, data.title, data.artist);
    }
  }

  async refreshTempoCamelot(id: DeckId) {
    const deck = this.getDeck(id);
    deck.lastError = null;
    try {
      const res = await audioIpc.detectTempoCamelot({
        baseBpm: deck.baseBpm,
        pitchPercent: deck.pitchPercent,
        camelotKey: deck.camelotKey,
      });
      deck.baseBpm = res.bpm;
      deck.pitchPercent = res.pitchPercent;
      deck.camelotKey = res.camelotKey;
      deck.camelotLabel = res.camelotLabel;
    } catch (err) {
      deck.lastError = err instanceof Error ? err.message : 'Échec analyse tempo/clé';
    }
  }

  /** Décharge la piste d'un platine (ALC-129 / ALC-183) : arrêt AUDIO réel puis reset complet. */
  eject(id: DeckId) {
    this.oracleApplyState.applied = false; // ALC-221 : eject → conseils réinitialisés
    this.resetVocalRelay(); // ALC-223 : eject → relais vocal désarmé
    const deck = this.getDeck(id);
    // ALC-183 : le bouton EJECT doit COUPER le son et libérer le Player — pas seulement vider
    // l'état du store (sinon les stems/mono continuent de tourner et l'URL blob n'est pas révoquée).
    const p = this.getPlayer(id);
    p?.stop(); // coupe stems + mono, invalide toute lecture en vol (génération + verrou).
    p?.disposeStems(); // libère GainNode / EQ / buffers stems.
    p?.setStemMode(false); // retour propre au mono pur (unmute + reconnexion srcNode).
    p?.clearSource(); // révoque l'URL blob + vide src mono.
    deck.transport = 'stopped';
    deck.filePath = null;
    deck.trackTitle = '';
    deck.artist = '';
    deck.album = '';
    deck.genre = '';
    deck.year = '';
    deck.coverUrl = '';
    deck.lowEqDb = 0;
    deck.highEqDb = 0;
    deck.waveformPeaks = [];
    deck.keyTimeline = [];
    deck.segments = [];
    // ALC-146 : ne vide que le platine éjecté (l'autre conserve sa segmentation analytique).
    if (id === 'A') this.deckSegmentsA = [];
    else this.deckSegmentsB = [];
    deck.coverAlt = 'Vide — aucune piste chargée';
    deck.baseBpm = 0;
    deck.pitchPercent = 0;
    deck.elapsedSeconds = 0;
    deck.durationSeconds = 0;
    deck.codec = '—';
    deck.lastError = null;
    // ALC-183 : reset STEMS complet (pas seulement filePath) — jamais de « stems prêts » orphelins.
    deck.stems = null;
    deck.stemsStatus = 'idle';
    deck.stemsProgress = 0;
    deck.stemsCalibrated = false; // ALC-242 : télémétrie HTDemucs réinitialisée (nouvelle piste)
    deck.stemsMeta = null;
    deck.firstDownbeatSeconds = null; // ALC-253-1
    deck.isExtractingStems = false;
    deck.stemsExported = false;
    deck.stemGains = { vocals: 1, drums: 1, bass: 1, other: 1 };
    deck.stemMutes = { vocals: false, drums: false, bass: false, other: false };
    // ALC-183 : métriques de télémétrie remises à leur place « vide ».
    deck.sampleRate = '—';
    deck.bitrate = '—';
    deck.stereoMode = '—';
    deck.freqResponse = '—';
    deck.peakVuDb = '—';
  }

  /** Déclenche l'analyse temps réel sur les deux decks (utilisé lors du chargement/analyse). */
  async analyzeAllTempoCamelot() {
    await Promise.all([
      this.refreshTempoCamelot('A'),
      this.refreshTempoCamelot('B'),
    ]);
  }

  // ALC-132-3 : horloge de lecture — avance elapsedSeconds (MM:SS) pour les decks en lecture.
  private _clockId: number | undefined;
  startClock() {
    if (this._clockId !== undefined) return;
    this._clockId = window.setInterval(() => this.advanceClock(), 250);
  }
  private advanceClock() {
    const dt = 0.25;
    [this.deckA, this.deckB].forEach((deck) => {
      if (deck.transport === 'playing' && deck.durationSeconds > 0) {
        deck.elapsedSeconds = Math.min(deck.durationSeconds, deck.elapsedSeconds + dt);
      }
    });
  }
}

export const mixerStore = new AlchemixMixerStore();
