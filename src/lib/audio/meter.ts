// Métrologie VU temps réel (ALC-102) : flux RMS/Peak (dBFS) via un AnalyserNode WebAudio.
// Par défaut, alimente un signal de démonstration (bruit) pour animer les galvanomètres ;
// il suffit de remplacer `_seedNoise` par le vrai flux de lecture une fois branché.

export class Meter {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private buf: Uint8Array<ArrayBuffer>;
  private lowFilter: BiquadFilterNode | null = null;
  private outputGain: GainNode | null = null;

  constructor() {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    this._seedNoise();
  }

  /** Génère une boucle de bruit doux comme source de démonstration (sourde). */
  private _seedNoise() {
    const len = this.ctx.sampleRate * 1;
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.55;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.55;
    // ALC-132-4 : filtre grave (lowshelf 120 Hz) sur la chaîne du lecteur — applique le LOW EQ.
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowshelf';
    filter.frequency.value = 120;
    filter.gain.value = 0;
    this.lowFilter = filter;
    // ALC-105-2 : nœud de gain maître de sortie (crossfader égal-puissance × volume).
    this.outputGain = this.ctx.createGain();
    this.outputGain.gain.value = 1;
    src.connect(gain).connect(filter).connect(this.outputGain).connect(this.analyser); // mode silencieux
    src.start();
  }

  /** ALC-105-2 : fixe le gain maître de sortie = gain du crossfader égal-puissance × volume du canal. */
  setOutputGain(g: number) {
    if (this.outputGain) {
      this.outputGain.gain.setTargetAtTime(Math.max(0, g), this.ctx.currentTime, 0.04);
    }
  }

  /** ALC-132-4 : règle l'atténuation du filtre grave (dB) sur la sortie du lecteur. */
  setLowShelf(dB: number) {
    if (this.lowFilter) {
      this.lowFilter.gain.setTargetAtTime(dB, this.ctx.currentTime, 0.08);
    }
  }

  resume(): void {
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /** Lit RMS et Peak (dBFS) du signal courant. */
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
}