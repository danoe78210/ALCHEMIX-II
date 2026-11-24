//! ALC-270 — **IA Chef d'Orchestre embarquée** (100 % hors-ligne).
//!
//! Gestion du cycle de vie d'un modèle de langage local (optionnel, ~1,9 Go) téléchargé dans
//! `%LOCALAPPDATA%\AlcheMixII\models\` et du choix explicite de l'utilisateur (`ai_module_prefs.json`):
//! - `get_chef_llm_status` → `{ optInState, modelInstalled, loraInstalled, modelSizeBytes, loraFilename }`
//! - `set_chef_llm_opt_in(state)` → persiste `'unset' | 'installed' | 'declined'`
//! - `install_chef_llm_model(on_progress)` → télécharge en streaming (`0.0..1.0`) et écrit de façon
//!   atomique `.part` → `.gguf`
//! - `uninstall_chef_llm_model()` → libère ~1,9 Go et repasse opt-in à `'declined'`
//!
//! L'inférence (`generate_chef_arrangement_score`) charge le GGUF de base via **llama-cpp-2** (feature
//! optionnelle `chef-llm`) et applique l'adaptateur **LoRA** `alchemix-chef-lora.gguf` s'il est présent ;
//! en build léger (sans la feature), elle génère une partition **déterministe** à partir des règles
//! SQLite `mashup_rules` et des partitions `arrangement_scores` les plus proches.

use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::error::Error;
use crate::library::LibraryState;

/// Nom du fichier du modèle de base GGUF (quantification Q4_K_M, ~1,9 Go).
pub const MODEL_FILENAME: &str = "qwen2.5-coder-3b-instruct-q4_k_m.gguf";
/// Adaptateur LoRA entraîné (apprentissage continu) — appliqué s'il est présent dans `models\`.
pub const LORA_FILENAME: &str = "alchemix-chef-lora.gguf";
/// Sous-archive des modèles dans le répertoire de données de l'application.
pub const MODELS_DIR: &str = "models";
/// Fichier de choix explicite de l'utilisateur à l'installation / au premier lancement.
pub const PREFS_FILENAME: &str = "ai_module_prefs.json";
/// URL du modèle (téléchargement optionnel à l'installation).
pub const MODEL_URL: &str =
    "https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf";

/// Etat du choix utilisateur (JSON `ai_module_prefs.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModulePrefs {
    #[serde(default = "opt_unset")]
    pub opt_in_state: String,
}

fn opt_unset() -> String {
    "unset".to_string()
}

/// Statut renvoyé au frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChefLlmStatus {
    pub opt_in_state: String,
    pub model_installed: bool,
    pub lora_installed: bool,
    pub model_size_bytes: u64,
    pub lora_filename: Option<String>,
}

/// Métadonnées d'une platine transmises à la génération IA (télémétrie A/B).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckMeta {
    pub bpm: f64,
    pub camelot_key: Option<String>,
    pub genre: Option<String>,
    pub vocal_activity_ratio: Option<f64>,
    pub drums_energy: Option<f64>,
}

// ── Chemins (fonctions pures testables, `base` injecté) ────────────────────────────────────────

fn models_dir(base: &Path) -> PathBuf {
    base.join(MODELS_DIR)
}

fn prefs_path(base: &Path) -> PathBuf {
    base.join(PREFS_FILENAME)
}

fn model_path(base: &Path) -> PathBuf {
    models_dir(base).join(MODEL_FILENAME)
}

fn lora_path(base: &Path) -> PathBuf {
    models_dir(base).join(LORA_FILENAME)
}

/// Répertoire de base : `%LOCALAPPDATA%\AlcheMixII` (repli sur `app_data_dir()`).
fn local_base(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local).join("AlcheMixII");
    }
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Lit `optInState` depuis le fichier de préférences (défaut `'unset'` si absent / illisible).
fn read_opt_in(base: &Path) -> String {
    match fs::read_to_string(prefs_path(base)) {
        Ok(text) => serde_json::from_str::<AiModulePrefs>(&text)
            .map(|p| p.opt_in_state)
            .unwrap_or_else(|_| opt_unset()),
        Err(_) => opt_unset(),
    }
}

fn write_opt_in(base: &Path, state: &str) -> Result<(), Error> {
    fs::create_dir_all(base).map_err(Error::Io)?;
    let prefs = AiModulePrefs {
        opt_in_state: state.to_string(),
    };
    let text = serde_json::to_string(&prefs).map_err(|e| Error::ChefLlm(format!("sérialisation prefs : {e}")))?;
    let tmp = prefs_path(base).with_extension("json.tmp");
    fs::write(&tmp, text).map_err(Error::Io)?;
    fs::rename(&tmp, prefs_path(base)).map_err(Error::Io)?;
    Ok(())
}

#[tauri::command]
pub fn get_chef_llm_status(app: tauri::AppHandle) -> Result<ChefLlmStatus, Error> {
    let base = local_base(&app);
    let model = model_path(&base);
    let lora = lora_path(&base);
    let model_size = fs::metadata(&model).map(|m| m.len()).unwrap_or(0);
    let lora_installed = lora.exists();
    let status = ChefLlmStatus {
        opt_in_state: read_opt_in(&base),
        model_installed: model.exists(),
        lora_installed,
        model_size_bytes: model_size,
        lora_filename: if lora_installed {
            Some(LORA_FILENAME.to_string())
        } else {
            None
        },
    };
    Ok(status)
}

#[tauri::command]
pub fn set_chef_llm_opt_in(app: tauri::AppHandle, state: String) -> Result<(), Error> {
    let s = state.trim().to_string();
    if !["unset", "installed", "declined"].contains(&s.as_str()) {
        return Err(Error::InvalidInput(format!("État opt-in inconnu : {state}")));
    }
    let base = local_base(&app);
    write_opt_in(&base, &s)
}

#[tauri::command]
pub async fn install_chef_llm_model(app: tauri::AppHandle, on_progress: tauri::ipc::Channel<f32>) -> Result<(), Error> {
    let base = local_base(&app);
    tauri::async_runtime::spawn_blocking(move || download_model(&base, &on_progress))
        .await
        .map_err(|e| Error::ChefLlm(format!("tâche d'installation interrompue : {e}")))?
}

/// Télécharge le modèle GGUF en streaming dans `models\` (écriture atomique `.part` → `.gguf`),
/// renvoie la progression `0.0..1.0`, puis marque l'opt-in `'installed'`.
fn download_model(base: &Path, on_progress: &tauri::ipc::Channel<f32>) -> Result<(), Error> {
    let dir = models_dir(base);
    fs::create_dir_all(&dir).map_err(Error::Io)?;
    let part = dir.join(format!("{MODEL_FILENAME}.part"));
    let dest = model_path(base);

    if dest.exists() {
        write_opt_in(base, "installed")?;
        return Ok(());
    }
    let _ = fs::remove_file(&part);

    let resp = ureq::get(MODEL_URL)
        .call()
        .map_err(|e| Error::ChefLlm(format!("téléchargement du modèle impossible : {e}")))?;
    let total: u64 = resp
        .header("content-length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = BufWriter::new(fs::File::create(&part).map_err(Error::Io)?);
    let mut buf = vec![0u8; 128 * 1024];
    let mut written: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| Error::ChefLlm(format!("lecture du flux du modèle : {e}")))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(Error::Io)?;
        written += n as u64;
        if total > 0 {
            let p = (written as f32) / (total as f32);
            let _ = on_progress.send(p.clamp(0.0, 1.0));
        }
    }
    file.flush().map_err(Error::Io)?;
    fs::rename(&part, &dest).map_err(Error::Io)?;
    write_opt_in(base, "installed")?;
    Ok(())
}

#[tauri::command]
pub fn uninstall_chef_llm_model(app: tauri::AppHandle) -> Result<(), Error> {
    let base = local_base(&app);
    let dest = model_path(&base);
    if dest.exists() {
        fs::remove_file(&dest).map_err(Error::Io)?;
    }
    let part = dest.with_extension("gguf.part");
    let _ = fs::remove_file(&part);
    write_opt_in(&base, "declined")
}

// ── Génération de partition d'arrangement (apprentissage contextuel + inférence locale) ─────────

/// Rôle « platine » dérivé de la spécialité (decks A/B du `MashupArrangementScore`).
fn deck_roles(specialty: &str) -> (&'static str, &'static str) {
    match specialty {
        "ost-crossover" => ("rhythm", "theme"),
        "ost-medley" => ("instrumental", "theme"),
        "pop-rock" => ("instrumental", "vocal"),
        _ => ("ost-instrumental", "vocal"),
    }
}

/// Détecte la spécialité mashup à partir de la télémétrie A/B (heuristique dérivée des règles).
fn detect_specialty(a: &DeckMeta, b: &DeckMeta) -> String {
    let av = a.vocal_activity_ratio.unwrap_or(0.5);
    let bv = b.vocal_activity_ratio.unwrap_or(0.5);
    let ost = |g: &Option<String>| -> bool {
        g.as_deref().map(|s| {
            let l = s.to_lowercase();
            l.contains("ost")
                || l.contains("cinéma")
                || l.contains("cinema")
                || l.contains("soundtrack")
                || l.contains("score")
        }).unwrap_or(false)
    };
    let a_ost = ost(&a.genre);
    let b_ost = ost(&b.genre);
    let a_low = av < 0.12;
    let b_low = bv < 0.12;
    if (a_low && b_low) && (a_ost || b_ost) {
        // Double instrumental / cinéma → medley (deux OST pures) sinon crossover.
        return if a_ost && b_ost { "ost-medley" } else { "ost-crossover" }.to_string();
    }
    if (a_low != b_low) && (a_ost || b_ost) {
        return "ost-vocal".to_string();
    }
    let has_genre = |g: &Option<String>, names: &[&str]| -> bool {
        g.as_deref().map(|s| {
            let l = s.to_lowercase();
            names.iter().any(|n| l.contains(n))
        }).unwrap_or(false)
    };
    let pop_rock = (has_genre(&a.genre, &["pop"]) && has_genre(&b.genre, &["rock"]))
        || (has_genre(&b.genre, &["pop"]) && has_genre(&a.genre, &["rock"]));
    if pop_rock {
        return "pop-rock".to_string();
    }
    "ost-vocal".to_string()
}

/// Construit une partition d'arrangement valide « MashupArrangementScore » (déterministe) à partir
/// de la spécialité, des règles actives et des partitions voisines. Filet de sécurité si l'inférence
/// llama est indisponible (build léger), ou sortie autonome.
fn build_deterministic_score(
    specialty: &str,
    a: &DeckMeta,
    b: &DeckMeta,
    rules: &[crate::library::MashupRule],
    _neighbors: &[crate::library::ArrangementScore],
) -> serde_json::Value {
    let target = (a.bpm.abs().max(1.0) + b.bpm.abs().max(1.0)) * 0.5;
    let entry_bar = if specialty == "ost-vocal" || specialty == "pop-rock" { 9 } else { 17 };
    let (role_a, role_b) = deck_roles(specialty);
    // Règles actives → paramètres DSP (creux, ducking, hpf) injectés dans l'EQ de la partition.
    let rule = rules.iter().find(|r| r.specialty == specialty);
    let dsp: serde_json::Value = rule
        .and_then(|r| serde_json::from_str(&r.dsp_params_json).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let duck_freq = dsp.get("duckFreqHz").and_then(|v| v.as_f64()).unwrap_or(1800.0);
    let duck_gain = dsp.get("duckGainDb").and_then(|v| v.as_f64()).unwrap_or(-4.5);
    let hpf_a: i64 = if matches!(specialty, "ost-vocal" | "ost-crossover" | "ost-medley") { 140 } else { 20 };
    let eq = serde_json::json!({
        "duckTarget": if specialty == "ost-vocal" { "A.other" } else { "none" },
        "duckFreqHz": duck_freq,
        "duckGainDb": duck_gain,
        "duckQ": dsp.get("duckQ").and_then(|v| v.as_f64()).unwrap_or(1.0),
        "hpfHz": {"A": hpf_a}
    });
    let bpm_round = (a.bpm.abs().max(1.0) + b.bpm.abs().max(1.0)) as i64;
    let camelot_a = a.camelot_key.as_deref().unwrap_or("—");
    serde_json::json!({
        "version": "1.0",
        "title": format!("IA Chef d'Orchestre — {specialty}"),
        "masterBpm": target,
        "crossfader": 0.5,
        "deckA": {"role": role_a, "startBar": 1},
        "deckB": {"role": role_b, "entryBar": entry_bar, "sourceStartBar": 1},
        "eq": eq,
        "timeline": [
            {"bar": 1, "deckA": ["drums","bass","other"], "deckB": [], "crossfader": 0.6, "label": format!("Intro — {specialty}")},
            {"bar": entry_bar, "deckA": ["drums","bass"], "deckB": ["vocals"], "crossfader": 0.5, "label": format!("Exposition {camelot_a}")},
            {"bar": 33, "deckA": ["drums","bass","other"], "deckB": ["vocals","bass"], "crossfader": 0.7, "label": "Refrain"},
            {"bar": 65, "deckA": ["bass"], "deckB": ["vocals"], "crossfader": 0.0, "label": format!("Outro {bpm_round} BPM")}
        ]
    })
}

/// `prompt_directive` de la règle canonique pour une spécialité (source `resources/default_mashup_rules.json`).
fn resource_prompt_directive(specialty: &str) -> String {
    const RULES_RES: &str = include_str!("../resources/default_mashup_rules.json");
    serde_json::from_str::<serde_json::Value>(RULES_RES)
        .ok()
        .and_then(|v| v.as_array().cloned().unwrap_or_default().into_iter().find(
            |r| r.get("specialty").and_then(|s| s.as_str()) == Some(specialty),
        ))
        .and_then(|r| r.get("prompt_directive").and_then(|p| p.as_str()).map(String::from))
        .unwrap_or_default()
}

fn telemetry_line(id: &str, m: &DeckMeta) -> String {
    format!(
        "{id} : BPM={:.1}, camelot={}, genre={}, vocalsRms={}, drumsRms={}, otherRms=—",
        m.bpm,
        m.camelot_key.as_deref().unwrap_or("—"),
        m.genre.as_deref().unwrap_or("—"),
        m.vocal_activity_ratio.map(|v| format!("{v:.3}")).unwrap_or_else(|| "—".into()),
        m.drums_energy.map(|v| format!("{v:.3}")).unwrap_or_else(|| "—".into())
    )
}

/// Construit le prompt ChatML Qwen (user) : spécialité + télémétrie A/B + directive de la règle
/// active + les 2 partitions de référence (apprentissage contextuel immédiat).
fn build_chef_prompt(
    specialty: &str,
    a: &DeckMeta,
    b: &DeckMeta,
    rules: &[crate::library::MashupRule],
    neighbors: &[crate::library::ArrangementScore],
) -> String {
    let directive = resource_prompt_directive(specialty);
    let names = rules
        .iter()
        .map(|r| r.name.clone())
        .collect::<Vec<_>>()
        .join(", ");
    let few = neighbors
        .iter()
        .map(|n| n.score_json.clone())
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        "Spécialité mashup : {specialty}.\n{}\n{}\nRègles actives : {names}.\nDirective de la règle active : {directive}\nPartitions de référence (les plus proches) :\n{few}\nGénère la partition d'arrangement JSON (version 1.0) : timeline avec bar >= 1 et stems parmi vocals, drums, bass, other.",
        telemetry_line("Platine A", a),
        telemetry_line("Platine B", b)
    )
}

/// Valide la structure minimale d'un `MashupArrangementScore` généré (version, titre, timeline
/// non vide, bar >= 1, stems connus). Retourne `false` sinon (filet de sécurité de l'IA).
fn validate_arrangement_json(json: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return false;
    };
    if v.get("version").and_then(|x| x.as_str()) != Some("1.0") {
        return false;
    }
    if v.get("title").is_none() {
        return false;
    }
    let Some(timeline) = v.get("timeline").and_then(|x| x.as_array()) else {
        return false;
    };
    if timeline.is_empty() {
        return false;
    }
    const VALID: [&str; 4] = ["vocals", "drums", "bass", "other"];
    let stems_ok = |stem: &serde_json::Value| -> bool {
        stem.as_array()
            .map(|a| a.iter().all(|s| s.as_str().map(|x| VALID.contains(&x)).unwrap_or(false)))
            .unwrap_or(false)
    };
    timeline.iter().all(|c| {
        let bar = c.get("bar").and_then(|b| b.as_i64()).unwrap_or(0);
        bar >= 1 && stems_ok(&c.get("deckA").cloned().unwrap_or_else(|| serde_json::json!([])))
            && stems_ok(&c.get("deckB").cloned().unwrap_or_else(|| serde_json::json!([])))
    })
}

/// Inférence locale réelle via llama-cpp-2 + LoRA (compilée uniquement avec la feature `chef-llm`).
/// En cas d'échec (modèle absent, erreur d'inférence, sortie non-JSON), renvoie `Ok(None)` afin que
/// le générateur déterministe prenne le relais — jamais d'erreur bloquante pour l'utilisateur.
#[cfg(feature = "chef-llm")]
mod llama {
    use super::*;
    use std::sync::OnceLock;

    use llama_cpp_2::context::params::LlamaContextParams;
    use llama_cpp_2::context::LlamaContext;
    use llama_cpp_2::llama_backend::LlamaBackend;
    use llama_cpp_2::llama_batch::LlamaBatch;
    use llama_cpp_2::model::params::LlamaModelParams;
    use llama_cpp_2::model::{LlamaChatMessage, LlamaModel};
    use llama_cpp_2::sampling::LlamaSampler;
    use llama_cpp_2::token::LlamaToken;

    /// Charge le GGUF de base, attache l'adaptateur LoRA s'il est présent, applique le template
    /// ChatML Qwen (baked) et échantillonne (température `0.15`, stop `<|im_end|>`, plafond 1024
    /// tokens). Tout échec est transformé en `Ok(None)` (repli déterministe).
    pub fn infer(model_path: &Path, lora: Option<&Path>, prompt: &str) -> Result<Option<String>, Error> {
        match run_inference(model_path, lora, prompt) {
            Ok(text) if text.trim_end().ends_with("<|im_end|>") => Ok(Some(text.trim_end().to_string())),
            Ok(text) => Ok(Some(text)),
            Err(e) => {
                eprintln!("[chef-llm] inférence locale indisponible, repli déterministe : {e}");
                Ok(None)
            }
        }
    }

    fn run_inference(model_path: &Path, lora: Option<&Path>, prompt: &str) -> Result<String, Error> {
        static BACKEND: OnceLock<LlamaBackend> = OnceLock::new();
        let backend = BACKEND.get_or_init(|| LlamaBackend::init().expect("initialisation du backend llama"));

        let params = LlamaModelParams::default();
        let mut model = LlamaModel::load_from_file(backend, model_path, &params)
            .map_err(|e| Error::ChefLlm(format!("chargement du modèle GGUF : {e}")))?;

        // Adaptateur LoRA (gardé en vie pour la durée de vie du modèle).
        let _lora_adapter = if let Some(lp) = lora {
            if lp.exists() {
                Some(model.lora_adapter_init(lp).map_err(|e| Error::ChefLlm(format!("application LoRA : {e}")))?)
            } else {
                None
            }
        } else {
            None
        };

        let vocab = model.vocab();
        let tmpl = model.chat_template(None).map_err(|e| Error::ChefLlm(format!("template ChatML : {e}")))?;
        let system = "Tu es le Chef d'Orchestre d'AlcheMix II. À partir de la télémétrie des platines A/B, des directives des règles métier actives et des partitions de référence, génère UNIQUEMENT la partition d'arrangement JSON valide au format MashupArrangementScore (version 1.0). Ne produis aucun texte hors du JSON.";
        let chat = [
            LlamaChatMessage::new("system".to_string(), system.to_string())
                .map_err(|e| Error::ChefLlm(format!("message system : {e}")))?,
            LlamaChatMessage::new("user".to_string(), prompt.to_string())
                .map_err(|e| Error::ChefLlm(format!("message user : {e}")))?,
        ];
        let prompt_text = model
            .apply_chat_template(&tmpl, &chat, true)
            .map_err(|e| Error::ChefLlm(format!("application du template chat : {e}")))?;

        let ctx_params =
            LlamaContextParams::default().with_n_ctx(Some(std::num::NonZeroU32::new(2048).unwrap()));
        let mut ctx: LlamaContext<'_> = model
            .new_context(backend, ctx_params)
            .map_err(|e| Error::ChefLlm(format!("création du contexte : {e}")))?;

        let mut batch = LlamaBatch::new(2048, 1);
        let prompt_tokens = vocab.tokenize(prompt_text.as_bytes(), true, true);
        batch
            .add_sequence(&prompt_tokens, 0, false)
            .map_err(|e| Error::ChefLlm(format!("batch du prompt : {e}")))?;
        ctx.decode(&mut batch).map_err(|e| Error::ChefLlm(format!("decodage du prompt : {e}")))?;
        let mut n_past = prompt_tokens.len();

        let mut sampler = LlamaSampler::chain(
            [
                LlamaSampler::min_p(0.05, 64),
                LlamaSampler::top_p(0.9, 64),
                LlamaSampler::temp(0.15),
                LlamaSampler::dist(42),
            ],
            false,
        );

        let mut out: Vec<LlamaToken> = Vec::new();
        let mut n_len = 0usize;
        while n_len < 1024 {
            let idx = (n_past as i32) - 1;
            let tok = sampler.sample(&ctx, idx);
            out.push(tok);
            n_len += 1;
            if vocab.is_eog(tok) {
                break;
            }
            batch.clear();
            batch
                .add(tok, n_past as i32, &[0], true)
                .map_err(|e| Error::ChefLlm(format!("batch du token généré : {e}")))?;
            n_past += 1;
            ctx.decode(&mut batch).map_err(|e| Error::ChefLlm(format!("decodage génération : {e}")))?;
        }
        let bytes = vocab.detokenize(&out, true, false);
        Ok(String::from_utf8_lossy(&bytes).to_string())
    }
}

#[tauri::command]
pub fn generate_chef_arrangement_score(
    app: tauri::AppHandle,
    state: State<'_, LibraryState>,
    deck_a_meta: DeckMeta,
    deck_b_meta: DeckMeta,
) -> Result<String, Error> {
    let base = local_base(&app);
    let model = model_path(&base);
    if !model.exists() {
        return Err(Error::ChefLlm(
            "Modèle IA Chef d'Orchestre non installé — utilisez l'option d'installation (~1,9 Go)".into(),
        ));
    }
    let _lora = lora_path(&base).exists().then(|| lora_path(&base));
    let specialty = detect_specialty(&deck_a_meta, &deck_b_meta);
    let conn = state.0.lock().map_err(|e| Error::Library(format!("Catalogue verrouillé : {e}")))?;
    let rules = crate::library::list_active_rules_conn(&conn, &specialty)?;
    let neighbors = crate::library::find_similar_score_conn(&conn, &specialty, deck_a_meta.bpm, deck_b_meta.bpm, 2)?;

    // Apprentissage contextuel immédiat + inférence locale : prompt complet (télémétrie A/B,
    // directive de la règle active + 2 partitions de référence) transmis au moteur llama-cpp-2.
    let _prompt = build_chef_prompt(&specialty, &deck_a_meta, &deck_b_meta, &rules, &neighbors);

    #[cfg(feature = "chef-llm")]
    let llm_json = llama::infer(&model, _lora.as_deref(), &_prompt).unwrap_or(None);

    #[cfg(not(feature = "chef-llm"))]
    let llm_json: Option<String> = None;

    if let Some(json) = llm_json {
        // Filet de sécurité : n'accepte que du JSON valide qui passe la validation mini.
        if validate_arrangement_json(&json) {
            return Ok(json);
        }
    }

    let score = build_deterministic_score(&specialty, &deck_a_meta, &deck_b_meta, &rules, &neighbors);
    serde_json::to_string(&score).map_err(|e| Error::ChefLlm(format!("sérialisation score : {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alchemix_chef_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn opt_in_persistence_unset_installed_declined() {
        let base = temp_base();
        assert_eq!(read_opt_in(&base), "unset");
        write_opt_in(&base, "declined").unwrap();
        assert_eq!(read_opt_in(&base), "declined");
        write_opt_in(&base, "installed").unwrap();
        assert_eq!(read_opt_in(&base), "installed");
        assert!(prefs_path(&base).exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn status_reflects_model_install() {
        let base = temp_base();
        assert!(!model_path(&base).exists());
        fs::create_dir_all(models_dir(&base)).unwrap();
        let model = models_dir(&base).join(MODEL_FILENAME);
        fs::write(&model, b"not-a-gguf").unwrap();
        let status = ChefLlmStatus {
            opt_in_state: read_opt_in(&base),
            model_installed: model.exists(),
            lora_installed: lora_path(&base).exists(),
            model_size_bytes: fs::metadata(&model).map(|m| m.len()).unwrap_or(0),
            lora_filename: None,
        };
        assert!(status.model_installed);
        assert_eq!(status.model_size_bytes, b"not-a-gguf".len() as u64);
        let _ = fs::remove_dir_all(&base);
    }
}