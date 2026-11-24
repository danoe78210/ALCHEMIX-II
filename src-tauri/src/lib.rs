use tauri::Manager;

mod audio;
mod chef_llm;
mod commands;
mod error;
mod library;
mod stems;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // ALC-165 : catalogue de la LIBRAIRIE (SQLite local) — ouvert une seule fois au
            // demarrage, puis partage entre toutes les commandes `library_*`.
            let db = library::open_db(app.handle())?;
            app.manage(library::LibraryState(std::sync::Mutex::new(db)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_audio_file,
            commands::open_audio_file,
            commands::detect_tempo_camelot,
            commands::extract_stems_onnx,
            commands::read_audio_file_bytes,
            commands::read_audio_file_raw,
            commands::exit_app,
            library::library_list_tracks,
            library::library_upsert_track,
            library::library_import_folder,
            library::library_delete_track,
            library::library_toggle_duo,
            library::library_list_duos,
            library::library_update_track_meta,
            library::library_apply_stems_telemetry,
            library::library_reanalyze_analysis,
            library::list_mashup_rules,
            library::upsert_mashup_rule,
            library::save_arrangement_score,
            library::list_arrangement_scores,
            library::find_similar_arrangement_scores,
            library::export_training_dataset_jsonl,
            stems::check_cached_stems,
            stems::separate_stems,
            stems::export_stems_to_folder,
            stems::stems_telemetry,
            chef_llm::get_chef_llm_status,
            chef_llm::set_chef_llm_opt_in,
            chef_llm::install_chef_llm_model,
            chef_llm::uninstall_chef_llm_model,
            chef_llm::generate_chef_arrangement_score
        ])
        .run(tauri::generate_context!())
        .expect("Erreur critique lors du lancement d'AlcheMix II");
}
