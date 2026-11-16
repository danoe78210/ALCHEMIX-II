// ALC-136 : lecteur audio WebAudio réel par platine.
// Chaîne complète : MediaElementAudioSourceNode → BiquadFilterNode (lowshelf 120 Hz)
//                   → GainNode (volume × crossfader égal-puissance) → AnalyserNode → ctx.destination.
// Source chargée en URL blob: (aucun blocage CORS WebView2 asset://), révoquée à EJECT/rechargement.

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

export class Player {
  readonly ctx: AudioContext;
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

  /** Callbacks pour synchroniser la position (ROLL) et la durée depuis l'élément <audio>. */
  onTime: ((current: number) => void) | null = null;
  onDuration: ((duration: number) => void) | null = null;
  private _loop: [number, number] | null = null; // ALC-142 auto-loop quantifié [IN, OUT]

  /** ALC-142 : position de lecture courante (s). */
  get position(): number { return this.audio.currentTime || 0; }
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

  constructor(readonly id: string) {
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
    this.audio.playbackRate = 1 + pitchPercent / 100;
  }

  /** REW / FFWD / reprise : déplace la position de lecture. */
  seek(seconds: number) {
    const d = this.audio.duration || 0;
    this.audio.currentTime = Math.max(0, Math.min(d, seconds));
  }

  async play(): Promise<void> {
    await this.resume();
    try {
      await this.audio.play();
    } catch (err) {
      // ALC-136-3 : aucune erreur audio silencieuse.
      console.error('[Player] audio.play a échoué', err);
      throw err;
    }
  }

  pause() {
    this.audio.pause();
  }

  stop() {
    this.audio.pause();
    this.audio.currentTime = 0;
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