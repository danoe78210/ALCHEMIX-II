use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Fichier audio introuvable : {0}")]
    NotFound(String),

    #[error("Format audio ou chemin invalide : {0}")]
    InvalidInput(String),

    #[error("Erreur d'entrée/sortie : {0}")]
    Io(#[from] std::io::Error),

    #[error("Erreur moteur ONNX : {0}")]
    OnnxInference(String),

    #[error("Erreur moteur d'analyse audio : {0}")]
    Audio(String),

    /// ALC-165 : catalogue de la LIBRAIRIE (base SQLite locale).
    #[error("Erreur bibliothèque locale : {0}")]
    Library(String),
}

pub type Error = AppError;

#[derive(Serialize)]
struct SerializedError {
    code: &'static str,
    message: String,
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let code = match self {
            AppError::NotFound(_) => "AUDIO_NOT_FOUND",
            AppError::InvalidInput(_) => "INVALID_AUDIO_INPUT",
            AppError::Io(_) => "IO_ERROR",
            AppError::OnnxInference(_) => "ONNX_ERROR",
            AppError::Audio(_) => "AUDIO_ENGINE_ERROR",
            AppError::Library(_) => "LIBRARY_ERROR",
        };
        SerializedError {
            code,
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}
