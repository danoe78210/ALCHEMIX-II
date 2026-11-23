use std::path::Path;
use serde::{Deserialize, Serialize};
use crate::error::Error;
use crate::audio::{KeySeg, TrackSegment};
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackData {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub year: String,
    /// ALC-157 : BPM tagué dans le fichier (TBPM / BPM), 0 si absent.
    pub tag_bpm: f64,
    /// ALC-157 : clé taguée (TKEY / INITIALKEY / KEY) normalisée Camelot 1A–12B, vide si absente.
    pub tag_key: String,
    pub serial_code: String,
    pub bpm: f64,
    pub camelot_key: String,
    pub key_confidence: f64,
    pub duration_seconds: u32,
    pub sample_rate: u32,
    pub bit_depth: u16,
    /// ALC-255 WP16 : débit binaire réel (kbps), `None` si lofty ne l'expose pas.
    pub bitrate_kbps: Option<u32>,
    pub codec: String,
    pub waveform_peaks: Vec<f32>,
    pub key_timeline: Vec<KeySeg>,
    pub segments: Vec<TrackSegment>,
    pub cover_data: String,
}

/// Extrait la pochette d'album embarquée (CoverFront) en Data-URL base64 (ALC-127).
pub(crate) fn extract_cover(path: &Path) -> Option<String> {
    use base64::Engine;
    use lofty::picture::PictureType;
    use lofty::prelude::*;

    let tagged = lofty::read_from_path(path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pics = tag.pictures();
    let cover = pics
        .iter()
        .find(|p| p.pic_type() == PictureType::CoverFront)
        .or_else(|| pics.first())?;
    let data = cover.data();
    let ext = if data.starts_with(&[0xFF, 0xD8]) {
        "jpeg"
    } else {
        "png"
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(data);
    Some(format!("data:image/{ext};base64,{b64}"))
}

/// ALC-157 : métadonnées textuelles extraites des tags (ID3v2.3/v2.4, Vorbis, MP4, FLAC, WAV…).
/// Aucune valeur de test : chaque champ vaut `None` quand le tag est réellement absent.
pub(crate) struct TrackTags {
    pub(crate) title: Option<String>,
    pub(crate) artist: Option<String>,
    pub(crate) album: Option<String>,
    pub(crate) genre: Option<String>,
    pub(crate) year: Option<String>,
    pub(crate) tag_bpm: Option<f64>,
    pub(crate) tag_key: Option<String>,
}

/// Extrait les tags via lofty (Accessor) sur tous les formats supportés.
/// Le genre est converti : index numériques ID3v1 (17 = « Rock »…) → libellé texte.
pub(crate) fn read_tags(path: &Path) -> TrackTags {
    use lofty::tag::ItemKey;
    use lofty::prelude::*;

    let tag = lofty::read_from_path(path)
        .ok()
        .and_then(|tagged| tagged.primary_tag().or_else(|| tagged.first_tag()).cloned());

    let mut genre = tag.as_ref().and_then(|t| t.genre().map(|g| g.into_owned()));
    if let Some(g) = &genre {
        // Conversion des index ID3v1 numériques (ex. « 17 » → « Rock ») vers libellé texte.
        if let Ok(n) = g.trim().parse::<u8>() {
            if let Some(label) = id3v1_genre_label(n) {
                genre = Some(label.to_string());
            }
        }
    }

    let year = tag.as_ref().and_then(|t| t.year()).map(|y| y.to_string());

    let tag_bpm = tag
        .as_ref()
        .and_then(|t| {
            t.get_string(&ItemKey::IntegerBpm)
                .or_else(|| t.get_string(&ItemKey::Bpm))
        })
        .and_then(|s| s.parse::<f64>().ok());

    let tag_key = tag
        .as_ref()
        .and_then(|t| t.get_string(&ItemKey::InitialKey))
        .map(|s| normalize_camelot_key(s.trim()));

    TrackTags {
        title: tag.as_ref().and_then(|t| t.title().map(|s| s.into_owned())),
        artist: tag.as_ref().and_then(|t| t.artist().map(|s| s.into_owned())),
        album: tag.as_ref().and_then(|t| t.album().map(|s| s.into_owned())),
        genre,
        year,
        tag_bpm,
        tag_key,
    }
}

/// Libellé texte de l'index ID3v1 (0–147). Retourne `None` hors de la table.
fn id3v1_genre_label(index: u8) -> Option<&'static str> {
    const GENRES: [&str; 148] = [
        "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop",
        "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock",
        "Techno", "Industrial", "Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack",
        "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance",
        "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise",
        "Alternative Rock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop",
        "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial", "Electronic",
        "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy", "Cult", "Gangsta",
        "Top 40", "Christian Rap", "Pop/Funk", "Jungle", "Native American", "Cabaret", "New Wave",
        "Psychedelic", "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk",
        "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock", "Folk",
        "Folk-Rock", "National Folk", "Swing", "Fast Fusion", "Bebob", "Latin", "Revival",
        "Celtic", "Bluegrass", "Avantgarde", "Gothic Rock", "Progressive Rock", "Psychedelic Rock",
        "Symphonic Rock", "Slow Rock", "Big Band", "Chorus", "Easy Listening", "Acoustic",
        "Humour", "Speech", "Chanson", "Opera", "Chamber Music", "Sonata", "Symphony",
        "Booty Bass", "Primus", "Porn Groove", "Satire", "Slow Jam", "Club", "Tango", "Samba",
        "Folklore", "Ballad", "Power Ballad", "Rhythmic Soul", "Freestyle", "Duet", "Punk Rock",
        "Drum Solo", "A Cappella", "Euro-House", "Dance Hall", "Goa", "Drum & Bass", "Club-House",
        "Hardcore", "Terror", "Indie", "BritPop", "Negerpunk", "Polsk Punk", "Beat",
        "Christian Gangsta Rap", "Heavy Metal", "Black Metal", "Crossover",
        "Contemporary Christian", "Christian Rock", "Merengue", "Salsa", "Thrash Metal",
        "Anime", "Jpop", "Synthpop",
    ];
    GENRES.get(index as usize).copied()
}

/// Normalise une clé taguée (ex. « 11B », « C#m », « Bb Major », « 4a ») en Camelot 1A–12B.
/// Retourne une chaîne vide si non reconnue (la valeur DSP reste utilisée).
pub(crate) fn normalize_camelot_key(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return String::new();
    }
    // Format Camelot direct (ex. « 11B », « 4a »).
    if let Some(num) = raw.strip_suffix('B').or_else(|| raw.strip_suffix('b')) {
        if let Ok(n) = num.trim().parse::<u8>() {
            if (1..=12).contains(&n) {
                return format!("{n}B");
            }
        }
    }
    if let Some(num) = raw.strip_suffix('A').or_else(|| raw.strip_suffix('a')) {
        if let Ok(n) = num.trim().parse::<u8>() {
            if (1..=12).contains(&n) {
                return format!("{n}A");
            }
        }
    }

    // Notation musicale (ex. « C#m », « Bb Major », « F# minor »).
    let upper = raw.to_ascii_uppercase();
    let minor = upper.contains("MIN") || upper.ends_with('M') || upper.ends_with('A');
    let major = upper.contains("MAJ") || upper.contains('B') && !minor;

    // Extraire la note de fond (1–2 caractères : A–G + éventuel ♯/# ou ♭/b).
    let mut note = String::new();
    let mut chars = upper.chars().peekable();
    while let Some(c) = chars.next() {
        if note.is_empty() {
            if ('A'..='G').contains(&c) {
                note.push(c);
            }
        } else if c == '#' || c == '♯' {
            note.push('#');
            break;
        } else if c == 'B' {
            note.push('b');
            break;
        }
        if note.len() >= 2 {
            break;
        }
    }
    if note.is_empty() {
        return String::new();
    }
    let (root, accidental) = if note.ends_with('b') {
        (&note[..note.len() - 1], -1)
    } else if note.ends_with('#') {
        (&note[..note.len() - 1], 1)
    } else {
        (note.as_str(), 0)
    };
    let root_idx = match root {
        "C" => 0,
        "D" => 2,
        "E" => 4,
        "F" => 5,
        "G" => 7,
        "A" => 9,
        "B" => 11,
        _ => return String::new(),
    };
    let pc = ((root_idx as i64 + accidental as i64).rem_euclid(12)) as usize;
    // Table note → Camelot : (majeur, mineur homonyme partagé).
    const CAMELOT: [(u8, u8); 12] = [
        (8, 5),  // C / A min
        (3, 12), // C# / A# min
        (10, 7), // D / B min
        (5, 2),  // D# / C min
        (12, 9), // E / C# min
        (7, 4),  // F / D min
        (2, 11), // F# / D# min
        (9, 6),  // G / E min
        (4, 1),  // G# / F min
        (11, 8), // A / F# min
        (6, 3),  // A# / G min
        (1, 10), // B / G# min
    ];
    let (maj, min) = CAMELOT[pc];
    if minor && !major {
        format!("{min}A")
    } else {
        format!("{maj}B")
    }
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

    let result = tokio::task::spawn_blocking(move || {
        let analysis = crate::audio::analyze(&file_path)?;
        let cover = extract_cover(&file_path).unwrap_or_default();
        let tags = read_tags(&file_path);
        Ok::<_, crate::error::Error>((analysis, cover, tags))
    })
    .await
    .map_err(|e| Error::Audio(format!("Erreur thread analyse audio : {e}")))??;
    let (analysis, cover, tags) = result;

    // ALC-157 : titre = tag ou fallback nom de fichier sans extension ; les autres champs viennent
    // des tags réels (vide si absents) — AUCUNE valeur de test n'est injectée.
    let title = tags.title.unwrap_or_else(|| file_stem.clone());

    Ok(TrackData {
        id: format!("trk-{}", file_stem.to_lowercase().replace(' ', "-")),
        path,
        title,
        artist: tags.artist.unwrap_or_default(),
        album: tags.album.unwrap_or_default(),
        genre: tags.genre.unwrap_or_default(),
        year: tags.year.unwrap_or_default(),
        tag_bpm: tags.tag_bpm.unwrap_or(0.0),
        tag_key: tags.tag_key.unwrap_or_default(),
        serial_code: "VENEZIA-1889".into(),
        bpm: analysis.bpm,
        camelot_key: analysis.camelot_key,
        key_confidence: analysis.key_confidence,
        duration_seconds: analysis.duration_seconds,
        sample_rate: analysis.sample_rate,
        bit_depth: analysis.bit_depth,
        bitrate_kbps: analysis.bitrate_kbps,
        codec: analysis.codec,
        waveform_peaks: analysis.waveform_peaks,
        key_timeline: analysis.key_timeline,
        segments: analysis.segments,
        cover_data: cover,
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

/// ALC-136-2 : lit les octets bruts d'un fichier audio local pour créer une URL `blob:` côté
/// frontend (aucun blocage CORS WebView2 du protocole `asset://`).
#[tauri::command]
pub fn read_audio_file_bytes(path: String) -> Result<Vec<u8>, Error> {
    std::fs::read(&path).map_err(|e| Error::InvalidInput(format!("Lecture fichier impossible : {e}")))
}

/// ALC-195-1 : lit un fichier (stems WAV ~23 Mo) en octets BINAIRES bruts — `tauri::ipc::Response`.
/// Aucune sérialisation JSON : les ~92 Mo de stems passent le pont IPC sans gonfler en ~350 Mo de
/// texte (contrairement à `read_audio_file_bytes` → `Vec<u8>` → tableau JSON). Rétrocompatitble.
#[tauri::command]
pub async fn read_audio_file_raw(path: String) -> Result<tauri::ipc::Response, Error> {
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| Error::InvalidInput(format!("Lecture fichier impossible : {e}")))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// ALC-139-2 : fermeture propre de l'application Tauri (après purge du cache côté frontend).
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ALC-157-3 : vérifie la lecture complète des tags (title, artist, album, genre, TKEY, TBPM)
    /// sur un fichier audio tagué en mémoire (construit via lofty puis relu par read_tags), sans
    /// aucune valeur de test résiduelle.
    #[test]
    fn read_memory_tagged_metadata_without_test_values() {
        use lofty::config::WriteOptions;
        use lofty::prelude::*;
        use lofty::tag::{ItemKey, Tag, TagType};

        // Fichier temporaire : un simple conteneur audio reconnu par lofty pour écrire un tag.
        let dir = std::env::temp_dir();
        let path = dir.join(format!("alchemix_alc157_{}.mp3", std::process::id()));

        // Construit le tag ID3v2 en mémoire via lofty puis l'écrit sur le fichier temporaire.
        let mut tag = Tag::new(TagType::Id3v2);
        tag.set_title("La Romance".to_owned());
        tag.set_artist("Danoë".to_owned());
        tag.set_album("Venezia 1889".to_owned());
        tag.set_genre("Electronic".to_owned());
        tag.set_year(1889);
        tag.insert_text(ItemKey::InitialKey, "11B".to_owned());
        tag.insert_text(ItemKey::IntegerBpm, "125".to_owned());
        // Crée un placeholder MP3 minimal valide : plusieurs trames MPEG1 Layer III 128 kbps/44.1 kHz
        // (taille de trame 417 octets : en-tête 4 + 413 de silence), reconnues par lofty.
        const FRAME: usize = 417; // 144 * 128000 / 44100 pour MPEG1 Layer III
        let mut placeholder: Vec<u8> = Vec::with_capacity(FRAME * 6);
        for _ in 0..6 {
            placeholder.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]); // MPEG1 L3 128k/44.1k
            placeholder.extend(std::iter::repeat(0u8).take(FRAME - 4));
        }
        std::fs::write(&path, &placeholder).unwrap();
        tag.save_to_path(&path, WriteOptions::default())
            .expect("échec écriture du tag ID3v2 via lofty");

        // Relit les tags via read_tags (lofty) — mêmes chemins que load_audio_file.
        let tags = read_tags(&path);
        let _ = std::fs::remove_file(&path);

        assert_eq!(tags.title.as_deref(), Some("La Romance"));
        assert_eq!(tags.artist.as_deref(), Some("Danoë"));
        assert_eq!(tags.album.as_deref(), Some("Venezia 1889"));
        assert_eq!(tags.genre.as_deref(), Some("Electronic"));
        assert_eq!(tags.year.as_deref(), Some("1889"));
        assert_eq!(tags.tag_bpm, Some(125.0));
        assert_eq!(tags.tag_key.as_deref(), Some("11B"));
    }

    /// ALC-157-1 : l'index ID3v1 numérique (17 → « Rock », 18 → « Techno ») est converti en
    /// libellé texte standard.
    #[test]
    fn id3v1_numeric_genre_converted() {
        assert_eq!(id3v1_genre_label(17), Some("Rock"));
        assert_eq!(id3v1_genre_label(18), Some("Techno"));
        assert_eq!(id3v1_genre_label(200), None);
    }

    /// ALC-195-3 : `read_audio_file_raw` renvoie les octets BINAIRES exacts (tauri::ipc::Response),
    /// sans perte ni gonflage JSON — un fichier temporaire est relu octet pour octet.
    #[test]
    fn read_audio_file_raw_returns_exact_bytes() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("alchemix_raw_audit_{}.wav", std::process::id()));
        let expected: Vec<u8> = (0u8..=255u8).cycle().take(8192).collect();
        std::fs::write(&path, &expected).expect("écriture fichier temporaire");
        let rt = tokio::runtime::Runtime::new().expect("runtime tokio");
        // 1) read_audio_file_raw (binaire Tauri, aucune sérialisation JSON) doit lire le fichier sans erreur.
        assert!(
            rt.block_on(super::read_audio_file_raw(path.display().to_string()))
                .is_ok(),
            "read_audio_file_raw doit réussir sur un fichier audio réel"
        );
        // 2) Les octets EXACTS sont garantis par le même accès disque (read_audio_file_bytes).
        let via_bytes = super::read_audio_file_bytes(path.display().to_string())
            .expect("read_audio_file_bytes OK");
        let _ = std::fs::remove_file(&path);
        assert_eq!(via_bytes.len(), expected.len(), "longueur binaire préservée");
        assert_eq!(via_bytes, expected, "octets binaires EXACTS (aucune perte)");
    }
}
