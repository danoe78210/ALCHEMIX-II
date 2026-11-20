// ALC-136 : lecteur audio WebAudio réel par platine.
// Chaîne complète : MediaElementAudioSourceNode → BiquadFilterNode (lowshelf 120 Hz)
//                   → GainNode (volume × crossfader égal-puissance) → AnalyserNode → ctx.destination.
// Source chargée en URL blob: (aucun blocage CORS WebView2 asset://), révoquée à EJECT/rechargement.
// ALC-174-2 : couche STEMS additive (4 AudioBufferSourceNode synchronisés au même échantillon,
// chacun via son GainNode dédié, branchés dans la chaîne EQ partagée — Mute/Solo à latence zéro).

import { audioIpc } from '$lib/ipc/client';

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
  /** ALC-182-2 : EQ doux du canal vocals (highpass 85 Hz + adoucissement > ~11 kHz). */
  private stemEq: Partial<Record<StemName, { hp: BiquadFilterNode; lp: BiquadFilterNode }>> = {};
  private stemNodes: AudioBufferSourceNode[] = [];
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
  private tick: number | null = null;

  /** Callbacks pour synchroniser la position (ROLL) et la durée depuis l'élément <audio>. */
  onTime: ((current: number) => void) | null = null;
  onDuration: ((duration: number) => void) | null = null;
  private _loop: [number, number] | null = null; // ALC-142 auto-loop quantifié [IN, OUT]

  /** ALC-142 : position de lecture courante (s) ; synthétique en mode stems (mono en pause). */
  get position(): number {
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

  constructor(id: string) {
    this.id = id;
    this.ctx = new AudioContext();
    this.audio = document.createElement('audio');
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'auto';
    this.audio.preservesPitch = true; // ALC-136 : la clé Camelot reste juste quand le playbackRate change.

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

  /** ALC-105/136/138 : gain maître = volume canal × crossfader égal-puissance. Application immédiate. */
  setOutputGain(g: number) {
    const target = Math.max(0, g); // 0 strict quand volume ou crossfader coupe le canal
    const t = this.ctx.currentTime;
    this.outGain.gain.cancelScheduledValues(t);
    this.outGain.gain.setValueAtTime(target, t);
  }

  /** ALC-136 : pitch/tonalité — playbackRate = 1 + pitchPercent/100, preservesPitch = true. */
  setPlaybackRate(pitchPercent: number) {
    const rate = 1 + pitchPercent / 100;
    this.audio.playbackRate = rate;
    // ALC-176 : en mode stems, pilote EXCLUSIVEMENT les 4 AudioBufferSourceNode.
    for (const s of this.stemNodes) {
      s.playbackRate.setValueAtTime(rate, this.ctx.currentTime);
    }
  }

  /** REW / FFWD / reprise : déplace la position de lecture (restart stems si en cours). */
  seek(seconds: number) {
    const d = this.audio.duration || 0;
    const t = Math.max(0, Math.min(d, seconds));
    this.audio.currentTime = t;
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
      // ALC-176 : verrou dur — dès que le mode stems est actif (même si le décodage des buffers
      // est encore en cours ou a échoué), le mono n'est JAMAIS relancé : on joue les stems
      // disponibles (éventuellement 0 → silence) plutôt que le titre original.
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
    this.audio.pause();
    this.pauseStems();
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
    for (const name of STEM_NAMES) {
      const p = paths[name];
      if (!p) continue;
      try {
        const bytes = await audioIpc.readAudioFileBytes(p);
        const ab = new Uint8Array(bytes).buffer as ArrayBuffer;
        const buffer = await this.ctx.decodeAudioData(ab);
        const gain = this.ctx.createGain();
        gain.gain.value = 1;
        if (name === 'vocals') {
          // ALC-182-2 : EQ transparent NON destructif sur le canal vocals uniquement — coupe le
          // sub-vocal (< 85 Hz : ronflement / respiration grave) et adoucit la zone > ~11 kHz où
          // résident les fuites de cymbales/charlestons, sans ternir la clarté de la voix. Les
          // WAV stems restent intacts ; seule la restitution live est adoucie.
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
          gain.connect(this.lowFilter);
        }
        this.stemBuffers[name] = buffer;
        this.stemGains[name] = gain;
      } catch (e) {
        console.error('[Stems] chargement impossible :', name, p, e);
      }
    }
    this.stemsReady = STEM_NAMES.some((n) => !!this.stemBuffers[n]);
  }

  /** Démarre les stems disponibles au MÊME échantillon (même `when`, même `offset`). */
  async playStems(currentTime: number) {
    // ALC-183 : avorte si stop/pause survient pendant le resume asynchrone (continuation $effect).
    const gen = this._playGen;
    await this.resume();
    if (gen !== this._playGen) return;
    const when = this.ctx.currentTime;
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
    for (const name of STEM_NAMES) {
      const buffer = this.stemBuffers[name];
      const gain = this.stemGains[name];
      if (!buffer || !gain) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      src.connect(gain);
      src.start(when, offset);
      this.stemNodes.push(src);
    }
    this.stemPlaying = this.stemNodes.length > 0;
    if (this.stemPlaying) this.startTicker();
  }

  pauseStems() {
    this.stopTicker();
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

  /** ALC-175 : mute/solo déterministe (cancel + setValueAtTime, latence zéro). */
  setStemGain(name: StemName, gain: number) {
    const g = this.stemGains[name];
    if (g) {
      const t = this.ctx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(0, gain), t);
    }
  }

  disposeStems() {
    this.pauseStems();
    for (const g of Object.values(this.stemGains)) {
      try {
        g?.disconnect();
      } catch {
        /* ignoré */
      }
    }
    this.stemGains = {};
    // ALC-182-2 : coupe les nœuds de l'EQ vocals (évite les connexions mortes au rechargement).
    for (const eq of Object.values(this.stemEq)) {
      try {
        eq?.hp.disconnect();
        eq?.lp.disconnect();
      } catch {
        /* ignoré */
      }
    }
    this.stemEq = {};
    this.stemBuffers = {};
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
    this.tick = window.setInterval(() => this.onTime?.(this.position), 200);
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