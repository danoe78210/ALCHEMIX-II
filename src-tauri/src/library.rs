//! ALC-165 — Catalogue local de la **LIBRAIRIE** (base SQLite `library.db`).
//!
//! Deux tables, persistées dans le répertoire de données de l'application (`app_data_dir()`),
//! là où l'OS autorise l'écriture :
//! - `tracks` : une ligne par fichier archivé (`file_path` **UNIQUE** → aucun doublon), avec le
//!   titre, l'artiste, le genre, la clé **Camelot** (« 2A »…), le **BPM**, la durée et la date
//!   d'ajout (ISO 8601, heure locale `Europe/Paris` côté poste).
//! - `validated_duos` : les associations `★ DUO` validées par le DJ (clé étrangère `ON DELETE
//!   CASCADE` → supprimer une piste fait disparaître ses duos).
//!
//! La connexion est ouverte **une seule fois** au démarrage puis partagée via
//! `app.manage(Mutex<Connection>)` : les commandes Tauri étant potentiellement appelées en
//! parallèle, chaque accès prend le verrou `Mutex`. Les opérations lourdes (scan de dossier)
//! passent par `tauri::async_runtime::spawn_blocking` pour ne jamais figer le thread IPC.
//!
//! L'import réutilise le moteur existant : tags via **lofty** + `read_tags`, analyse MIR via
//! `crate::audio::analyze` (BPM et clé Camelot) — aucun second moteur d'analyse.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

use crate::commands::{normalize_camelot_key, read_tags};
use crate::error::Error;

/// Extensions audio reconnues par l'import de dossier (minuscules, sans le point).
pub const LIBRARY_EXTENSIONS: [&str; 5] = ["mp3", "flac", "wav", "m4a", "ogg"];

/// Nom du fichier de base, rangé dans le répertoire de données de l'application.
pub const LIBRARY_DB_FILE: &str = "library.db";

/// Une piste du catalogue, telle qu'affichée dans la table de la Librairie.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTrack {
    /// Identifiant SQLite (`INTEGER PRIMARY KEY`), attribué par la base.
    pub id: i64,
    pub file_path: String,
    pub title: String,
    pub artist: String,
    pub genre: String,
    /// Clé Camelot (« 2A », « 4B »…), ou chaîne vide si l'analyse n'a rien trouvé.
    pub camelot_key: String,
    pub bpm: f64,
    pub duration_sec: u32,
    /// Date d'ajout au catalogue, ISO 8601.
    pub added_at: String,
    /// Format déduit du chemin (« FLAC », « MP3 »…).
    #[serde(default)]
    pub codec: String,
    /// Pochette d'album embarquée (Data-URL base64), ou chaîne vide.
    #[serde(default)]
    pub cover_data: String,
}

/// Piste fournie au catalogue (archivage depuis une Platine A/B ou import de dossier).
/// Les champs `Option` laissent le backend compléter par les tags (lofty) puis par l'analyse MIR.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTrackInput {
    pub file_path: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub camelot_key: Option<String>,
    /// `None` → BPM calculé par `audio::analyze`.
    #[serde(default)]
    pub bpm: Option<f64>,
    /// `None` → durée calculée par `audio::analyze`.
    #[serde(default)]
    pub duration_sec: Option<u32>,
    #[serde(default)]
    pub cover_data: Option<String>,
}

/// Résultat d'un import de dossier (renvoyé au frontend pour le compte rendu).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryImportReport {
    pub folder_path: String,
    /// Fichiers audio trouvés dans le dossier (récursivement).
    pub found: usize,
    /// Nouvelles pistes ajoutées au catalogue.
    pub inserted: usize,
    /// Fichiers déjà présents (même `file_path`) → simplement mis à jour.
    pub updated: usize,
    /// Fichiers ignorés (format non décodable, analyse en échec…) sans interrompre l'import.
    pub failed: usize,
    /// Nombre total de pistes du catalogue après l'import.
    pub total_tracks: usize,
    /// Durée du scan en millisecondes (télémétrie).
    pub elapsed_ms: u64,
}

/// Un duo validé par le DJ (paire non ordonnée, `track_a_id < track_b_id`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedDuo {
    pub track_a_id: i64,
    pub track_b_id: i64,
    pub note: String,
    pub created_at: String,
}

/// État partagé du catalogue : la connexion SQLite unique de l'application.
pub struct LibraryState(pub Mutex<Connection>);

/// ALC-165 : progression d'un import, diffusee sur l'evenement `library://scan` (barre de scan).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScanProgress {
    pub done: usize,
    pub total: usize,
    pub current: String,
}

const SCHEMA_TRACKS: &str = "CREATE TABLE IF NOT EXISTS tracks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path    TEXT    NOT NULL UNIQUE,
    title        TEXT    NOT NULL,
    artist       TEXT    NOT NULL,
    genre        TEXT    NOT NULL,
    camelot_key  TEXT    NOT NULL,
    bpm          REAL    NOT NULL,
    duration_sec INTEGER NOT NULL,
    added_at     TEXT    NOT NULL,
    cover_data   TEXT    NOT NULL DEFAULT ''
)";

const SCHEMA_DUOS: &str = "CREATE TABLE IF NOT EXISTS validated_duos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    track_a_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    track_b_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    note        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    UNIQUE (track_a_id, track_b_id),
    CHECK (track_a_id < track_b_id)
)";

/// Colonnes de `tracks` lues dans le même ordre par `list_tracks` et l'`upsert`.
const TRACK_COLUMNS: &str =
    "id, file_path, title, artist, genre, camelot_key, bpm, duration_sec, added_at, cover_data";

fn now_iso() -> String {
    // Horodatage RFC 3339 (sans dépendance chrono) : date d'ajout de la piste au catalogue.
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => format!("{}Z", d.as_secs()),
        Err(_) => "1970-01-01T00:00:00Z".to_string(),
    }
}

/// `"FLAC"` / `"MP3"`… : extension du fichier en majuscules (`Codec` de `TrackData`).
fn codec_from_path(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_uppercase())
        .unwrap_or_default()
}

/// Map une ligne SQLite vers `LibraryTrack`.
fn track_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryTrack> {
    let file_path: String = row.get(1)?;
    Ok(LibraryTrack {
        id: row.get(0)?,
        file_path: file_path.clone(),
        title: row.get(2)?,
        artist: row.get(3)?,
        genre: row.get(4)?,
        camelot_key: row.get(5)?,
        bpm: row.get(6)?,
        duration_sec: row.get(7)?,
        added_at: row.get(8)?,
        codec: codec_from_path(Path::new(&file_path)),
        cover_data: row.get(9)?,
    })
}

fn query_tracks(conn: &Connection) -> Result<Vec<LibraryTrack>, Error> {
    let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks ORDER BY added_at DESC, id DESC");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| Error::Library(format!("Préparation de la lecture du catalogue : {e}")))?;
    let rows = stmt
        .query_map([], track_from_row)
        .map_err(|e| Error::Library(format!("Lecture du catalogue : {e}")))?;
    let mut tracks: Vec<LibraryTrack> = Vec::new();
    for row in rows {
        tracks.push(row.map_err(|e| Error::Library(format!("Ligne du catalogue illisible : {e}")))?);
    }
    Ok(tracks)
}


/// ALC-165 — scan **récursif** d'un dossier, filtré sur les extensions audio.
///
/// Une pile (`Vec<PathBuf>`) remplace la récursion : pas de risque de débordement de pile sur
/// une arborescence très profonde `<Artiste>/<Album>/<Sous-dossier>`. Un sous-dossier illisible
/// (droits, lien mort) est sauté sans interrompre le reste du scan.
pub fn collect_audio_files(root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if is_audio_path(&path) {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}


/// ALC-165 — ouvre (ou crée) `library.db` et applique le schéma des deux tables.
///
/// `journal_mode = WAL` : les lectures de la table ne sont pas bloquées par une écriture
/// d'archivage (utile pendant qu'un import tourne). `busy_timeout = 5 s` évite un échec
/// immédiat « database is locked ». `PRAGMA foreign_keys = ON` est **indispensable** :
/// SQLite désactive les clés étrangères par défaut, et sans cette ligne le `ON DELETE
/// CASCADE` des duos serait purement ignoré.
pub fn open_db(app: &tauri::AppHandle) -> Result<Connection, Error> {
    let db_path = library_db_path(app)?;
    let conn = Connection::open(&db_path).map_err(|e| {
        Error::Library(format!("Ouverture de {} impossible : {e}", db_path.display()))
    })?;
    for pragma in [
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = NORMAL",
        "PRAGMA foreign_keys = ON",
        "PRAGMA busy_timeout = 5000",
    ] {
        conn.execute_batch(pragma)
            .map_err(|e| Error::Library(format!("Réglage SQLite « {pragma} » : {e}")))?;
    }
    conn.execute_batch(SCHEMA_TRACKS)
        .and_then(|_| conn.execute_batch(SCHEMA_DUOS))
        .map_err(|e| Error::Library(format!("Création du schéma de la Librairie : {e}")))?;
    // ALC-166-3 : migration idempotente — ajoute cover_data aux bases créées avant cette colonne.
    let _ = conn.execute_batch(
        "ALTER TABLE tracks ADD COLUMN cover_data TEXT NOT NULL DEFAULT ''",
    );
    // ALC-242 : migration idempotente — verrou de rétro-alimentation stems (éditions manuelles).
    let _ = conn.execute_batch(
        "ALTER TABLE tracks ADD COLUMN user_edited INTEGER NOT NULL DEFAULT 0",
    );
    Ok(conn)
}

/// Vrai si le chemin porte une des extensions audio acceptées (`LIBRARY_EXTENSIONS`).
pub fn is_audio_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| LIBRARY_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// ALC-165 — chemin du fichier SQLite : `<répertoire de données de l'app>/library.db`.
///
/// Le répertoire est créé au besoin : sur un poste neuf `app_data_dir()` peut désigner un
/// dossier absent, et SQLite refuserait alors d'ouvrir la base (« unable to open database file »).
pub fn library_db_path(app: &tauri::AppHandle) -> Result<PathBuf, Error> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::Library(format!("Répertoire de données introuvable : {e}")))?;
    fs::create_dir_all(&dir)
        .map_err(|e| Error::Library(format!("Création de {} impossible : {e}", dir.display())))?;
    Ok(dir.join(LIBRARY_DB_FILE))
}

/// Complete un `LibraryTrackInput` en reutilisant le moteur existant :
/// 1. tags textuels (titre, artiste, genre, pochette) via lofty (`read_tags` / `extract_cover`)
///    quand les champs optionnels sont vides ;
/// 2. analyse MIR (BPM + cle Camelot + duree) via `crate::audio::analyze` quand ces valeurs
///    sont absentes (cas d'un import de dossier, sans platine passe par IPC avant).
fn enrich_input(input: &mut LibraryTrackInput) -> Result<(), Error> {
    let path = Path::new(&input.file_path);
    if input.title.is_none() || input.artist.is_none() || input.genre.is_none() || input.cover_data.is_none() {
        let tags = read_tags(path);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        input.title = tags.title.or_else(|| input.title.take()).or(Some(stem));
        input.artist = tags.artist.or(input.artist.take());
        input.genre = tags.genre.or(input.genre.take());
        if input.cover_data.is_none() {
            input.cover_data = Some(crate::commands::extract_cover(path).unwrap_or_default());
        }
    }
    if input.bpm.is_none() || input.duration_sec.is_none() || input.camelot_key.is_none() {
        let analysis = crate::audio::analyze(path)?;
        input.bpm = input.bpm.take().or(Some(analysis.bpm));
        input.duration_sec = input.duration_sec.take().or(Some(analysis.duration_seconds));
        input.camelot_key = input.camelot_key.take().or(Some(analysis.camelot_key));
    }
    Ok(())
}

fn conn_err(e: rusqlite::Error) -> Error {
    Error::Library(format!("Acces au catalogue SQLite : {e}"))
}

fn lock_err<T>(e: std::sync::PoisonError<T>) -> Error {
    Error::Library(format!("Catalogue verrouille par un acces interrompu : {e}"))
}

fn canonical(path: &str) -> String {
    fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string())
}

fn upsert_conn(conn: &Connection, input: &LibraryTrackInput) -> Result<LibraryTrack, Error> {
    let path = canonical(&input.file_path);
    let now = now_iso();
    conn.execute(
        "INSERT INTO tracks (file_path, title, artist, genre, camelot_key, bpm, duration_sec, added_at, cover_data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(file_path) DO UPDATE SET
             title = excluded.title,
             artist = excluded.artist,
             genre = excluded.genre,
             camelot_key = excluded.camelot_key,
             bpm = excluded.bpm,
             duration_sec = excluded.duration_sec,
             cover_data = excluded.cover_data",
        params![
            path,
            input.title.clone().unwrap_or_default(),
            input.artist.clone().unwrap_or_default(),
            input.genre.clone().unwrap_or_default(),
            normalize_camelot_key(&input.camelot_key.clone().unwrap_or_default()),
            input.bpm.unwrap_or(0.0),
            input.duration_sec.unwrap_or(0),
            now,
            input.cover_data.clone().unwrap_or_default(),
        ],
    )
    .map_err(conn_err)?;

    let track = conn
        .query_row(
            &format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE file_path = ?1"),
            params![path],
            track_from_row,
        )
        .map_err(conn_err)?;
    let mut track = track;
    if let Some(cover) = &input.cover_data {
        if !cover.is_empty() {
            track.cover_data = cover.clone();
        }
    }
    Ok(track)
}


// ---------------------------------------------------------------------------------------------
// Commandes IPC exposees au frontend Svelte (ALC-165-1)
// ---------------------------------------------------------------------------------------------


/// Insertion (ou retrait) d'un duo valide : renvoie `true` si le duo existe apres l'operation.
/// La paire est normalisee (`a < b`) pour qu'un meme duo ne soit jamais stocke deux fois.
fn library_toggle_duo_conn(conn: &Connection, track_a_id: i64, track_b_id: i64) -> Result<bool, Error> {
    if track_a_id == track_b_id {
        return Err(Error::InvalidInput("Une piste ne peut pas former un duo avec elle-meme".into()));
    }
    let (a, b) = if track_a_id < track_b_id {
        (track_a_id, track_b_id)
    } else {
        (track_b_id, track_a_id)
    };
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM validated_duos WHERE track_a_id = ?1 AND track_b_id = ?2",
            params![a, b],
            |_| Ok(()),
        )
        .is_ok();
    if exists {
        conn.execute(
            "DELETE FROM validated_duos WHERE track_a_id = ?1 AND track_b_id = ?2",
            params![a, b],
        )
        .map_err(conn_err)?;
        Ok(false)
    } else {
        conn.execute(
            "INSERT INTO validated_duos (track_a_id, track_b_id, note, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![a, b, "", now_iso()],
        )
        .map_err(conn_err)?;
        Ok(true)
    }
}

/// Scan + analyse + ecriture en base hors du thread IPC (async_runtime::spawn_blocking).
/// Un fichier illisible incremente `failed` sans jamais interrompre l'import du reste.
fn import_folder_sync(app: tauri::AppHandle, folder_path: String) -> Result<LibraryImportReport, Error> {
    let started = Instant::now();
    let root = Path::new(&folder_path).to_path_buf();
    if !root.is_dir() {
        return Err(Error::InvalidInput(format!("Dossier introuvable : {folder_path}")));
    }
    let files = collect_audio_files(&root);
    let total = files.len();
    let mut report = LibraryImportReport {
        folder_path,
        found: total,
        inserted: 0,
        updated: 0,
        failed: 0,
        total_tracks: 0,
        elapsed_ms: 0,
    };
    let state: State<'_, LibraryState> = app.state();
    for (index, path) in files.iter().enumerate() {
        let mut input = LibraryTrackInput {
            file_path: path.to_string_lossy().to_string(),
            ..Default::default()
        };
        if enrich_input(&mut input).is_ok() {
            let canonical_path = canonical(&input.file_path);
            let conn = match state.0.lock() {
                Ok(c) => c,
                Err(_) => {
                    report.failed += 1;
                    continue;
                }
            };
            let known: bool = conn
                .query_row(
                    "SELECT 1 FROM tracks WHERE file_path = ?1",
                    params![canonical_path],
                    |_| Ok(()),
                )
                .is_ok();
            if upsert_conn(&conn, &input).is_ok() {
                if known {
                    report.updated += 1;
                } else {
                    report.inserted += 1;
                }
            } else {
                report.failed += 1;
            }
        } else {
            report.failed += 1;
        }
        // Progression poussee vers la vue LIBRAIRIE (barre d'import), best-effort.
        let _ = app.emit(
            "library://scan",
            LibraryScanProgress {
                done: index + 1,
                total,
                current: path.to_string_lossy().to_string(),
            },
        );
    }
    if let Ok(conn) = state.0.lock() {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
            .map_err(conn_err)?;
        report.total_tracks = count as usize;
    }
    report.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

#[tauri::command]
pub fn library_list_tracks(state: State<'_, LibraryState>) -> Result<Vec<LibraryTrack>, Error> {
    let conn = state.0.lock().map_err(lock_err)?;
    query_tracks(&conn)
}

#[tauri::command]
pub fn library_upsert_track(
    state: State<'_, LibraryState>,
    track: LibraryTrackInput,
) -> Result<LibraryTrack, Error> {
    let mut input = track;
    if input.file_path.trim().is_empty() {
        return Err(Error::InvalidInput("Chemin de fichier requis".into()));
    }
    if !Path::new(&input.file_path).is_file() {
        return Err(Error::NotFound(input.file_path.clone()));
    }
    enrich_input(&mut input)?;
    let conn = state.0.lock().map_err(lock_err)?;
    upsert_conn(&conn, &input)
}

#[tauri::command]
pub async fn library_import_folder(app_handle: tauri::AppHandle, folder_path: String) -> Result<LibraryImportReport, Error> {
    tauri::async_runtime::spawn_blocking(move ||
        import_folder_sync(app_handle, folder_path))
    .await
.map_err(|e| Error::Library(format!("Import interrompu : {e}")))?
}

#[tauri::command]
pub fn library_delete_track(state: State<'_, LibraryState>, id: i64) -> Result<bool, Error> {
    let conn = state.0.lock().map_err(lock_err)?;
    let removed = conn.execute("DELETE FROM tracks WHERE id = ?1", params![id]).map_err(conn_err)?;
    Ok(removed > 0)
}

#[tauri::command]
pub fn library_toggle_duo(
    state: State<'_, LibraryState>,
    track_a_id: i64,
    track_b_id: i64,
) -> Result<bool, Error> {
    let conn = state.0.lock().map_err(lock_err)?;
    library_toggle_duo_conn(&conn, track_a_id, track_b_id)
}

#[tauri::command]
pub fn library_list_duos(state: State<'_, LibraryState>) -> Result<Vec<ValidatedDuo>, Error> {
    let conn = state.0.lock().map_err(lock_err)?;
    let mut stmt = conn
        .prepare("SELECT track_a_id, track_b_id, note, created_at FROM validated_duos")
        .map_err(conn_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ValidatedDuo {
                track_a_id: row.get(0)?,
                track_b_id: row.get(1)?,
                note: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(conn_err)?;
    let mut duos: Vec<ValidatedDuo> = Vec::new();
    for row in rows {
        duos.push(row.map_err(conn_err)?);
    }
    Ok(duos)
}

/// ALC-232 : réécrit les tags embarqués du fichier audio (ID3v2 / Vorbis / MP4) via `lofty`.
/// Best-effort : un fichier verrouillé / en lecture seule ne doit JAMAIS bloquer la sauvegarde SQLite.
fn write_tags_to_file(
    path: &Path,
    title: &str,
    artist: &str,
    genre: &str,
    bpm: f64,
    camelot_key: &str,
) -> Result<(), Error> {
    use lofty::config::WriteOptions;
    use lofty::prelude::*;
    use lofty::tag::{ItemKey, Tag};

    let tagged = lofty::read_from_path(path)
        .map_err(|e| Error::Library(format!("Lecture des tags du fichier : {e}")))?;
    // On partage le tag existant (préserve album/année/pochette) ou on en crée un neuf du bon type.
    let primary = tagged.primary_tag().cloned();
    let fallback = tagged.first_tag().cloned();
    let mut tag = primary
        .or(fallback)
        .unwrap_or_else(|| Tag::new(tagged.primary_tag_type()));

    // Préserve la pochette embarquée (CoverFront) si présente.
    if let Some(src) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        for pic in src.pictures() {
            tag.push_picture((*pic).clone());
        }
    }

    if !title.is_empty() {
        tag.set_title(title.to_owned());
    }
    if !artist.is_empty() {
        tag.set_artist(artist.to_owned());
    }
    if !genre.is_empty() {
        tag.set_genre(genre.to_owned());
    }
    if bpm.is_finite() && bpm > 0.0 {
        let bpm_text = format!("{bpm:.1}");
        tag.insert_text(ItemKey::IntegerBpm, bpm_text.clone()); // frame TBPM (ID3) / BPM (Vorbis)
        tag.insert_text(ItemKey::Bpm, bpm_text);
    }
    if !camelot_key.is_empty() {
        tag.insert_text(ItemKey::InitialKey, camelot_key.to_owned()); // frame TKEY / INITIALKEY
    }

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| Error::Library(format!("Réécriture des tags (lofty) : {e}")))?;
    Ok(())
}

/// ALC-232 : mise à jour ATOMIQUE des 5 champs principaux d'une piste (SQLite) avec validation :
/// titre non vide (trimé), artiste / genre (trimés), BPM dans la plage DJ [40..240],
/// clé Camelot normalisée (`normalize_camelot_key`, ex. « 8a » → « 8A », « Am » → « 8A »).
fn update_track_meta_conn(
    conn: &Connection,
    id: i64,
    title: Option<String>,
    artist: Option<String>,
    genre: Option<String>,
    bpm: Option<f64>,
    camelot_key: Option<String>,
) -> Result<LibraryTrack, Error> {
    // ALC-242 : une édition MANUELLE (ALC-232) verrouille la piste — la rétro-alimentation
    // automatique des stems (BPM/clé) ne pourra plus écraser ces valeurs (user_edited = 1).
    conn.execute("UPDATE tracks SET user_edited = 1 WHERE id = ?1", params![id])
        .map_err(conn_err)?;
    if let Some(t) = title {
        let t = t.trim().to_string();
        if t.is_empty() {
            return Err(Error::InvalidInput("Le titre ne peut pas être vide".into()));
        }
        conn.execute("UPDATE tracks SET title = ?1 WHERE id = ?2", params![t, id])
            .map_err(conn_err)?;
    }
    if let Some(a) = artist {
        conn.execute(
            "UPDATE tracks SET artist = ?1 WHERE id = ?2",
            params![a.trim().to_string(), id],
        )
        .map_err(conn_err)?;
    }
    if let Some(g) = genre {
        conn.execute(
            "UPDATE tracks SET genre = ?1 WHERE id = ?2",
            params![g.trim().to_string(), id],
        )
        .map_err(conn_err)?;
    }
    if let Some(b) = bpm {
        if !(b.is_finite() && b >= 40.0 && b <= 240.0) {
            return Err(Error::InvalidInput(format!("BPM hors plage DJ [40..240] : {b}")));
        }
        conn.execute("UPDATE tracks SET bpm = ?1 WHERE id = ?2", params![b, id])
            .map_err(conn_err)?;
    }
    if let Some(k) = camelot_key {
        let k = normalize_camelot_key(&k);
        if k.is_empty() {
            return Err(Error::InvalidInput("Clé Camelot non reconnue".into()));
        }
        conn.execute(
            "UPDATE tracks SET camelot_key = ?1 WHERE id = ?2",
            params![k, id],
        )
        .map_err(conn_err)?;
    }
    conn.query_row(
        &format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE id = ?1"),
        params![id],
        track_from_row,
    )
    .map_err(conn_err)
}

/// ALC-166-4 / ALC-232 : édition des métadonnées (titre / artiste / genre / BPM / clé Camelot)
/// directement en base, sans ré-écraser les champs par les tags du fichier. `write_to_file` (optionnel)
/// déclenche en plus la réécriture des tags embarqués ID3 / Vorbis / MP4 via `lofty` (best-effort).
#[tauri::command]
pub fn library_update_track_meta(
    state: State<'_, LibraryState>,
    id: i64,
    title: Option<String>,
    artist: Option<String>,
    genre: Option<String>,
    bpm: Option<f64>,
    camelot_key: Option<String>,
    write_to_file: Option<bool>,
) -> Result<LibraryTrack, Error> {
    let conn = state.0.lock().map_err(lock_err)?;
    let track = update_track_meta_conn(&conn, id, title, artist, genre, bpm, camelot_key)?;
    // Réécriture best-effort des tags du fichier audio si demandée : un fichier en lecture seule
    // ne bloque jamais la sauvegarde SQLite (l'erreur est journalisée côté terminal).
    if write_to_file.unwrap_or(false) && Path::new(&track.file_path).is_file() {
        // ALC-234 : les fichiers WAV ne supportent pas l'écriture de tags ID3 standard — on conserve
        // leurs métadonnées en base uniquement (le frontend désactive aussi la case dans la modale).
        let is_wav = Path::new(&track.file_path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("wav"))
            .unwrap_or(false);
        if is_wav {
            eprintln!(
                "[Library] format WAV : tags ID3 non supportés — métadonnées conservées en base uniquement (id={id})."
            );
        } else if let Err(e) = write_tags_to_file(
            Path::new(&track.file_path),
            track.title.trim(),
            track.artist.trim(),
            track.genre.trim(),
            track.bpm,
            track.camelot_key.trim(),
        ) {
            eprintln!("[Library] réécriture des tags embarqués impossible : {e}");
        }
    }
    Ok(track)
}

/// ALC-166-4 / ALC-242 : rétro-alimentation AUTOMATIQUE de la Librairie depuis `stems_meta.json`.
/// Met à jour `bpm` et `camelot_key` d'une piste SEULEMENT si le DJ n'a pas verrouillé ses tags
/// manuellement (`user_edited = 0`, verrou posé par l'éditeur ALC-232). Retourne la piste mise à
/// jour, ou `None` si la piste est absente du catalogue ou verrouillée.
#[tauri::command]
pub fn library_apply_stems_telemetry(
    state: State<'_, LibraryState>,
    file_path: String,
    bpm: Option<f64>,
    camelot_key: Option<String>,
) -> Result<Option<LibraryTrack>, Error> {
    let conn = state.0.lock().map_err(lock_err)?;
    let id: Option<i64> = conn
        .query_row(
            "SELECT id FROM tracks WHERE file_path = ?1 AND user_edited = 0",
            params![file_path.trim()],
            |r| r.get(0),
        )
        .optional()
        .map_err(conn_err)?;
    let Some(id) = id else {
        return Ok(None);
    };
    if let Some(b) = bpm {
        if b.is_finite() && (40.0..=240.0).contains(&b) {
            conn.execute("UPDATE tracks SET bpm = ?1 WHERE id = ?2", params![b, id])
                .map_err(conn_err)?;
        }
    }
    if let Some(k) = camelot_key {
        let k = normalize_camelot_key(&k);
        if !k.is_empty() {
            conn.execute(
                "UPDATE tracks SET camelot_key = ?1 WHERE id = ?2",
                params![k, id],
            )
            .map_err(conn_err)?;
        }
    }
    let track = conn
        .query_row(
            &format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE id = ?1"),
            params![id],
            track_from_row,
        )
        .map_err(conn_err)?;
    Ok(Some(track))
}

/// ALC-258-3 : ré-analyse contrôlée des pistes archivées (BPM + Clé Camelot).
/// Réexécute `crate::audio::analyze` sur chaque piste de `library.db` **dont `user_edited = 0`**
/// (jamais les corrections manuelles de l'utilisateur via l'éditeur ALC-232), puis met à jour
/// `bpm` et `camelot_key`. Renvoie le nombre de pistes ré-analysées.
#[tauri::command]
pub fn library_reanalyze_analysis(state: State<'_, LibraryState>) -> Result<u32, Error> {
    let conn = state.0.lock().map_err(lock_err)?;
    // Sélectionne uniquement les pistes non verrouillées par édition manuelle.
    let rows: Vec<(i64, String)> = conn
        .prepare("SELECT id, file_path FROM tracks WHERE user_edited = 0")
        .map_err(conn_err)?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(conn_err)?
        .collect::<Result<_, _>>()
        .map_err(conn_err)?;

    let mut updated = 0u32;
    for (id, path) in rows {
        let p = Path::new(&path);
        match crate::audio::analyze(p) {
            Ok(analysis) => {
                // BPM dans le domaine valide 30–240, clé Camelot normalisée.
                let bpm = if analysis.bpm.is_finite() && (30.0..=240.0).contains(&analysis.bpm) {
                    (analysis.bpm * 10.0).round() / 10.0
                } else {
                    0.0
                };
                let key = normalize_camelot_key(&analysis.camelot_key);
                conn.execute(
                    "UPDATE tracks SET bpm = ?1, camelot_key = ?2 WHERE id = ?3",
                    params![bpm, key, id],
                )
                .map_err(conn_err)?;
                updated += 1;
            }
            Err(_) => continue, // fichier illisible/supprimé → piste conservée, analyse ignorée
        }
    }
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Base SQLite en mémoire avec le schéma complet (aucun fichier disque, aucun Tauri).
    fn open_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        conn.execute_batch(SCHEMA_TRACKS).unwrap();
        conn.execute_batch(SCHEMA_DUOS).unwrap();
        // ALC-242 : verrou de rétro-alimentation stems sur les bases de test (supplément du schéma).
        conn.execute_batch("ALTER TABLE tracks ADD COLUMN user_edited INTEGER NOT NULL DEFAULT 0")
            .unwrap();
        conn
    }

    fn sample_input(path: &str, title: &str) -> LibraryTrackInput {
        LibraryTrackInput {
            file_path: path.to_string(),
            title: Some(title.to_string()),
            artist: Some("Artiste Test".into()),
            genre: Some("House".into()),
            camelot_key: Some("2A".into()),
            bpm: Some(85.2),
            duration_sec: Some(231),
            cover_data: None,
        }
    }

    #[test]
    fn is_audio_path_recognizes_the_five_formats() {
        assert!(is_audio_path(Path::new("C:\\DJ\\track.flac")));
        assert!(is_audio_path(Path::new("C:\\DJ\\track.MP3")));
        assert!(is_audio_path(Path::new("track.WAV")));
        assert!(is_audio_path(Path::new("track.m4a")));
        assert!(is_audio_path(Path::new("track.ogG")));
        assert!(!is_audio_path(Path::new("track.txt")));
        assert!(!is_audio_path(Path::new("track")));
    }

    #[test]
    fn upsert_is_idempotent_on_file_path() {
        let conn = open_memory_db();
        let input = sample_input("C:\\DJ\\a.mp3", "Title A");
        let t1 = upsert_conn(&conn, &input).unwrap();
        let t2 = upsert_conn(&conn, &input).unwrap();
        assert_eq!(t1.id, t2.id, "un re-upsert du meme chemin doit reutiliser l'id existant");
        assert_eq!(query_tracks(&conn).unwrap().len(), 1);
        assert_eq!(t2.camelot_key, "2A");
        assert_eq!(t2.bpm, 85.2);
        assert_eq!(t2.duration_sec, 231);
    }

    #[test]
    fn toggle_duo_normalizes_pair_and_is_reversible() {
        let conn = open_memory_db();
        let a = upsert_conn(&conn, &sample_input("C:\\DJ\\a.mp3", "A")).unwrap();
        let b = upsert_conn(&conn, &sample_input("C:\\DJ\\b.mp3", "B")).unwrap();
        assert!(library_toggle_duo_conn(&conn, b.id, a.id).unwrap(), "insertion (ordre normalise)");
        assert!(!library_toggle_duo_conn(&conn, a.id, b.id).unwrap(), "re-activation = suppression");
        assert!(library_toggle_duo_conn(&conn, b.id, a.id).unwrap(), "re-ajout possible");
    }

    #[test]
    fn delete_track_cascades_to_validated_duos() {
        let conn = open_memory_db();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        let a = upsert_conn(&conn, &sample_input("C:\\DJ\\a.mp3", "A")).unwrap();
        let b = upsert_conn(&conn, &sample_input("C:\\DJ\\b.mp3", "B")).unwrap();
        library_toggle_duo_conn(&conn, a.id, b.id).unwrap();
        assert_eq!(query_tracks(&conn).unwrap().len(), 2);
        conn.execute("DELETE FROM tracks WHERE id = ?1", params![a.id]).unwrap();
        let duos: i64 = conn
            .query_row("SELECT COUNT(*) FROM validated_duos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(duos, 0, "le duo doit disparaitre en cascade avec sa piste");
        assert_eq!(query_tracks(&conn).unwrap().len(), 1);
    }

    #[test]
    fn update_track_meta_validates_and_normalizes() {
        let conn = open_memory_db();
        let t = upsert_conn(&conn, &sample_input("C:\\DJ\\a.mp3", "Titre A")).unwrap();

        // Mise à jour complète des 5 champs principaux : title non vide (trimé), artist/genre (trimés),
        // BPM dans [40..240], clé Camelot normalisée (« 8a » → « 8A »).
        let upd = update_track_meta_conn(
            &conn,
            t.id,
            Some("  Nouveau Titre  ".into()),
            Some("  Artiste B  ".into()),
            Some(" OST / Cinéma  ".into()),
            Some(174.5),
            Some("8a".into()),
        )
        .unwrap();
        assert_eq!(upd.title, "Nouveau Titre");
        assert_eq!(upd.artist, "Artiste B");
        assert_eq!(upd.genre, "OST / Cinéma");
        assert_eq!(upd.bpm, 174.5);
        assert_eq!(upd.camelot_key, "8A");

        // Notation musicale → Camelot (table officielle du projet : « Am » → « 8A »).
        let upd2 = update_track_meta_conn(&conn, t.id, None, None, None, None, Some("Am".into())).unwrap();
        assert_eq!(upd2.camelot_key, "8A");

        // Rejets : titre vide, BPM hors plage, clé non reconnue.
        assert!(update_track_meta_conn(&conn, t.id, Some("   ".into()), None, None, None, None).is_err());
        assert!(update_track_meta_conn(&conn, t.id, None, None, None, Some(320.0), None).is_err());
        assert!(update_track_meta_conn(&conn, t.id, None, None, None, None, Some("Xy".into())).is_err());

        // La ligne en base reste exactement l'état validé après les rejets.
        let after = query_tracks(&conn).unwrap().into_iter().find(|r| r.id == t.id).unwrap();
        assert_eq!(after.title, "Nouveau Titre");
        assert_eq!(after.bpm, 174.5);
        assert_eq!(after.camelot_key, "8A");
    }

    #[test]
    fn write_tags_to_file_rewrites_id3v2_frames() {
        use lofty::config::WriteOptions;
        use lofty::prelude::*;
        use lofty::tag::{Tag, TagType};

        // Placeholder MP3 minimal (mêmes octets que le test ALC-157), reconnu par lofty.
        let dir = std::env::temp_dir();
        let path = dir.join(format!("alchemix_alc232_{}.mp3", std::process::id()));
        const FRAME: usize = 417; // MPEG1 Layer III 128k / 44.1k
        let mut placeholder: Vec<u8> = Vec::with_capacity(FRAME * 6);
        for _ in 0..6 {
            placeholder.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            placeholder.extend(std::iter::repeat(0u8).take(FRAME - 4));
        }
        std::fs::write(&path, &placeholder).unwrap();
        // Fichier déjà tagué (album) pour vérifier que l'édition clone/conserve le tag existant.
        let mut seed = Tag::new(TagType::Id3v2);
        seed.set_album("Venezia".to_owned());
        seed.save_to_path(&path, WriteOptions::default()).unwrap();

        // Réécriture ALC-232 : titre / artiste / genre / TBPM / TKEY.
        write_tags_to_file(&path, "Golden Hour", "Danoë", "Synthpop", 123.0, "8A").unwrap();

        // Relit via read_tags (chemins exacts de la librairie).
        let tags = read_tags(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(tags.title.as_deref(), Some("Golden Hour"));
        assert_eq!(tags.artist.as_deref(), Some("Danoë"));
        assert_eq!(tags.genre.as_deref(), Some("Synthpop"));
        assert_eq!(tags.tag_bpm, Some(123.0));
        assert_eq!(tags.tag_key.as_deref(), Some("8A"));
    }
}

