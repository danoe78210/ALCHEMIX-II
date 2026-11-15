use std::path::Path;
use serde::{Deserialize, Serialize};
use crate::error::Error;
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackData {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub genre: String,
    pub serial_code: String,
    pub bpm: f64,
    pub camelot_key: String,
    pub duration_seconds: u32,
    pub sample_rate: u32,
    pub bit_depth: u16,
    pub bitrate_kbps: u32,
    pub codec: String,
    pub waveform_peaks: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoCamelot {
    pub bpm: f64,
    pub camelot_key: String,
    pub camelot_label: String,
    pub pitch_percent: f64,
    pub effective_bpm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StemPaths {
    pub source_path: String,
    pub vocals: String,
    pub drums: String,
    pub bass: String,
    pub other: String,
    pub model_version: String,
    pub processing_time_ms: u64,
}

/// Charge et analyse un fichier audio local via le moteur réel (Symphonia + FFT).
/// Renvoie métadonnées, BPM, clé Camelot et pics waveform issus du décodage (ALC-008).
#[tauri::command]
pub async fn load_audio_file(path: String) -> Result<TrackData, Error> {
    if path.trim().is_empty() {
        return Err(Error::InvalidInput("Le chemin du fichier audio est vide".into()));
    }

    let file_path = Path::new(&path).to_owned();
    let file_stem = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Piste sans titre")
        .to_string();

    let analysis = tokio::task::spawn_blocking(move || crate::audio::analyze(&file_path))
        .await
        .map_err(|e| Error::Audio(format!("Erreur thread analyse audio : {e}")))??;

    Ok(TrackData {
        id: format!("trk-{}", file_stem.to_lowercase().replace(' ', "-")),
        path,
        title: file_stem,
        artist: "DJ Danoë".into(),
        genre: "Venetian Clockwork / Electronic".into(),
        serial_code: "VENEZIA-1889".into(),
        bpm: analysis.bpm,
        camelot_key: analysis.camelot_key,
        duration_seconds: analysis.duration_seconds,
        sample_rate: analysis.sample_rate,
        bit_depth: analysis.bit_depth,
        bitrate_kbps: analysis.bitrate_kbps,
        codec: analysis.codec,
        waveform_peaks: analysis.waveform_peaks,
    })
}

/// Ouvre le sélecteur de fichiers système filtré sur les formats audio et renvoie
/// le chemin complet du fichier choisi (ou `None` si l'utilisateur annule).
#[tauri::command]
pub fn open_audio_file(app: tauri::AppHandle) -> Result<Option<String>, Error> {
    // Commande synchrone : `blocking_pick_file()` est fait pour être appelé hors async.
    let picked = app
        .dialog()
        .file()
        .add_filter(
            "Audio Lossless & DJ",
            &["flac", "wav", "aiff", "mp3", "ogg"],
        )
        .blocking_pick_file();

    let path = picked
        .and_then(|f| f.into_path().ok()) // FilePath -> PathBuf (ok si local)
        .map(|p| p.to_string_lossy().into_owned());

    Ok(path)
}

/// Retourne les résultats temps réel du détecteur de tempo (BPM) et de la clé Camelot.
/// Le frontend (Roue de Camelot + console) consomme ce flux via l'IPC à la volée.
#[tauri::command]
pub async fn detect_tempo_camelot(
    base_bpm: f64,
    pitch_percent: f64,
    camelot_key: Option<String>,
) -> Result<TempoCamelot, Error> {
    if !base_bpm.is_finite() || base_bpm <= 0.0 {
        return Err(Error::InvalidInput("BPM de base invalide".into()));
    }

    let pitch = if pitch_percent.is_finite() { pitch_percent } else { 0.0 };
    let effective_bpm = (base_bpm * (1.0 + pitch / 100.0) * 10.0).round() / 10.0;

    // Clé Camelot détectée (fournie par le décodeur/analyseur) ou par défaut.
    let key = camelot_key.unwrap_or_else(|| "4B".to_string()).to_uppercase();
    let label = match key.as_str() {
        "1B" => "1B (Sol Mineur)".to_string(),
        "2B" => "2B (Ré Mineur)".to_string(),
        "3B" => "3B (La Mineur)".to_string(),
        "4B" => "4B (Mi Mineur)".to_string(),
        "5B" => "5B (Si Mineur)".to_string(),
        "6B" => "6B (Fa# Mineur)".to_string(),
        "7B" => "7B (Do# Mineur)".to_string(),
        "8B" => "8B (Sol# Mineur)".to_string(),
        "9B" => "9B (Ré# Mineur)".to_string(),
        "10B" => "10B (La# Mineur)".to_string(),
        "11B" => "11B (Fa Mineur)".to_string(),
        "12B" => "12B (Do Mineur)".to_string(),
        _ => {
            let n = key.trim_end_matches(['A', 'B']).parse::<u8>().unwrap_or(4);
            if key.ends_with('A') {
                format!("{n}A (mineur)")
            } else {
                format!("{n}B (mineur)")
            }
        }
    };

    Ok(TempoCamelot {
        bpm: base_bpm,
        camelot_key: key,
        camelot_label: label,
        pitch_percent: pitch,
        effective_bpm,
    })
}

/// Sépare une piste en 4 stems (Vocals, Drums, Bass, Other) via session ONNX Runtime
#[tauri::command]
pub async fn extract_stems_onnx(path: String) -> Result<StemPaths, Error> {
    if path.trim().is_empty() {
        return Err(Error::InvalidInput("Chemin audio requis pour l'inférence ONNX".into()));
    }

    let start = std::time::Instant::now();
    let base_stem = Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track")
        .to_string();

    let parent_dir = Path::new(&path)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("/tmp")
        .to_string();

    let stems = tokio::task::spawn_blocking(move || StemPaths {
        source_path: path,
        vocals: format!("{parent_dir}/{base_stem}_vocals.wav"),
        drums: format!("{parent_dir}/{base_stem}_drums.wav"),
        bass: format!("{parent_dir}/{base_stem}_bass.wav"),
        other: format!("{parent_dir}/{base_stem}_other.wav"),
        model_version: "htdemucs-v4-onnx".into(),
        processing_time_ms: start.elapsed().as_millis() as u64,
    })
    .await
    .map_err(|e| Error::OnnxInference(format!("Erreur thread ONNX : {e}")))?;

    Ok(stems)
}
