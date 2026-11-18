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

use rusqlite::{params, Connection};
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

/// ALC-166-4 : édition rapide des métadonnées (titre / genre) directement en base,
/// sans ré-écraser les champs par les tags du fichier (contrairement à `library_upsert_track`).
#[tauri::command]
pub fn library_update_track_meta(
    state: State<'_, LibraryState>,
    id: i64,
    title: Option<String>,
    genre: Option<String>,
) -> Result<LibraryTrack, Error> {
    let conn = state.0.lock().map_err(lock_err)?;
    if let Some(t) = title {
        conn.execute("UPDATE tracks SET title = ?1 WHERE id = ?2", params![t, id])
            .map_err(conn_err)?;
    }
    if let Some(g) = genre {
        conn.execute("UPDATE tracks SET genre = ?1 WHERE id = ?2", params![g, id])
            .map_err(conn_err)?;
    }
    let track = conn
        .query_row(
            &format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE id = ?1"),
            params![id],
            track_from_row,
        )
        .map_err(conn_err)?;
    Ok(track)
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
}

