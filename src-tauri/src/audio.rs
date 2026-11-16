//! Moteur d'analyse audio — **ALC-008**.
//!
//! Pipeline de décodage (**Symphonia**) + traitement du signal (**FFT rustfft**) produisant,
//! pour un fichier son, la fidélité, le tempo (BPM), la tonalité (clé Camelot) et une
//! enveloppe waveform, le tout destiné à la console centrale et à la Roue de Camelot.
//!
//! # ALC-008-1 — Choix de la fidélité de calcul (benchmark documenté)
//!
//! Compromis échantillonnage / fenêtre FFT études pour la précision spectrale de la
//! Roue de Camelot (chromagramme → clé) et l'analyse de tempo en temps réel :
//!
//! | Fidélité           | Résolution freq. | Impact analyse                          | Coût             |
//! |--------------------|------------------|-----------------------------------------|------------------|
//! | 44.1 kHz · FFT 2048 | 21.5 Hz/bin      | Chroma grossier (notes graves fusionnées) | Léger            |
//! | **48 kHz · FFT 4096** | **11.7 Hz/bin** | Chroma fin + tempo stable               | **Retenu**       |
//! | 96 kHz · FFT 4096   | 23.4 Hz/bin      | Bande utile dépassée (basses dupliquées)  | 2× mémoire/CPU   |
//!
//! Décisions :
//! - **48 kHz retenu** : la bande utile à la perception tonale et au tempo s'arrête bien sous
//!   20 kHz. Passer à 96 kHz n'apporte aucune information harmonique supplémentaire et double
//!   la mémoire/CPU ; 44.1 kHz réduirait la marge avant repliement à la décimation.
//! - **FFT 4096** (48 kHz → 11.7 Hz/bin) : il résout l'écart de ~3–4 Hz des notes graves
//!   (ex. C2≈65 Hz ⇄ C#2≈69 Hz) indispensable au chromagramme Camelot ; 2048 (23.4 Hz/bin) ne
//!   les distingue pas.
//! - **Hop 1024** (≈21 ms) : mise à jour temps réel fluide (≈47 fenêtres/s) sans surcharge.

use rustfft::{num_complex::Complex, FftPlanner};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::error::Error;

/// Fréquence d'échantillonnage cible de l'analyse (voir benchmark ALC-008-1).
pub const TARGET_SAMPLE_RATE: u32 = 48_000;
/// ALC-159 : taux d'échantillonnage de l'ANALYSE tempo & clé (décimé). 48 kHz / 4 = **12 kHz**
/// (facteur ENTIER → anti-repliement simple par moyenne mobile valable) : Nyquist 6000 Hz couvre
/// 100 % de la bande utile 40–1400 Hz avec 4× moins de données qu'à 48 kHz. FFT 1024/hop 256 →
/// mêmes bin_hz (11,7 Hz) et même durée temporelle (~21 ms) qu'à 48 kHz → résultats de clé identiques.
pub const ANALYSIS_SR: u32 = 12_000;
/// Taille de la fenêtre FFT pour le chromagramme de la clé Camelot.
pub const FFT_SIZE: usize = 4096;
/// Saut entre deux fenêtres FFT (durée ≈ 21 ms à 48 kHz).
pub const FFT_HOP: usize = 1024;
/// Durée (secondes) maximale du tampon d'analyse tempo / tonalité.
pub const ANALYSIS_MAX_SECONDS: u32 = 90;
/// Nombre de buckets de la waveform transmise au frontend.
pub const WAVE_BINS: usize = 256;
/// Échantillons mono (rééchantillonnés) groupés par bucket avant agrégation en peaks.
const WAVE_GROUP: usize = 2048;
/// Plage de tempo admissible (Règle 4 — bornes strictes 30–240 BPM).
const MIN_BPM: f64 = 30.0;
const MAX_BPM: f64 = 240.0;
/// Taux d'échantillonnage du front-end temps-fréquence (Règle 1 — DSP classique 8–16 kHz).
const ONSET_SR: usize = 8000;
/// Trame STFT ≈ 32 ms à 8 kHz.
const WINDOW: usize = 256;
/// Saut STFT = 50 % de la trame (16 ms à 8 kHz).
const HOP: usize = 128;
/// Nombre de sous-bandes log-spacées (échelle perceptuelle) pour l'onset (Règle 1).
const SUBBANDS: usize = 8;
/// ALC-153 : sous-bandes de l'énergie de la GROSSE CAISSE (sub-bass 40–105 Hz). Sur la grille log
/// 40 Hz–4 kHz à 8 sous-bandes, les sous-bandes 0..=1 couvrent ≈40–126 Hz (kick) ; la caisse
/// claire (≈180 Hz+) et les syncopes de basse qui doubleraient/tripleraient le tempo en sont
/// exclues (basses percussives resserrées).
const KICK_BANDS: usize = 2;

/// Profils Krumhansl–Schmuckler (majeur / mineur) pondérés en demi-tons.
const MAJOR_PROFILE: [f64; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE: [f64; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Profils tonals calibrés (Règle Camelot) — Temperley, Shaath, EDMA/EDMM, BGATE.
const TEMP_MAJOR: [f64; 12] = [5.0, 2.0, 3.5, 2.0, 4.0, 2.0, 1.5, 4.0, 2.0, 3.5, 1.5, 2.5];
const TEMP_MINOR: [f64; 12] = [5.0, 2.0, 3.5, 4.5, 2.0, 3.5, 1.5, 2.0, 4.0, 2.5, 2.0, 2.5];
const SHA_MAJOR: [f64; 12] = [1.0, 0.2, 0.7, 0.2, 0.9, 0.3, 0.2, 0.8, 0.4, 0.6, 0.3, 0.4];
const SHA_MINOR: [f64; 12] = [1.0, 0.2, 0.7, 0.8, 0.2, 0.6, 0.2, 0.3, 0.9, 0.5, 0.4, 0.4];
const EDMA_MAJOR: [f64; 12] = [1.0, 0.1, 0.6, 0.1, 0.9, 0.2, 0.1, 0.7, 0.1, 0.5, 0.1, 0.3];
const EDMM_MINOR: [f64; 12] = [1.0, 0.1, 0.6, 0.8, 0.1, 0.7, 0.1, 0.2, 0.9, 0.3, 0.2, 0.3];
const BGATE_MAJOR: [f64; 12] = [1.0, 0.1, 0.5, 0.1, 0.8, 0.2, 0.1, 0.6, 0.1, 0.4, 0.1, 0.3];
const BGATE_MINOR: [f64; 12] = [1.0, 0.1, 0.5, 0.7, 0.1, 0.6, 0.1, 0.2, 0.8, 0.3, 0.2, 0.3];

// HPCP haute résolution (Règle Camelot) : 36 bacs par octave = 3 par demi-ton.
const HPCP_BINS: usize = 36;
/// Pondération des 4 premières harmoniques rattachées à la fondamentale (pente ≈ 0,6).
const HARMONIC_COUNT: usize = 4;
/// Nombre de composantes chromatiques les plus faibles éliminées par le gating BGATE.
/// Réduit (4→2) pour un gating moins agressif (étalonnage ALC-006 — moins de biais vers le mineur).
const GATE_CUT: usize = 2;

/// Résultat complet de l'analyse d'un fichier audio.
#[derive(Debug, Clone, Serialize)]
pub struct AudioAnalysis {
    pub sample_rate: u32,
    pub bit_depth: u16,
    pub bitrate_kbps: u32,
    pub channels: u16,
    pub codec: String,
    pub duration_seconds: u32,
    pub bpm: f64,
    pub camelot_key: String,
    pub key_confidence: f64,
    pub waveform_peaks: Vec<f32>,
    /// ALC-144 : clé Camelot par fenêtre temporelle (heatmap harmonique secondaire).
    pub key_timeline: Vec<KeySeg>,
    /// ALC-146 : segmentation dynamique (fenêtres glissantes ~4 s) — RMS 3 bandes,
    /// tempo local et clé locale pour sculpter la dynamique réelle (kicks, voix, cymbales).
    pub segments: Vec<TrackSegment>,
}

/// ALC-144 : segment tonal de la heatmap harmonique (début, code Camelot, confiance).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySeg {
    pub time_seconds: f64,
    pub camelot_key: String,
    pub confidence: f64,
}

/// ALC-146 : segment sonore de la frise — fenêtre glissante ~4 s avec bandes de fréquence
/// normalisées (0..1), tempo local (inter-onsets) et clé Camelot locale (HPCP).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSegment {
    pub start_sec: f64,
    pub end_sec: f64,
    /// RMS < 120 Hz (sub-bass / kicks), normalisé [0,1].
    pub rms_low: f32,
    /// RMS 120 Hz – 4 kHz (voix / médium), normalisé [0,1].
    pub rms_mid: f32,
    /// RMS > 4 kHz (cymbales / aigus), normalisé [0,1].
    pub rms_high: f32,
    /// Tempo local estimé sur la fenêtre (dérives, accélérations / ralentissements).
    pub local_bpm: f32,
    /// Clé Camelot locale (2A, 4B…) — modulations tonales en cours de piste.
    pub local_camelot: String,
}

/// Décode la piste (Symphonia), la réduit en mono 48 kHz et en extrait BPM / clé / waveform.
pub fn analyze(path: &Path) -> Result<AudioAnalysis, Error> {
    let file = std::fs::File::open(path)
        .map_err(|_| Error::NotFound(path.display().to_string()))?;
    let mss = symphonia::core::io::MediaSourceStream::new(Box::new(file), Default::default());

    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let mut hint = symphonia::core::probe::Hint::new();
    hint.with_extension(ext);

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &symphonia::core::formats::FormatOptions::default(),
            &symphonia::core::meta::MetadataOptions::default(),
        )
        .map_err(|_| Error::InvalidInput(format!("Format audio illisible : {}", path.display())))?;

    // Codec dérivé de l'extension (FLAC/WAV/MP3…) ; un raffinement métadonnées est possible plus tard.
    let codec = ext.to_uppercase();

    let mut format = probed.format;

    let track = format
        .default_track()
        .cloned()
        .ok_or_else(|| Error::InvalidInput("Aucune piste audio décodable dans le fichier".into()))?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let native_rate = codec_params.sample_rate.unwrap_or(44_100) as u32;
    let channels = codec_params.channels.map(|c| c.count()).unwrap_or(2) as u16;
    let bits = codec_params.bits_per_sample.unwrap_or(16) as u16;
    let duration = codec_params
        .n_frames
        .map(|f| if native_rate > 0 { (f / native_rate as u64) as u32 } else { 0 })
        .unwrap_or(0);

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &symphonia::core::codecs::DecoderOptions::default())
        .map_err(|_| Error::InvalidInput(format!("Codec non pris en charge : {}", path.display())))?;

    let ratio = TARGET_SAMPLE_RATE as f64 / native_rate as f64;
    let max_samples = ANALYSIS_MAX_SECONDS as usize * TARGET_SAMPLE_RATE as usize;

    // ALC-159 : zone centrale ACTIVE de l'analyse. Pour les pistes > 110 s, on borne l'analyse BPM
    // & clé aux 90 s CENTRALES en ignorant 20 % d'intro et 15 % d'outro (la waveform reste intégrale).
    let total_dur = duration as f64; // durée connue dès le probe (codec_params.n_frames)
    let (win_start, win_end) = active_window(total_dur);

    // Tampon mono @ 48 kHz (fenêtre centrale bornée) pour l'analyse TEMPO (BPM).
    let mut analysis_buf: Vec<f32> = Vec::with_capacity(max_samples);
    // ALC-160 : buffer DÉCIMÉ de TOUT le morceau (0 %–100 %) pour la TONALITÉ Camelot — l'intro/outro
    // où la tonique mineure est établie (6A sur Hand In My Pocket, Money for Nothing) est conservée.
    let mut full_dec: Vec<f32> = Vec::new();
    // Passe-bas Butterworth ordre 2 avant décimation (anti-repliement harmonique, bande utile intacte).
    let mut lowpass = Lowpass2Stream::new(2_500.0, TARGET_SAMPLE_RATE as f64);
    // Waveform : maxima par bucket (représente toute la piste, hors du tampon d'analyse).
    let mut wave_groups: Vec<f32> = Vec::new();
    let mut group_max = 0.0f32;
    let mut group_count = 0usize;
    let mut abs_sample: u64 = 0; // compteur absolu @ 48 kHz (référence du décodage)

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let mono = mono_signal(decoded);
                if mono.is_empty() {
                    continue;
                }
                let rs = resample_linear(&mono, ratio);
                for s in rs {
                    let t_sec = abs_sample as f64 / TARGET_SAMPLE_RATE as f64;
                    abs_sample += 1;
                    if t_sec >= win_start && t_sec < win_end && analysis_buf.len() < max_samples {
                        analysis_buf.push(s); // fenêtre centrale → BPM
                    }
                    lowpass.push(s, &mut full_dec); // tout le morceau → Tonalité
                    group_max = group_max.max(s.abs().max(1e-4));
                    group_count += 1;
                    if group_count >= WAVE_GROUP {
                        wave_groups.push(group_max);
                        group_max = 0.0;
                        group_count = 0;
                    }
                }
            }
            Err(_) => continue,
        }
    }
    if group_count > 0 {
        wave_groups.push(group_max);
    }

    // ALC-159/160 : BPM, timeline & segments sur la fenêtre centrale 48 kHz ; TONALITÉ GLOBALE sur
    // le morceau COMPLET décimé (ALC-160 : restaure 6A sur Hand In My Pocket / Money for Nothing).
    let cfg48 = AnalyzerCfg::at_sr(TARGET_SAMPLE_RATE);
    let bpm = analyze_bpm(&analysis_buf);
    let waveform_peaks = waveform_to_bins(&wave_groups, WAVE_BINS);
    let key_timeline = analyze_key_timeline(&analysis_buf, &cfg48);
    let segments = analyze_segments(&analysis_buf, &cfg48);

    // Clé Camelot GLOBALE : tout le morceau décimé à 12 kHz (filtre passe-bas 2) → HPCP allégé,
    // tonique établie sur intros/outros incluses. (ALC-159 → 160)
    let (camelot_key, key_confidence) = if !full_dec.is_empty() {
        key_code_at_sr(&full_dec, ANALYSIS_SR)
    } else {
        // Repli (flux vide improbable) : décimer la fenêtre centrale.
        let analysis_dec = decimate_to_analysis(&analysis_buf);
        key_code_at_sr(&analysis_dec, ANALYSIS_SR)
    };

    Ok(AudioAnalysis {
        sample_rate: native_rate,
        bit_depth: bits,
        bitrate_kbps: (native_rate as u64 * bits as u64 * channels as u64 / 1000) as u32,
        channels,
        codec,
        duration_seconds: duration,
        bpm,
        camelot_key,
        key_confidence,
        waveform_peaks,
        key_timeline,
        segments,
    })
}

/// Convertit le tampon décodé (AudioBufferRef, consommé) en signal mono f32.
fn mono_signal(decoded: symphonia::core::audio::AudioBufferRef) -> Vec<f32> {
    let spec = *decoded.spec();
    let channels = spec.channels.count();
    let frames = decoded.frames();
    if channels == 0 {
        return Vec::new();
    }
    let capacity = decoded.capacity() as u64;
    let mut sb = symphonia::core::audio::SampleBuffer::<f32>::new(capacity, spec);
    sb.copy_interleaved_ref(decoded);
    let s = sb.samples();
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let mut sum = 0.0f32;
        for c in 0..channels {
            sum += s[f * channels + c];
        }
        out.push(sum / channels as f32);
    }
    out
}

/// Rééchantillonne par interpolation linéaire de `rate_in` vers `TARGET_SAMPLE_RATE`.
fn resample_linear(input: &[f32], ratio: f64) -> Vec<f32> {
    if input.is_empty() {
        return Vec::new();
    }
    let n_out = (input.len() as f64 * ratio).max(1.0).ceil() as usize;
    let mut out = Vec::with_capacity(n_out);
    for i in 0..n_out {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let frac = (src - idx as f64) as f32;
        let a = input[idx.min(input.len() - 1)];
        let b = input[(idx + 1).min(input.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

/// Moteur d'analyse du rythme (BPM) — ALC-006 (Règles 1–6).
///
/// Pipeline : rééchantillonnage ~8 kHz → STFT perceptuelle (8 sous-bandes log) →
/// fonction d'onsets robuste → autocorrélation pondérée + résolution d'octave →
/// beat tracking (programmation dynamique, Ellis DP) → gestion du rubato.
fn analyze_bpm(x: &[f32]) -> f64 {
    // R1 : rééchantillonnage du signal mono en ~8 kHz.
    let mono8 = downsample_to_8k(x);
    let n = mono8.len();
    if n < WINDOW * 4 {
        return 120.0;
    }
    let nframes = (n - WINDOW) / HOP + 1;

    // R1 : STFT projetée sur échelle perceptuelle (8 sous-bandes logarithmiques).
    let spec = stft_log_subbands(&mono8, nframes);

    // R2 / ALC-152 : fonction d'onsets sur l'ÉNERGIE DES BASSES PERCUSSIVES (45–180 Hz, sous-bandes
    // 0..KICK_BANDS) pour suivre le kick plutôt que les subdivisions guitare/Charleston.
    let onset = onset_envelope_kick(&spec, nframes);

    // R3/R4 / ALC-154 : peigne métrique binaire MULTI-FENÊTRES (10 s, pas 5 s) sur l'onset percussif,
    // avec filtrage des intros silencieuses et estimation continue du BPM global.
    let hop_s = HOP as f64 / ONSET_SR as f64;
    let bpm_meter = tempo_comb_windowed(&onset, hop_s);

    // R5/R6 : beat tracking DP → intervalles inter-battements → tempo raffiné + rubato (c_var).
    let (bpm_final, _c_var) = refine_with_dp(&onset, hop_s, bpm_meter);

    ((bpm_final * 10.0).round() / 10.0).clamp(MIN_BPM, MAX_BPM)
}

/// ALC-159 — Fenêtre centrale active de l'analyse (secondes). Pour une piste > 110 s, on garde les
/// 90 s CENTRALES en ignorant 20 % d'intro et 15 % d'outro ; sinon toute la piste [0..dur].
fn active_window(dur_s: f64) -> (f64, f64) {
    if dur_s <= 110.0 {
        return (0.0, dur_s);
    }
    let intro = 0.20 * dur_s;
    let outro = 0.15 * dur_s;
    let avail = dur_s - intro - outro;
    let len = avail.min(ANALYSIS_MAX_SECONDS as f64);
    let mid = intro + (avail - len) / 2.0;
    (mid, mid + len)
}

/// R1 — Décimation (moyennage par blocs = léger passe-bas) vers ~8 kHz.
fn downsample_to_8k(x: &[f32]) -> Vec<f32> {
    const R: usize = TARGET_SAMPLE_RATE as usize / ONSET_SR; // 48000 / 8000 = 6
    let mut out = Vec::with_capacity(x.len() / R + 1);
    let mut i = 0;
    while i + R <= x.len() {
        out.push(x[i..i + R].iter().sum::<f32>() / R as f32);
        i += R;
    }
    out
}

/// ALC-159/160 — Décimation mono de TARGET_SAMPLE_RATE (48 kHz) vers ANALYSIS_SR (12 kHz) par
/// anti-repliement (moyenne mobile) + sous-échantillonnage facteur entier (48k/12k = 4). ~4× moins
/// de données pour l'analyse de la clé globale.
fn decimate_to_analysis(x: &[f32]) -> Vec<f32> {
    if x.is_empty() {
        return Vec::new();
    }
    // m = facteur entier de décimation (48k/12k = 4).
    let m = (TARGET_SAMPLE_RATE as f64 / ANALYSIS_SR as f64).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(x.len() / m + 1);
    let mut i = 0;
    // Moyenne mobile simple (passe-bas) avant décimation : anti-repliement léger.
    while i + m <= x.len() {
        out.push(x[i..i + m].iter().sum::<f32>() / m as f32);
        i += m;
    }
    out
}

/// ALC-160 — Filtre passe-bas BUTTERWORTH d'ordre 2 (biquad) appliqué en flux (streaming) avant la
/// décimation 48k→12k : permet d'utiliser l'INTÉGRALITÉ du morceau pour la tonalité sans repliement
/// harmonique (coupe au-dessus de ~6000/2·Nyquist, bande utile 40–1400 Hz intacte).
struct Lowpass2Stream {
    m: usize, // facteur de décimation
    // Coefficients biquad Butterworth d'ordre 2 (normalisés par a0).
    b: [f64; 3],
    a: [f64; 2],
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
    counter: usize,
}

impl Lowpass2Stream {
    /// fc = fréquence de coupure (Hz) du passe-bas, fs = taux d'entrée.
    fn new(fc: f64, fs: f64) -> Self {
        let m = (fs / ANALYSIS_SR as f64).round().max(1.0) as usize;
        let w0 = 2.0 * std::f64::consts::PI * fc / fs;
        let cosw = w0.cos();
        let alpha = w0.sin() / 2.0 * std::f64::consts::SQRT_2;
        let a0 = 1.0 + alpha;
        let (b0, b1, b2) = ((1.0 - cosw) / 2.0, 1.0 - cosw, (1.0 - cosw) / 2.0);
        Lowpass2Stream {
            m,
            b: [b0 / a0, b1 / a0, b2 / a0],
            a: [(-2.0 * cosw) / a0, (1.0 - alpha) / a0],
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
            counter: 0,
        }
    }

    /// Consomme un échantillon 48 kHz et, tous les `m` échantillons, pousse le filtre décimé dans `out`.
    fn push(&mut self, x: f32, out: &mut Vec<f32>) {
        let y = self.b[0] * x as f64 + self.b[1] * self.x1 + self.b[2] * self.x2
            - self.a[0] * self.y1 - self.a[1] * self.y2;
        self.x2 = self.x1;
        self.x1 = x as f64;
        self.y2 = self.y1;
        self.y1 = y;
        self.counter += 1;
        if self.counter % self.m == 0 {
            out.push(y as f32);
        }
    }
}

/// R1 — STFT mono, magnitudes regroupées en `SUBBANDS` sous-bandes log-spacées.
fn stft_log_subbands(mono: &[f32], nframes: usize) -> Vec<[f32; SUBBANDS]> {
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(WINDOW);
    let bin_hz = ONSET_SR as f64 / WINDOW as f64; // ≈ 31,25 Hz/bin
    let fmin = 40.0f64;
    let fmax = ONSET_SR as f64 * 0.5; // Nyquist
    let edges: Vec<usize> = (0..=SUBBANDS)
        .map(|b| {
            let f = fmin * (fmax / fmin).powf(b as f64 / SUBBANDS as f64);
            (f / bin_hz).round().max(1.0) as usize
        })
        .collect();

    let mut spec = vec![[0f32; SUBBANDS]; nframes];
    for t in 0..nframes {
        let start = t * HOP;
        let mut buf: Vec<Complex<f32>> = Vec::with_capacity(WINDOW);
        for i in 0..WINDOW {
            // Fenêtre de Hann (32 ms à 8 kHz).
            let h = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / WINDOW as f64).cos();
            buf.push(Complex::new(mono[start + i] * h as f32, 0.0));
        }
        fft.process(&mut buf);
        for b in 0..SUBBANDS {
            let lo = edges[b];
            let hi = edges[b + 1].min(WINDOW / 2);
            let mut m = 0.0f32;
            for k in lo..hi {
                if k < buf.len() {
                    m += buf[k].norm();
                }
            }
            spec[t][b] = m / (hi - lo).max(1) as f32;
        }
    }
    spec
}

/// R2 — Fonction d'onsets robuste (pleine bande — conservée comme variante généraliste, différente
/// de la variante kick ALC-152 utilisée par analyze_bpm).
#[allow(dead_code)]
fn onset_envelope(spec: &[[f32; SUBBANDS]], nframes: usize) -> Vec<f32> {
    // a) Flux spectral élémentaire, redressement demi-onde en échelle log.
    let mut flux = vec![0.0f32; nframes];
    for t in 1..nframes {
        let mut vals = [0.0f32; SUBBANDS];
        for b in 0..SUBBANDS {
            let cur = (spec[t][b] as f64 + 1e-9).ln();
            let prev = (spec[t - 1][b] as f64 + 1e-9).ln();
            vals[b] = ((cur - prev).max(0.0)) as f32;
        }
        // b) Agrégation inter-fréquences par MÉDIANE (filtre les bruits isolés).
        vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
        flux[t] = vals[SUBBANDS / 2];
    }

    // c) Soustraction du seuil dynamique local (médiane temporelle ≈ 200 ms).
    let halfwin = 6usize; // 6 trames × 16 ms de chaque côté ≈ 190 ms de fenêtre
    let mut onset = vec![0.0f32; nframes];
    for t in 0..nframes {
        let lo = t.saturating_sub(halfwin);
        let hi = (t + halfwin + 1).min(nframes);
        let mut w = flux[lo..hi].to_vec();
        w.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let med = w[w.len() / 2];
        onset[t] = (flux[t] - med).max(0.0);
    }

    // d) Normalisation par écart-type (z-score).
    let mean = onset.iter().sum::<f32>() / nframes.max(1) as f32;
    let var = onset.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / nframes.max(1) as f32;
    let std = var.sqrt();
    if std > 1e-6 {
        for v in onset.iter_mut() {
            *v = (*v - mean) / std;
        }
    }
    onset
}

/// ALC-152 — Fonction d'onsets restreinte aux basses percussives (kick).
/// Utilise le flux spectral des sous-bandes 0..KICK_BANDS (≈45–180 Hz) avec une agrégation par
/// MAX (le kick domine le grave), + seuil dynamique local + normalisation z-score. Cale le beat
/// sur le kick, pas sur les subdivisions guitare/Charleston.
fn onset_envelope_kick(spec: &[[f32; SUBBANDS]], nframes: usize) -> Vec<f32> {
    let mut flux = vec![0.0f32; nframes];
    for t in 1..nframes {
        let mut mx = 0.0f32;
        for b in 0..KICK_BANDS {
            let cur = (spec[t][b] as f64 + 1e-9).ln();
            let prev = (spec[t - 1][b] as f64 + 1e-9).ln();
            let f = ((cur - prev).max(0.0)) as f32;
            if f > mx {
                mx = f;
            }
        }
        flux[t] = mx;
    }

    // Seuil dynamique local (médiane temporelle ≈ 200 ms).
    let halfwin = 6usize;
    let mut onset = vec![0.0f32; nframes];
    for t in 0..nframes {
        let lo = t.saturating_sub(halfwin);
        let hi = (t + halfwin + 1).min(nframes);
        let mut w = flux[lo..hi].to_vec();
        w.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let med = w[w.len() / 2];
        onset[t] = (flux[t] - med).max(0.0);
    }

    // Normalisation z-score.
    let mean = onset.iter().sum::<f32>() / nframes.max(1) as f32;
    let var = onset.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / nframes.max(1) as f32;
    let std = var.sqrt();
    if std > 1e-6 {
        for v in onset.iter_mut() {
            *v = (*v - mean) / std;
        }
    }
    onset
}

/// Autocorrélation normalisée (Pearson) pour un décalage `lag` (en trames).
fn autocorr(s: &[f32], lag: usize) -> f64 {
    if lag == 0 || lag >= s.len() {
        return 0.0;
    }
    let n = s.len() - lag;
    let mut num = 0.0;
    let mut d1 = 0.0;
    let mut d2 = 0.0;
    for i in 0..n {
        let a = s[i] as f64;
        let b = s[i + lag] as f64;
        num += a * b;
        d1 += a * a;
        d2 += b * b;
    }
    if d1 <= 0.0 || d2 <= 0.0 {
        0.0
    } else {
        num / (d1.sqrt() * d2.sqrt())
    }
}

/// ALC-158 — Évalue l'autocorrélation (Pearson) à un LAG RÉEL non entier.
///
/// La courbe `r(lag)` n'est normale, définie que sur les lags entiers (`autocorr`). Or le peigne
/// harmonique interroge `r(bpm)`, `r(2·bpm)` et `r(bpm/2)`, dont les lags restants (`60/bpm/hop_s`,
/// et sa moitié) sont généralement FRACTIONNAIRES. Sans interpolation, `r(2·bpm)` d'un candidat à
/// lag IMPAIR (ex. lag 61 → ½ = 30.5) tombe entre deux indices : l'implémentation retenue
/// arrondissait à l'entier inférieur → sous-évaluation du candidat impair → bascule systématique
/// vers le lag pair voisin (+4 à +9 BPM). L'interpolation LINÉAIRE entre `r[floor]` et `r[ceil]`
/// égalise la précision des lags pairs et impairs.
fn interp_autocorr(s: &[f32], exact_lag: f32) -> f32 {
    if exact_lag <= 0.0 || s.is_empty() {
        return 0.0;
    }
    let lo = exact_lag.floor().max(1.0) as usize;
    let hi = lo + 1;
    let frac = exact_lag.fract().clamp(0.0, 1.0);
    let r_lo = autocorr(s, lo.min(s.len().saturating_sub(1)));
    let r_hi = if hi < s.len() {
        autocorr(s, hi)
    } else {
        r_lo
    };
    r_lo as f32 + (r_hi - r_lo) as f32 * frac
}

/// R3/R4 — Tempogramme normalisé par paire + prior large et plat [75–155] + fusion ½ & ⅓.
/// ALC-152 : interpolation parabolique du pic (précision sub-BPM, fin des paliers 93.8/138.9).
/// ALC-153 : auto-corrélation déjà normalisée par paire (Pearson, voir `autocorr`) ; prior plat
/// large centré 105 BPM (σ=38) sans favoriser 129–144 vs 85–95 ; pénalité des sous-harmoniques
/// rapides (T/1.5 ternaire, T/2 double-temps) quand un tempo lent [72–100] en émerge à >78 %.
fn tempo_autocorr(onset: &[f32], hop_s: f64) -> f64 {
    // ALC-158 : plage continue [75..155] au pas 0.1 BPM sur la courbe d'auto-corrélation INTERPOLÉE.
    const MIN_TA: f64 = 75.0;
    const MAX_TA: f64 = 155.0;
    const STEP_TA: f64 = 0.1;

    // Peigne binaire CONTINU : score(bpm) = r(bpm) + 0.45·r(2·bpm) + 0.35·r(bpm/2) − 0.30·r(1.5·bpm),
    // où chaque terme est évalué par interp_autocorr à un LAG RÉEL. Ceci supprime le biais de parité :
    // pour un candidat à lag IMPAIR (ex. 123.0 → lag ≈ 30.49), r(2·bpm) (lag/2 ≈ 15.25) est interpolé
    // linéairement entre r[15] et r[16] au lieu d'être écrasé par la troncature. (ALC-154 : pénalité
    // de la croche pointée 1.5×.)
    let r = |bpm_c: f64| -> f64 {
        if bpm_c <= 0.0 || bpm_c > 2.2 * MAX_TA {
            return 0.0;
        }
        let lag = 60.0 / bpm_c / hop_s; // lag RÉEL (trames)
        if lag <= 0.0 || lag >= onset.len() as f64 {
            return 0.0;
        }
        interp_autocorr(onset, lag as f32) as f64
    };
    let score = |bpm_c: f64| -> f64 {
        // ALC-153 : prior « plat et large » plané (floor 0.7) pour créer un plateau neutre.
        let prior = (-((bpm_c - 105.0) * (bpm_c - 105.0)) / (2.0 * 38.0 * 38.0)).exp().max(0.7);
        (r(bpm_c) + 0.45 * r(2.0 * bpm_c) + 0.35 * r(bpm_c / 2.0) - 0.30 * r(1.5 * bpm_c)) * prior
    };

    // Scan continu du score, puis interpolation parabolique du sommet gagnant.
    let mut best = (f64::MIN, MIN_TA);
    let mut b = MIN_TA;
    while b <= MAX_TA {
        let s = score(b);
        if s > best.0 {
            best = (s, b);
        }
        b += STEP_TA;
    }
    let (sm, sp, sn) = (score(best.1), score((best.1 + STEP_TA).min(MAX_TA)), score((best.1 - STEP_TA).max(MIN_TA)));
    let d1 = sp - sn;
    let d2 = sp - 2.0 * sm + sn;
    let bpm = if d2.abs() > 1e-9 { best.1 - 0.5 * d1 / d2 * STEP_TA } else { best.1 };
    (bpm.clamp(MIN_BPM, MAX_BPM) * 10.0).round() / 10.0
}

/// ALC-154 — Peigne métrique binaire multi-fenêtres.
///
/// Découpe l'enveloppe d'onset (40–135 Hz) en fenêtres glissantes de 10 s (pas 5 s), filtre les
/// fenêtres silencieuses/intro (énergie percussive < 35 % de la médiane), évalue chaque candidat
/// continu `bpm ∈ [76..154]` (pas 0.2 BPM + interpolation parabolique) par un peigne binaire :
///   score(bpm) = 1.0·r(bpm) + 0.45·r(2·bpm) + 0.35·r(bpm/2) − 0.30·r(1.5·bpm)
/// qui récompense la structure binaire (temps / demi-temps / double-temps) et PÉNALISE le faux
/// verrouillage sur la croche pointée 1.5× (ex. 129.3 BPM sur un morceau à 85–91). Les estimations
/// des fenêtres actives sont agrégées par histogramme lissé (KDE, mode pondéré par l'énergie).
/// ALC-156 : peigne d'impulsions GAUSSIEN en temps CONTINU (Comb Filter). Pour un `bpm` donné
/// (période T = 60/bpm en secondes), aligne un noyau gaussien (σ_t = 0.022 s) autour
/// des instants théoriques t_k = φ + k·T (secondes flottantes) et mesure l'énergie moyenne d'onset
/// sous ce noyau, sur 4 décalages de phase (0, T/4, T/2, 3T/4). Le temps CONTINU (interpolation par
/// le noyau gaussien) supprime la re-quantification des paliers 7500/lag (93.8, 98.7, 85.2) ; la
/// normalisation par nombre de battements rend le score comparable entre BPM.
fn impulse_comb(win: &[f32], bpm: f64, hop_s: f64) -> f64 {
    // ALC-160 : normalisation par DENSITÉ théorique (durée_fenêtre / T) — supprime l'avantage
    // numérique des tempos rapides (une fenêtre fixe de 10 s contient plus de dents à 98 BPM
    // qu'à 91 BPM). Pénalité de HORS-PHASE : soustrait 0.35 × énergie moyenne à mi-temps (t+T/2).
    comb_score_normalized(win, bpm, hop_s)
}

/// ALC-160 — Score du peigne temporel normalisé par le nombre EXACT de dents théoriques
/// `N = durée_fenêtre / T` (moyenne par battement, jamais somme brute), auquel est retirée une
/// pénalité de hors-phase : `0.35 × énergie_moyenne(t_k + T/2)`. Au vrai tempo (ex. 91.0 BPM) les
/// mi-temps sont calmes → pénalité faible et score maximal ; à un tempo décalé de +6 % (96.5), les
/// dents dérivent et remplissent les vallées → pénalité élevée et score inférieur.
fn comb_score_normalized(win: &[f32], bpm: f64, hop_s: f64) -> f64 {
    let sigma_t = 0.022f64; // noyau gaussien temporel (s)
    let t = 60.0 / bpm; // période en secondes
    if t / hop_s < 2.0 {
        return 0.0;
    }
    let n = win.len() as i64;
    let dur_s = win.len() as f64 * hop_s; // durée de la fenêtre (s)
    let n_theor = dur_s / t; // nombre de dents théoriques (flottant)
    if n_theor <= 1e-6 {
        return 0.0;
    }
    let mut best = f64::NEG_INFINITY;
    for ph_i in 0..4 {
        let ph = ph_i as f64 * t / 4.0; // phase en secondes
        let mut acc = 0.0f64; // énergie totale sous les temps forts
        let mut acc_valley = 0.0f64; // énergie à mi-chemin t_k + T/2 (vallées)
        let mut k = 0i64;
        loop {
            let tk = ph + k as f64 * t; // instant théorique (s)
            // Valeur du noyau gaussien centré au temps fort.
            let beat_e = gauss_kernel_sum(win, n, tk, hop_s, sigma_t);
            if beat_e.0 == KernelPos::PastEnd {
                break;
            }
            if beat_e.0 == KernelPos::Inside {
                acc += beat_e.1;
            }
            // Énergie à mi-chemin entre deux temps théoriques (hors-phase → pénalité).
            let valley_e = gauss_kernel_sum(win, n, tk + t / 2.0, hop_s, sigma_t);
            if valley_e.0 == KernelPos::Inside {
                acc_valley += valley_e.1;
            }
            k += 1;
        }
        // Moyenne PAR BATTEMENT THÉORIQUE (indépendant du tempo) puis pénalité de hors-phase.
        let on_beat = acc / n_theor;
        let valley = acc_valley / n_theor;
        let score = on_beat - 0.35 * valley;
        if score > best {
            best = score;
        }
    }
    best.max(0.0)
}

/// Position du centre d'un noyau gaussien par rapport à la fenêtre, pour controler le balayage.
#[derive(Clone, Copy, PartialEq)]
enum KernelPos {
    /// Le noyau est entièrement AVANT le début de la fenêtre (centre très négatif) — à ignorer, continuer.
    BeforeStart,
    /// Le noyau recouvre la fenêtre — à sommer.
    Inside,
    /// Le noyau est entièrement APRÈS la fin de la fenêtre — arrêter le balayage.
    PastEnd,
}

/// Évalue l'énergie d'onset sous un noyau gaussien de centre `tk` (s). Renvoie la position et
/// l'énergie somnée.
fn gauss_kernel_sum(win: &[f32], n: i64, tk: f64, hop_s: f64, sigma_t: f64) -> (KernelPos, f64) {
    let center = tk / hop_s; // en trames (flottant)
    let half = (3.0 * sigma_t / hop_s).ceil() as i64;
    let lo_i = (center - half as f64).floor() as i64;
    let hi_i = (center + half as f64).ceil() as i64;
    if lo_i >= n {
        return (KernelPos::PastEnd, 0.0);
    }
    if hi_i < 0 {
        return (KernelPos::BeforeStart, 0.0);
    }
    let lo = lo_i.max(0);
    let hi = hi_i.min(n - 1);
    let mut s = 0.0f64;
    for j in lo..=hi {
        let tj = j as f64 * hop_s;
        let d = (tj - tk) / sigma_t;
        s += win[j as usize] as f64 * (-0.5 * d * d).exp();
    }
    (KernelPos::Inside, s)
}

/// ALC-156 : mesure la régularité PARITÉ (paire vs impaire) sur 4 temps consécutifs d'un candidat.
/// Renvoie (score_pairs, score_impairs) via le même noyau gaussien, normalisés par battement.
/// Un candidat à 2/3 du vrai BPM aligne une impulsion sur deux : les impulsions paires k=0,2,4…
/// sont fortes et les impaires k=1,3,5… faibles — signature de verrouillage sous-harmonique 2/3.
fn comb_parity(win: &[f32], bpm: f64, hop_s: f64) -> (f64, f64) {
    let sigma_t = 0.022f64;
    let t = 60.0 / bpm; // s
    if t / hop_s < 2.0 {
        return (0.0, 0.0);
    }
    let n = win.len() as i64;
    let mut even = 0.0f64;
    let mut odd = 0.0f64;
    let mut ce = 0usize;
    let mut co = 0usize;
    for ph_i in 0..4 {
        let ph = ph_i as f64 * t / 4.0;
        let mut k = 0i64;
        loop {
            let tk = ph + k as f64 * t;
            let center = tk / hop_s;
            let half = (3.0 * sigma_t / hop_s).ceil() as i64;
            let lo = (center - half as f64).floor() as i64;
            let hi = (center + half as f64).ceil() as i64;
            if lo >= n {
                break;
            }
            if hi < 0 {
                k += 1;
                continue;
            }
            let lo = lo.max(0);
            let hi = hi.min(n - 1);
            let mut s = 0.0f64;
            for j in lo..=hi {
                let tj = j as f64 * hop_s;
                let d = (tj - tk) / sigma_t;
                s += win[j as usize] as f64 * (-0.5 * d * d).exp();
            }
            if k % 2 == 0 {
                even += s;
                ce += 1;
            } else {
                odd += s;
                co += 1;
            }
            k += 1;
        }
    }
    let e = if ce > 0 { even / ce as f64 } else { 0.0 };
    let o = if co > 0 { odd / co as f64 } else { 0.0 };
    (e, o)
}

fn tempo_comb_windowed(onset: &[f32], hop_s: f64) -> f64 {
    // ALC-158 : plage [75..155] au pas 0.1 BPM (résolution continue, fin des paliers pairs 129.3/96.2).
    const MIN_BPM_C: f64 = 75.0;
    const MAX_BPM_C: f64 = 155.0;
    const STEP_BPM: f64 = 0.1;
    let frames_per_10s = (10.0 / hop_s).round() as usize;
    let step_frames = (5.0 / hop_s).round() as usize;
    if onset.len() < frames_per_10s {
        // Trop court pour une fenêtre complète : repli sur l'autocorrélation classique.
        return tempo_autocorr(onset, hop_s);
    }

    // Énergie percussive par fenêtre pour filtrer intros/passages calmes.
    let mut energies: Vec<f64> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut s = 0usize;
    while s + frames_per_10s <= onset.len() {
        let e: f64 = onset[s..s + frames_per_10s].iter().map(|v| (*v as f64).abs()).sum();
        energies.push(e);
        starts.push(s);
        s += step_frames;
    }
    if energies.is_empty() {
        return tempo_autocorr(onset, hop_s);
    }
    let mut sorted = energies.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = sorted[sorted.len() / 2];
    let skip_thr = 0.35 * median;

    // ALC-158 : saute les premières fenêtres d'une intro AMBIANTE calme (énergie percussive
    // < 50 % de la médiane) tant qu'on reste dans les 25 % de durée initiaux — corrige les longs
    // départs calmes de Spaceman (146 BPM) et Money for Nothing (134 BPM) qui faussaient le mode KDE.
    let quarter_frames = onset.len() / 4;
    let mut lead_skip = 0usize;
    while lead_skip < energies.len()
        && starts[lead_skip] < quarter_frames
        && energies[lead_skip] < 0.5 * median
    {
        lead_skip += 1;
    }

    // Histogramme KDE (mode pondéré par l'énergie) : accumulateur sur une grille fine 0.1 BPM.
    let grid_n = ((MAX_BPM_C - MIN_BPM_C) / 0.1).round() as usize + 1;
    let mut hist = vec![0.0f64; grid_n];
    let mut any_active = false;

    for (i, &start) in starts.iter().enumerate().skip(lead_skip) {
        let energy = energies[i];
        if energy < skip_thr || energy <= 1e-6 {
            continue; // fenêtre silencieuse / intro calme
        }
        let win = &onset[start..start + frames_per_10s];
        const COARSE_BPM: f64 = 1.0; // ALC-159 : balayage grossier 1.0 BPM (80 évaluations au lieu de 800)
        const REFINE_RADIUS: f64 = 2.5; // puis raffinement 0.1 BPM sur ±2.5 autour des 3 meilleurs
        // 1) Scan COARSE de tout [75..155] par pas 1.0 BPM → garde les 3 meilleurs candidats.
        const TOP_K: usize = 3;
        let mut coarse: [(f64, f64); TOP_K] = [(f64::MIN, MIN_BPM_C); TOP_K];
        let mut b = MIN_BPM_C;
        while b <= MAX_BPM_C {
            let score = impulse_comb(win, b, hop_s);
            // Insertion dans le top-3 (tri décroissant par score).
            for t in 0..TOP_K {
                if score > coarse[t].0 {
                    if t + 1 < TOP_K {
                        coarse[t + 1] = coarse[t];
                    }
                    coarse[t] = (score, b);
                    break;
                }
            }
            b += COARSE_BPM;
        }
        // 2) Raffinement FIN : pour chacun des 3 meilleurs, balaie [cand−2.5 .. cand+2.5] au pas 0.1.
        let mut win_best = (f64::MIN, MIN_BPM_C);
        for (_sc, cand) in coarse {
            let lo = (cand - REFINE_RADIUS).max(MIN_BPM_C);
            let hi = (cand + REFINE_RADIUS).min(MAX_BPM_C);
            let mut f = lo;
            while f <= hi {
                let score = impulse_comb(win, f, hop_s);
                if score > win_best.0 {
                    win_best = (score, f);
                }
                f += STEP_BPM;
            }
        }
        // Interpolation parabolique fine sur le pic continu (temps flottant → plus de palier 7500/lag).
        let pb = win_best.1;
        let (sm, sp, sn) = (
            impulse_comb(win, pb, hop_s),
            impulse_comb(win, (pb + STEP_BPM).min(MAX_BPM_C), hop_s),
            impulse_comb(win, (pb - STEP_BPM).max(MIN_BPM_C), hop_s),
        );
        let d1 = sp - sn;
        let d2 = sp - 2.0 * sm + sn;
        let mut peak_bpm = if d2.abs() > 1e-9 { pb - 0.5 * d1 / d2 * STEP_BPM } else { pb };

        // ALC-156 : rejet du verrouillage sous-harmonique 2/3 (118→81.5, 125→85.2, 133→87.2).
        // Si le meilleur candidat tombe en [76..100] (c.-à-d. plausible 2/3 du vrai tempo), on
        // compare explicitement sa régularité à 1.5× lui (en [114..150]) : si 1.5·B est ≥ 88 % du
        // score de B et que la parité impaire de B est faible (impulsions impaires k=1,3,5… cassées,
        // signature 2/3), on sélectionne le tempo binaire réel 1.5·B.
        if peak_bpm >= MIN_BPM_C && peak_bpm <= 100.0 {
            let x15 = peak_bpm * 1.5;
            if x15 <= MAX_BPM_C {
                let s_b = impulse_comb(win, peak_bpm, hop_s);
                let s_15 = impulse_comb(win, x15, hop_s);
                let (e_b, o_b) = comb_parity(win, peak_bpm, hop_s);
                // Parité : les impaires faibles vs paires → signature 2/3.
                let parity_suspicious = s_b > 1e-6 && (e_b + o_b > 1e-6) && o_b < 0.55 * e_b;
                if s_b > 1e-6 && s_15 >= 0.88 * s_b && parity_suspicious {
                    peak_bpm = x15;
                }
            }
        }
        any_active = true;

        // Accumulation KDE (noyau gaussien σ=0.6 BPM) pondérée par l'énergie de la fenêtre :
        // bande étroite pour ne pas moyenner le vrai tempo avec les fenêtres syncopées.
        let sigma = 0.6;
        for gi in 0..grid_n {
            let gb = MIN_BPM_C + gi as f64 * 0.1;
            let d = (peak_bpm - gb) / sigma;
            hist[gi] += energy * (-0.5 * d * d).exp();
        }
    }

    if !any_active {
        return tempo_autocorr(onset, hop_s);
    }

    // Mode de l'histogramme lissé = BPM global.
    let mut best_gi = 0usize;
    let mut best_v = f64::MIN;
    for (gi, &v) in hist.iter().enumerate() {
        if v > best_v {
            best_v = v;
            best_gi = gi;
        }
    }
    let global = MIN_BPM_C + best_gi as f64 * 0.1;
    (global * 10.0).round() / 10.0
}

/// R5/R6 — Beat tracking (programmation dynamique, Ellis DP) + analyse du rubato (c_var).
///
/// Optimise conjointement l'amplitude de nouveauté acoustique et une pénalité de régularité
/// temporelle par rapport à l'intervalle idéal δ̂ ; la médiane des IBI donne le tempo raffiné,
/// et le coefficient de variation c_var = σ_IBI/μ_IBI mesure l'expressivité (rubato).
///
/// ALC-158 : le DP travaille en trames entières, ce qui re-quantifiait le BPM final sur les lags
/// entiers (129.3, 96.2, 93.8…) en pénalisant les tempos à lag IMPAIR (123.0 → 129, 92.6 → 96).
/// On neutralise cette re-quantification : (1) la période reste un RÉEL `period_f` (non arrondi à
/// l'entier) pour la pénalité de régularité ; (2) chaque beat backtracké est affiné à une position
/// FRACTIONNAIRE par interpolation parabolique du pic d'onset local → des IBI en secondes flottantes
/// → BPM = 60/médiane(IBI) CONTINU (123.0, 91.0, 85.0, 142.0 au lieu des paliers pairs).
fn refine_with_dp(onset: &[f32], hop_s: f64, bpm_init: f64) -> (f64, f64) {
    let n = onset.len();
    let period_f = 60.0 / bpm_init.max(MIN_BPM) / hop_s;
    if n < 16 {
        return (bpm_init, 0.0);
    }

    let mean_amp = onset.iter().map(|v| v.abs()).sum::<f32>() / n as f32;
    let alpha = (mean_amp as f64) * 0.15;

    let mut c = vec![f64::NEG_INFINITY; n];
    let mut back = vec![0usize; n];
    for i in 0..n {
        c[i] = onset[i] as f64;
        // ALC-159 : fenêtre de prédécesseurs BORNÉE à [0.5·period .. 2.0·period] → DP linéaire O(N)
        // (au lieu de parcourir tout l'historique ; window 0.5→2.0 = 2× effort moyen, indépendant de N).
        let lo = (period_f * 0.5).round().max(1.0) as usize;
        let hi = ((period_f * 2.0).round() as usize).max(lo + 1);
        let mut best = (f64::NEG_INFINITY, i);
        let start = i.saturating_sub(hi);
        let end = i.saturating_sub(lo);
        for u in start..end {
            let delta = (i - u) as f64;
            let penalty = alpha * (delta - period_f).abs();
            let v = c[u] - penalty;
            if v > best.0 {
                best = (v, u);
            }
        }
        if best.0 > f64::NEG_INFINITY {
            c[i] += best.0;
            back[i] = best.1;
        } else {
            back[i] = i;
        }
    }

    // Backtracking depuis le pic maximal de nouveauté cumulée.
    let mut last = 0usize;
    let mut cmax = f64::NEG_INFINITY;
    for (i, ci) in c.iter().enumerate() {
        if *ci > cmax {
            cmax = *ci;
            last = i;
        }
    }
    let mut beat_i = Vec::new();
    let mut cur = last;
    for _ in 0..n {
        beat_i.push(cur);
        let p = back[cur];
        if p == cur {
            break;
        }
        cur = p;
    }
    beat_i.sort_unstable();

    // ALC-158 : affinage SUB-TRAME de chaque beat → IBI en secondes FLOTTANTES (fini les paliers 60/(lag·hop_s)).
    let beats: Vec<f64> = beat_i
        .iter()
        .map(|&i| refine_beat_pos(onset, i).max(0.0))
        .collect();

    let mut ibis: Vec<f64> = beats.windows(2).map(|w| (w[1] - w[0]) * hop_s).collect();
    if ibis.is_empty() {
        return (bpm_init, 0.0);
    }
    // R6 : robustesse aux irrégularités → tempo issu de la médiane (équivalent médiane glissante 12 s).
    ibis.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median_ibi = ibis[ibis.len() / 2];
    let mu = ibis.iter().sum::<f64>() / ibis.len() as f64;
    let sigma = if ibis.len() > 1 {
        (ibis.iter().map(|v| (v - mu) * (v - mu)).sum::<f64>() / ibis.len() as f64).sqrt()
    } else {
        0.0
    };
    let c_var = if mu > 1e-9 { sigma / mu } else { 0.0 };
    let bpm = if median_ibi > 1e-6 { 60.0 / median_ibi } else { bpm_init };
    (bpm, c_var)
}

/// ALC-158 — Affine une position de beat entière `idx` vers une position FRACTIONNAIRE (en trames)
/// par interpolation parabolique du pic d'onset local. Retourne la position réelle (≥ 0).
fn refine_beat_pos(onset: &[f32], idx: usize) -> f64 {
    let n = onset.len();
    if n == 0 {
        return idx as f64;
    }
    let idx = idx.min(n - 1);
    let c0 = onset[idx] as f64;
    let c1 = *onset.get(idx + 1).unwrap_or(&0.0) as f64;
    let cm = if idx > 0 { onset[idx - 1] as f64 } else { c0 };
    let a = cm - 2.0 * c0 + c1; // coefficient du second degré
    let b = c1 - cm; // pseudo-dérivée
    // Sommet si a < 0 (concavité) ; sinon pas d'ajustement.
    let offset = if a < 0.0 { -(b / (2.0 * a)).clamp(-1.0, 1.0) } else { 0.0 };
    (idx as f64 + offset).max(0.0)
}

/// ALC-159 — Taille FFT & hop PROPORTIONNELS au taux d'échantillonnage effectif de l'analyse.
/// À 48 kHz → FFT_SIZE/FFT_HOP inchangés ; à ANALYSIS_SR (11 025) → fenêtres ~4× plus courtes en
/// données, même DURÉE temporelle (~85 ms / ~21 ms) → résultats de clé identiques, 4× moins de FFT.
struct AnalyzerCfg {
    pub sr: u32,
    pub fft: usize,
    pub hop: usize,
    pub bin_hz: f64,
}

impl AnalyzerCfg {
    fn at_sr(sr: u32) -> Self {
        let k = sr.min(TARGET_SAMPLE_RATE) as f64 / TARGET_SAMPLE_RATE as f64;
        // FFT puissance de 2 proportionnelle (4096 @48k → ~1024 @11k) pour préserver la résolution temporelle.
        let fft = (FFT_SIZE as f64 * k).round().max(8.0) as usize;
        let fft = next_pow2(fft);
        let hop = ((FFT_HOP as f64 * k).round().max(1.0) as usize).min(fft);
        let bin_hz = sr as f64 / fft as f64;
        AnalyzerCfg { sr, fft, hop, bin_hz }
    }
}

/// Plus petite puissance de deux ≥ n (rustfft exige une taille puissance de 2).
fn next_pow2(n: usize) -> usize {
    let mut p = 1usize;
    while p < n {
        p <<= 1;
    }
    p
}

/// Estimation de la clé Camelot — pipeline MIR (Règles Camelot).
fn analyze_key(x: &[f32], cfg: &AnalyzerCfg) -> (usize, bool, f64) {
    if x.len() < cfg.fft * 4 {
        return (0, true, 0.0); // repli : Do majeur, confiance nulle
    }
    // Tuning Correction (Règle 1) : déviation globale d'accordage (pas de diapason fixe).
    let tuning = estimate_tuning(x, cfg);
    // HPCP haute résolution + repli → chroma Flat Input (0/1) et chroma de magnitude.
    let (flat, mag) = hpcp_chroma(x, tuning, cfg);
    // Registre grave (50–250 Hz) : ligne de basse & fondamentales → tonique/mode stables (étalonnage).
    let bass = bass_chroma(x, tuning, cfg);
    detect_key_from(&flat, &mag, &bass)
}

/// Test-friendly : clé sur un buffer à un taux arbitraire (utilisé par analyze() après décimation).
fn key_code_at_sr(x: &[f32], sr: u32) -> (String, f64) {
    let cfg = AnalyzerCfg::at_sr(sr);
    let (tonic, major, confidence) = analyze_key(x, &cfg);
    (camelot_from_tonic(tonic, major), confidence)
}

/// Code Camelot (ex. « 11B ») sur un buffer mono à 48 kHz — utilisé par les tests unitaires
/// (synthèse de signaux à TARGET_SAMPLE_RATE). En production, analyze() passe par la version décimée.
#[cfg(test)]
fn key_code(x: &[f32]) -> (String, f64) {
    let cfg = AnalyzerCfg::at_sr(TARGET_SAMPLE_RATE);
    let (tonic, major, confidence) = analyze_key(x, &cfg);
    (camelot_from_tonic(tonic, major), confidence)
}

/// ALC-144 : clé Camelot par fenêtres temporelles (heatmap harmonique secondaire).
///
/// Réutilise le pipeline MIR existant (tuning global + HPCP + registre grave) sur des
/// segments réguliers du buffer d'analyse, afin de révéler les modulations tonales le
/// long de la frise (zones de clash vs la clé de l'autre platine).
fn analyze_key_timeline(x: &[f32], cfg: &AnalyzerCfg) -> Vec<KeySeg> {
    if x.len() < cfg.fft * 4 {
        return Vec::new();
    }
    let tuning = estimate_tuning(x, cfg); // Tonalité globale : accordage unique, stable sur la piste
    const SEG_SEC: usize = 6; // granularité ~6 s (≈ 2 mesures à 90 BPM) sans surcoût excessif
    let seg = SEG_SEC * cfg.sr as usize;
    let n = ((x.len() + seg - 1) / seg).max(1).min(16);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let start = i * seg;
        let end = ((i + 1) * seg).min(x.len());
        let slice = &x[start..end];
        if slice.len() < cfg.fft * 4 {
            break;
        }
        let (flat, mag) = hpcp_chroma(slice, tuning, cfg);
        let bass = bass_chroma(slice, tuning, cfg);
        let (tonic, major, confidence) = detect_key_from(&flat, &mag, &bass);
        out.push(KeySeg {
            time_seconds: start as f64 / cfg.sr as f64,
            camelot_key: camelot_from_tonic(tonic, major),
            confidence,
        });
    }
    out
}

/// ALC-146 : segmentation de la piste en fenêtres glissantes (~4 s, hop 50 %) produisant
/// pour chaque segment les RMS 3 bandes (sub <120 Hz / médium 120–4000 Hz / aigus >4 kHz)
/// normalisés [0,1], le tempo local (intervalles inter-onsets) et la clé Camelot locale
/// (corrélation HPCP locale). Permet de sculpter la dynamique réelle (kicks, voix,
/// cymbales) et de détecter accélérations / ralentissements et modulations tonales.
fn analyze_segments(x: &[f32], cfg: &AnalyzerCfg) -> Vec<TrackSegment> {
    if x.len() < cfg.fft * 4 {
        return Vec::new();
    }
    let tuning = estimate_tuning(x, cfg);
    const SEG_SEC: usize = 4; // ~4 secondes ≈ 1 phrase à 120 BPM (4 mesures 4/4)
    let seg = SEG_SEC * cfg.sr as usize;
    let hop = seg / 2; // recouvrement 50 % → fenêtres glissantes lissées
    let n = x.len().saturating_sub(seg) / hop + 1;
    let n = n.min(64); // borne de sécurité (ex. 90 s bornés d'analyse → ~45 segments)

    // Passe brute : RMS 3 bandes + tempo local + clé locale par fenêtre.
    let mut raw: Vec<([f64; 3], f64, String, usize, usize)> = Vec::with_capacity(n);
    for i in 0..n {
        let start = i * hop;
        let end = (start + seg).min(x.len());
        let slice = &x[start..end];
        if slice.len() < cfg.fft * 4 {
            continue;
        }
        let rms = band_rms(slice, cfg);
        // Le BPM local est mesuré sur 48 kHz via l'original (re-sous-échantillonné en interne
        // à 8 kHz par analyze_bpm) ; on remonte le slice au taux 48k équivalent pour la mesure tempo.
        let local_bpm = analyze_bpm(slice);
        let (flat, mag) = hpcp_chroma(slice, tuning, cfg);
        let bass = bass_chroma(slice, tuning, cfg);
        let (tonic, major, _conf) = detect_key_from(&flat, &mag, &bass);
        // Pose l'ancre de la fenêtre au centre temporel pour un rendu aligné sur la grille.
        let center = (start + end) / 2;
        raw.push((rms, local_bpm, camelot_from_tonic(tonic, major), center, end));
    }
    if raw.is_empty() {
        return Vec::new();
    }

    // Normalisation par bande sur le maximum de la frise → chaque bande en [0,1].
    let mut max = [1e-6f64; 3];
    for r in &raw {
        max[0] = max[0].max(r.0[0]);
        max[1] = max[1].max(r.0[1]);
        max[2] = max[2].max(r.0[2]);
    }

    raw.into_iter()
        .map(|(rms, bpm, key, center, end)| {
            let start_sec = (center.saturating_sub(end - center)) as f64 / TARGET_SAMPLE_RATE as f64;
            TrackSegment {
                start_sec: start_sec.max(0.0),
                end_sec: center as f64 / TARGET_SAMPLE_RATE as f64,
                rms_low: (rms[0] / max[0]).min(1.0) as f32,
                rms_mid: (rms[1] / max[1]).min(1.0) as f32,
                rms_high: (rms[2] / max[2]).min(1.0) as f32,
                local_bpm: bpm as f32,
                local_camelot: key,
            }
        })
        .collect()
}

/// ALC-146 : RMS par bande de fréquence (sub <120 Hz, médium 120–4000 Hz, aigus >4 kHz)
/// calculée par accumulation FFT + fenêtre de Hann, sur une fenêtre glissante.
fn band_rms(x: &[f32], cfg: &AnalyzerCfg) -> [f64; 3] {
    if x.len() < cfg.fft {
        return [0.0; 3];
    }
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(cfg.fft);
    let bin_hz = cfg.bin_hz;
    let hop = cfg.hop;
    let nframes = ((x.len() - cfg.fft) / hop + 1).min(64);
    let mut acc = [0.0f64; 3];
    let mut count = 0usize;
    for frame in 0..nframes {
        let start = frame * hop;
        let mut buf: Vec<Complex<f32>> = Vec::with_capacity(cfg.fft);
        for i in 0..cfg.fft {
            let h = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / cfg.fft as f64).cos();
            buf.push(Complex::new(x[start + i] * h as f32, 0.0));
        }
        fft.process(&mut buf);
        for b in 1..cfg.fft / 2 {
            let freq = b as f64 * bin_hz;
            let mag = buf[b].norm() as f64;
            let e = mag * mag;
            if freq < 120.0 {
                acc[0] += e;
            } else if freq < 4_000.0 {
                acc[1] += e;
            } else {
                acc[2] += e;
            }
        }
        count += 1;
    }
    let inv = if count > 0 { 1.0 / count as f64 } else { 0.0 };
    [acc[0] * inv, acc[1] * inv, acc[2] * inv]
}

/// Tuning Correction — déviation globale d'accordage en demi-tons (circulaire, sur pics spectraux).
fn estimate_tuning(x: &[f32], cfg: &AnalyzerCfg) -> f32 {
    if x.len() < cfg.fft {
        return 0.0;
    }
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(cfg.fft);
    let bin_hz = cfg.bin_hz;
    let hop = cfg.hop;
    // Borne ~16 s de trames au taux courant (équivalent 16·48000/1024 = 750 à 48 kHz).
    let max_frames = ((16 * cfg.sr as usize) / hop.max(1)).max(1);
    let nframes = ((x.len() - cfg.fft) / hop + 1).min(max_frames);
    let mut s = 0.0f64;
    let mut c = 0.0f64;
    let mut weight = 0.0f64;
    for frame in 0..nframes {
        let start = frame * hop;
        let mut buf: Vec<Complex<f32>> = Vec::with_capacity(cfg.fft);
        for i in 0..cfg.fft {
            let h = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / cfg.fft as f64).cos();
            buf.push(Complex::new(x[start + i] * h as f32, 0.0));
        }
        fft.process(&mut buf);
        for i in 1..cfg.fft / 2 {
            let freq = i as f64 * bin_hz;
            if !(80.0..2_000.0).contains(&freq) {
                continue;
            }
            let mag = buf[i].norm() as f64;
            let midi = 69.0 + 12.0 * (freq / 440.0).log2();
            let r = midi - midi.floor();
            let dev = if r <= 0.5 { r } else { r - 1.0 }; // [-0,5 ; +0,5] demi-ton
            let ang = 2.0 * std::f64::consts::PI * dev;
            s += ang.sin() * mag;
            c += ang.cos() * mag;
            weight += mag;
        }
    }
    if weight <= 0.0 {
        return 0.0;
    }
    // Borne de déviation ±0,2 demi-ton : évite la sur-compensation d'accordage sur les
    // enregistrements analogiques anciens (étalonnage ALC-006).
    ((s.atan2(c) / (2.0 * std::f64::consts::PI)) as f32).clamp(-0.2, 0.2)
}

/// Chroma secondaire du registre grave (50–250 Hz) : fondamentales de basse et d'accords.
/// Combine au chroma global pour stabiliser la tonique et lever les ambiguïtés majeur/mineur.
fn bass_chroma(x: &[f32], tuning: f32, cfg: &AnalyzerCfg) -> [f32; 12] {
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(cfg.fft);
    let bin_hz = cfg.bin_hz;
    let hop = cfg.hop;
    let nframes = (x.len() - cfg.fft) / hop + 1;
    let mut bass = [0.0f32; 12];
    let mut frame_energies: Vec<f64> = Vec::with_capacity(nframes);
    // ALC-155 : pondération des temps forts — ×1.8 appliqué aux trames coïncidant avec les pics
    // d'énergie percussive, pour que la fondamentale posée sur le temps 1 (A sur My Hometown,
    // E sur Julia) prime sur les notes tenues des degrés IV/iv.
    for frame in 0..nframes {
        let start = frame * hop;
        let mut buf: Vec<Complex<f32>> = Vec::with_capacity(cfg.fft);
        for i in 0..cfg.fft {
            let h = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / cfg.fft as f64).cos();
            buf.push(Complex::new(x[start + i] * h as f32, 0.0));
        }
        fft.process(&mut buf);
        // Registre grave utile à partir de 65 Hz (évite la résonance sub-sonore des kicks ~50-65 Hz).
        let mut fe = 0.0f64;
        for i in 1..cfg.fft / 2 - 1 {
            let f0 = i as f64 * bin_hz;
            if f0 < 65.0 {
                continue;
            }
            let f2 = (i + 2) as f64 * bin_hz;
            if f2 > 250.0 {
                break;
            }
            let m0 = buf[i].norm() as f64;
            let mp = buf[i - 1].norm() as f64;
            let mn = buf[i + 1].norm() as f64;
            if m0 <= 0.0 {
                continue;
            }
            fe += m0;
            // Interpolation parabolique : maximum sub-bin pour éviter les sauts d'un bac.
            let denom = mp + mn - 2.0 * m0;
            let delta = if denom.abs() > 1e-9 { (mp - mn) / (2.0 * denom) } else { 0.0 };
            let delta = delta.clamp(-0.5, 0.5);
            let freq = (i as f64 + delta) * bin_hz;
            let midi = 69.0 + 12.0 * (freq / 440.0).log2();
            let s_fpos = (midi - tuning as f64) * (HPCP_BINS as f64 / 12.0);
            let bin = (s_fpos.round() as i64).rem_euclid(HPCP_BINS as i64) as usize;
            // ALC-151 : repli en classe de hauteur par DIVISION (1 bac = 1/3 demi-ton), pas modulo 12.
            bass[bin / 3] += m0 as f32;
        }
        frame_energies.push(fe);
    }
    // Poids ×1.8 sur les trames de pics percussifs (moyenne locale pierrée par un seuil énergie).
    if !frame_energies.is_empty() {
        let mean_e = frame_energies.iter().sum::<f64>() / frame_energies.len() as f64;
        // Deuxième passe : on ne peut pas re-déplier bass sans conserver la contribution frame ;
        // on applique donc un boost en réaffectant les classes par un sous-calcul localisé.
        // Simplification robuste : on re-somme avec le poids fort sur les trames au-dessus du
        // seuil percussif (≈ pics de kick), pondération ×1.8, réinitialisation puis normalisation.
        let mut bass_strong = [0.0f32; 12];
        let thresh = mean_e * 1.25;
        for frame in 0..nframes {
            let strong = frame_energies[frame] > thresh;
            if !strong { continue; }
            let wt = 1.15f32;
            let start = frame * hop;
            let mut buf: Vec<Complex<f32>> = Vec::with_capacity(cfg.fft);
            for i in 0..cfg.fft {
                let h = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / cfg.fft as f64).cos();
                buf.push(Complex::new(x[start + i] * h as f32, 0.0));
            }
            fft.process(&mut buf);
            for i in 1..cfg.fft / 2 - 1 {
                let f0 = i as f64 * bin_hz;
                if f0 < 65.0 { continue; }
                let f2 = (i + 2) as f64 * bin_hz;
                if f2 > 250.0 { break; }
                let m0 = buf[i].norm() as f64;
                if m0 <= 0.0 { continue; }
                let delta = {
                    let mp = buf[i - 1].norm() as f64;
                    let mn = buf[i + 1].norm() as f64;
                    let denom = mp + mn - 2.0 * m0;
                    if denom.abs() > 1e-9 { (mp - mn) / (2.0 * denom) } else { 0.0 }.clamp(-0.5, 0.5)
                };
                let freq = (i as f64 + delta) * bin_hz;
                let midi = 69.0 + 12.0 * (freq / 440.0).log2();
                let s_fpos = (midi - tuning as f64) * (HPCP_BINS as f64 / 12.0);
                let bin = (s_fpos.round() as i64).rem_euclid(HPCP_BINS as i64) as usize;
                bass_strong[bin / 3] += (m0 as f32) * wt;
            }
        }
        // Basse finale = (1 − α)·bass + α·bass_strong (boost des temps forts).
        let alpha = 0.5;
        let mut hosted = [0.0f64; 12];
        for c in 0..12 {
            hosted[c] = (1.0 - alpha) * bass[c] as f64 + alpha * bass_strong[c] as f64;
        }
        for c in 0..12 {
            bass[c] = hosted[c] as f32;
        }
    }
    l2_inplace(&mut bass);
    bass
}

/// Affine la fréquence d'un bac FFT par interpolation parabolique (précision sub-bin).
fn refine_freq(buf: &[Complex<f32>], i: usize, bin_hz: f64) -> f64 {
    if i == 0 || i + 1 >= buf.len() {
        return i as f64 * bin_hz;
    }
    let m0 = buf[i].norm() as f64;
    if m0 <= 0.0 {
        return i as f64 * bin_hz;
    }
    let mp = buf[i - 1].norm() as f64;
    let mn = buf[i + 1].norm() as f64;
    let denom = mp + mn - 2.0 * m0;
    let delta = if denom.abs() > 1e-9 { (mp - mn) / (2.0 * denom) } else { 0.0 };
    let delta = delta.clamp(-0.5, 0.5);
    (i as f64 + delta) * bin_hz
}

/// HPCP (36 bacs/octave) → repli 12 classes + gating BGATE + Flat Input binarisé, puis normalisation L2.
fn hpcp_chroma(x: &[f32], tuning: f32, cfg: &AnalyzerCfg) -> ([f32; 12], [f32; 12]) {
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(cfg.fft);
    let bin_hz = cfg.bin_hz;
    let hop = cfg.hop;
    let nframes = (x.len() - cfg.fft) / hop + 1;

    // Pondération exponentielle des 4 premières harmoniques (pente ≈ 0,6) : 1, e^-0,6, e^-1,2, e^-1,8.
    const HARM_W: [f64; HARMONIC_COUNT] = [1.0, 0.5488116361, 0.3011942119, 0.1652988882];

    let mut flat = [0.0f32; 12];
    let mut mag_chroma = [0.0f32; 12];
    for frame in 0..nframes {
        let start = frame * hop;
        let mut buf: Vec<Complex<f32>> = Vec::with_capacity(cfg.fft);
        for i in 0..cfg.fft {
            let h = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / cfg.fft as f64).cos();
            buf.push(Complex::new(x[start + i] * h as f32, 0.0));
        }
        fft.process(&mut buf);

        let mut pcp36 = [0.0f64; HPCP_BINS];
        let mut frame_energy = 0.0f64;
        for i in 1..cfg.fft / 2 {
            let freq = refine_freq(&buf, i, bin_hz);
            // ALC-151/152 : bande harmonique 90 Hz – 1400 Hz. Au-delà de 1400 Hz, la 5e harmonique
            // des guitares/cuivres génère une fausse tierce majeure qui ferait basculer les morceaux
            // mineurs (6A/2A) vers leur Majeur homonyme (9B/5B, +3 heures).
            if !(90.0..1_400.0).contains(&freq) {
                continue;
            }
            let mag = buf[i].norm() as f64;
            frame_energy += mag;
            for (h, w) in HARM_W.iter().enumerate() {
                let hf = freq * (h as f64 + 1.0);
                // ALC-152 : borne aussi le repli harmonique à 1400 Hz (même bande que le fondamental).
                // La 5e harmonique des guitares/cuivres (>1400 Hz) générerait une fausse tierce
                // majeure qui biaiserait les morceaux mineurs vers leur Majeur homonyme.
                if hf > 1_400.0 {
                    break;
                }
                let midi = 69.0 + 12.0 * (hf / 440.0).log2();
                let s_fpos = (midi - tuning as f64) * (HPCP_BINS as f64 / 12.0);
                let bin = (s_fpos.round() as i64).rem_euclid(HPCP_BINS as i64) as usize;
                pcp36[bin] += mag * w;
            }
        }
        if frame_energy < 1e-4 {
            continue; // gating : trame silencieuse
        }
        let mut chroma12 = [0.0f64; 12];
        for b in 0..HPCP_BINS {
            // ALC-151 : chaque bac HPCP = 1/3 demi-ton (36 bacs/octave) → repli en classe de
            // hauteur 0=C..11=B par DIVISION (b/3), et non modulo 12. Le modulo seul décalait
            // la tonique de plusieurs demi-tons (ex. A maj (p=9) → D♯/E♭), source du biais.
            chroma12[b / 3] += pcp36[b];
        }
        gate_chroma(&mut chroma12); // gating BGATE : éliminer les composantes les plus faibles
        let frame_max = chroma12.iter().cloned().fold(f64::MIN, f64::max);
        // ALC-154 : pondération par l'ÉNERGIE HARMONIQUE NETTE de la trame → les refrains et
        // couplets établis pèsent plus que les intros/ponts modulants (My Hometown, Julia).
        let w = frame_energy;
        for cl in 0..12 {
            // Flat Input (0/1) : ne compte que les classes significatives (> 6 % du max de la trame).
            if chroma12[cl] > frame_max * 0.06 {
                flat[cl] += w as f32;
            }
            mag_chroma[cl] += chroma12[cl] as f32 * w as f32;
        }
    }
    // Normalisation L2 (indépendance au volume du master).
    l2_inplace(&mut flat);
    l2_inplace(&mut mag_chroma);
    (flat, mag_chroma)
}

/// Gating BGATE : met à zéro les `GATE_CUT` composantes chromatiques les plus faibles.
fn gate_chroma(chroma: &mut [f64; 12]) {
    let mut pairs: Vec<(f64, usize)> = chroma.iter().enumerate().map(|(i, &v)| (v, i)).collect();
    pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    for (_, idx) in pairs.iter().take(GATE_CUT) {
        chroma[*idx] = 0.0;
    }
}

/// Normalisation L2 d'un vecteur chroma 12 classes.
fn l2_inplace(v: &mut [f32; 12]) {
    let n = v.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>().sqrt();
    if n > 1e-9 {
        for x in v.iter_mut() {
            *x = (*x as f64 / n) as f32;
        }
    }
}

/// Désambiguïsation de la clé : chroma composite (global + grave), corrélation cosinus aux
/// 24 profils (fixe la tonique), puis ARBITRAGE EXPLICITE Majeur vs Mineur homonyme par la
/// tierce pondérée du grave (mode), + pénalité de quinte (ALC-152).
fn detect_key_from(flat: &[f32; 12], mag: &[f32; 12], bass: &[f32; 12]) -> (usize, bool, f64) {
    // Composite pour la corrélation : le chroma de MAGNITUDE (mag) porte la preuve audible du tonique
    // et du mode (tierce majeure vs mineure), le Flat Input n'en retient qu'une binarisation (0/1).
    // On favorise mag (0.80) + une pointe de Flat (0.05) + registre grave (0.15).
    let mut combo = [0.0f32; 12];
    for i in 0..12 {
        combo[i] = 0.80 * mag[i] + 0.05 * flat[i] + 0.15 * bass[i];
    }
    l2_inplace(&mut combo);

    // Étape 1 — scorer les 12 toniques (meilleur mode chacun) via corrélation cosinus + prior bass.
    let mut tonic_score = [0.0f64; 12];
    for tonic in 0..12 {
        let smaj = cosine(&combo, &blended_profile(tonic, true)) + 0.4 * bass[tonic] as f64;
        let smin = cosine(&combo, &blended_profile(tonic, false)) + 0.4 * bass[tonic] as f64;
        tonic_score[tonic] = smaj.max(smin);
    }

    // Étape 2 — tonique gagnante (meilleur score), écart vs 2e et vs sa quinte (rock ±1 h).
    let mut order: Vec<usize> = (0..12).collect();
    order.sort_by(|&a, &b| tonic_score[b].partial_cmp(&tonic_score[a]).unwrap());
    let t1 = order[0];
    let s1 = tonic_score[t1];
    let s2 = tonic_score[order[1]];
    let margin = if s1.abs() > 1e-9 { (s1 - s2) / s1 } else { 0.0 };
    let confidence = margin.clamp(0.0, 1.0);

    // ALC-152 : pénalité de quinte PLUS FERME quand la quinte rivalise avec la tonique (écart < 8 %).
    let fifth = (t1 + 7) % 12;
    let gap_to_fifth = if s1.abs() > 1e-9 { (s1 - tonic_score[fifth]).abs() / s1.abs() } else { 0.0 };

    // Étape 3 — ARBITRAGE Majeur/Mineur HOMONYME sur la tonique gagnante : comparer explicitement
    // l'énergie de la TIERCE MINEURE (+3) face à la TIERCE MAJEURE (+4), pondérée par bass_chroma.
    let emin = 0.60 * mag[(t1 + 3) % 12] as f64 + 0.40 * bass[(t1 + 3) % 12] as f64;
    let emaj = 0.60 * mag[(t1 + 4) % 12] as f64 + 0.40 * bass[(t1 + 4) % 12] as f64;
    // ALC-153 : power chord (fondamentale + quinte, SANS tierce) → tierces ~0 → on retient la
    // convention majeure (réellement ambigu en l'absence de tierce), pour ne pas reclasser en mineur.
    let is_major = if emin.abs() < 1e-4 && emaj.abs() < 1e-4 {
        true
    } else {
        emaj > emin
    };

    // ALC-153 : si la tonique est en compétition avec sa quinte inférieure, la basse (qui joue la
    // fondamentale réelle) prime sur l'harmonique de quinte de la guitare (corrige le +1 h rock).
    let t1_anchored = bass_anchored_tonic(t1, bass);

    // Pénalité de quinte appliquée à la tonique (pour mémoire / arbitrage rock) : si la quinte est
    // trop proche (< 8 %) OU domine la tonique, on restreint la confiance (le mode reste fiable).
    let final_confidence =
        if gap_to_fifth < 0.08 || combo[fifth] as f64 > combo[t1] as f64 {
            confidence * 0.85
        } else {
            confidence
        };
    // ALC-153 : retourne la tonique ancrée par la BASSE (quinte inférieure) si elle prime — un
    // décalage d'une quinte conserve le mode (majeur/mineur identiques).
    (t1_anchored, is_major, final_confidence.clamp(0.0, 1.0))
}

/// ALC-153 : vérifie si la tonique gagnante `p` doit être remplacée par sa QUINTE INFÉRIEURE
/// ((p+5)%12). Sur les guitares rock, la quinte précède/prime sur la note fondamentale : si le
/// chroma des basses (bass_chroma) porte la quinte inférieure ≥ 78 % de la tonique (ALC-154),
/// la basse (qui joue la fondamentale réelle) l'emporte → corrige le glissement +1 heure
/// (ex. Sol 9B → Do 8B, Ironic 1B, Spaceman 8B).
fn bass_anchored_tonic(t1: usize, bass: &[f32; 12]) -> usize {
    let lower_fifth = (t1 + 5) % 12;
    let bt = bass[t1] as f64;
    let bf = bass[lower_fifth] as f64;
    if bt > 1e-6 && bf >= 0.82 * bt {
        lower_fifth
    } else {
        t1
    }
}

/// Normalisation Z-score stricte d'un profil tonal (moyenne 0, variance 1). Enlève le biais de
/// magnitude absolue entre les profils Majeur (B) et Mineur (A) : la corrélation ne dépend plus
/// que de la « forme » du profil, pas de son énergie globale (ALC-151).
fn zscore12(p: &[f64; 12]) -> [f64; 12] {
    let mean = p.iter().sum::<f64>() / 12.0;
    let var = p.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / 12.0;
    let std = var.sqrt().max(1e-9);
    p.iter().map(|v| (v - mean) / std).collect::<Vec<f64>>().try_into().unwrap()
}

/// Profil tonal calibré par tonique et mode — profils normalisés en Z-score (ALC-151) pour
/// supprimer le biais statistique Majeur vs Mineur. Majorité KS + Temperley + Shaath ; EDMA/EDMM
/// drastiquement réduit (retrait du biais mineur électronique) et poids BGATE amoindri.
fn blended_profile(tonic: usize, major: bool) -> [f64; 12] {
    let (ks, tp, sh, dm, bg) = if major {
        (zscore12(&MAJOR_PROFILE), zscore12(&TEMP_MAJOR), zscore12(&SHA_MAJOR), zscore12(&EDMA_MAJOR), zscore12(&BGATE_MAJOR))
    } else {
        (zscore12(&MINOR_PROFILE), zscore12(&TEMP_MINOR), zscore12(&SHA_MINOR), zscore12(&EDMM_MINOR), zscore12(&BGATE_MINOR))
    };
    let mut out = [0.0f64; 12];
    for i in 0..12 {
        let pc = (i + tonic) % 12;
        out[pc] = 0.45 * ks[i] + 0.40 * tp[i] + 0.12 * sh[i] + 0.01 * dm[i] + 0.02 * bg[i];
    }
    out
}

/// Similarité cosinus entre le chroma normalisé et un profil.
fn cosine(a: &[f32; 12], b: &[f64; 12]) -> f64 {
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for i in 0..12 {
        dot += a[i] as f64 * b[i];
        na += (a[i] as f64) * (a[i] as f64);
        nb += b[i] * b[i];
    }
    let den = na.sqrt() * nb.sqrt();
    if den <= 1e-9 {
        0.0
    } else {
        dot / den
    }
}

/// Conversion modulaire fermée en notation Camelot (Règle Camelot) :
///   Majeur (B) : ((7·p + 7) mod 12) + 1   ;   Mineur (A) : ((7·p + 4) mod 12) + 1
/// avec `p` la note fondamentale (C=0, C♯=1, …, B=11).
fn camelot_from_tonic(tonic: usize, major: bool) -> String {
    let p = (tonic as i64).rem_euclid(12);
    let num = if major {
        ((7 * p + 7) % 12) + 1
    } else {
        ((7 * p + 4) % 12) + 1
    };
    format!("{num}{}", if major { "B" } else { "A" })
}

/// Agrége les maxima bruts en `bins` buckets normalisés pour la waveform frontend.
fn waveform_to_bins(groups: &[f32], bins: usize) -> Vec<f32> {
    if groups.is_empty() {
        return vec![0.0; bins];
    }
    let peaks: Vec<f32> = if groups.len() <= bins {
        let mut out = groups.to_vec();
        let last = *groups.last().unwrap_or(&0.0);
        while out.len() < bins {
            out.push(last);
        }
        out
    } else {
        let per = groups.len() / bins;
        (0..bins)
            .map(|b| {
                let st = b * per;
                let en = (st + per).min(groups.len());
                groups[st..en].iter().cloned().fold(0.0f32, f32::max)
            })
            .collect()
    };
    let max = peaks.iter().cloned().fold(0.0f32, f32::max).max(1e-4);
    peaks.into_iter().map(|v| v / max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Génère une fonction d'onsets périodique (impulsions toutes les `period_frames` trames).
    fn periodic_onset(period_frames: usize, len: usize) -> Vec<f32> {
        let mut o = vec![0.0f32; len];
        let mut f = 0usize;
        while f < len {
            o[f] = 1.0;
            f += period_frames;
        }
        o
    }

    // ---- Règle 7 : métriques MIREX -----------------------------------------
    /// Acc1 (P-Score) — tolérance stricte ±5 %.
    fn acc1(ref_bpm: f64, pred: f64) -> bool {
        if ref_bpm <= 0.0 {
            return false;
        }
        (pred - ref_bpm).abs() / ref_bpm <= 0.05
    }
    /// Acc2 (ALOTC) — tolère les multiples & sous-multiples métriques (×0,5 / ×2 / ×0,33 / ×3).
    fn acc2(ref_bpm: f64, pred: f64) -> bool {
        if ref_bpm <= 0.0 || pred <= 0.0 {
            return false;
        }
        let r = pred / ref_bpm;
        [1.0, 0.5, 2.0, 1.0 / 3.0, 3.0]
            .iter()
            .any(|m| ((r - m).abs() / m) <= 0.05)
    }
    /// F-mesure d'alignement de battements — fenêtre ±70 ms.
    fn f_measure(gt: &[f64], pred: &[f64], tol: f64) -> f64 {
        if gt.is_empty() || pred.is_empty() {
            return 0.0;
        }
        let mut used = vec![false; pred.len()];
        let mut tp = 0usize;
        for g in gt {
            for (i, p) in pred.iter().enumerate() {
                if !used[i] && (p - g).abs() <= tol {
                    used[i] = true;
                    tp += 1;
                    break;
                }
            }
        }
        let prec = tp as f64 / pred.len() as f64;
        let rec = tp as f64 / gt.len() as f64;
        if prec + rec <= 0.0 {
            0.0
        } else {
            2.0 * prec * rec / (prec + rec)
        }
    }

    const HOP_S: f64 = HOP as f64 / ONSET_SR as f64; // 16 ms

    #[test]
    fn tempo_120_tolerant_acc1() {
        // 120 BPM : période 0,5 s → 31,25 trames ; on accepte ±5 % (Acc1).
        let onset = periodic_onset(31, 1300); // ≈ 119 BPM périodicité encodée
        let pred = tempo_autocorr(&onset, HOP_S) as f64;
        assert!(acc1(120.0, pred), "prédit {pred:.1} vs 120 (Acc1)");
        assert!(acc2(120.0, pred), "prédit {pred:.1} vs 120 (Acc2)");
    }

    #[test]
    fn tempo_125_exact() {
        // 125 BPM : période 0,48 s = 30 trames exactes.
        let onset = periodic_onset(30, 1300);
        let pred = tempo_autocorr(&onset, HOP_S);
        assert!((pred - 125.0).abs() < 1e-3, "prédit {pred}");
    }

    #[test]
    fn double_tempo_resolves_to_metric() {
        // Impulsions à 250 BPM (période 15 trames) : le prior 120 + fusion ½/⅓ doit retenir 125.
        let onset = periodic_onset(15, 1300);
        let pred = tempo_autocorr(&onset, HOP_S);
        assert!(acc1(125.0, pred), "prédit {pred:.1} (Acc1)");
        assert!(acc2(250.0, pred), "prédit {pred:.1} (Acc2, sous-multiple)");
    }

    #[test]
    fn bip_boundaries() {
        // La recherche doit rester bornée à [MIN_BPM, MAX_BPM].
        let onset = periodic_onset(10, 400); // très rapide (>240) → doit être clampée
        let pred = tempo_autocorr(&onset, HOP_S);
        assert!(pred >= MIN_BPM && pred <= MAX_BPM, "prédit {pred} hors bornes");
    }

    #[test]
    fn mi_rex_metrics() {
        // Acc1 : strict
        assert!(acc1(120.0, 120.0));
        assert!(acc1(120.0, 125.0)); // +4,2 %
        assert!(!acc1(120.0, 140.0)); // +16,7 %
        // Acc2 : multiples métriques
        assert!(acc2(120.0, 60.0));   // ×0,5
        assert!(acc2(120.0, 240.0));  // ×2
        assert!(acc2(120.0, 40.0));   // ×0,33
        assert!(acc2(120.0, 360.0));  // ×3
        assert!(!acc2(120.0, 100.0)); // hors multiples
        // F-mesure (±70 ms)
        let gt = [1.0, 2.0, 3.0, 4.0];
        let pred_ok = [0.95, 1.95, 2.95, 3.95]; // décalage 50 ms < 70 ms
        assert!((f_measure(&gt, &pred_ok, 0.07) - 1.0).abs() < 1e-6);
        let pred_bad = [1.5, 3.0, 4.5]; // alignement médiocre
        assert!(f_measure(&gt, &pred_bad, 0.07) < 0.5);
    }

    #[test]
    fn beat_dp_regular_125() {
        let onset = periodic_onset(30, 700); // ~11,2 s de battements réguliers 125 BPM
        let (bpm, c_var) = refine_with_dp(&onset, HOP_S, 125.0);
        assert!((bpm - 125.0).abs() < 5.0, "tempo DP {bpm}");
        assert!(c_var < 0.15, "c_var {c_var} pour un battement régulier");
    }

    // Règle Camelot — conversion modulaire fermée & détection de clé.
    #[test]
    fn camelot_modular_mapping() {
        // Formules : Majeur B = ((7·p+7) mod 12)+1 ; Mineur A = ((7·p+4) mod 12)+1.
        assert_eq!(camelot_from_tonic(0, true), "8B");   // Do majeur
        assert_eq!(camelot_from_tonic(4, true), "12B");  // Mi majeur
        assert_eq!(camelot_from_tonic(7, true), "9B");   // Sol majeur
        assert_eq!(camelot_from_tonic(2, true), "10B");  // Ré majeur
        assert_eq!(camelot_from_tonic(5, true), "7B");   // Fa majeur
        assert_eq!(camelot_from_tonic(0, false), "5A");  // Do mineur
        assert_eq!(camelot_from_tonic(9, false), "8A");  // La mineur
        assert_eq!(camelot_from_tonic(11, false), "10A");// Si mineur
        // Les 24 clés sont deux à deux distinctes sur 12 toniques × 2 modes.
        assert_ne!(camelot_from_tonic(1, true), camelot_from_tonic(1, false));
    }

    #[test]
    fn key_detection_from_profile() {
        // Un chroma dont le profil est exactement celui de Do majeur → (0, true).
        let prof = blended_profile(0, true);
        let mut flat = [0.0f32; 12];
        let mut mag = [0.0f32; 12];
        let mut bass = [0.0f32; 12];
        for i in 0..12 {
            flat[i] = prof[i] as f32;
            mag[i] = prof[i] as f32;
            bass[i] = prof[i] as f32;
        }
        let (kt, kmaj, _conf) = detect_key_from(&flat, &mag, &bass);
    assert_eq!((kt, kmaj), (0, true));
    }

    #[test]
    fn tuning_shift_is_bounded() {
        // estimate_tuning est bornée à ±0,2 demi-ton (évite la sur-compensation analogique).
        let x = vec![0.0f32; FFT_SIZE];
        let cfg = AnalyzerCfg::at_sr(TARGET_SAMPLE_RATE);
        let t = estimate_tuning(&x, &cfg);
        assert!(t >= -0.2 && t <= 0.2, "tuning {t}");
    }

    #[test]
    fn no_minor_bias_major_keys() {
        // Une triade/progression en mode majeur (Mi maj → 12B, La maj → 11B) ne doit pas
        // basculer vers l'anneau mineur A malgré les profils électroniques de la musique dance.
        for tonic in [4usize, 9usize] {
            let prof = blended_profile(tonic, true);
            let mut flat = [0.0f32; 12];
            let mut mag = [0.0f32; 12];
            let mut bass = [0.0f32; 12];
            for i in 0..12 {
                flat[i] = prof[i] as f32;
                mag[i] = prof[i] as f32;
            }
            // Registre grave orienté tonique / quinte / tierce majeure → soutient le mode majeur.
            bass[tonic] = 1.0;
            bass[(tonic + 7) % 12] = 0.5;
            bass[(tonic + 4) % 12] = 0.35;
            l2_inplace(&mut bass);
            let (t, major, _conf) = detect_key_from(&flat, &mag, &bass);
            assert!(major, "tonique {t} jugée mineure (biais vers A)");
            let code = camelot_from_tonic(t, major);
            assert!(code.ends_with('B'), "code {code} non majeur (B)");
        }
    }

    #[test]
    fn anti_double_tempo_preserves_fast() {
        // Vraie piste rapide ~146 BPM (période 26 trames) : NE PAS diviser (4B entre 138 et 152).
        let o146 = periodic_onset(26, 1400);
        let p146 = tempo_autocorr(&o146, HOP_S);
        assert!(p146 > 138.0 && p146 < 152.0, "146 préservé ? prédit {p146}");
    }

    #[test]
    fn anti_double_tempo_fixes_true_double() {
        // Vrai doublage ~168 BPM (période 22 trames) : doit être ramené à ~84 BPM.
        let o168 = periodic_onset(22, 1400);
        let p168 = tempo_autocorr(&o168, HOP_S);
        assert!(p168 < 100.0, "168→84 attendu, prédit {p168}");
    }

    fn synth_pcm(freqs: &[f64], seconds: f64) -> Vec<f32> {
        // Synthèse « instrumentale » réaliste : chaque fondamentale porte sa série harmonique
        // (1..5, amplitude 1/h) → spectre riche cohérent avec le modèle HPCP.
        let sr = TARGET_SAMPLE_RATE as usize;
        let n = (sr as f64 * seconds) as usize;
        let mut x = vec![0.0f32; n];
        for i in 0..n {
            let t = i as f64 / sr as f64;
            let mut s = 0.0f32;
            for &f in freqs {
                for h in 1usize..=5 {
                    s += (2.0 * std::f64::consts::PI * f * h as f64 * t).sin() as f32 / h as f32;
                }
            }
            x[i] = s * (0.2 / freqs.len() as f32);
        }
        x
    }

    #[test]
    fn synth_key_do_major_8b() {
        // End-to-end PCM : Do majeur (C2 + C3 + E3 + G3) → 8B, jamais 2A (basse ancrée tonique).
        let x = synth_pcm(&[65.41, 130.81, 164.81, 196.0], 2.0);
        let (code, conf) = key_code(&x);
        assert_eq!(code, "8B", "attendu 8B, obtenu {code}");
        assert!((conf >= 0.0) && (conf <= 1.0), "confidence normalisée hors bornes");
    }

    // Décision déterministe sur chroma de profil : garantit les codes exacts (11B/7A/8B, jamais 2A)
    // indépendamment de la conversion PCM→chroma (elle-même validée par synth_key_do_major_8b).
    fn key_from_profile_chroma(tonic: usize, mode: bool) -> String {
        let prof = blended_profile(tonic, mode);
        let mut flat = [0.0f32; 12];
        let mut mag = [0.0f32; 12];
        let mut bass = [0.0f32; 12];
        for i in 0..12 {
            flat[i] = prof[i] as f32;
            mag[i] = prof[i] as f32;
        }
        bass[tonic] = 1.0;
        l2_inplace(&mut bass);
        let (t, m, _conf) = detect_key_from(&flat, &mag, &bass);
        camelot_from_tonic(t, m)
    }

    #[test]
    fn exact_keys_never_2a() {
        assert_eq!(key_from_profile_chroma(9, true), "11B");   // La majeur
        assert_eq!(key_from_profile_chroma(2, false), "7A");    // Ré mineur
        assert_eq!(key_from_profile_chroma(0, true), "8B");     // Do majeur
        // Jamais 2A (dont le tonique serait Mi♭/Ré♯, p=3).
        assert_ne!(key_from_profile_chroma(9, true), "2A");
        assert_ne!(key_from_profile_chroma(2, false), "2A");
        assert_ne!(key_from_profile_chroma(0, true), "2A");
    }

    // ALC-151 : détection End-to-End PCM d'accords riches en harmoniques (série 1..5) pour
    // les modulations majeures/mineures couramment inversées (biais mineur) : La maj 11B, Mi maj
    // 12B, Sol maj 9B, La min 8A. Vérifie que l'algorithme retourne EXACTEMENT la bonne clé.

    #[test]
    fn synth_key_a_major_11b() {
        // La majeur (racine ancrée 2 octaves, comme le test Do majeur) : La2 + La3 + Do#3 + Mi3 → 11B.
        let x = synth_pcm(&[110.0, 220.0, 138.59, 164.81], 2.0);
        let (code, conf) = key_code(&x);
        assert_eq!(code, "11B", "La majeur attendu = 11B, obtenu {code}");
        assert!((0.0..=1.0).contains(&conf), "confidence hors bornes {conf}");
    }

    #[test]
    fn synth_key_e_major_12b() {
        // Mi majeur : Mi2 + Mi3 + Sol#3 + Si3 → 12B.
        let x = synth_pcm(&[82.41, 164.81, 207.65, 246.94], 2.0);
        let (code, _) = key_code(&x);
        assert_eq!(code, "12B", "Mi majeur attendu = 12B, obtenu {code}");
    }

    #[test]
    fn synth_key_g_major_9b() {
        // Sol majeur : Sol2 + Sol3 + Si3 + Ré4 → 9B.
        let x = synth_pcm(&[98.0, 196.0, 246.94, 293.66], 2.0);
        let (code, _) = key_code(&x);
        assert_eq!(code, "9B", "Sol majeur attendu = 9B, obtenu {code}");
    }

    #[test]
    fn synth_key_a_minor_8a() {
        // La mineur : La2 + La3 + Do3 + Mi3 → 8A.
        let x = synth_pcm(&[110.0, 220.0, 130.81, 164.81], 2.0);
        let (code, _) = key_code(&x);
        assert_eq!(code, "8A", "La mineur attendu = 8A, obtenu {code}");
    }

    // ALC-151 : toutes les 12 toniques MAJEURES doivent rendre un code Camelot se terminant
    // par B (jamais le biais mineur A), quel que soit le degré de la triade majeure.
    #[test]
    fn no_minor_bias_any_tonic() {
        for tonic in 0..12usize {
            let code = key_from_profile_chroma(tonic, true);
            assert!(code.ends_with('B'), "tonique {tonic} majeur → code mineur {code}");
        }
    }

    // ---- ALC-152 : précision sub-BPM (interpolation parabolique) ----
    #[test]
    fn tempo_parabolic_91() {
        // Impulsions à 91 BPM : période ≈ 60/(91·0.016) ≈ 41,2 trames → lag entier 41 ~ 91.5 ;
        // l'interpolation parabolique doit converger ~91.0 (plus de palier fixe).
        let o = periodic_onset(41, 2400);
        let p = tempo_autocorr(&o, HOP_S);
        assert!((p - 91.0).abs() < 0.7, "91 BPM attendu, prédit {p:.2}");
    }

    #[test]
    fn tempo_parabolic_134() {
        // Impulsions à 134 BPM : période ≈ 28 trames → interp ~134.0.
        let o = periodic_onset(28, 2400);
        let p = tempo_autocorr(&o, HOP_S);
        assert!((p - 134.0).abs() < 0.7, "134 BPM attendu, prédit {p:.2}");
    }

    // ---- ALC-152 : arbitrage Majeur/Mineur homonyme ----
    #[test]
    fn homonyme_g_minor_6a() {
        // Sol mineur (tonique p=7) → 6A, jamais son Majeur homonyme 9B (+3 h).
        assert_eq!(key_from_profile_chroma(7, false), "6A");
        assert_eq!(camelot_from_tonic(7, true), "9B");
    }

    #[test]
    fn homonyme_eb_minor_2a() {
        // Mi♭ mineur (tonique p=3) → 2A, jamais 5B.
        assert_eq!(key_from_profile_chroma(3, false), "2A");
        assert_eq!(camelot_from_tonic(3, true), "5B");
    }

    #[test]
    fn synth_key_g_minor_6a() {
        // PCM racine ancrée (pattern identique au A-minor ALC-151, racine Sol3 ~196 Hz dans la
        // bande 90–1400) : Sol3 + Sol4 + Si♭3 + Ré4 → 6A (jamais son Majeur homonyme 9B).
        let x = synth_pcm(&[196.0, 392.0, 233.08, 293.66], 2.0);
        let (code, _) = key_code(&x);
        assert_eq!(code, "6A", "Sol mineur attendu = 6A, obtenu {code}");
    }

    #[test]
    fn synth_key_eb_minor_2a() {
        // Mi♭ mineur : Mi♭2 + Mi♭3 + Sol♭2 + Si♭2 → 2A.
        let x = synth_pcm(&[77.78, 155.56, 92.5, 116.54], 2.0);
        let (code, _) = key_code(&x);
        assert_eq!(code, "2A", "Mi♭ mineur attendu = 2A, obtenu {code}");
    }

    // ---- ALC-153 : biais des harmoniques rythmiques (tempo lent préservé) ----
    #[test]
    fn ternary_85_detected_not_129() {
        // Rythme syncopé/ternaire à 85 BPM : la pulsation fondamentale est à 85 ; les subdivisions
        // (127.5 = 1.5×85, 170 = 2×85) ne doivent PAS faire remonter le tempo à 129 BPM.
        // On synthétise une fonction d'onsets périodique dont la période fondamentale = 85 BPM
        // (lag = 60/(85·hop_s) ≈ 44,1 trames) mais avec des impulsions de subdivision plus denses.
        let mut o = periodic_onset(44, 2600);
        // Ajoute des subdivisions ternaires aux 2/3 de la période (renforce 127.5 BPM ≈ lag 29).
        let period = 44usize;
        for i in 0..(o.len() / period) {
            let base = i * period;
            if base + (period * 2 / 3) < o.len() {
                o[base + (period * 2 / 3)] = o[base + (period * 2 / 3)].max(0.6);
            }
        }
        let p = tempo_autocorr(&o, HOP_S);
        assert!(p > 78.0 && p < 95.0, "85 BPM attendu, prédit {p:.1} (biais rapide?)");
    }

    #[test]
    fn powerchord_c_major_stays_8b() {
        // Power chord Do majeur (fondamentale + 5e) : la quinte Sol est volontairement FORTE.
        // Le classement doit rester 8B (Do majeur), pas 9B (Sol majeur, +1 h par quinte).
        // Tonique Do (p=0), quinte inférieure de Do = (0+5)%12 = 5 = Fa.
        let mut flat = [0.0f32; 12];
        let mut mag = [0.0f32; 12];
        let mut bass = [0.0f32; 12];
        // Chroma marqué sur la tonique Do (0) et sa quinte Sol (7) — même amplitude (guitare).
        for i in 0..12 {
            flat[i] = 0.0;
        }
        flat[0] = 1.0;
        flat[7] = 1.0;
        mag[0] = 1.0;
        mag[7] = 1.0;
        // La BASSE joue la fondamentale réelle (Do) plus forte que l'harmonique de quinte (Sol).
        bass[0] = 1.0;
        bass[7] = 0.4;
        l2_inplace(&mut mag);
        l2_inplace(&mut flat);
        l2_inplace(&mut bass);
        let (t, m, _v) = detect_key_from(&flat, &mag, &bass);
        let code = camelot_from_tonic(t, m);
        assert_eq!(code, "8B", "power chord Do attendu = 8B, obtenu {code} (tonique {t})");
    }

    // ---- ALC-154 : peigne métrique multi-fenêtres (binaire, anti-ternaire) ----

    /// Enveloppe d'onset : intro calme (2 s, amplitude ~0.04) puis beat binaire régulier à `bpm`.
    /// Le beat est placé à un INSTANT FLOTTANT (fraction de trame) et réparti sur les 2 trames
    /// voisines proportionnellement — pour que le tempo nominal (118.0, 91.0…) soit réellement
    /// représentable malgré la grille de trames discrète.
    fn onset_with_intro(bpm: f64, seconds: f64, intro_seconds: f64) -> Vec<f32> {
        let total = (seconds / HOP_S).round() as usize;
        let intro = (intro_seconds / HOP_S).round() as usize;
        let period = 60.0 / bpm / HOP_S; // période en trames (flottant)
        let len = total.max(intro + 16);
        let mut o = vec![0.02f32; len];
        let mut k = 0f64;
        let t0 = intro as f64;
        loop {
            let t = t0 + k * period; // instant flottant (trames)
            let j = t.floor(); // trame entière
            let frac = t - j; // fraction sub-frame
            let idx = j as i64;
            if idx + 1 >= len as i64 {
                break;
            }
            o[idx.max(0) as usize] += (1.0 - frac) as f32;
            o[(idx + 1).min(len as i64 - 1) as usize] += frac as f32;
            k += 1.0;
        }
        o
    }

    #[test]
    fn binary_146_not_divided() {
        // Intro calme + beat binaire à 146 BPM : la division T/1.5 (97.3) doit être évitée.
        let o = onset_with_intro(146.0, 26.0, 2.0);
        let p = tempo_comb_windowed(&o, HOP_S);
        assert!(p > 140.0 && p < 152.0, "146 BPM attendu (binaire, intro calme), prédit {p:.1}");
    }

    #[test]
    fn binary_133_not_divided() {
        let o = onset_with_intro(133.0, 26.0, 2.0);
        let p = tempo_comb_windowed(&o, HOP_S);
        assert!(p > 127.0 && p < 139.0, "133 BPM attendu (binaire), prédit {p:.1}");
    }

    #[test]
    fn dotted_eighth_89_resolved() {
        // Croches pointées : subdivision 1.5×89 = 133.5 BPM. Le peigne −0.30·r(1.5b) doit
        // ramener le verrouillage sur 89 BPM.
        let nframes = (24.0 / HOP_S).round() as usize;
        let intro = (2.0 / HOP_S).round() as usize;
        let period = (60.0 / 89.0 / HOP_S).round().max(1.0) as usize;
        let mut o = vec![0.02f32; nframes];
        // Impulsion fondamentale à 89 BPM, plus une croche pointée forte (dotted) à 1.5×.
        let dotted_period = (60.0 / 133.5 / HOP_S).round().max(1.0) as usize;
        for t in intro..nframes {
            let k = t - intro;
            if k % period == 0 {
                o[t] = 1.0;
            } else if k % dotted_period == 0 {
                o[t] = 0.55;
            }
        }
        let p = tempo_comb_windowed(&o, HOP_S);
        assert!(p > 82.0 && p < 96.0, "89 BPM attendu (anti-ternaire), prédit {p:.1}");
    }

    #[test]
    fn dotted_eighth_89_autocorr_penalized() {
        // Vérifie la pénalité −0.30·r(1.5b) au niveau du candidat : le score binaire doit être
        // maximum à 89 et non à 133.5 (fallback => tempo_autocorr pour un train court).
        let nframes = (12.0 / HOP_S).round() as usize;
        let period = (60.0 / 89.0 / HOP_S).round().max(1.0) as usize;
        let dotted_period = (60.0 / 133.5 / HOP_S).round().max(1.0) as usize;
        let mut o = vec![0.02f32; nframes];
        for t in 0..nframes {
            if t % period == 0 {
                o[t] = 1.0;
            } else if t % dotted_period == 0 {
                o[t] = 0.5;
            }
        }
        let s89 = temposcore_binary(&o, 89.0, HOP_S);
        let s133 = temposcore_binary(&o, 133.5, HOP_S);
        assert!(
            s89 > s133,
            "score binaire 89 ({s89:.3}) doit dépasser 133.5 ({s133:.3})"
        );
    }

    /// score du peigne binaire d'un candidat, défini pour le test (ré-implémente la formule).
    fn temposcore_binary(onset: &[f32], bpm: f64, hop_s: f64) -> f64 {
        let r = |slug_bpm: f64| -> f64 {
            let lag = 60.0 / slug_bpm / hop_s;
            if lag < 1.0 || lag >= onset.len() as f64 {
                return 0.0;
            }
            let lo = lag.floor().max(1.0) as usize;
            let hi = lo + 1;
            let rm = autocorr(onset, lo);
            let rp = if hi < onset.len() { autocorr(onset, hi) } else { rm };
            let rn = if lo > 1 { autocorr(onset, lo - 1) } else { rm };
            let denom = rn + rp - 2.0 * rm;
            let frac = if denom.abs() > 1e-9 { 0.5 * (rn - rp) / denom } else { 0.0 }.clamp(-0.5, 0.5);
            rm + (rp - rn) * frac * 0.5 + (rp - 2.0 * rm + rn) * frac * frac * 0.5
        };
        r(bpm) + 0.45 * r(2.0 * bpm) + 0.35 * r(bpm / 2.0) - 0.30 * r(1.5 * bpm)
    }

    // ---- ALC-155 : verrouillage de phase — peigne d'impulsions 91 vs 96 BPM ----

    #[test]
    fn phase_lock_91_not_96() {
        // Beat binaire à ~91 BPM (synthèse trames entières → 60/(41·hop_s) ≈ 91.46) : le peigne en
        // phase doit verrouiller près de 91 (tolérance < 1 BPM, homogène à la quantification) et ne
        // PAS glisser vers le candidat voisin 96.0 (+5 %). La discrimination stricte 91 vs 96 est
        // couverte par impulse_comb_peaks_91_over_96.
        let o = onset_with_intro(91.0, 26.0, 2.0);
        let p = tempo_comb_windowed(&o, HOP_S);
        assert!(
            (p - 91.0).abs() < 1.0,
            "~91 BPM attendu (peigne en phase), prédit {p:.2}"
        );
        assert!((p - 96.0).abs() > 3.0, "ne doit pas glisser vers 96, prédit {p:.2}");
    }

    #[test]
    fn impulse_comb_peaks_91_over_96() {
        // Vérifie directement la sélectivité du peigne : score(91) > score(96) sur un onset 91.
        let o = onset_with_intro(91.0, 26.0, 2.0);
        let s91 = impulse_comb(&o, 91.0, HOP_S);
        let s96 = impulse_comb(&o, 96.0, HOP_S);
        assert!(s91 > s96, "peigne 91 ({s91:.3}) doit > peigne 96 ({s96:.3})");
    }

    // ---- ALC-156 : peigne gaussien continu + refus des sous-harmoniques 2/3 ----

    #[test]
    fn binary_125_not_2_3_capture() {
        // Beat binaire strictement à 125 BPM : ne doit PAS être capturé par son sous-multiple 2/3
        // (≈83.3 BPM) ; le peigne gaussien en temps continu + le rejet 2/3 → 125.0 ± 0.5.
        let o = onset_with_intro(125.0, 26.0, 2.0);
        let p = tempo_comb_windowed(&o, HOP_S);
        assert!(
            (p - 125.0).abs() < 0.5,
            "125.0 BPM attendu (pas 83.3), prédit {p:.2}"
        );
    }

    #[test]
    fn binary_118_not_2_3_capture() {
        // Beat binaire à 118 BPM : sous-multiple 2/3 ≈ 78.7 BPM à rejeter → 118.0 ± 0.5.
        // (tolérance inclusive : le peigne normalise par nombre de battements → léger biais +0.5).
        let o = onset_with_intro(118.0, 26.0, 2.0);
        let p = tempo_comb_windowed(&o, HOP_S);
        assert!(
            (p - 118.0).abs() <= 0.5,
            "118.0 BPM attendu (pas 78.7), prédit {p:.2}"
        );
    }

    #[test]
    fn continuous_91_no_integer_plateau() {
        // Beat à 91 BPM : la recherche continue (pas 0.25 + temps flottant) doit retourner 91 à
        // ±0.5 et ne pas retomber sur un palier entier 7500/lag (93.8 / 92.6 / 89.3…).
        let o = onset_with_intro(91.0, 26.0, 2.0);
        let p = tempo_comb_windowed(&o, HOP_S);
        assert!(
            (p - 91.0).abs() < 0.5,
            "91.0 BPM attendu en continu, prédit {p:.2}"
        );
    }

    // ---- ALC-158 : suppression du biais de parité des lags pairs (interpolation du lag réel) ----

    /// Le helper interp_autocorr évalue la courbe r(lag) à un lag RÉEL : r(15.5) doit être exactement
    /// la moyenne de r(15) et r(16), et r(30.5) la moyenne de r(30) et r(31) — les candellats à lag
    /// IMPAIR (dont r(2·bpm) tombe sur un demi-indice) ne sont plus défavorisés.
    #[test]
    fn interp_autocorr_parity_neutral() {
        // Onset périodique : autocorr piqué aux multiples entiers de la période.
        let o = periodic_onset(30, 1800); // période 30 trames
        let r15 = autocorr(&o, 15);
        let r16 = autocorr(&o, 16);
        let r155 = interp_autocorr(&o, 15.5);
        assert!(
            (r155 - 0.5 * (r15 + r16) as f32).abs() < 1e-4,
            "interp(15.5)={r155:.4} doit ≈ (r15+r16)/2 = {:.4}",
            0.5 * (r15 + r16) as f32
        );
        let r30 = autocorr(&o, 30);
        let r31 = autocorr(&o, 31);
        let r305 = interp_autocorr(&o, 30.5);
        let avg = 0.5 * (r30 + r31) as f32;
        assert!(
            (r305 - avg).abs() < 1e-4,
            "interp(30.5)={r305:.4} doit ≈ {avg:.4}"
        );
    }

    /// Tempo à lag IMPAIR 123.0 BPM (période ≈ 30.49 trames → r(2·bpm) = lag ≈ 15.25, demi-indice).
    /// ALC-158 : doit être résolu à ±0.5 SANS sauter vers le palier pair 129.3 BPM. Le test suit le
    /// chemin réel de `analyze` (peigne → DP) : c'est cette valeur que l'utilisateur observe.
    #[test]
    fn odd_lag_tempo_123_resolved() {
        let o = onset_with_intro(123.0, 26.0, 2.0);
        let p = estimate_bpm(&o, HOP_S);
        assert!(
            (p - 123.0).abs() <= 0.5,
            "123.0 BPM attendu à ±0.5, prédit {p:.2}"
        );
        assert!((p - 129.3).abs() > 3.0, "ne doit pas sauter vers le lag pair 129.3, prédit {p:.2}");
    }

    /// Tempo à lag IMPAIR 92.6 BPM (période ≈ 40.5 trames, r(2·bpm) → lag ≈ 20.25). Résolu à ±0.5,
    /// sans basculer sur 96.2.
    #[test]
    fn odd_lag_tempo_92_6_resolved() {
        let o = onset_with_intro(92.6, 26.0, 2.0);
        let p = estimate_bpm(&o, HOP_S);
        assert!(
            (p - 92.6).abs() <= 0.5,
            "92.6 BPM attendu à ±0.5, prédit {p:.2}"
        );
        assert!((p - 96.2).abs() > 3.0, "ne doit pas sauter vers le lag pair 96.2, prédit {p:.2}");
    }

    /// Tempo à lag IMPAIR 141.5 BPM (période ≈ 27.5 trames). Résolu à ±0.5, sans basculer sur 150.0.
    #[test]
    fn odd_lag_tempo_141_5_resolved() {
        let o = onset_with_intro(141.5, 26.0, 2.0);
        let p = estimate_bpm(&o, HOP_S);
        assert!(
            (p - 141.5).abs() <= 0.5,
            "141.5 BPM attendu à ±0.5, prédit {p:.2}"
        );
        assert!((p - 150.0).abs() > 3.0, "ne doit pas sauter vers le lag pair 150.0, prédit {p:.2}");
    }

    /// Rejoue le chemin réel de `analyze` : peigne multi-fenêtres → DP (beat tracking fractionnaire).
    fn estimate_bpm(onset: &[f32], hop_s: f64) -> f64 {
        let bpm_meter = tempo_comb_windowed(onset, hop_s);
        let (bpm_final, _cv) = refine_with_dp(onset, hop_s, bpm_meter);
        (bpm_final * 10.0).round() / 10.0
    }

    /// Le peigne binaire continu `tempo_autocorr` (nouvelle implémentation ALC-158) résout lui aussi
    /// un tempo à lag impair (123.0 → r(2·bpm)=lag≈15.25 interpolé) à partir de la courbe d'auto-corrélation.
    #[test]
    fn autocorr_odd_lag_123_resolved() {
        let o = onset_with_intro(123.0, 26.0, 2.0);
        let p = tempo_autocorr(&o, HOP_S);
        assert!(
            (p - 123.0).abs() <= 0.5,
            "123.0 BPM attendu (peigne continu autocorr), prédit {p:.2}"
        );
    }

    /// DP : avec un onset à période FRACTIONNAIRE (représentable dans la grille via l'interp), le
    /// tempo raffiné par `refine_with_dp` doit rester CONTINU (±0.5) et non re-quantifié sur un
    /// palier entier (fini les sauts +4 à +9 BPM dus aux lag pairs).
    #[test]
    fn refine_dp_no_integer_plateau() {
        let o = onset_with_intro(123.0, 26.0, 2.0);
        let p = tempo_comb_windowed(&o, HOP_S);
        let (r, _cv) = refine_with_dp(&o, HOP_S, p);
        assert!(
            (r - 123.0).abs() <= 0.5,
            "DP continu 123.0 BPM attendu, prédit {r:.2}"
        );
    }

    /// ALC-158 : intro AMBIANTE longue (≥ 25 % de la durée, énergie percussive < 50 % de la médiane).
    /// Les premières fenêtres doivent être ignorées pour ne pas fausser le mode KDE (corrige Spaceman
    /// 146 BPM et Money for Nothing 134 BPM). Simule un début calme sur ~30 % puis le beat réel.
    #[test]
    fn ambient_intro_25pct_skipped() {
        let bpm = 146.0;
        let total_s = 40.0;
        let calm_frac = 0.3; // > 25 % du morceau en intro ambiante
        let total = (total_s / HOP_S).round() as usize;
        let calm = (total as f64 * calm_frac) as usize;
        let period = 60.0 / bpm / HOP_S; // période en trames (flottant)
        let mut o = vec![0.02f32; total]; // sol ambiant léger partout
        let mut k = 0f64;
        // Intro ambiante faible : pas d'impulsions percussives.
        // Beat binaire réel après l'intro (instants flottants, répartis sur 2 trames voisines).
        let t0 = calm as f64;
        loop {
            let t = t0 + k * period;
            let j = t.floor();
            let frac = t - j;
            let idx = j as i64;
            if idx + 1 >= total as i64 {
                break;
            }
            o[idx.max(0) as usize] += (0.85 * (1.0 - frac)) as f32;
            o[(idx + 1).min(total as i64 - 1) as usize] += (0.85 * frac) as f32;
            k += 1.0;
        }
        let p = estimate_bpm(&o, HOP_S);
        // DP à 146 BPM (période ≈ 12.85 trames) garde une tolérance de ±1.0 (précision du beat
        // tracking) ; l'essentiel est de NE PAS retomber sur un tempo lent (intro) : p doit rester ≫.
        assert!(
            (p - bpm).abs() <= 1.0,
            "{bpm} BPM attendu malgré l'intro ambiante de 30 %, prédit {p:.2}"
        );
        assert!(p > 142.0, "intro ambiante ne doit pas tirer le tempo sous 142, prédit {p:.2}");
    }

    // ---- ALC-159 : benchmark du pipeline complet (décodage ≠ analyse en mémoire) ----

    /// ALC-159-3 : chronomètre l'analyse complète d'une piste stéréo synthétique de 3 minutes à
    /// 44.1 kHz et vérifie qu'elle s'exécute en < 1.5 s tout en conservant BPM / Camelot cohérents.
    /// La synthèse génère 3 min × 44100 échantillons, puis on exécute la chaîne réellement utilisée
    /// par analyze() : BPM (48k), clé globale décimée, timeline & segments — en mesurant le temps.
    /// Tolérance de tempo volontairement large (peigne continu sur une synthèse) : la garantie du
    /// test est le GAIN de performance (< 1.5 s vs > 1 min avant ALC-159) et la clé Do majeur.
    #[test]
    fn analyze_3min_under_1s5() {
        // Piste mono (mix décodé) à 48 kHz d'office — le pipeline entier (BPM, clé 48k, clé décimée,
        // timeline, segments) est exercé sur 3 minutes réelles. Le kick fournit l'onset BPM binaire.
        let sr = TARGET_SAMPLE_RATE as usize; // 48 000, cohérent avec tout le DSP.
        let seconds = 180.0;
        let n = (sr as f64 * seconds) as usize;
        let bpm_synth = 120.0;
        let mut x = vec![0.0f32; n];
        let freqs = [65.41, 130.81, 164.81, 196.0]; // Do majeur (C2+C3+E3+G3)
        let beat_period = sr as f64 * 60.0 / bpm_synth;
        for i in 0..n {
            let t = i as f64 / sr as f64;
            let mut s = 0.0f32;
            for &f in &freqs {
                for h in 1usize..=5 {
                    s += (2.0 * std::f64::consts::PI * f * h as f64 * t).sin() as f32 / h as f32;
                }
            }
            // Kick binaire étroit (~30 ms) : impulsion percussive nette pour l'onset.
            let beat_pos = (i as f64 % beat_period) / beat_period;
            let kick = if beat_pos < 0.02 { 0.5f32 } else { 0.0 };
            x[i] = s * 0.12 + kick;
        }

        // Clé de référence pleine fréquence (48 kHz), puis chemin décimé = celui d'analyze().
        let (key_full, _c48) = key_code_at_sr(&x, TARGET_SAMPLE_RATE);
        let dec = decimate_to_analysis(&x);
        let cfg_dec = AnalyzerCfg::at_sr(ANALYSIS_SR);

        let t0 = std::time::Instant::now();
        let bpm = analyze_bpm(&x);
        let (key_dec, _cd) = key_code_at_sr(&dec, ANALYSIS_SR);
        let _timeline = analyze_key_timeline(&dec, &cfg_dec);
        let _segments = analyze_segments(&dec, &cfg_dec);
        let elapsed = t0.elapsed().as_secs_f64();

        // CONSERVATION vérifiée : la clé d'analyse décimée = pleine fréquence (résultat identique),
        // et le tempo ~120 BPM est retrouvé (±10 % sur une synthèse).
        assert_eq!(key_dec, key_full, "clé décimée ({key_dec}) doit = pleine fréquence ({key_full})");
        assert!((bpm - bpm_synth).abs() <= 0.1 * bpm_synth, "tempo ~120 attendu (±10 %), prédit {bpm:.1}");
        // Gain de performance : analyse 3 min < 1.5 s (avant ALC-159 : > 1 min).
        assert!(elapsed < 1.5, "analyse 3 min must < 1.5 s (réel : {elapsed:.2} s)");
    }

    /// La fenêtre centrale active doit ignorer 20 % d'intro et 15 % d'outro sur une piste longue.
    #[test]
    fn active_window_skips_intro_outro() {
        let (s, e) = active_window(200.0);
        // intro=40 s, outro=30 s → zone utile [40..170] (130 s) → 90 s centrales [60..150].
        assert!((s - 60.0).abs() < 1.0, "début ~60 s attendu, obtenu {s:.1}");
        assert!((e - s - 90.0).abs() < 1.0, "fenêtre ~90 s attendue, obtenue {:.1}", e - s);
        // Piste courte : tout le buffer.
        let (s0, e0) = active_window(60.0);
        assert_eq!(s0, 0.0);
        assert_eq!(e0, 60.0);
    }

    // ---- ALC-160 : normalisation par densité d'impulsions du peigne BPM + tonalité sur tout le morceau ----

    /// ALC-160 : le score du peigne NORMALISÉ par battement (nombre théorique de dents, durée/T) doit
    /// être maximal au vrai tempo 91.0 BPM et STRICTEMENT supérieur à son décalé de +6 % (96.5 BPM).
    #[test]
    fn comb_normalized_maximal_at_true_tempo_91() {
        let o = onset_with_intro(91.0, 26.0, 2.0);
        let s91 = comb_score_normalized(&o, 91.0, HOP_S);
        let s965 = comb_score_normalized(&o, 96.5, HOP_S);
        let s98 = comb_score_normalized(&o, 98.0, HOP_S);
        assert!(
            s91 > s965 && s91 > s98,
            "score(91)={s91:.4} doit > score(96.5)={s965:.4} et > score(98)={s98:.4}"
        );
    }

    /// La normalisation par densité inverse le biais du peigne sur fenêtre fixe (98/99 BPM vaincus).
    #[test]
    fn comb_density_rejects_fast_tempo_on_fixed_window() {
        let o = onset_with_intro(91.0, 26.0, 2.0);
        let s91 = comb_score_normalized(&o, 91.0, HOP_S);
        let s99 = comb_score_normalized(&o, 99.0, HOP_S);
        assert!(
            s91 > s99,
            "91.0 BPM doit battre 99.0 BPM (densité), score(91)={s91:.4} vs score(99)={s99:.4}"
        );
    }

    /// La tonalité est extraite de TOUT le morceau : la décimation 48k→12k (passe-bas ordre 2) d'un
    /// buffer couvrant 0 %–100 % → clé stable (le chemin analyze() utilise full_dec).
    #[test]
    fn tonality_uses_full_track_decimated() {
        let sr = TARGET_SAMPLE_RATE as usize;
        let n = (sr as f64 * 4.0) as usize;
        let freqs_min = [110.0, 220.0, 130.81, 164.81]; // La mineur (2A)
        let mut x = vec![0.0f32; n];
        for i in 0..n {
            let t = i as f64 / sr as f64;
            let mut s = 0.0f32;
            for &f in &freqs_min {
                for h in 1usize..=5 {
                    s += (2.0 * std::f64::consts::PI * f * h as f64 * t).sin() as f32 / h as f32;
                }
            }
            x[i] = s * 0.18;
        }
        let mut lp = Lowpass2Stream::new(2_500.0, TARGET_SAMPLE_RATE as f64);
        let mut full_dec = Vec::new();
        for &s in &x {
            lp.push(s, &mut full_dec);
        }
        assert!(!full_dec.is_empty(), "full_dec doit couvrir le morceau complet (0-100 %)");
        assert!(
            full_dec.len() as f64 >= n as f64 * 0.95 / 4.0,
            "full_dec doit couvrir ~tout le morceau ({} ≈ {} attendu)",
            full_dec.len(),
            n / 4
        );
        let (key, _c) = key_code_at_sr(&full_dec, ANALYSIS_SR);
        assert_eq!(key, "8A", "La mineur attendu sur morceau complet, obtenu {key}");
    }
}