mod audio;
mod commands;
mod error;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::load_audio_file,
            commands::open_audio_file,
            commands::detect_tempo_camelot,
            commands::extract_stems_onnx
        ])
        .run(tauri::generate_context!())
        .expect("Erreur critique lors du lancement d'AlcheMix II");
}
