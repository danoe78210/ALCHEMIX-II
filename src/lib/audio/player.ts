// ALC-136 : lecteur audio WebAudio réel par platine.
// Chaîne complète : MediaElementAudioSourceNode → BiquadFilterNode (lowshelf 120 Hz)
//                   → GainNode (volume × crossfader égal-puissance) → AnalyserNode → ctx.destination.
// Source chargée en URL blob: (aucun blocage CORS WebView2 asset://), révoquée à EJECT/rechargement.
// ALC-174-2 : couche STEMS additive (4 AudioBufferSourceNode synchronisés au même échantillon,
// chacun via son GainNode dédié, branchés dans la chaîne EQ partagée — Mute/Solo à latence zéro).

import { audioIpc } from '$lib/ipc/client';
import { normalizePlaybackRate } from '$lib/utils/tempo'; // ALC-212 : garde-fou octave playbackRate
import { fxEchoDelayClipped, fxComplementaryBalance, type FxRackState } from '$lib/audio/fxRack'; // ALC-213/218 : Rack FX
import { cleanVocalsSamples } from '$lib/utils/vocalClean'; // ALC-218 : propreté stem vocals
import { keyLockCompensationCents } from '$lib/audio/stemMix'; // ALC-235 : Key Lock des stems

export function mimeFromPath(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    aiff: 'audio/aiff',
    aif: 'audio/aiff',
    wma: 'audio/x-ms-wma',
  };
  return map[ext] || 'audio/mpeg';
}

export const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'] as const;
export type StemName = (typeof STEM_NAMES)[number];

/** ALC-231 : rôle mashup WebAudio du canal — pilote le Dynamic Orchestral Ducking (peaking 1.8 kHz). */
export type MashupRole = 'none' | 'instrumental' | 'vocal' | 'ost-instrumental';

export class Player {
  readonly ctx: AudioContext;
  /** ALC-182-3 : identifiant de platine ('A'|'B'), champ explicite (constructeur node-testable). */
  readonly id: string;
  private audio: HTMLAudioElement;
  private srcNode: MediaElementAudioSourceNode;
  private lowFilter: BiquadFilterNode;
  private midFilter: BiquadFilterNode; // ALC-143 : bande médium (Smart Filter)
  private highFilter: BiquadFilterNode;
  private outGain: GainNode;
  private analyser: AnalyserNode;
  private buf: Uint8Array<ArrayBuffer>;
  private url: string | null = null;
  sourcePath: string | null = null;

  // ALC-174-2 : couche STEMS (additive, ne remplace jamais la source single-buffer ci-dessus).
  private stemBuffers: Partial<Record<StemName, AudioBuffer>> = {};
  private stemGains: Partial<Record<StemName, GainNode>> = {};
  /** ALC-249-1 : dernière GAIN CIBLE désirée par stem — source de vérité du mute média (un
   * `AudioParam.value` reste STALE après `setTargetAtTime`, on ne peut pas s'en servir pour
   * décider `el.muted` ; ici la cible reflète exactement `applyStemMutes` / fader / presets). */
  private stemDesiredGains: Record<StemName, number> = { vocals: 1, drums: 1, bass: 1, other: 1 };
  /** ALC-190-1 : enveloppe d'amplitude 512 bins (normalisée 0..1) par stem, pour le Beatgrid. */
  private stemEnvelopes: Partial<Record<StemName, Float32Array>> = {};
  /** ALC-182-2 : EQ doux du canal vocals (highpass 85 Hz + adoucissement > ~11 kHz). */
  private stemEq: Partial<Record<StemName, { hp?: BiquadFilterNode; lp?: BiquadFilterNode; pk?: BiquadFilterNode }>> = {};
  private stemNodes: AudioBufferSourceNode[] = [];
  /** ALC-246-1 : moteur 4 <audio> par stem — Key Lock NATIF (`preservesPitch`), la hauteur et le
   * timbre restent 100 % d'origine même quand `playbackRate ≠ 1` (jusqu'à ±10 % de tempo). */
  private stemEls: Partial<Record<StemName, HTMLAudioElement>> = {};
  private stemElSrcs: Partial<Record<StemName, MediaElementAudioSourceNode>> = {};
  private stemElUrls: Partial<Record<StemName, string>> = {};
  private stemMediaActive = false;
  /** ALC-252-1 : moteur stems EXCLUSIF AudioBufferSourceNode (échantillon-précis) — plus aucune
   * balise <audio>/createMediaElementSource : WebView2 bloque silencieusement plusieurs des 8
   * éléments simultanés (stems muets malgré el.play()). */
  /** Vrai si la couche stems est en cours de lecture (démarrée au même échantillon). */
  private stemPlaying = false;
  /**
   * ALC-183 : génération de lecture. Toute play()/playStems() relative à une génération annulée
   * (stop/pause survenus PENDANT le démarrage asynchrone) est avortée AVANT de lancer le moindre
   * node audio → une continuation $effect périmée ne peut plus relancer <audio>.play() (mono) ni
   * playStems() alors que le transport est au repos (régression ALC-182 « le mono revient »).
   */
  private _playGen = 0;
  /** ALC-175 : vrai dès que ≥1 stem est chargé → lecture exclusive stems (mono coupé). */
  private stemsReady = false;
  /** ALC-176 : VERROU DUR du mode stems — tant qu'il est actif, le <audio> mono ne peut
   *  JAMAIS produire de son : muted+paume+déconnecté, et play() n'atteint plus jamais audio.play(). */
  stemModeActive = false;
  /** ALC-175 : vrai quand srcNode (buffer mono) est déconnecté. */
  private monoDisconnected = false;
  /** Horloge synthétique en mode stems : origine ctx + offset de départ (le mono est en pause). */
  private stemStartCtx = 0;
  private stemStartOffset = 0;
  /** ALC-193-2 : position stems enregistrée à la pause (reprise synchronisée). */
  private stemOffsetSeconds = 0;
  /** ALC-231 : rôle mashup du canal (ducking orchestral dynamique). */
  private mashupRole: MashupRole = 'none';
  /** ALC-235 : Key Lock des stems — compensation de hauteur (detune) quand playbackRate ≠ 1. */
  keyLock = true;
  /** ALC-231 : filtre `peaking` 1 800 Hz inséré entre highFilter et outGain (rôle 'ost-instrumental'). */
  private ostDuckFilter: BiquadFilterNode | null = null;
  private ostDuckInChain = false;
  private tick: number | null = null;

  /** Callbacks pour synchroniser la position (ROLL) et la durée depuis l'élément <audio>. */
  onTime: ((current: number) => void) | null = null;
  onDuration: ((duration: number) => void) | null = null;
  private _loop: [number, number] | null = null; // ALC-142 auto-loop quantifié [IN, OUT]

  /** ALC-142 : position de lecture courante (s) ; synthétique en mode stems (mono en pause). */
  get position(): number {
    // ALC-246-1 : en mode <audio> par stem, la position est celle de l'élément maître (temps fichier réel).
    if (this.stemMediaActive) {
      const m = this.stemMasterElement();
      if (m) return m.currentTime || 0;
    }
    if (this.stemPlaying) return this.stemStartOffset + Math.max(0, this.ctx.currentTime - this.stemStartCtx);
    return this.audio.currentTime || 0;
  }
  get duration(): number { return this.audio.duration || 0; }
  get loop(): [number, number] | null { return this._loop; }

  /** ALC-142 : boucle quantifiée sur la grille (T_beat = 60 / BPM effectif). */
  setQuantizedLoop(beats: number, bpmEffective: number) {
    const beatSec = 60 / (bpmEffective || 120);
    const t = this.audio.currentTime || 0;
    const inS = Math.floor(t / beatSec) * beatSec;
    this._loop = [inS, inS + beats * beatSec];
  }
  clearLoop() { this._loop = null; }

  // ALC-213 : sous-graphe Rack FX (canal maître) + enregistreur — inséré entre outGain et analyser.
  private fxIn!: GainNode;
  private fxReturn!: GainNode;
  private dryGain!: GainNode;
  private wetGain!: GainNode;
  private fxFilter!: BiquadFilterNode;
  private fxShaper!: WaveShaperNode;
  private flangerDelay?: DelayNode;
  private flangerLfo?: OscillatorNode;
  private flangerLfoGain?: GainNode;
  private fxDelay?: DelayNode;
  private fxDelayFeedback?: GainNode;
  private fxEchoDampen?: BiquadFilterNode;
  private fxReverb?: ConvolverNode;
  private fxReverbSend?: GainNode;
  private fxReverbGain?: GainNode;
  private recDest?: MediaStreamAudioDestinationNode;
  private rec?: MediaRecorder;
  private recChunks: Blob[] = [];
  private recUrl: string | null = null;
  private _fxBuilt = false;
  // ALC-226 : capture PCM WAV du Master post-crossfader (stéréo) pour l'enregistrement mashup.
  private wavChunks: Float32Array[] = [];
  private wavSampleRate = 48000;
  private wavProc: ScriptProcessorNode | null = null;

  constructor(id: string) {
    this.id = id;
    // ALC-212 : sampleRate forcé à 48 kHz — les stems décodés (decodeAudioData) sont ré-échantillonnés
    // vers ctx.sampleRate automatiquement, sans aucune division de vitesse.
    this.ctx = new AudioContext({ sampleRate: 48000 });
    this.audio = document.createElement('audio');
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'auto';
    // ALC-136/ALC-212 : la clé Camelot reste juste quand le playbackRate change (+ variantes navigateur).
    this.audio.preservesPitch = true;
    (this.audio as any).webkitPreservesPitch = true;
    (this.audio as any).mozPreservesPitch = true;
    // ALC-252-1 : moteur <audio>/createMediaElementSource ABANDONNÉ — WebView2 bloque silencieusement
    // plusieurs des 8 éléments <audio> simultanés (drums/bass/other de A et voix de B restent MUETS
    // malgré el.play()). Retour EXCLUSIF au moteur AudioBufferSourceNode échantillon-précis (100 %
    // d'audibilité dès ctx.resume(), synchro parfaite des 4 stems au même lâcher d'échantillon).

    this.lowFilter = this.ctx.createBiquadFilter();
    this.lowFilter.type = 'lowshelf';
    this.lowFilter.frequency.value = 120;
    this.lowFilter.gain.value = 0;

    // ALC-137-4 : égaliseur aigu (highshelf 3.2 kHz).
    this.highFilter = this.ctx.createBiquadFilter();
    this.highFilter.type = 'highshelf';
    this.highFilter.frequency.value = 3200;
    this.highFilter.gain.value = 0;

    // ALC-143 : bande médium (peaking ~900 Hz) — cible des atténuations du Smart Filter.
    this.midFilter = this.ctx.createBiquadFilter();
    this.midFilter.type = 'peaking';
    this.midFilter.frequency.value = 900;
    this.midFilter.Q.value = 0.7;
    this.midFilter.gain.value = 0;

    this.outGain = this.ctx.createGain();
    this.outGain.gain.value = 1;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));

    // Routage complet (ALC-136-1) : source → lowshelf → gain → analyser → destination.
    this.srcNode = this.ctx.createMediaElementSource(this.audio);
    this.srcNode.connect(this.lowFilter);
    this.lowFilter.connect(this.midFilter);
    this.midFilter.connect(this.highFilter);
    this.highFilter.connect(this.outGain);
    // Rack FX construit paresseusement (ensureFxGraph) pour ne pas créer de nœuds WebAudio au constructeur
    // (les tests unitaires mockent AudioContext sans createWaveShaper/createConvolver). Lecture standard intacte.
    this.outGain.connect(this.analyser);

    this.analyser.connect(this.ctx.destination);

    this.audio.addEventListener('timeupdate', () => {
      // ALC-142 : reboucle IN → OUT quand un auto-loop est actif.
      if (this._loop && this.audio.currentTime >= this._loop[1] - 0.02) {
        this.audio.currentTime = this._loop[0];
      }
      this.onTime?.(this.audio.currentTime ?? 0);
    });
    this.audio.addEventListener('loadedmetadata', () => this.onDuration?.(this.audio.duration ?? 0));
  }

  /** ALC-136-1 : réveil explicite de l'AudioContext (geste utilisateur = clic PLAY). */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* ignoré */ }
    }
  }

  /** ALC-136-2 : charge les octets en URL blob: et assigne la source à l'élément <audio>. */
  setSource(bytes: ArrayBuffer | number[], mime: string, filePath: string) {
    const buf: ArrayBuffer = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer as ArrayBuffer;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(new Blob([buf], { type: mime }));
    this.audio.src = this.url;
    this.sourcePath = filePath;
  }

  /** ALC-137-4 : égaliseur aigu (highshelf 3.2 kHz). */
  setHighShelf(dB: number) {
    this.highFilter.gain.setTargetAtTime(dB, this.ctx.currentTime, 0.08);
  }

  /** ALC-136 : filtre grave en temps réel (basses atténuées). */
  setLowShelf(dB: number) {
    this.lowFilter.gain.setTargetAtTime(dB, this.ctx.currentTime, 0.08);
  }

  /** ALC-143 : bande médium (peaking ~900 Hz) en temps réel — Smart Filter. */
  setMidBand(dB: number) {
    this.midFilter.gain.setTargetAtTime(dB, this.ctx.currentTime, 0.08);
  }

  /** ALC-231 : rôle mashup WebAudio courant du canal. */
  getMashupRole(): MashupRole {
    return this.mashupRole;
  }

  /** ALC-235 : état du Key Lock (compensation de hauteur sur les stems). */
  getKeyLock(): boolean {
    return this.keyLock;
  }

  /** ALC-235 : active/désactive le Key Lock (télémétrie + évolution live). */
  setKeyLock(on: boolean): void {
    this.keyLock = on;
  }

  /**
   * ALC-231 : affecte le rôle mashup du canal. En `'ost-instrumental'`, insère (une seule fois)
   * un filtre `peaking` à 1 800 Hz (Q = 1.0, gain 0 dB) entre `highFilter` et `outGain` — la cible
   * du Dynamic Orchestral Ducking (cordes/cuivres de l'OST). Tout autre rôle retire le filtre et
   * ramène immédiatement le gain à 0 dB (aucun creux résiduel).
   */
  setMashupRole(role: MashupRole) {
    this.mashupRole = role;
    if (role === 'ost-instrumental') {
      this.ensureOstDuckFilter();
      return;
    }
    this.removeOstDuckFilter();
  }

  /** Crée/câble le filtre peaking 1.8 kHz dans la chaîne partagée (idempotent). */
  private ensureOstDuckFilter() {
    if (this.ostDuckInChain) return;
    if (!this.ostDuckFilter) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = 1800;
      f.Q.value = 1.0;
      f.gain.value = 0;
      this.ostDuckFilter = f;
    }
    this.highFilter.disconnect(this.outGain);
    this.highFilter.connect(this.ostDuckFilter);
    this.ostDuckFilter.connect(this.outGain);
    this.ostDuckInChain = true;
    const t = this.ctx.currentTime;
    this.ostDuckFilter.gain.cancelScheduledValues(t);
    this.ostDuckFilter.gain.setTargetAtTime(0, t, 0.06);
  }

  /** Dé-câble proprement le filtre peaking (rôle != 'ost-instrumental'). */
  private removeOstDuckFilter() {
    if (!this.ostDuckInChain || !this.ostDuckFilter) return;
    try {
      this.ostDuckFilter.disconnect();
    } catch {
      /* déjà déconnecté */
    }
    this.ostDuckInChain = false;
    this.highFilter.connect(this.outGain);
    const t = this.ctx.currentTime;
    this.ostDuckFilter.gain.cancelScheduledValues(t);
    this.ostDuckFilter.gain.setValueAtTime(0, t);
  }

  /**
   * ALC-231 : Dynamic Orchestral Ducking — module en douceur le gain du creux à 1 800 Hz jusqu'à
   * **−4.5 dB** proportionnellement à l'amplitude instantanée (0..1) du stem vocal OPPOSÉ. Clause 9 :
   * **attaque rapide 15 ms** / **relâchement 90 ms** pour la respiration Call-and-Response (les
   * cordes/chœurs gonflent entre les vers). En rôle ≠ 'ost-instrumental', remet le gain à 0 dB.
   */
  updateDynamicOrchestralDucking(vocalEnvelopeValue: number, maxDuckDb = -4.5) {
    const f = this.ostDuckFilter;
    if (this.mashupRole !== 'ost-instrumental' || !f || !this.ostDuckInChain) {
      if (f && this.ostDuckInChain) {
        const t = this.ctx.currentTime;
        f.gain.cancelScheduledValues(t);
        f.gain.setTargetAtTime(0, t, 0.09); // relâchement 90 ms (clause 9)
      }
      return;
    }
    const v = Math.max(0, Math.min(1, Number.isFinite(vocalEnvelopeValue) ? vocalEnvelopeValue : 0));
    // ALC-235 : creux borné à [−6.5, 0] dB — amplifié à −6.5 dB (anti-collision dialogues)
    // quand l'OST présente un risque de dialogue résiduel, sinon −4.5 dB nominal.
    const depth = Math.min(0, Math.max(-6.5, Number.isFinite(maxDuckDb) ? maxDuckDb : -4.5));
    const targetDb = depth * v;
    const t = this.ctx.currentTime;
    f.gain.cancelScheduledValues(t);
    f.gain.setTargetAtTime(targetDb, t, 0.015); // attaque 15 ms (clause 9)
  }

  /** ALC-105/136/138 : gain maître = volume canal × crossfader égal-puissance. Application immédiate. */
  setOutputGain(g: number) {
    const target = Math.max(0, g); // 0 strict quand volume ou crossfader coupe le canal
    const t = this.ctx.currentTime;
    this.outGain.gain.cancelScheduledValues(t);
    this.outGain.gain.setValueAtTime(target, t);
  }

  /** ALC-136/ALC-212 : pitch/tonalité — playbackRate = 1 + pitchPercent/100, conserve la hauteur, garde-fou octave. */
  setPlaybackRate(pitchPercent: number) {
    const raw = 1 + pitchPercent / 100;
    // ALC-212 : garde-fou dur — un ratio ~0.5 (~0.52 de Julia) ou ~2.0 est normalisé ×2 / ÷2 puis borné à [0.75;1.35],
    // de sorte qu'un calage d'octave fautif ne peut JAMAIS ralentir/dénaturer la voix.
    const rate = normalizePlaybackRate(raw);
    const t = this.ctx.currentTime;
    this.audio.playbackRate = rate;
    // La hauteur tonale reste juste (ré-affirmée — certains navigateurs la réinitialisent).
    this.audio.preservesPitch = true;
    (this.audio as any).webkitPreservesPitch = true;
    (this.audio as any).mozPreservesPitch = true;
    // ALC-176 : en mode stems, pilote EXCLUSIVEMENT les 4 AudioBufferSourceNode.
    // ALC-235 : Key Lock — compensation de hauteur (detune) pour préserver la clé d'origine
    // quand le playbackRate ≠ 1 (ex. Club / fader CADENCE), sans effet « hélium ».
    const cents = this.keyLock ? keyLockCompensationCents(rate) : 0;
    for (const s of this.stemNodes) {
      s.playbackRate.setValueAtTime(rate, t);
      if (s.detune) s.detune.setValueAtTime(cents, t); // ALC-235 : Key Lock (défensif)
    }
    // ALC-246-1 : les <audio> par stem appliquent le même rate — hauteur NATIVELLEMENT préservée.
    for (const name of STEM_NAMES) {
      const el = this.stemEls[name];
      if (!el) continue;
      el.playbackRate = rate;
      el.preservesPitch = true;
      (el as any).webkitPreservesPitch = true;
      (el as any).mozPreservesPitch = true;
    }
  }

  /** ALC-213 : construit une seule fois le sous-graphe Rack FX (dry/wet) inséré entre outGain et analyser. */
  private ensureFxGraph(): void {
    if (this._fxBuilt) return;
    this._fxBuilt = true;
    this.dryGain = this.ctx.createGain();
    this.wetGain = this.ctx.createGain();
    this.wetGain.gain.value = 0;
    this.fxIn = this.ctx.createGain();
    this.fxReturn = this.ctx.createGain();
    this.fxFilter = this.ctx.createBiquadFilter();
    this.fxFilter.type = 'lowpass';
    this.fxFilter.frequency.value = 20000;
    this.fxFilter.Q.value = 0.707;
    this.fxShaper = this.ctx.createWaveShaper();
    this.fxShaper.curve = this.warmCurve(0);
    this.fxShaper.oversample = '2x';
    this.flangerDelay = this.ctx.createDelay(0.05);
    this.flangerDelay.delayTime.value = 0.002;
    this.flangerLfo = this.ctx.createOscillator();
    this.flangerLfo.frequency.value = 0.35;
    this.flangerLfoGain = this.ctx.createGain();
    this.flangerLfoGain.gain.value = 0;
    this.flangerLfo.connect(this.flangerLfoGain);
    this.flangerLfoGain.connect(this.flangerDelay.delayTime);
    this.flangerLfo.start();
    this.fxDelay = this.ctx.createDelay(4);
    this.fxDelay.delayTime.value = 0.25;
    this.fxDelayFeedback = this.ctx.createGain();
    this.fxDelayFeedback.gain.value = 0;
    this.fxEchoDampen = this.ctx.createBiquadFilter();
    this.fxEchoDampen.type = 'lowpass';
    this.fxEchoDampen.frequency.value = 4000;
    this.fxReverb = this.ctx.createConvolver();
    this.fxReverb.buffer = this.syntheticStereoReverb(2.2, this.ctx.sampleRate);
    this.fxReverbSend = this.ctx.createGain();
    this.fxReverbSend.gain.value = 0;
    this.fxReverbGain = this.ctx.createGain();
    this.fxReverbGain.gain.value = 0.8; // ALC-217 : réverb bien présente une fois dosée
    // Chaîne wet NETTOYÉE (ALC-217) : fxIn → filtre → shaper → flanger → délai écho (dampené),
    // puis une unique sortie écho → fxReturn, avec une boucle de feedback et un SEND parallèle vers la réverb.
    // On évite les chemins multiples (echoWet/delayToReturn supprimés) qui atténuaient l'effet audible.
    this.fxIn.connect(this.fxFilter);
    this.fxFilter.connect(this.fxShaper);
    this.fxShaper.connect(this.flangerDelay);
    this.flangerDelay.connect(this.fxDelay);
    this.fxDelay.connect(this.fxEchoDampen);
    this.fxEchoDampen.connect(this.fxReturn); // écho (dampené) → retour wet
    this.fxDelay.connect(this.fxDelayFeedback);
    this.fxDelayFeedback.connect(this.fxEchoDampen); // boucle de feedback (à travers dampen)
    this.fxEchoDampen.connect(this.fxReverbSend); // send parallèle → réverb
    this.fxReverbSend.connect(this.fxReverb);
    this.fxReverb.connect(this.fxReverbGain);
    this.fxReverbGain.connect(this.fxReturn); // réverb → retour wet
    // Re-routage dry/wet : outGain → dryGain → analyser ; outGain → fxIn → … → fxReturn → wetGain → analyser
    this.outGain.disconnect(this.analyser);
    this.outGain.connect(this.dryGain);
    this.dryGain.connect(this.analyser);
    this.outGain.connect(this.fxIn);
    this.fxReturn.connect(this.wetGain);
    this.wetGain.connect(this.analyser);
  }

  /** ALC-213 : applique l'état du Rack FX (params DSP + dry/wet) sur ce canal — délai synchronisé au BPM. */
  applyFxRack(fx: FxRackState, bpm: number): void {
    this.ensureFxGraph();
    const t = this.ctx.currentTime;
    const s1 = fx.slot1, s2 = fx.slot2, s3 = fx.slot3;
    const any = s1.active || s2.active || s3.active;
    if (!any) {
      this.wetGain.gain.setTargetAtTime(0, t, 0.03);
      this.dryGain.gain.setTargetAtTime(1, t, 0.03);
      return;
    }
    // Slot 01 — Filtre résonant
    this.fxFilter.type = (s1.active ? s1.mode : 'LPF').toLowerCase() as BiquadFilterType;
    this.fxFilter.frequency.setTargetAtTime(s1.active ? Math.min(16000, Math.max(40, s1.cutoff)) : 20000, t, 0.02);
    this.fxFilter.Q.setTargetAtTime(s1.active ? Math.min(12, Math.max(0.2, s1.resonance)) : 0.707, t, 0.02);
    // Slot 02 — Saturation (tanh lampe chaude) / Flanger (LFO sur ligne de délai courte)
    const drive = s2.active && s2.mode === 'LAMPE CHAUDE' ? s2.drive : 0;
    this.fxShaper.curve = this.warmCurve(drive);
    const flangOn = s2.active && s2.mode === 'FLANGER';
    this.flangerLfoGain?.gain.setTargetAtTime(flangOn ? 0.0014 * Math.min(1, Math.max(0, s2.modulate)) : 0, t, 0.02);
    // Slot 03 — Écho Bande Sync BPM + Réverbération + FIN D'ÉCHO (tailHold)
    // ALC-218 : plancher 110 ms (anti-slapback) — jamais de délai court qui « double » la voix.
    this.fxDelay?.delayTime.setTargetAtTime(fxEchoDelayClipped(s3.division, bpm, s3.active), t, 0.02);
    if (s3.active) {
      const fb = s3.tailHold ? Math.min(0.9, Math.max(0, s3.feedback)) : s3.feedback * 0.35;
      this.fxDelayFeedback?.gain.setTargetAtTime(fb, t, 0.02);
      this.fxReverbSend?.gain.setTargetAtTime(Math.min(1, Math.max(0, s3.reverbMix)), t, 0.02);
    } else {
      this.fxDelayFeedback?.gain.setTargetAtTime(0, t, 0.02);
      this.fxReverbSend?.gain.setTargetAtTime(0, t, 0.02);
    }
    this.fxEchoDampen?.frequency.setTargetAtTime(Math.min(12000, Math.max(200, s3.dampen)), t, 0.02);
    // Mélange dry/wet COMPLÉMENTAIRE STRICT (ALC-218) : dryGain = 1 - mix, wetGain = mix.
    // dry + wet === 1 → plus aucune somme parallèle non atténuée (suppression du dédoublement vocal).
    const mix = Math.max(s1.active ? s1.dryWet : 0, s2.active ? s2.dryWet : 0, s3.active ? s3.dryWet : 0);
    const { wet, dry } = fxComplementaryBalance(any ? mix : 0);
    this.wetGain.gain.setTargetAtTime(wet, t, 0.03);
    this.dryGain.gain.setTargetAtTime(dry, t, 0.03);
  }

  /** Courbe de saturation « lampe chaude » (tanh) — identité si drive ≈ 0. */
  private warmCurve(drive: number): Float32Array<ArrayBuffer> {
    if (drive <= 0.001) {
      const id = new Float32Array(new ArrayBuffer(8));
      id[0] = -1;
      id[1] = 1;
      return id;
    }
    const n = 1024;
    const curve = new Float32Array(new ArrayBuffer(n * 4));
    const k = 1 + 4 * Math.min(1, Math.max(0, drive));
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const v = (i / (n - 1)) * 2 - 1;
      curve[i] = v === 0 ? 0 : Math.tanh(k * v) / norm;
    }
    return curve;
  }

  /** Réverbération stéréo synthétique : impulsion de bruit à décroissance exponentielle. */
  private syntheticStereoReverb(seconds: number, sampleRate: number): AudioBuffer {
    const len = Math.max(1, Math.floor(sampleRate * seconds));
    const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const n = Math.random() * 2 - 1;
        const decay = Math.exp((-3.2 * i) / len);
        last = (last + decay * n) * 0.5;
        data[i] = ch === 1 ? last : last * 0.9;
      }
    }
    return buf;
  }

  /** ALC-213 : démarre l'enregistrement du flux traité (post-Rack FX) vers un blob audio exportable. */
  startFxRecording(): void {
    if (this.rec || this.recDest) this.stopFxRecording();
    this.recDest = this.ctx.createMediaStreamDestination();
    this.analyser.connect(this.recDest);
    this.recChunks = [];
    this.rec = new MediaRecorder(this.recDest.stream);
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.recChunks.push(e.data);
    };
    this.rec.onstop = () => {
      if (this.recUrl) URL.revokeObjectURL(this.recUrl);
      this.recUrl = URL.createObjectURL(new Blob(this.recChunks, { type: 'audio/webm' }));
    };
    this.rec.start();
  }

  /** ALC-213 : arrête l'enregistrement et renvoie le blob URL (null si aucun enregistrement). */
  stopFxRecording(): string | null {
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    this.recDest?.disconnect();
    this.recDest = undefined;
    this.rec = undefined;
    return this.recUrl;
  }

  /** ALC-213 : dernière URL d'enregistrement FX (null si aucune). */
  getLastFxRecordingUrl(): string | null {
    return this.recUrl;
  }

  /** ALC-226 : démarre la capture PCM stéréo du flux Master post-crossfader (pour un WAV 16-bit). */
  startWavCapture(): void {
    this.stopWavCapture();
    this.wavChunks = [];
    this.wavSampleRate = this.ctx.sampleRate;
    const proc = this.ctx.createScriptProcessor(1024, 2, 2);
    proc.onaudioprocess = (e: AudioProcessingEvent) => {
      this.wavChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      this.wavChunks.push(new Float32Array(e.inputBuffer.getChannelData(1)));
    };
    // Branche la capture sur le bus Master (post crossfader/<outGain>, avant sortie).
    this.analyser.connect(proc);
    proc.connect(this.ctx.destination);
    this.wavProc = proc;
  }

  /** ALC-226 : arrête la capture et renvoie l'échantillon interleaved stéréo (sinon null). */
  stopWavCapture(): { samples: Float32Array; sampleRate: number } | null {
    if (!this.wavProc) return null;
    try {
      this.wavProc.disconnect();
    } catch {
      /* déjà déconnecté */
    }
    this.wavProc = null;
    if (!this.wavChunks.length) return null;
    const n = this.wavChunks.length / 2;
    const len = this.wavChunks[0].length;
    const samples = new Float32Array(n * len * 2);
    for (let i = 0; i < n; i++) {
      const l = this.wavChunks[i * 2];
      const r = this.wavChunks[i * 2 + 1];
      for (let j = 0; j < len; j++) {
        samples[(i * len + j) * 2] = l[j];
        samples[(i * len + j) * 2 + 1] = r[j];
      }
    }
    this.wavChunks = [];
    return { samples, sampleRate: this.wavSampleRate };
  }

  /** REW / FFWD / reprise : déplace la position de lecture (restart stems si en cours). */
  seek(seconds: number) {
    const d = this.audio.duration || 0;
    const t = Math.max(0, Math.min(d, seconds));
    this.audio.currentTime = t;
    // ALC-246-1 : en mode <audio> par stem, repositionne chaque élément en continu (pas de re-seek haché).
    if (this.stemMediaActive) {
      for (const name of STEM_NAMES) {
        const el = this.stemEls[name];
        if (!el) continue;
        try {
          el.currentTime = t;
        } catch { /* ignore */ }
      }
      // ALC-249-1 : tout seek re-synchronise l'état média — un stem audible ne reste jamais muet.
      for (const name of STEM_NAMES) this.syncStemMediaState(name);
      this.stemStartOffset = t;
      return;
    }
    if (this.stemPlaying) {
      this.pauseStems();
      void this.playStems(t);
    }
  }

  async play(): Promise<void> {
    // ALC-183 : capture la génération de lecture. Si `stop()` / `pause()` survient pendant le
    // démarrage asynchrone (continuation $effect périmée), on ne lance AUCUNE source audio.
    const gen = this._playGen;
    await this.resume();
    if (gen !== this._playGen) return;
    console.log(
      `[STEMS-DEBUG] PLAY deck=${this.id} stemModeActive=${this.stemModeActive} stemsReady=${this.stemsReady} monoDisconnected=${this.monoDisconnected}`
    );
    if (gen !== this._playGen) return;
    if (this.stemModeActive) {
      // ALC-243-1 : zéro échec silencieux — si le verrou stems est actif sans aucun buffer décodé,
      // on lève une erreur explicite (remontée dans deck.lastError / bandeau) au lieu d'un silence.
      if (!this.stemsReady) {
        throw new Error(`[Stems] mode stems actif mais aucun stem décodé (deck ${this.id}) — lecture impossible`);
      }
      await this.playStems(this.audio.currentTime || 0);
      return;
    }
    if (this.stemsReady && !this.stemModeActive) {
      // Marge de sécurité : buffers stems chargés sans verrou → on les joue quand même.
      await this.playStems(this.audio.currentTime || 0);
      return;
    }
    // Mono : ne peut être déclenché que si le verrou stems est levé ET aucune génération annulée.
    if (gen !== this._playGen) return;
    try {
      await this.audio.play();
    } catch (err) {
      // ALC-136-3 : aucune erreur audio silencieuse.
      console.error('[Player] audio.play a échoué', err);
      throw err;
    }
  }

  pause() {
    this._playGen++; // ALC-183 : invalide toute play()/playStems() en vol.
    // ALC-193-2 : mémorise la position stems courante AVANT la coupe, puis coupe MATÉRIELLEMENT :
    // arrêt/déconnexion des stemNodes + pause du mono + AudioContext.suspend() (aucun flux résiduel).
    this.stemOffsetSeconds = this.position;
    this.audio.pause();
    this.pauseStems();
    void this.ctx?.suspend?.();
  }

  // ── ALC-174-2 : couche STEMS additive (jamais à la place de la source single-buffer) ──

  /**
   * Charge les 4 buffers stems (read_audio_file_bytes → decodeAudioData), chacun via son GainNode
   * dédié branché dans la chaîne EQ partagée (LOW 120 → HIGH 3.2 → Volume → Crossfader).
   */
  async loadStems(paths: Partial<Record<StemName, string>>) {
    const wasActive = this.stemModeActive;
    this.disposeStems();
    this.stemModeActive = wasActive; // disposeStems ne reconnecte pas le mono si verrou actif.
    // ALC-193-1 : décodage des 4 WAV en PARALLÈLE (Promise.all) — fini le for-await séquentiel
    // qui gelait le 1er ▶ LANCER A + B pendant ~30 s sur 8 fichiers de ~62 Mo.
    // ALC-195-2 : lecture BINAIRE brute (ArrayBuffer natif, aucun JSON) + décodage direct.
    const _perfT0 = performance.now();
    await Promise.all(
      STEM_NAMES.map(async (name) => {
        const p = paths[name];
        if (!p) return;
        try {
          const buffer = await this.ctx.decodeAudioData(await audioIpc.readAudioFileRaw(p));
          const gain = this.ctx.createGain();
          gain.gain.value = 1;
          if (name === 'vocals') {
            // ALC-218 : nettoyage spectral OFF-LINE non destructif sur le buffer vocals — coupe-bas
            // propre (< 90 Hz), contrôle doux des sibilantes / fuites aiguës (> ~7 kHz) et atténuation
            // des silences sans chant. Réduit la brillance de la voix sans en dénaturer le timbre.
            for (let c = 0; c < buffer.numberOfChannels; c++) {
              const ch = buffer.getChannelData(c);
              ch.set(cleanVocalsSamples(ch, buffer.sampleRate));
            }
            // ALC-182-2 : EQ transparent NON destructif (renforcé) sur le canal vocals — coupe le
            // sub-vocal (< 80 Hz) et adoucit la zone > ~9 kHz (cymbales), sans ternir la voix.
            const hp = this.ctx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = 85;
            hp.Q.value = 0.7;
            const lp = this.ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 11500;
            lp.Q.value = 0.5;
            gain.connect(hp);
            hp.connect(lp);
            lp.connect(this.lowFilter);
            this.stemEq[name] = { hp, lp };
          } else {
            // ALC-26x : sculpture spectrale (Crossover OST × OST & Medley) — HP 20 Hz + LP 20 kHz
            // transparents + peaking 0 dB pré-câblés en série, réglés via setStemBandFilter / setStemMidNotch.
            const hp = this.ctx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = 20;
            hp.Q.value = 0.7;
            const lp = this.ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 20000;
            lp.Q.value = 0.5;
            const pk = this.ctx.createBiquadFilter();
            pk.type = 'peaking';
            pk.frequency.value = 1500;
            pk.Q.value = 1.0;
            pk.gain.value = 0; // transparent par défaut
            gain.connect(hp);
            hp.connect(lp);
            lp.connect(pk);
            pk.connect(this.lowFilter);
            this.stemEq[name] = { hp, lp, pk };
          }
          this.stemBuffers[name] = buffer;
          this.stemGains[name] = gain;
          this.stemEnvelopes[name] = this.computeEnvelope(buffer, 512);
          // ALC-252-1 : PLUS aucun <audio>/createMediaElementSource par stem (WebView2 les bloque
          // silencieusement) — seul le buffer AudioBufferSourceNode est créé (synchro parfaite).
        } catch (e) {
          console.error('[Stems] chargement impossible :', name, p, e);
        }
      })
    );
    this.stemsReady = STEM_NAMES.some((n) => !!this.stemBuffers[n]);
    if (this.stemsReady) {
      console.log(
        `[STEMS-PERF] loadStems deck=${this.id} → 4 WAV chargés+décodés en ${Math.round(performance.now() - _perfT0)} ms (objectif < 350 ms)`
      );
    }
  }

  /** Démarre les stems disponibles au MÊME échantillon (même `when`, même `offset`). */
  async playStems(currentTime: number) {
    // ALC-183 : avorte si stop/pause survient pendant le resume asynchrone (continuation $effect).
    const gen = this._playGen;
    await this.resume();
    if (gen !== this._playGen) return;
    // ALC-252-1 : moteur UNIQUE AudioBufferSourceNode (échantillon-précis) — plus aucune balise
    // <audio> par stem (WebView2 bloque silencieusement plusieurs des 8 éléments simultanés).
    // ALC-219 : UNICITÉ des sources stems. On arrête/détruit toute couche précédente AVANT d'en
    // créer une nouvelle : sinon les anciens AudioBufferSourceNode (toujours branchés) continuent
    // de jouer et un re-déclenchement (AUTO VOIX / AUTO-MIX / ré-entrée $effect / re-PLAY) empile
    // une 2e lecture → instrumental entendu EN DOUBLE. `pauseStems` couvre le cas vide.
    this.pauseStems();
    // ALC-252-1 : les 4 sources démarrent au MÊME instant futur (+15 ms) — synchronisation à
    // l'échantillon près entre drums/bass/other/vocals (zéro dérive, 100 % d'audibilité).
    const when = this.ctx.currentTime + 0.015;
    const offset = Math.max(0, currentTime);
    const rate = this.audio.playbackRate || 1;
    console.log(
      `[STEMS-DEBUG] playStems deck=${this.id} stemModeActive=${this.stemModeActive} gains=${JSON.stringify(
        Object.fromEntries(STEM_NAMES.map((s) => [s, this.stemGainValue(s)]))
      )}`
    );
    this.stemStartCtx = when;
    this.stemStartOffset = offset;
    this.stemNodes = [];
    // ALC-252-1 : applique les stemDesiredGains COURANTS dès la création des nœuds (setStemGain
    // immédiat : cancelScheduledValues + setValueAtTime) — mutes/volumes respectés au 1er échantillon.
    for (const name of STEM_NAMES) this.setStemGain(name, this.stemDesiredGains[name] ?? 1);
    // ALC-235 : compensation Key Lock (detune) des stems quand playbackRate ≠ 1.
    const cents = this.keyLock ? keyLockCompensationCents(rate) : 0;
    for (const name of STEM_NAMES) {
      const buffer = this.stemBuffers[name];
      const gain = this.stemGains[name];
      if (!buffer || !gain) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      if (src.detune) src.detune.value = cents; // ALC-235 : Key Lock (défensif si node sans detune)
      src.connect(gain);
      src.start(when, offset);
      this.stemNodes.push(src);
    }
    this.stemPlaying = this.stemNodes.length > 0;
    if (this.stemPlaying) this.startTicker();
    // ALC-220 : diagnostic [STEMS-DEBUG] — gain de bout en bout du chemin vocals + état Rack FX.
    console.log(
      `[STEMS-DEBUG] playStems deck=${this.id} vocalsConnected=${!!(
        this.stemBuffers.vocals && this.stemGains.vocals && this.stemEq.vocals
      )} vocalsGain=${this.stemGainValue('vocals')} dryGain=${this.dryGain?.gain.value} wetGain=${this.wetGain?.gain.value} keyLock=${this.keyLock} rate=${rate.toFixed(4)} detune=${cents.toFixed(2)}`
    );
  }

  pauseStems() {
    this.stopTicker();
    if (this.stemMediaActive) {
      for (const name of STEM_NAMES) {
        const el = this.stemEls[name];
        if (!el) continue;
        try {
          el.pause();
        } catch { /* ignore */ }
      }
      this.stemMediaActive = false;
      this.stemPlaying = false;
    }
    if (this.stemNodes.length === 0) {
      this.stemPlaying = false;
      return;
    }
    for (const s of this.stemNodes) {
      try {
        s.stop();
        s.disconnect(); // ALC-184 : déconnecte aussi la source (aucun résidu dans le graphe).
      } catch {
        /* déjà arrêté / déconnecté */
      }
    }
    this.stemNodes = [];
    this.stemPlaying = false;
  }

  /** ALC-249-1 : re-synchronise l'<audio> d'un stem sur l'état réel de son GainNode — un stem
   * AUDIBLE (gain effectif > 0) ne doit JAMAIS rester `muted` ni en `volume < 1` (l'élément est
   * alors muet même si le GainNode est ouvert → silence total au franchissement d'ENTRÉE VOIX
   * quand un preset a figé `el.muted=true` avant la création des éléments). */
  private syncStemMediaState(name: StemName) {
    const el = this.stemEls[name];
    if (!el) return;
    const audible = (this.stemDesiredGains[name] ?? 0) > 0.001;
    el.muted = !audible;
    if (audible && el.volume !== 1) el.volume = 1.0; // le GainNode reste la SEULE source de vérité
  }

  /** ALC-249-2 : état réel des 4 <audio> stems (muted/paused) du canal — consommé par le
   * `[AUDIO-WATCHDOG]` du store au franchissement d'ENTRÉE VOIX. */
  getStemMediaState(): Record<StemName, { muted: boolean | null; paused: boolean | null }> {
    const out = {} as Record<StemName, { muted: boolean | null; paused: boolean | null }>;
    for (const n of STEM_NAMES) {
      const el = this.stemEls[n];
      out[n] = el ? { muted: el.muted, paused: el.paused } : { muted: null, paused: null };
    }
    return out;
  }

  /** ALC-175 : mute/solo déterministe (cancel + setValueAtTime, latence zéro). */
  setStemGain(name: StemName, gain: number) {
    const g = this.stemGains[name];
    if (g) {
      const t = this.ctx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(0, gain), t);
    }
    this.stemDesiredGains[name] = Math.max(0, Number.isFinite(gain) ? gain : 0); // ALC-249-1
    // ALC-248-1 / ALC-249-1 : mute strict + resync — jamais d'élément <audio> muet si gain > 0.
    this.syncStemMediaState(name);
  }

  /**
   * ALC-187-1 : volume individuel d'un stem (0.0 → 1.0) avec rampe douce
   * `setTargetAtTime` (défaut 15 ms — aucun clic audio au glissement de fader).
   * ALC-238-1 : `rampMs` optionnel (ex. 30 ms pour le gating inter-strophes).
   * Le store combine cet état avec `stemMutes` (effectiveGain = muted ? 0 : volume).
   */
  setStemVolume(name: StemName, volume: number, rampMs = 15) {
    const g = this.stemGains[name];
    if (g) {
      const t = this.ctx.currentTime;
      const v = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1));
      const tau = Math.max(0.001, (rampMs || 15) / 1000);
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(v, t, tau);
    }
    this.stemDesiredGains[name] = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1)); // ALC-249-1
    // ALC-248-1/ALC-249-1 : isolation stricte + resync — mute l'élément si gain ~ 0, et garantit
    // `muted=false` + `volume=1.0` pour tout stem réellement audible (aucun état stale au PLAY).
    this.syncStemMediaState(name);
  }

  /**
   * Crossover OST × OST — sculpture spectrale asymétrique (partage du médium) : creux dynamique sur un
   * stem (ex. `other` de la Platine Rythmique) via le filtre peaking pré-câblé `pk` (transparent 0 dB).
   * `Q = 1.0` ; gain borné à [‑6, 0] dB pour ouvrir une niche en 500 Hz – 4 kHz sans déplacer le timbre.
   */
  setStemMidNotch(name: StemName, freqHz: number, gainDb: number) {
    const pk = this.stemEq[name]?.pk;
    if (!pk) return;
    const t = this.ctx.currentTime;
    pk.frequency.setValueAtTime(Math.max(20, Math.min(20000, Number.isFinite(freqHz) ? freqHz : 1500)), t);
    pk.Q.setValueAtTime(1.0, t);
    pk.gain.setTargetAtTime(Math.max(-6, Math.min(0, Number.isFinite(gainDb) ? gainDb : 0)), t, 0.02);
  }

  /** Medley OST × OST — séparation spectrale complémentaire au climax : LPF (thème grave) / HPF (thème aigu). */
  setStemBandFilter(name: StemName, kind: 'highpass' | 'lowpass', freqHz: number) {
    const eq = this.stemEq[name];
    if (!eq) return;
    const t = this.ctx.currentTime;
    const f = Math.max(20, Math.min(20000, Number.isFinite(freqHz) ? freqHz : 1000));
    if (kind === 'highpass') {
      if (!eq.hp) {
        eq.hp = this.ctx.createBiquadFilter();
        eq.hp.connect(eq.lp ?? this.lowFilter);
      }
      eq.hp.type = 'highpass';
      eq.hp.frequency.setValueAtTime(f, t);
      eq.hp.Q.setValueAtTime(0.7, t);
    } else {
      if (!eq.lp) {
        eq.lp = this.ctx.createBiquadFilter();
        eq.lp.connect(eq.pk ?? this.stemGains[name] ?? this.lowFilter);
      }
      eq.lp.type = 'lowpass';
      eq.lp.frequency.setValueAtTime(f, t);
      eq.lp.Q.setValueAtTime(0.7, t);
    }
  }

  disposeStems() {
    this.pauseStems();
    // ALC-246-1 : coupe les <audio> par stem + révoque leurs URL blob (aucune fuite mémoire).
    for (const [name, el] of Object.entries(this.stemEls) as [StemName, HTMLAudioElement][]) {
      try {
        el.pause();
        el.removeAttribute('src');
      } catch { /* ignoré */ }
      const url = this.stemElUrls[name];
      if (url) URL.revokeObjectURL(url);
    }
    this.stemEls = {};
    this.stemElSrcs = {};
    this.stemElUrls = {};
    this.stemMediaActive = false;
    for (const g of Object.values(this.stemGains)) {
      try {
        g?.disconnect();
      } catch {
        /* ignoré */
      }
    }
    this.stemGains = {};
    this.stemDesiredGains = { vocals: 1, drums: 1, bass: 1, other: 1 }; // ALC-249-1 : reset des cibles
    // ALC-182-2 : coupe les nœuds de l'EQ vocals (évite les connexions mortes au rechargement).
    for (const eq of Object.values(this.stemEq)) {
      try {
        eq?.hp?.disconnect();
        eq?.lp?.disconnect();
        eq?.pk?.disconnect();
      } catch {
        /* ignoré */
      }
    }
    this.stemEq = {};
    this.stemBuffers = {};
    this.stemEnvelopes = {};
    this.stemsReady = false;
    // ALC-176 : ne JAMAIS réactiver le mono tant que le verrou stemModeActive est levé.
    if (!this.stemModeActive) this.reconnectMono();
  }

  /**
   * ALC-176 : bascule EXCLUSIVE mono ↔ stems (verrou dur).
   * active=true → le buffer mono est PAUSE + MUTED + DÉCONNECTÉ ; aucun appel play/pause/seek
   * ne peut lui redonner du son tant que le verrou est levé. active=false → retour mono pur.
   */
  setStemMode(active: boolean) {
    this.stemModeActive = active;
    if (active) {
      try {
        this.audio.pause();
        this.audio.muted = true;
        if (!this.monoDisconnected) {
          this.srcNode.disconnect();
          this.monoDisconnected = true;
        }
      } catch {
        /* ignoré */
      }
    } else {
      this.audio.muted = false;
      this.reconnectMono();
    }
  }

  /** Preuve d'état pour la couche UI / tests : le mono <audio> est-il verrouillé off ? */
  isStemModeActive(): boolean {
    return this.stemModeActive;
  }

  /** ALC-178 : valeur RÉELLE (AudioParam.value) du GainNode d'un stem — diagnostic + preuves. */
  stemGainValue(name: StemName): number | null {
    return this.stemGains[name]?.gain.value ?? null;
  }

  /**
   * ALC-190-1 : enveloppe 512 bins (normalisée 0..1) par stem, lue par le Beatgrid.
   * Retourne `null` tant que les stems ne sont pas chargés (repli sur l'enveloppe globale).
   */
  getStemEnvelopes(): Record<StemName, Float32Array> | null {
    return Object.keys(this.stemEnvelopes).length
      ? (this.stemEnvelopes as Record<StemName, Float32Array>)
      : null;
  }

  /** ALC-190-1 : calcul léger (stride) de l'enveloppe d'amplitude normalisée d'un stem buffer. */
  private computeEnvelope(buffer: AudioBuffer, bins: number): Float32Array {
    const out = new Float32Array(Math.max(1, bins));
    const frames = buffer.length;
    const chs = buffer.numberOfChannels;
    if (frames <= 0) return out;
    // Fenêtres contiguës couvrant tout le buffer, sous-échantillonnées (stride) pour rester rapide.
    const step = Math.max(1, Math.floor(frames / out.length));
    const sub = Math.max(1, Math.floor(step / 16) || 1);
    for (let b = 0; b < out.length; b++) {
      const s0 = Math.min(frames - 1, b * step);
      const e0 = Math.min(frames, s0 + step);
      let peak = 0;
      for (let c = 0; c < chs; c++) {
        const data = buffer.getChannelData(c);
        for (let i = s0; i < e0; i += sub) {
          const a = Math.abs(data[i]);
          if (a > peak) peak = a;
        }
      }
      out[b] = peak;
    }
    let max = 0;
    for (let b = 0; b < out.length; b++) if (out[b] > max) max = out[b];
    if (max > 0) for (let b = 0; b < out.length; b++) out[b] /= max;
    return out;
  }

  private reconnectMono() {
    this.stopTicker();
    if (this.monoDisconnected) {
      try {
        this.srcNode.connect(this.lowFilter);
      } catch {
        /* ignoré */
      }
      this.monoDisconnected = false;
    }
  }

  /** Tick light (200 ms) pour onTime en mode stems (le <audio> mono est en pause). */
  private startTicker() {
    if (this.tick != null) return;
    this.tick = window.setInterval(() => {
      // ALC-246-1 : recalage de dérive des <audio> stems — si un stem s'écarte de plus de 5 ms
      // du stem maître (vocals/first), on le ramène doucement (jamais de seek audible à < 5 ms).
      if (this.stemMediaActive) {
        const master = this.stemMasterElement();
        if (master) {
          const ref = master.currentTime || 0;
          for (const name of STEM_NAMES) {
            const el = this.stemEls[name];
            if (!el || el === master) continue;
            const drift = (el.currentTime || 0) - ref;
            if (Math.abs(drift) > 0.005) {
              try {
                el.currentTime += drift;
              } catch { /* ignore */ }
            }
          }
        }
      }
      this.onTime?.(this.position);
    }, 200);
  }

  /** ALC-246-1 : élément <audio> maître des stems (priorité vocals, sinon premier chargé). */
  private stemMasterElement(): HTMLAudioElement | null {
    for (const name of STEM_NAMES) {
      const el = this.stemEls[name];
      if (el) return el;
    }
    return null;
  }

  private stopTicker() {
    if (this.tick != null) {
      window.clearInterval(this.tick);
      this.tick = null;
    }
  }

  /**
   * ALC-136 / ALC-182 : STOP total. En mode stems, le <audio> mono étant déjà verrouillé
   * muet (stemModeActive), il faut AUSSI arrêter les 4 AudioBufferSourceNode actifs — sinon
   * le STOP ne coupe pas le son et un re-PLAY empile une seconde couche auditive. Remet la
   * position à 0 et l'horloge synthétique stems à l'origine.
   */
  stop() {
    // ALC-183 : invalide toute lecture en vol (continuation $effect périmée) AVANT de couper.
    this._playGen++;
    // ALC-182 : arrête/détruit (et déconnecte) les stemNodes actifs, coupe le ticker, stemPlaying=false.
    this.pauseStems();
    this.audio.pause();
    this.audio.currentTime = 0;
    // ALC-183 : le mono <audio> RESTE verrouillé muet tant que le mode stems est actif (sinon
    // une continuation résiduelle pourrait le relancer → « le mono revient après STOP »).
    if (this.stemModeActive) this.audio.muted = true;
    // ALC-184 : coupure MATÉRIELLE — suspend tout l'AudioContext : aucun son ne peut sortir,
    // même d'un éventuel nœud orphelin non nettoyé. Un nouveau play()/playStems() réveille le
    // contexte via resume() (cf. this.resume()).
    void this.ctx?.suspend?.();
    // ALC-182 : origine de l'horloge stems remise à zéro → position() = 0 (et non la valeur
    // résiduelle du dernier morceau), cohérent avec elapsedSeconds = 0 posé par setTransport.
    this.stemStartOffset = 0;
    this.stemStartCtx = 0;
  }

  /**
   * ALC-183 : libère la source mono (URL blob + src) pour un EJECT / rechargement propre.
   * N'appelle PAS ctx.close() : le Player reste réutilisable pour la platine.
   */
  clearSource() {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.sourcePath = null;
    try {
      this.audio.removeAttribute('src');
      this.audio.load();
    } catch {
      /* ignoré */
    }
  }

  /** ALC-136-3 : lecture des échantillons réels → RMS / Peak (dBFS) pour le galvanomètre. */
  read(): { rms: number; peak: number } {
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = (this.buf[i] - 128) / 128;
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    const rms = Math.sqrt(sum / this.buf.length);
    const toDb = (v: number) => (v <= 1e-4 ? -60 : 20 * Math.log10(v));
    return { rms: toDb(rms), peak: toDb(peak) };
  }

  dispose() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.ctx.close().catch(() => {});
  }
}