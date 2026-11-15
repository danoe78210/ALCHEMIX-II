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
use serde::Serialize;
use std::path::Path;

use crate::error::Error;

/// Fréquence d'échantillonnage cible de l'analyse (voir benchmark ALC-008-1).
pub const TARGET_SAMPLE_RATE: u32 = 48_000;
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
/// Plage de tempo explorée par l'autocorrélation.
const MIN_BPM: f64 = 55.0;
const MAX_BPM: f64 = 200.0;

/// Profils Krumhansl–Schmuckler (majeur / mineur) pondérés en demi-tons.
const MAJOR_PROFILE: [f64; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE: [f64; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

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
    pub waveform_peaks: Vec<f32>,
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

    // Tampon mono @ 48 kHz borné pour l'analyse tempo / tonalité.
    let mut analysis_buf: Vec<f32> = Vec::with_capacity(max_samples);
    // Waveform : maxima par bucket (représente toute la piste, hors du tampon d'analyse).
    let mut wave_groups: Vec<f32> = Vec::new();
    let mut group_max = 0.0f32;
    let mut group_count = 0usize;

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
                for s in resample_linear(&mono, ratio) {
                    if analysis_buf.len() < max_samples {
                        analysis_buf.push(s);
                    }
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

    let bpm = analyze_bpm(&analysis_buf);
    let (tonic, major) = analyze_key(&analysis_buf);
    let camelot_key = camelot_from_tonic(tonic, major);
    let waveform_peaks = waveform_to_bins(&wave_groups, WAVE_BINS);

    Ok(AudioAnalysis {
        sample_rate: native_rate,
        bit_depth: bits,
        bitrate_kbps: (native_rate as u64 * bits as u64 * channels as u64 / 1000) as u32,
        channels,
        codec,
        duration_seconds: duration,
        bpm,
        camelot_key,
        waveform_peaks,
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

/// Estimation du tempo par enveloppe d'énergie → autocorrélation normalisée.
fn analyze_bpm(x: &[f32]) -> f64 {
    const FRAME: usize = 2048;
    const HOP: usize = 1024;
    if x.len() < FRAME * 4 {
        return 120.0;
    }

    let mut env = Vec::new();
    let mut i = 0;
    while i + FRAME <= x.len() {
        let seg = &x[i..i + FRAME];
        let e = seg.iter().map(|s| s * s).sum::<f32>() / FRAME as f32;
        env.push(e);
        i += HOP;
    }
    let mut onset: Vec<f32> = Vec::with_capacity(env.len().saturating_sub(1));
    for j in 1..env.len() {
        onset.push((env[j] - env[j - 1]).max(0.0));
    }
    if onset.len() < 8 {
        return 120.0;
    }

    let hop_s = HOP as f64 / TARGET_SAMPLE_RATE as f64;
    let min_lag = (60.0 / (MAX_BPM * hop_s)).ceil() as usize;
    let max_lag = (60.0 / (MIN_BPM * hop_s)).floor() as usize;

    let mut best = (0.0f64, 0usize);
    for lag in min_lag..=max_lag.min(onset.len().saturating_sub(1)) {
        let n = onset.len() - lag;
        let mut num = 0.0;
        let mut d1 = 0.0;
        let mut d2 = 0.0;
        for k in 0..n {
            let a = onset[k] as f64;
            let b = onset[k + lag] as f64;
            num += a * b;
            d1 += a * a;
            d2 += b * b;
        }
        if d1 > 0.0 && d2 > 0.0 {
            let corr = num / (d1.sqrt() * d2.sqrt());
            if corr > best.0 {
                best = (corr, lag);
            }
        }
    }

    if best.1 == 0 {
        return 120.0;
    }
    let mut bpm = 60.0 / (best.1 as f64 * hop_s);
    // Nettoie le double-tempo quand un sous-multiple a une autocorrélation plus forte.
    if bpm > 170.0 && best.1 % 2 == 0 {
        bpm /= 2.0;
    }
    (bpm * 10.0).round() / 10.0
}

/// Chromagramme 12 classes → corrélation Krumhansl–Schmuckler → (tonique, majeur/bool).
fn analyze_key(x: &[f32]) -> (usize, bool) {
    if x.len() < FFT_SIZE {
        return (7, true); // G majeur par défaut (chemin de repli)
    }
    let mut chroma = [0.0f64; 12];
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let bin_hz = TARGET_SAMPLE_RATE as f64 / FFT_SIZE as f64;
    let n_win = (x.len() - FFT_SIZE) / FFT_HOP + 1;

    let mut time_seen = 0usize;
    for w in 0..n_win {
        let start = w * FFT_HOP;
        let mut buf: Vec<Complex<f32>> = Vec::with_capacity(FFT_SIZE);
        for i in 0..FFT_SIZE {
            // Fenêtre de Hann.
            let h = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / FFT_SIZE as f64).cos();
            buf.push(Complex::new(x[start + i] * h as f32, 0.0));
        }
        fft.process(&mut buf);
        for i in 1..FFT_SIZE / 2 {
            let freq = i as f64 * bin_hz;
            if !(60.0..5_000.0).contains(&freq) {
                continue;
            }
            let midi = 69.0 + 12.0 * (freq / 440.0).log2();
            let pc = ((midi.round() as i32).rem_euclid(12)) as usize;
            chroma[pc] += buf[i].norm() as f64;
        }
        time_seen += FFT_HOP;
        if time_seen >= 60 * TARGET_SAMPLE_RATE as usize {
            break; // 60 s de matériau musical analysé suffisent.
        }
    }

    let total: f64 = chroma.iter().sum();
    if total <= 0.0 {
        return (7, true);
    }
    for c in chroma.iter_mut() {
        *c /= total;
    }

    let mut best = (f64::MIN, 0usize, true);
    for major in [true, false] {
        let prof: &[f64; 12] = if major { &MAJOR_PROFILE } else { &MINOR_PROFILE };
        for tonic in 0..12 {
            let corr = pearson_shifted(&chroma, prof, tonic);
            if corr > best.0 {
                best = (corr, tonic, major);
            }
        }
    }
    (best.1, best.2)
}

/// Corrélation de Pearson entre un chromatogramme et un profil, décalé de `shift` demi-tons.
fn pearson_shifted(chroma: &[f64; 12], prof: &[f64; 12], shift: usize) -> f64 {
    let mut x = [0.0f64; 12];
    let mut y = [0.0f64; 12];
    for i in 0..12 {
        x[i] = chroma[(i + shift) % 12];
        y[i] = prof[i];
    }
    let n = 12.0f64;
    let mx = x.iter().sum::<f64>() / n;
    let my = y.iter().sum::<f64>() / n;
    let mut num = 0.0;
    let mut dx = 0.0;
    let mut dy = 0.0;
    for i in 0..12 {
        let vx = x[i] - mx;
        let vy = y[i] - my;
        num += vx * vy;
        dx += vx * vx;
        dy += vy * vy;
    }
    if dx <= 0.0 || dy <= 0.0 {
        return 0.0;
    }
    num / (dx.sqrt() * dy.sqrt())
}

/// Mappe (tonique, mode) vers la clé Camelot (Roue) — numéros officiels du Camelot Wheel.
fn camelot_from_tonic(tonic: usize, major: bool) -> String {
    let major_num = [12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
    let minor_num = [9, 4, 11, 6, 1, 8, 3, 10, 5, 12, 7, 2];
    let num = if major { major_num[tonic % 12] } else { minor_num[tonic % 12] };
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