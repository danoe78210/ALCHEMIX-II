//! ALC-174 — Séparation IA locale des 4 Stems (HTDemucs / ONNX Runtime).
//!
//! 100 % local : modèle `htdemucs.onnx` (contraat `mix [1,2,segmentSamples]` onde brute planar
//! f32, sortie `sources [1,4,2,segmentSamples]` — STFT/iSTFT embarqués, opset 17) via `ort`.
//! Cache disque : `%LOCALAPPDATA%\AlcheMixII\stems\<sha256_du_fichier>\` (vocals/drums/bass/other.wav).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use ort::session::Session;
use ort::value::Tensor;
use sha2::{Digest, Sha256};

use crate::commands::StemPaths;
use crate::error::Error;

/// Fréquence de sortie normalisée (HTDemucs = 44,1 kHz).
const OUTPUT_RATE: u32 = 44_100;
/// Longueur de segment du modèle (repli). Confirmé par le gate : reshape [1,4,-1,343980]
/// → `smank/htdemucs-onnx` = **343 980** échantillons (7,8 s @44,1 kHz).
const SEGMENT: usize = 343_980;
/// Recouvrement des fenêtres glissantes (ALC-184-3 : 50 % → hop 50 %, Hann symétrique COLA) —
/// un chevauchement plus dense affine les masques de séparation sur les mix denses.
const HOP_RATIO: f32 = 0.50;

fn onx(e: impl std::fmt::Display) -> Error {
    Error::OnnxInference(e.to_string())
}

fn cache_root() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    // ALC-175 : "stems-v2" invalide les caches ALC-174 étiquetés (mapping inversé) →
    // un recalcul propre avec le mapping canonique est forcé une fois pour chaque source.
    // ALC-179 : "stems-v3" invalide les caches v2 dont les WAV étaient TOUS silencieux
    // (garde overlap-add `w > 1e-3` vs wsum ~1e-5 → échantillons écrasés à 0.0).
    // ALC-180 : "stems-v4" invalide les caches v3 dont les WAV étaient sous-scalés ~0.26× car
    // `wsum` était accumulé DANS la boucle des stems (facteur 4) → division par 4 → quasi mutisme.
    // ALC-181 : "stems-v5" invalide les caches v4 dont l'en-tête WAV est invalide
    // (bitsPerSample=2 au lieu de 16 dans le chunk `fmt `) → les lecteurs honnorant l'en-tête
    // décodaient du PCM16 comme du 2-bit → bourdonnement/grondement saturé à pleine échelle.
    // ALC-184-3 : "stems-v6" invalide les caches v5 — overlap 50 % + Wiener soft-mask vocals
    // → régénération automatique des stems anti-bleed (Spaceman : guitares saturées/cymbales).
    // ALC-185-1 : "stems-v7" invalide les caches v6 — Wiener K(f) par bande + gate d'activité
    // vocale doux (intros sans chant) → régénération automatique (Bon Jovi - Livin' On A Prayer).
    Path::new(&base).join("AlcheMixII").join("stems-v7")
}
fn model_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    Path::new(&base).join("AlcheMixII").join("models").join("htdemucs.onnx")
}
fn stems_dir_for_sha(sha: &str) -> PathBuf {
    cache_root().join(sha)
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
fn sha256_hex_file(path: &str) -> Result<String, Error> {
    let data = std::fs::read(path)?;
    Ok(sha256_hex(&data))
}

/// Session ONNX globale (chargée une seule fois) sous `Mutex<Option<Session>>` :
/// `Session::run(&mut self)` exige un accès mutable, satisfait sans recharger le modèle 304 Mo.
static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();

fn build_session() -> Result<Session, Error> {
    let p = model_path();
    if !p.exists() {
        return Err(Error::OnnxInference("modèle htdemucs.onnx absent — téléchargement requis".into()));
    }
    let env = ort::init().with_name("alchemix-stems").build().map_err(onx)?;
    Session::builder(&env).map_err(onx)?.commit_from_file(&p).map_err(onx)
}

fn session_guard() -> Result<MutexGuard<'static, Option<Session>>, Error> {
    let m = SESSION.get_or_init(|| Mutex::new(None));
    let mut g = m.lock().map_err(|_| Error::OnnxInference("verrou session stems".into()))?;
    if g.is_none() {
        *g = Some(build_session()?);
    }
    Ok(g)
}

/// Longueur de segment effective : récupérée dynamiquement si possible (repli `SEGMENT`).
fn effective_segment(_sess: &Session) -> usize {
    // session.inputs() permet de lire la shape d'entrée (segmentSamples). On s'appuie sur le
    // repli constant tant que l'export htdemucs fixe cette dimension.
    SEGMENT
}

/// Vrai si les 4 WAV du cache existent et sont non vides.
fn cached_stem_paths(cache: &Path, source: &str) -> Option<StemPaths> {
    let mut paths = Vec::with_capacity(4);
    for n in ["vocals", "drums", "bass", "other"] {
        let p = cache.join(format!("{n}.wav"));
        if p.exists() && p.metadata().map(|m| m.len()).unwrap_or(0) > 44 {
            paths.push(p.to_string_lossy().into_owned());
        } else {
            return None;
        }
    }
    Some(StemPaths {
        source_path: source.to_string(),
        vocals: paths[0].clone(),
        drums: paths[1].clone(),
        bass: paths[2].clone(),
        other: paths[3].clone(),
        model_version: "htdemucs-4s-onnx".into(),
        processing_time_ms: 0,
    })
}

/// Retourne instantanément les stems déjà calculés (cache) pour un fichier, sinon `None`.
#[tauri::command]
pub fn check_cached_stems(path: String) -> Option<StemPaths> {
    let p = path.trim();
    if p.is_empty() {
        return None;
    }
    let Ok(sha) = sha256_hex_file(p) else {
        return None;
    };
    cached_stem_paths(&stems_dir_for_sha(&sha), p)
}

/// Assainit un préfixe de fichier pour Windows (interdit `< > : " / \ | ? *`, Ctrl, point).
/// ALC-177 : retourne toujours un nom non vide (repli `"stem"`).
fn sanitize_prefix(s: &str) -> String {
    let bad: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let mut out: String = s
        .chars()
        .filter(|c| !bad.contains(c) && !c.is_control() && *c != '.')
        .collect();
    out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let out = out.trim().to_string();
    if out.is_empty() {
        "stem".into()
    } else {
        out
    }
}

/// Copie les 4 WAV stems du cache vers un dossier utilisateur, renommés `<préfixe> - <stem>.wav`.
/// ALC-177 : renvoie la liste des 4 chemins exportés, ou une erreur explicite si le cache
/// (séparation) n'existe pas encore pour `file_path`.
#[tauri::command]
pub fn export_stems_to_folder(
    file_path: String,
    dest_dir: String,
    track_prefix: Option<String>,
) -> Result<Vec<String>, Error> {
    let p = file_path.trim();
    if p.is_empty() {
        return Err(Error::InvalidInput("chemin source vide".into()));
    }
    let cache = stems_dir_for_sha(&sha256_hex_file(p)?);
    let stems = cached_stem_paths(&cache, p).ok_or_else(|| {
        Error::NotFound(
            "aucun cache stems pour ce fichier — séparez d'abord les 4 stems".into(),
        )
    })?;
    let dest = PathBuf::from(dest_dir);
    std::fs::create_dir_all(&dest)?;
    let prefix = match track_prefix {
        Some(s) if !s.trim().is_empty() => sanitize_prefix(&s),
        _ => "stem".to_string(),
    };
    let mut exported = Vec::with_capacity(4);
    for (name, src) in [
        ("vocals", &stems.vocals),
        ("drums", &stems.drums),
        ("bass", &stems.bass),
        ("other", &stems.other),
    ] {
        let target = dest.join(format!("{prefix} - {name}.wav"));
        std::fs::copy(src, &target)?;
        exported.push(target.to_string_lossy().into_owned());
    }
    Ok(exported)
}

// ── Passe 2a : décodage (symphonia), resampling 44,1 kHz, export WAV ──
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Décode un fichier en stéréo f32 (canaux L/R séparés) au taux natif.
fn decode_planar(path: &Path) -> Result<(Vec<f32>, Vec<f32>, u32), Error> {
    let file = std::fs::File::open(path)
        .map_err(|_| Error::NotFound(path.display().to_string()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let mut hint = Hint::new();
    hint.with_extension(ext);
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|_| Error::InvalidInput(format!("Format audio illisible : {}", path.display())))?;
    let format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| Error::InvalidInput("Aucune piste audio".into()))?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|_| Error::InvalidInput("Codec non pris en charge".into()))?;
    let mut left = Vec::new();
    let mut right = Vec::new();
    let mut rate = OUTPUT_RATE;
    let mut source = format;
    loop {
        match source.next_packet() {
            Err(_) => break,
            Ok(pkt) => {
                let Ok(decoded) = decoder.decode(&pkt) else { continue };
                let spec = *decoded.spec();
                rate = spec.rate;
                let ch = spec.channels.count();
                let n = decoded.capacity() as u64;
                let mut sb = SampleBuffer::<f32>::new(n, spec);
                sb.copy_interleaved_ref(decoded);
                let s = sb.samples();
                for frame in s.chunks(ch as usize) {
                    let a = frame[0];
                    let b = if ch >= 2 { frame[1] } else { frame[0] };
                    left.push(a);
                    right.push(b);
                }
            }
        }
    }
    Ok((left, right, rate))
}

/// Resampling linéaire simple → 44,1 kHz.
fn resample_to_44100(l: &[f32], r: &[f32], src_rate: u32) -> (Vec<f32>, Vec<f32>) {
    if src_rate == 0 || src_rate == OUTPUT_RATE {
        return (l.to_vec(), r.to_vec());
    }
    let ratio = src_rate as f64 / OUTPUT_RATE as f64;
    let out = (l.len() as f64 * OUTPUT_RATE as f64 / src_rate as f64).round().max(1.0) as usize;
    let mut lo = Vec::with_capacity(out);
    let mut ro = Vec::with_capacity(out);
    for i in 0..out {
        let fx = i as f64 * ratio;
        let i0 = fx.floor() as usize;
        let i1 = (i0 + 1).min(l.len().saturating_sub(1));
        let t = (fx - i0 as f64) as f32;
        lo.push(l[i0] + (l[i1] - l[i0]) * t);
        ro.push(r[i0] + (r[i1] - r[i0]) * t);
    }
    (lo, ro)
}

/// Écrit un WAV 16-bit PCM stéréo (planar L/R → entrelacé).
fn write_wav_stereo_i16(path: &Path, l: &[f32], r: &[f32], rate: u32) -> Result<(), Error> {
    let n = l.len().min(r.len());
    if n == 0 {
        return Err(Error::InvalidInput("piste vide (0 échantillon)".into()));
    }
    let mut h = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + (n as u32 * 4)).to_le_bytes());
    h.extend_from_slice(b"WAVE");
    h.extend_from_slice(b"fmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes());
    h.extend_from_slice(&2u16.to_le_bytes());
    h.extend_from_slice(&rate.to_le_bytes());
    h.extend_from_slice(&(rate * 4).to_le_bytes());
    h.extend_from_slice(&4u16.to_le_bytes());
    // ALC-181 : bitsPerSample du chunk `fmt ` doit être 16 (PCM16). Avant : 2 (valeur de canaux !)
    // → en-tête WAV invalide (bits=2) → tout consommateur honnorant l'en-tête (WebAudio
    // decodeAudioData, lecteurs système, éditeurs) décodait le PCM16 comme du 2-bit →
    // bourdonnement/grondement saturé continu à pleine échelle sur les stems réels (voix inaudible).
    h.extend_from_slice(&16u16.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&(n as u32 * 4).to_le_bytes());
    let mut buf = h;
    buf.reserve(44 + n * 4);
    for i in 0..n {
        let v = |x: f32| (x.clamp(-1.0, 1.0) * 32767.0) as i16;
        buf.extend_from_slice(&v(l[i]).to_le_bytes());
        buf.extend_from_slice(&v(r[i]).to_le_bytes());
    }
    std::fs::write(path, buf)?;
    Ok(())
}

// ── Passe 2b : inférence ONNX (fenêtre 344064), overlap-add Hann 25 %, + separate_stems ──

/// Offset mémoire (ordre C, output [1,4,2,seg]) de la source s, canal c (0=L,1=R), échantillon i.
/// ALC-176 : fonction pure testée — garantit qu'aucun mélange de stride ne copie la voix
/// (indice 3 canonique HTDemucs) dans les mauvais WAV.
fn tensor_offset(s: usize, c: usize, i: usize, seg: usize) -> usize {
    s * (2 * seg) + c * seg + i
}

/// Applique un gain stéréo plan (mute si 0.0). ALC-176 : testé — gain nul → sortie strictement nulle.
#[cfg_attr(not(test), allow(dead_code))]
fn apply_gain(samples: &mut [f32], gain: f32) {
    for x in samples.iter_mut() {
        *x *= gain;
    }
}

/// Exécute le modèle sur une fenêtre planar [1,2,seg] → 4 stems stéréo entrelacés (len 2×seg).
fn run_window(sess: &mut Session, l: &[f32], r: &[f32], seg: usize) -> Result<[Vec<f32>; 4], Error> {
    // ALC-180 : le modèle htdemucs.onnx accepte l'entrée brute et reconstruit déjà la somme
    // des 4 sources ≈ mix (~0.5 pour une entrée d'amplitude 0.5). Aucune normalisation par
    // segment requise — la distorsion venait UNIQUEMENT du wsum accumulé par stem (facteur 4×).
    let mut inp = Vec::with_capacity(2 * seg);
    inp.extend_from_slice(l); // canal L (planar)
    inp.extend_from_slice(r); // canal R
    let tensor = Tensor::<f32>::from_array(([1usize, 2, seg], inp)).map_err(onx)?;
    let outputs = sess.run(ort::inputs![tensor]).map_err(onx)?;
    // ALC-176 : inspection réelle de la shape du tenseur retourné (preuve runtime, une seule fois).
    let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(onx)?;
    static SHAPE_LOG: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if SHAPE_LOG.get().is_none() {
        let _ = SHAPE_LOG.set(());
        eprintln!("[stems] output tensor shape = {:?}", shape);
    }
    // data = [1,4,2,seg] ordre C ; stem s, canal c → tensor_offset(s, c, i, seg).
    let mut stems: [Vec<f32>; 4] = std::array::from_fn(|_| Vec::with_capacity(2 * seg));
    for s in 0..4 {
        for i in 0..seg {
            stems[s].push(data[tensor_offset(s, 0, i, seg)]); // L
            stems[s].push(data[tensor_offset(s, 1, i, seg)]); // R
        }
    }
    Ok(stems)
}

/// Sépare un signal planar et écrit 4 WAV dans `dir` (recouvrement 25 %, Hann normalisé).
fn run_separation(l: &[f32], r: &[f32], dir: &Path, prog: Option<&tauri::ipc::Channel<f32>>) -> Result<(), Error> {
    let seg = effective_segment(&session_guard()?.as_ref().unwrap()); // repli constant
    let total = l.len().min(r.len());
    let hop = (seg as f32 * HOP_RATIO) as usize;
    let n_win = if total <= seg { 1 } else { (total - seg + hop - 1) / hop + 1 };

    let mut acc_l: [Vec<f32>; 4] = std::array::from_fn(|_| vec![0.0; total]);
    let mut acc_r: [Vec<f32>; 4] = std::array::from_fn(|_| vec![0.0; total]);
    let mut wsum = vec![0.0f32; total];

    let mut guard = session_guard()?;
    let sess = guard.as_mut().expect("session ONNX");

    for w in 0..n_win {
        let start = w * hop;
        let mut inl = vec![0.0f32; seg];
        let mut inr = vec![0.0f32; seg];
        let mut hann = vec![0.0f32; seg];
        for i in 0..seg {
            let src = start + i;
            if src < total {
                inl[i] = l[src];
                inr[i] = r[src];
            }
            hann[i] =
                0.5 * (1.0 - ((2.0 * std::f64::consts::PI * i as f64) / (seg as f64 - 1.0)).cos()) as f32;
        }
        let norm = hann.iter().sum::<f32>().max(1e-6);
        let hann: Vec<f32> = hann.into_iter().map(|x| x / norm).collect();

        let stems = run_window(sess, &inl, &inr, seg)?;
        for s in 0..4 {
            for i in 0..seg {
                let out = start + i;
                if out >= total {
                    break;
                }
                acc_l[s][out] += stems[s][i * 2] * hann[i];
                acc_r[s][out] += stems[s][i * 2 + 1] * hann[i];
            }
        }
        // ALC-180 : wsum doit être accumulé UNE fois par échantillon — PAS une fois par stem.
        // (Avant : placé dans la boucle `for s in 0..4`, il était multiplié par 4 → chaque stem
        //  divisé par 4 → somme ~0.26× → quasi mutisme + dégradation i16 → « bruit » en écoute.)
        for i in 0..seg {
            let out = start + i;
            if out >= total {
                break;
            }
            wsum[out] += hann[i];
        }
        if let Some(ch) = prog {
            let _ = ch.send(((w + 1) as f32 / n_win as f32).min(1.0));
        }
    }

    std::fs::create_dir_all(dir)?;
    // Retrouve l'amplitude exacte par stem (ratio acc/wsum, garde overlap-add ~1e-9).
    let mut norm_l: [Vec<f32>; 4] = std::array::from_fn(|_| vec![0.0; total]);
    let mut norm_r: [Vec<f32>; 4] = std::array::from_fn(|_| vec![0.0; total]);
    for s in 0..4 {
        for i in 0..total {
            let scale = if wsum[i] > 1e-9 { 1.0 / wsum[i] } else { 0.0 };
            norm_l[s][i] = acc_l[s][i] * scale;
            norm_r[s][i] = acc_r[s][i] * scale;
        }
    }
    // ALC-184-3 : Wiener soft-mask des vocals contre le bleed de other+drums (cymbales/guitares).
    let od_l: Vec<f32> = norm_l[2].iter().zip(&norm_l[0]).map(|(a, b)| a + b).collect();
    let od_r: Vec<f32> = norm_r[2].iter().zip(&norm_r[0]).map(|(a, b)| a + b).collect();
    let (voc_l, voc_r) = wiener_soft_mask(&norm_l[3], &norm_r[3], &od_l, &od_r, OUTPUT_RATE);
    norm_l[3] = voc_l;
    norm_r[3] = voc_r;
    // ALC-185-1 : gate d'activité vocale doux vs instrumental (drums+bass+other) — nettoie les
    // intros / ponts sans chant (talk-box, nappes synthétiques) sans couper les attaques de mots.
    let inst_l: Vec<f32> = norm_l[0].iter().zip(&norm_l[1]).zip(&norm_l[2]).map(|((a, b), c)| a + b + c).collect();
    let inst_r: Vec<f32> = norm_r[0].iter().zip(&norm_r[1]).zip(&norm_r[2]).map(|((a, b), c)| a + b + c).collect();
    let (vg_l, vg_r) = apply_vocal_gate(&norm_l[3], &norm_r[3], &inst_l, &inst_r, OUTPUT_RATE);
    norm_l[3] = vg_l;
    norm_r[3] = vg_r;
    // ALC-175 : ordre HTDemucs canonique [0=drums, 1=bass, 2=other, 3=vocals] (mapping vérifié).
    for (s, name) in ["drums", "bass", "other", "vocals"].iter().enumerate() {
        write_wav_stereo_i16(&dir.join(format!("{name}.wav")), &norm_l[s], &norm_r[s], OUTPUT_RATE)?;
    }
    if let Some(ch) = prog {
        let _ = ch.send(1.0);
    }
    Ok(())
}

/// Sépare une piste en 4 stems (ONNX local) ; lit d'abord le cache, sinon infère puis met en cache.
#[tauri::command]
pub async fn separate_stems(path: String, on_progress: tauri::ipc::Channel<f32>) -> Result<StemPaths, Error> {
    let p = path.trim().to_string();
    if p.is_empty() {
        return Err(Error::InvalidInput("Chemin audio requis pour l'inférence ONNX".into()));
    }
    let sha = sha256_hex_file(&p)?;
    let dir = stems_dir_for_sha(&sha);
    if let Some(sp) = cached_stem_paths(&dir, &p) {
        return Ok(sp);
    }
    let pl = p.clone();
    let dl = dir.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<(), Error> {
        let (l0, r0, rate) = decode_planar(Path::new(&pl))?;
        let (l, r) = resample_to_44100(&l0, &r0, rate);
        run_separation(&l, &r, &dl, Some(&on_progress))
    })
    .await
    .map_err(|e| Error::OnnxInference(format!("tâche stems interrompue : {e}")))?;
    res?;
    cached_stem_paths(&dir, &p)
        .ok_or_else(|| Error::OnnxInference("échec de la séparation (aucun WAV)".into()))
}

// ── ALC-184-3 : Wiener soft-mask anti-bleed sur le stem vocals ────────────────────────────
// Structure STFT : n_fft = 2048, hop = 1024 (50 %), fenêtre de Hann symétrique (COLA).
const MASK_FFT: usize = 2048;
const MASK_HOP: usize = 1024;
/// Agressivité du Wiener : si `e_other+drums > K × e_vocals` dans une bande → forte atténuation.
const MASK_K: f64 = 2.0;
/// Ordre p du Wiener soft-mask (1 = doux).
const MASK_P: f64 = 1.0;
const MASK_EPS: f64 = 1e-10;

/// Coefficient de suppression K(f) du Wiener selon la bande (ALC-185-1) :
/// sub-grave < 120 Hz → 4.0 (élimine les résidus grosse caisse / basse dans `vocals`) ;
/// cœur des formants vocaux 300–4200 Hz → 1.5 (préserve chaleur & intelligibilité de la voix) ;
/// aigu cymbales crash / charlestons > 6500 Hz → 3.5 (réduit le bleed métallique des refrains rock).
fn wiener_k_at(freq_hz: f64) -> f64 {
    if freq_hz < 120.0 {
        4.0
    } else if (300.0..=4200.0).contains(&freq_hz) {
        1.5
    } else if freq_hz > 6500.0 {
        3.5
    } else {
        MASK_K // bande médiane / transition → 2.0
    }
}

/// Gain Wiener paramétré : gain = e_v^P / (e_v^P + K·e_od^P). ≈1 si la voix domine, <1 sinon.
/// e_v == e_od == 0 → 1 (un passage silencieux reste silencieux).
fn wiener_gain_k(e_v: f64, e_od: f64, k: f64) -> f64 {
    if e_v + e_od <= MASK_EPS {
        return 1.0;
    }
    let num = e_v.powf(MASK_P);
    let den = num + k * e_od.powf(MASK_P);
    if den <= 0.0 { 1.0 } else { (num / den).min(1.0) }
}

/// STFT à chevauchement (Hann symétrique, 50 %, COLA) : atténue le résidu spectral de `vocals`
/// quand `other+drums` dominent localement (cymbales > ~7 kHz, guitares saturées) tout en
/// préservant les crêtes de la voix. Masque Wiener calculé en mono (voc vs other+drums) puis
/// appliqué à chaque canal L / R.
fn wiener_soft_mask(
    voc_l: &[f32],
    voc_r: &[f32],
    od_l: &[f32],
    od_r: &[f32],
    rate: u32,
) -> (Vec<f32>, Vec<f32>) {
    use rustfft::{num_complex::Complex, FftPlanner};
    let n = voc_l.len().min(voc_r.len()).min(od_l.len()).min(od_r.len());
    if n < MASK_FFT {
        return (voc_l[..n].to_vec(), voc_r[..n].to_vec());
    }
    let mut out_l = vec![0.0f32; n];
    let mut out_r = vec![0.0f32; n];
    let mut wsum = vec![0.0f32; n];
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(MASK_FFT);
    let ifft = planner.plan_fft_inverse(MASK_FFT);
    let hann: Vec<f64> = (0..MASK_FFT)
        .map(|i| 0.5 * (1.0 - (2.0 * std::f64::consts::PI * i as f64 / (MASK_FFT as f64 - 1.0)).cos()))
        .collect();
    let bin_hz = rate as f64 / MASK_FFT as f64;
    // Bandes fréquentielles (~1/3 d'octave) → masque doux en blocs.
    let nyq = MASK_FFT / 2;
    let mut bands: Vec<(usize, usize)> = Vec::new();
    let mut lo = 2usize;
    let mut guard = 0usize;
    while lo < nyq && guard < 64 {
        let hi = ((lo as f64 * 1.122) as usize).max(lo + 1).min(nyq);
        bands.push((lo, hi));
        lo = hi + 1;
        guard += 1;
    }
    bands.push((bands.last().map_or(2, |b| b.1), nyq));

    let mut pos = 0usize;
    while pos + MASK_FFT <= n {
        let mut bv: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); MASK_FFT];
        let mut bo: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); MASK_FFT];
        let mut bl: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); MASK_FFT];
        let mut br: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); MASK_FFT];
        for k in 0..MASK_FFT {
            let i = pos + k;
            let vo = ((voc_l[i] as f64) + (voc_r[i] as f64)) * 0.5;
            let oo = ((od_l[i] as f64) + (od_r[i] as f64)) * 0.5;
            bv[k] = Complex::new((vo * hann[k]) as f32, 0.0);
            bo[k] = Complex::new((oo * hann[k]) as f32, 0.0);
            bl[k] = Complex::new((voc_l[i] as f64 * hann[k]) as f32, 0.0);
            br[k] = Complex::new((voc_r[i] as f64 * hann[k]) as f32, 0.0);
        }
        fft.process(&mut bv);
        fft.process(&mut bo);
        fft.process(&mut bl);
        fft.process(&mut br);
        let mut masks = vec![1.0f64; bands.len()];
        for (bi, (blo, bhi)) in bands.iter().enumerate() {
            let mut ev = 0.0f64;
            let mut eo = 0.0f64;
            for b in *blo..*bhi {
                ev += bv[b].re.powf(2.0) as f64 + bv[b].im.powf(2.0) as f64;
                eo += bo[b].re.powf(2.0) as f64 + bo[b].im.powf(2.0) as f64;
            }
            // ALC-185-1 : coefficient de suppression K(f) dépendant de la bande (formants préservés).
            let cf = ((*blo + *bhi) as f64 * 0.5) * bin_hz;
            masks[bi] = wiener_gain_k(ev, eo, wiener_k_at(cf));
        }
        for k in 1..MASK_FFT / 2 {
            let band = bands.iter().position(|b| k >= b.0 && k < b.1).unwrap_or(bands.len() - 1);
            let m = masks[band] as f32;
            let km = MASK_FFT - k;
            bl[k] = Complex::new(bl[k].re * m, bl[k].im * m);
            bl[km] = Complex::new(bl[km].re * m, bl[km].im * m);
            br[k] = Complex::new(br[k].re * m, br[k].im * m);
            br[km] = Complex::new(br[km].re * m, br[km].im * m);
        }
        ifft.process(&mut bl);
        ifft.process(&mut br);
        let inv = 1.0 / MASK_FFT as f64;
        for k in 0..MASK_FFT {
            let i = pos + k;
            if i < n {
                out_l[i] += (bl[k].re as f64 * inv * hann[k]) as f32;
                out_r[i] += (br[k].re as f64 * inv * hann[k]) as f32;
                wsum[i] += (hann[k] * hann[k]) as f32;
            }
        }
        pos += MASK_HOP;
    }
    for i in 0..n {
        let w = wsum[i];
        // ALC-184-3 : ne normaliser QUE là où la fenêtre de reconstruction est bien posée
        // (COLA, wsum ~constante). Aux bords (wsum ≈ 0) on garde le vocal d'origine => aucune
        // inflation/épine spectrale (régression fidélité ALC-180 : pic 1.43 au lieu de 0.5).
        if w > 0.1 {
            out_l[i] /= w;
            out_r[i] /= w;
        } else {
            out_l[i] = voc_l[i];
            out_r[i] = voc_r[i];
        }
    }
    (out_l, out_r)
}

/// ALC-185-1 : gate d'activité vocale doux (anti-bleed des intros / ponts instrumentaux).
/// Trames lissées de 250 ms (attaque 20 ms, relâchement 100 ms) : si le RMS du stem `vocals`
/// est < GATE_RATIO (12 %) de l'énergie instrumentale (drums+bass+other), on applique une
/// atténuation douce `GATE_GAIN` (0.125 = -18 dB) sans jamais couper les attaques de mots.
fn apply_vocal_gate(
    voc_l: &[f32],
    voc_r: &[f32],
    inst_l: &[f32],
    inst_r: &[f32],
    rate: u32,
) -> (Vec<f32>, Vec<f32>) {
    const GATE_FRAME_MS: f64 = 250.0;
    const GATE_ATTACK_MS: f64 = 20.0;
    const GATE_RELEASE_MS: f64 = 100.0;
    const GATE_RATIO: f64 = 0.12;
    const GATE_GAIN: f32 = 0.125; // -18 dB

    let n = voc_l.len().min(voc_r.len()).min(inst_l.len()).min(inst_r.len());
    if n == 0 {
        return (voc_l.to_vec(), voc_r.to_vec());
    }
    let sr = rate.max(1) as f64;
    let frame = ((sr * GATE_FRAME_MS / 1000.0).round() as usize).max(1);
    let attack = (sr * GATE_ATTACK_MS / 1000.0).max(1.0); // constante de temps (échantillons)
    let release = (sr * GATE_RELEASE_MS / 1000.0).max(1.0);

    let mut out_l = vec![0.0f32; n];
    let mut out_r = vec![0.0f32; n];
    let mut gain = 1.0f64;
    let mut pos = 0usize;
    while pos < n {
        let end = (pos + frame).min(n);
        let mut sv = 0.0f64;
        let mut si = 0.0f64;
        for i in pos..end {
            sv += voc_l[i] as f64 * voc_l[i] as f64 + voc_r[i] as f64 * voc_r[i] as f64;
            si += inst_l[i] as f64 * inst_l[i] as f64 + inst_r[i] as f64 * inst_r[i] as f64;
        }
        let cnt = (end - pos) as f64;
        let rms_v = (sv / cnt.max(1.0)).sqrt();
        let rms_i = (si / cnt.max(1.0)).sqrt();
        let target = if rms_i > 1e-8 && rms_v < GATE_RATIO * rms_i {
            GATE_GAIN as f64
        } else {
            1.0
        };
        let time = if target < gain { release } else { attack };
        let a = 1.0 - (-1.0 / time).exp();
        for i in pos..end {
            gain += a * (target - gain);
            out_l[i] = voc_l[i] * gain as f32;
            out_r[i] = voc_r[i] * gain as f32;
        }
        pos = end;
    }
    (out_l, out_r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static G: Mutex<()> = Mutex::new(());

    /// ALC-179 : signal stéréo synthétique 2 s @44,1 kHz — sinusoïde 440 Hz d'amplitude 0.5
    /// (les deux canaux), tel que spécifié par le gate acoustique ALC-179-2.
    fn synth2s() -> (Vec<f32>, Vec<f32>) {
        let n = OUTPUT_RATE as usize * 2;
        let mut l = Vec::with_capacity(n);
        let mut r = Vec::with_capacity(n);
        for i in 0..n {
            let t = i as f32 / OUTPUT_RATE as f32;
            let v = 0.5 * (2.0 * std::f32::consts::PI * 440.0 * t).sin();
            l.push(v);
            r.push(v);
        }
        (l, r)
    }

    /// ALC-184-3 (TDD) : le Wiener soft-mask atténue un composant ~8 kHz dominant dans other+drums
/// (bleed cymbales / guitares saturées Spaceman) tout en préservant un formant 440 Hz de la voix.
#[test]
    fn wiener_mask_attenuates_bleed_preserves_formant() {
        let rate = OUTPUT_RATE as f32; // 44 100
        let n = rate as usize * 2;
        let pi = std::f32::consts::PI;
        let mut voc = vec![0.0f32; n];
        let mut od = vec![0.0f32; n];
        for i in 0..n {
            let t = i as f32 / rate;
            voc[i] = 0.5 * (2.0 * pi * 440.0 * t).sin() + 0.15 * (2.0 * pi * 8000.0 * t).sin();
            od[i] = 0.6 * (2.0 * pi * 8000.0 * t).sin(); // other+drums dominent à 8 kHz
        }
        let proj = |x: &[f32], f: f32| -> f64 {
            let ph = 2.0 * pi * f;
            let mut acc = 0.0f64;
            let mut den = 0.0f64;
            for (i, v) in x.iter().enumerate() {
                let s = (ph * (i as f32 / rate)).sin() as f64;
                acc += *v as f64 * s;
                den += s * s;
            }
            if den > 0.0 { acc / den } else { 0.0 }
        };
        let o_440 = proj(&voc, 440.0).abs();
        let o_8k = proj(&voc, 8000.0).abs();
        let (ml, _mr) = wiener_soft_mask(&voc, &voc, &od, &od, 44_100);
        let m_440 = proj(&ml, 440.0).abs();
        let m_8k = proj(&ml, 8000.0).abs();
        assert!(
            m_440 > 0.8 * o_440,
            "formant 440 Hz préserve (m={m_440:.3}, orig={o_440:.3})"
        );
        assert!(
            m_8k < 0.5 * o_8k,
            "bleed 8 kHz atténué (m={m_8k:.3}, orig={o_8k:.3})"
        );
        assert!(
            m_8k > 0.0,
            "le masque ne doit pas annuler totalement (pas de trou spectral brutal)"
        );
    }

    /// ALC-185-2 (TDD) : avec K(f) par bande, l'atténuation d'un composant à 8 kHz (cymbale crash,
/// K=3.5) est PLUS forte que celle d'un composant à 1 kHz (formant, K=1.5) à dominance égale du bleed.
#[test]
    fn wiener_band_k_attenuates_8k_more_than_1k() {
        let rate = OUTPUT_RATE as f32;
        let n = rate as usize * 2;
        let pi = std::f32::consts::PI;
        let mut voc = vec![0.0f32; n];
        let mut od = vec![0.0f32; n];
        for i in 0..n {
            let t = i as f32 / rate;
            voc[i] = 0.1 * (2.0 * pi * 1000.0 * t).sin() + 0.1 * (2.0 * pi * 8000.0 * t).sin();
            od[i] = 0.5 * (2.0 * pi * 1000.0 * t).sin() + 0.5 * (2.0 * pi * 8000.0 * t).sin();
        }
        let proj = |x: &[f32], f: f32| -> f64 {
            let ph = 2.0 * pi * f;
            let mut acc = 0.0f64;
            let mut den = 0.0f64;
            for (i, v) in x.iter().enumerate() {
                let s = (ph * (i as f32 / rate)).sin() as f64;
                acc += *v as f64 * s;
                den += s * s;
            }
            if den > 0.0 { acc / den } else { 0.0 }
        };
        let a1_orig = proj(&voc, 1000.0).abs();
        let a8_orig = proj(&voc, 8000.0).abs();
        let (ml, _) = wiener_soft_mask(&voc, &voc, &od, &od, OUTPUT_RATE);
        let a1 = proj(&ml, 1000.0).abs();
        let a8 = proj(&ml, 8000.0).abs();
        let r1 = a1 / a1_orig.max(1e-9);
        let r8 = a8 / a8_orig.max(1e-9);
        assert!(
            r8 < r1,
            "attenuation 8 kHz doit depasser celle 1 kHz (r8={r8:.4}, r1={r1:.4})"
        );
        assert!(r8 < 0.05, "cymbale 8 kHz fortement attenuee (r8={r8:.4})");
    }

    /// ALC-185-2 (TDD) : le gate d'activité vocale atténue un passage purement instrumental de
    /// faible ratio (gain ~0.125) tout en laissant passer une entrée vocale à gain unitaire (>= 0.95).
    #[test]
    fn vocal_gate_attenuates_instrumental_preserves_voice() {
        let rate = OUTPUT_RATE as f32;
        let sr = rate as usize;
        let n = sr * 2;
        let pi = std::f32::consts::PI;
        let mut voc = vec![0.0f32; n];
        let mut inst = vec![0.0f32; n];
        for i in 0..n {
            let t = i as f32 / rate;
            let s440 = (2.0 * pi * 440.0 * t).sin();
            if t < 1.0 {
                voc[i] = 0.5 * s440; // voix dominante
                inst[i] = 0.1 * (2.0 * pi * 60.0 * t).sin();
            } else {
                voc[i] = 0.05 * s440; // simple bleed
                inst[i] = 1.0 * (2.0 * pi * 220.0 * t).sin(); // instrumental fort
            }
        }
        let (out_l, _) = apply_vocal_gate(&voc, &voc, &inst, &inst, OUTPUT_RATE);
        let rms = |x: &[f32], a: usize, b: usize| -> f64 {
            let s: f64 = x[a..b].iter().map(|v| (*v as f64) * (*v as f64)).sum();
            (s / (b - a) as f64).sqrt()
        };
        let rin0 = rms(&voc, 0, sr);
        let rout0 = rms(&out_l, 0, sr);
        assert!(
            rout0 >= 0.95 * rin0,
            "voix preservee (rout={rout0:.3}, rin={rin0:.3})"
        );
        let lo = (sr + sr / 2);
        let rin1 = rms(&voc, lo, n);
        let rout1 = rms(&out_l, lo, n);
        assert!(
            rout1 < 0.5 * rin1,
            "passage instrumental attenue (rout1={rout1:.3}, rin1={rin1:.3})"
        );
    }

    /// Gate ALC-174-1 : inférence ONNX réelle sur 2 s → 4 WAV non vides + rechargement cache.
    #[test]
    fn stems_2s_4_wavs_and_cache() {
        let _g = G.lock().unwrap();
        let tmp = std::env::temp_dir().join("alchemix-stems-2s");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let (l, r) = synth2s();
        let inwav = tmp.join("in.wav");
        write_wav_stereo_i16(&inwav, &l, &r, OUTPUT_RATE).unwrap();
        let sha = sha256_hex_file(inwav.to_str().unwrap()).unwrap();
        let cache = stems_dir_for_sha(&sha);
        let _ = std::fs::remove_dir_all(&cache);

        run_separation(&l, &r, &cache, None).expect("séparation ONNX doit réussir");

        // ALC-181 : intégrité de l'en-tête WAV (régression bitsPerSample=2 → bourdonnement saturé).
        for name in ["drums", "bass", "other", "vocals"] {
            let h = std::fs::read(cache.join(format!("{name}.wav"))).unwrap();
            let u16at = |o: usize| u16::from_le_bytes([h[o], h[o + 1]]);
            assert_eq!(u16at(20), 1, "{name}.wav : audioFmt doit être PCM");
            assert_eq!(u16at(22), 2, "{name}.wav : doit être stéréo");
            assert_eq!(u16at(32), 4, "{name}.wav : blockAlign=4 (PCM16 stéréo)");
            assert_eq!(
                u16at(34),
                16,
                "{name}.wav : bitsPerSample=16 — régression en-tête ALC-181"
            );
        }

        // ALC-179 : GATE ACOUSTIQUE — une sortie silencieuse (échantillons ~0) doit faire échouer le test.
        // C'est exactement la régression réelle (garde overlap-add `w > 1e-3` vs wsum ~1e-5 → WAV à 0).
        // Mesure directe du PCM i16 (offset entête 44) : indépendante de symphonia, et conforme au
        // critère « > 1 600 en i16 » (0,05 × 32767 ≈ 1638). Un WAV silencieux → échec strict.
        let mut global_peak_i16: i64 = 0;
        for name in ["vocals", "drums", "bass", "other"] {
            let p = cache.join(format!("{name}.wav"));
            assert!(p.exists(), "{name} manquant dans le cache");
            let raw = std::fs::read(&p).unwrap_or_else(|_| panic!("{name}.wav doit être lisible"));
            assert!(raw.len() > 44, "{name} ne contient que l'entête WAV");
            let mut mx: i64 = 0;
            for chunk in raw[44..].chunks_exact(2) {
                let s = i16::from_le_bytes([chunk[0], chunk[1]]) as i64;
                mx = mx.max(s.abs());
            }
            global_peak_i16 = global_peak_i16.max(mx);
            eprintln!("[GATE] {name}.wav max_i16={mx}");
        }
        assert!(
            global_peak_i16 > 1600,
            "gate acoustique ALC-179 : stems SILENCIEUX (max_i16={global_peak_i16} ≤ 1600) — WAV ~0 malgré sortie modèle non nulle"
        );

        let re = check_cached_stems(inwav.to_str().unwrap().to_string());
        assert!(re.is_some(), "check_cached_stems doit retrouver les stems");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// ALC-181-2 — GATE de séparation multi-sources (remplace le test sinusoïdal trop permissif).
    /// Signal synthétique réaliste 7,8 s (kick 60 Hz pulsé + basse 110 Hz + formants vocaux modulés
    /// 300-2500 Hz + 4 zones de silence), séparation réelle via run_separation → 4 WAV :
    ///  ① en-tête WAV exact (PCM stéréo 44,1 kHz — bitsPerSample=16, régression ALC-181) ;
    ///  ② zones silencieuses → silence dans CHAQUE stem (rms < 0.005, aucun bourdonnement) ;
    ///  ③ kick 60 Hz majoritairement dans drums (bande sub 30-90 Hz > 0.4) ;
    ///  ④ basse 110 Hz majoritairement dans bass (bande low 90-180 Hz > 0.6) ;
    ///  ⑤ formants 400-2400 Hz majoritairement dans vocals/other.
    /// Journalise aussi le contrat I/O réel du modèle (1 entrée `mix`, 1 sortie `sources`).
    #[test]
    fn stems_multisource_separation_gate() {
        let _g = G.lock().unwrap();
        let sr = OUTPUT_RATE as usize;
        let seg = SEGMENT;
        let pi = std::f64::consts::PI;

        // ① Contrat I/O réel du modèle
        let mut guard = session_guard().unwrap();
        let sess = guard.as_mut().unwrap();
        eprintln!("[A181] === session.inputs() ===");
        for inp in sess.inputs() {
            eprintln!(
                "[A181]   in name={:?} tensor_type={:?} shape={:?}",
                inp.name(),
                inp.dtype().tensor_type(),
                inp.dtype().tensor_shape().map(|s| s.to_vec()),
            );
        }
        eprintln!("[A181] === session.outputs() ===");
        for out in sess.outputs() {
            eprintln!(
                "[A181]   out name={:?} tensor_type={:?} shape={:?}",
                out.name(),
                out.dtype().tensor_type(),
                out.dtype().tensor_shape().map(|s| s.to_vec()),
            );
        }

        // ③ Signal multi-sources réaliste (7,8 s = 1 fenêtre), stéréo L=R.
        let mut l = vec![0f32; seg];
        let mut r = vec![0f32; seg];
        // Zones silencieuses d'entrée : 0,0-0,5 s | 1,5-2,5 s | 4,0-5,0 s | 6,8-7,8 s
        let sil: [std::ops::Range<usize>; 4] =
            [0..sr / 2, (3 * sr / 2)..(5 * sr / 2), (4 * sr)..(5 * sr), (34 * sr / 5)..seg];
        for k in 0..6usize {
            // kick 60 Hz pulsé (0,5-1,5 s)
            let t0 = sr / 2 + k * (sr / 6);
            for i in 0..(sr / 8) {
                let t = i as f32 / sr as f32;
                let v = 0.5 * (-t * 30.0).exp() * (2.0 * pi as f32 * 60.0 * t).sin();
                if t0 + i < seg {
                    l[t0 + i] += v;
                    r[t0 + i] += v;
                }
            }
        }
        for i in (5 * sr / 2)..(4 * sr) {
            // basse 110 Hz continue (2,5-4,0 s)
            let t = i as f32 / sr as f32;
            let v = 0.3 * (2.0 * pi as f32 * 110.0 * t).sin();
            l[i] += v;
            r[i] += v;
        }
        for i in (5 * sr)..(34 * sr / 5) {
            // formants vocaux modulés 400-2400 Hz (5,0-6,8 s) : AM ~6 Hz + vibrato ~5 Hz
            let t = i as f32 / sr as f32;
            let am = 0.5 + 0.5 * (2.0 * pi as f32 * 6.0 * t).sin();
            let vib = 1.0 + 0.03 * (2.0 * pi as f32 * 5.0 * t).sin();
            let mut v = 0.0f32;
            for (f, a) in [(400.0f32, 0.5f32), (800.0, 0.4), (1200.0, 0.3), (1800.0, 0.25), (2400.0, 0.15)]
            {
                v += a * am * (2.0 * pi as f32 * f * vib * t).sin();
            }
            v *= 0.12;
            l[i] += v;
            r[i] += v;
        }
        let rms_f = |x: &[f32]| {
            (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len() as f64).sqrt()
        };
        eprintln!(
            "[A181] INPUT: max_abs={:.4} rms={:.4} rms_kick={:.3} rms_bass={:.3} rms_form={:.3}",
            l.iter().fold(0f32, |m, &x| m.max(x.abs())),
            rms_f(&l),
            rms_f(&l[sr / 2..(3 * sr / 2)]),
            rms_f(&l[5 * sr / 2..4 * sr]),
            rms_f(&l[5 * sr..34 * sr / 5]),
        );

        drop(guard);
        // Chemin de production exact : run_separation écrit les 4 WAV réels.
        let tmp = std::env::temp_dir().join(format!("alc181-ms-gate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        run_separation(&l, &r, &tmp, None).unwrap();

        let read_itl = |p: &std::path::Path| -> Vec<f32> {
            let raw = std::fs::read(p).unwrap();
            let mut v = Vec::with_capacity((raw.len() - 44) / 2);
            for c in raw[44..].chunks_exact(2) {
                v.push(i16::from_le_bytes([c[0], c[1]]) as f32 / 32767.0);
            }
            v
        };
        let silrms = |st: &[f32], a: &std::ops::Range<usize>| {
            let mut s2 = 0.0f64;
            let mut c = 0usize;
            for i in a.clone() {
                if i * 2 + 1 < st.len() {
                    let x = st[2 * i] as f64;
                    let y = st[2 * i + 1] as f64;
                    s2 += x * x + y * y;
                    c += 2;
                }
            }
            (s2 / c.max(1) as f64).sqrt()
        };
        let mut bands_by_stem: Vec<[f64; 4]> = Vec::new();
        for (si, name) in ["drums", "bass", "other", "vocals"].iter().enumerate() {
            let p = tmp.join(format!("{name}.wav"));
            // ① Intégrité de l'en-tête WAV (régression ALC-181 : bitsPerSample valait 2 → bourdonnement).
            let h = std::fs::read(&p).unwrap();
            let u16at = |o: usize| u16::from_le_bytes([h[o], h[o + 1]]);
            let u32at = |o: usize| u32::from_le_bytes([h[o], h[o + 1], h[o + 2], h[o + 3]]);
            assert!(h.len() > 44, "{name}.wav : en-tête trop court");
            assert_eq!(u16at(20), 1, "{name}.wav : audioFmt doit être PCM");
            assert_eq!(u16at(22), 2, "{name}.wav : doit être stéréo");
            assert_eq!(u32at(24), OUTPUT_RATE as u32, "{name}.wav : taux 44,1 kHz attendu");
            assert_eq!(u16at(32), 4, "{name}.wav : blockAlign=4 (PCM16 stéréo)");
            assert_eq!(
                u16at(34),
                16,
                "{name}.wav : bitsPerSample=16 — régression en-tête ALC-181 (grondement saturé en écoute)"
            );
            let st = read_itl(&p);
            let sils = [
                silrms(&st, &sil[0]),
                silrms(&st, &sil[1]),
                silrms(&st, &sil[2]),
                silrms(&st, &sil[3]),
            ];
            // ② silence de l'entrée → silence du stem (zéro bourdonnement généré).
            assert!(
                sils[0] < 0.005 && sils[1] < 0.005 && sils[2] < 0.005 && sils[3] < 0.005,
                "{name}.wav : bruit généré dans les zones silencieuses rms=[{:.4},{:.4},{:.4},{:.4}]",
                sils[0], sils[1], sils[2], sils[3]
            );
            let bands = spectral_band_share(&st, sr);
            eprintln!(
                "[GATE] {} (index {si}): silence=[{:.4},{:.4},{:.4},{:.4}] bands[sub={:.3} low={:.3} form={:.3} rest={:.3}]",
                name, sils[0], sils[1], sils[2], sils[3], bands[0], bands[1], bands[2], bands[3],
            );
            bands_by_stem.push(bands);
        }
        let d = bands_by_stem[0]; // drums
        let b = bands_by_stem[1]; // bass
        let o = bands_by_stem[2]; // other
        let v = bands_by_stem[3]; // vocals
        // ③ kick 60 Hz → drums (bande sub 30-90 Hz prépondérante)
        assert!(
            d[0] > 0.4 && d[0] > b[0] && d[0] > o[0] && d[0] > v[0],
            "gate ALC-181 : kick 60 Hz mal routé (drums.sub={:.3}, bass.sub={:.3}, other.sub={:.3}, vocals.sub={:.3})",
            d[0], b[0], o[0], v[0]
        );
        // ④ basse 110 Hz → bass (bande low 90-180 Hz prépondérante)
        assert!(
            b[1] > 0.6 && b[1] > d[1] && b[1] > o[1] && b[1] > v[1],
            "gate ALC-181 : basse 110 Hz mal routée (bass.low={:.3})",
            b[1]
        );
        // ⑤ formants 400-2400 Hz → vocals/other (vs drums/bass)
        assert!(
            (o[2] + v[2]) > 1.5 * (d[2] + b[2]),
            "gate ALC-181 : formants vocaux mal routés (other.form={:.3}, vocals.form={:.3}, drums.form={:.3}, bass.form={:.3})",
            o[2], v[2], d[2], b[2]
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Répartition spectrale (magnitude²) d'un stem stéréo entrelacé [L,R,…] en 4 bandes :
    /// [0] sub 30-90 Hz (kick), [1] low 90-180 Hz (basse), [2] formants 300-2600 Hz (voix), [3] reste.
    /// Frames de 16384 éch. (Hann), hop 8192, FFT rustfft, mix mono. Parts normalisées (somme = 1).
    fn spectral_band_share(interleaved: &[f32], rate: usize) -> [f64; 4] {
        use rustfft::{num_complex::Complex, FftPlanner};
        const FFT: usize = 16384;
        const HOP: usize = 8192;
        let n = interleaved.len() / 2;
        if n < FFT {
            return [0.0; 4];
        }
        let mut mono: Vec<f64> = Vec::with_capacity(n);
        for i in 0..n {
            mono.push((interleaved[2 * i] as f64 + interleaved[2 * i + 1] as f64) * 0.5);
        }
        let mut hann = [0.0f64; FFT];
        for (i, h) in hann.iter_mut().enumerate() {
            *h = 0.5 * (1.0 - (2.0 * std::f64::consts::PI * i as f64 / (FFT as f64 - 1.0)).cos());
        }
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(FFT);
        let mut pow = vec![0.0f64; FFT / 2];
        let mut start = 0usize;
        while start + FFT <= n {
            let mut buf: Vec<Complex<f32>> = (0..FFT)
                .map(|k| Complex::new((mono[start + k] * hann[k]) as f32, 0.0))
                .collect();
            fft.process(&mut buf);
            for b in 0..FFT / 2 {
                let re = buf[b].re as f64;
                let im = buf[b].im as f64;
                pow[b] += re * re + im * im;
            }
            start += HOP;
        }
        let bin_hz = rate as f64 / FFT as f64;
        let mut bands = [0.0f64; 4];
        for (b, p) in pow.iter().enumerate() {
            let f = b as f64 * bin_hz;
            let idx = if (30.0..90.0).contains(&f) {
                0
            } else if (90.0..180.0).contains(&f) {
                1
            } else if (300.0..2600.0).contains(&f) {
                2
            } else {
                3
            };
            bands[idx] += p;
        }
        let total: f64 = bands.iter().sum();
        if total > 0.0 {
            for x in bands.iter_mut() {
                *x /= total;
            }
        }
        bands
    }
    // (Le test de diagnostic ALC-179-1 a été exécuté puis retiré après capture des faits —
    //  voir project-tracker/journals.json. Le gate acoustique strict est ci-dessus.)

    /// ALC-180-1 : diagnostic de FIDÉLITÉ — somme des 4 WAV générés vs signal d'entrée.
    /// Lit le PCM i16 brut des WAV, somme les 4 stems par canal, compare au signal original
    /// par corrélation de Pearson + RMS + pic. Compare fenêtre UNIQUE (2 s) vs MULTI-fenêtres (10 s).
    fn wav_i16_stereo_to_f32(path: &std::path::Path) -> (Vec<f32>, Vec<f32>) {
        let raw = std::fs::read(path).unwrap();
        let mut l = Vec::new();
        let mut r = Vec::new();
        for chunk in raw[44..].chunks_exact(4) {
            let ls = i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32767.0;
            let rs = i16::from_le_bytes([chunk[2], chunk[3]]) as f32 / 32767.0;
            l.push(ls);
            r.push(rs);
        }
        (l, r)
    }
    fn pearson(a: &[f32], b: &[f32]) -> f64 {
        let n = a.len().min(b.len());
        let ma = a[..n].iter().map(|x| *x as f64).sum::<f64>() / n as f64;
        let mb = b[..n].iter().map(|x| *x as f64).sum::<f64>() / n as f64;
        let mut num = 0.0;
        let mut da = 0.0;
        let mut db = 0.0;
        for i in 0..n {
            let x = a[i] as f64 - ma;
            let y = b[i] as f64 - mb;
            num += x * y;
            da += x * x;
            db += y * y;
        }
        num / (da * db).sqrt()
    }

    #[test]
    fn stems_reconstruction_fidelity_gate() {
        let _g = G.lock().unwrap();
        let sr = OUTPUT_RATE as usize;
        // Composite stéréo multi-fenêtres (10 s, ~2 fenêtres chevauchantes WOLA) : L=440 Hz/0.5, R=880 Hz/0.5.
        let n = sr * 10;
        let mut l = vec![0f32; n];
        let mut r = vec![0f32; n];
        for i in 0..n {
            let t = i as f32 / sr as f32;
            l[i] = 0.5 * (2.0 * std::f32::consts::PI * 440.0 * t).sin();
            r[i] = 0.5 * (2.0 * std::f32::consts::PI * 880.0 * t).sin();
        }
        let tmp = std::env::temp_dir().join("alchemix-fidelity-gate");
        let _ = std::fs::remove_dir_all(&tmp);
        run_separation(&l, &r, &tmp, None).unwrap();
        let mut sl = vec![0f32; n];
        let mut srr = vec![0f32; n];
        for name in ["drums", "bass", "other", "vocals"] {
            let (dl, dr) = wav_i16_stereo_to_f32(&tmp.join(format!("{name}.wav")));
            for (i, v) in dl.iter().enumerate() {
                if i < n {
                    sl[i] += v;
                }
            }
            for (i, v) in dr.iter().enumerate() {
                if i < n {
                    srr[i] += v;
                }
            }
        }
        let pl = pearson(&sl, &l);
        let pr = pearson(&srr, &r);
        let cross = pearson(&sl, &r); // L_sum vs R_original → doit être < pl (canaux non permutés)
        let pk = sl.iter().fold(0.0f32, |a, &x| a.max(x.abs()));
        let pk_i16 = (pk * 32767.0) as i64;
        eprintln!(
            "[GATE] fidelity pearson_L={pl:.4} pearson_R={pr:.4} cross_LvsR={cross:.4} peak_L_sum={pk:.4} peak_i16={pk_i16}"
        );
        assert!(
            pl > 0.95 && pr > 0.95,
            "gate fidélité ALC-180 : pearson L={pl:.4} / R={pr:.4} ≤ 0.95 (séparation non fidèle)"
        );
        assert!(
            pk >= 0.35 && pk <= 0.65,
            "gate fidélité ALC-180 : pic de la somme={pk:.4} hors [0.35,0.65]"
        );
        assert!(
            pk_i16 >= 11400 && pk_i16 <= 21300,
            "gate fidélité ALC-180 : pic i16={pk_i16} hors [11400,21300]"
        );
        assert!(
            cross < pl,
            "gate fidélité ALC-180 : canaux L/R possiblement permutés (L_sum vs R_orig={cross:.4} ≥ L vs L_orig={pl:.4})"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

#[cfg(test)]
mod tests_alc176_isolation {
    use super::{
        apply_gain, export_stems_to_folder, sha256_hex_file, stems_dir_for_sha, tensor_offset,
        write_wav_stereo_i16, OUTPUT_RATE,
    };

    /// ALC-176 : layout mémoire [1,4,2,seg] ordre C — la VOIX (indice 3 canonique HTDemucs)
    /// occupe les 2 derniers segments [6seg, 8seg) ; aucun chevauchement avec drums/bass/other.
    #[test]
    fn tensor_layout_offsets_htdemucs_voices_last() {
        let seg = 343_980usize;
        assert_eq!(tensor_offset(0, 0, 0, seg), 0); // drums L
        assert_eq!(tensor_offset(1, 0, 0, seg), 2 * seg); // bass L
        assert_eq!(tensor_offset(2, 0, 0, seg), 4 * seg); // other L
        assert_eq!(tensor_offset(3, 0, 0, seg), 6 * seg); // VOIX L
        assert_eq!(tensor_offset(3, 1, 0, seg), 7 * seg); // VOIX R (canal c=1 → +seg)
        assert_eq!(tensor_offset(3, 1, seg - 1, seg), 8 * seg - 1); // dernier échantillon VOIX R
    }

    /// ALC-176 : mute vocals (gain=0.0) → la sortie vocale est STRICTEMENT nulle (max abs == 0).
    #[test]
    fn mute_vocals_zeroes_output() {
        let mut vocals = vec![0.61f32; 8192]; // signal vocal non nul
        apply_gain(&mut vocals, 0.0);
        let max_abs = vocals.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
        assert_eq!(max_abs, 0.0, "gain 0 doit donner une sortie strictement nulle");
        // Garde-fou : gain 1 laisse le signal intact.
        let mut kept = vec![0.25f32; 128];
        apply_gain(&mut kept, 1.0);
        assert_eq!(kept.iter().fold(0.0f32, |m, &x| m.max(x.abs())), 0.25);
    }

    /// ALC-177 : `export_stems_to_folder` copie les 4 WAV du cache et les renomme
    /// proprement (`<préfixe assaini> - <stem>.wav`) dans le dossier cible.
    #[test]
    fn export_stems_copies_4_wavs() {
        use std::path::Path;
        let tmp = std::env::temp_dir().join(format!("alchemix_export_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // Cache stems factice (mêmes helpers que la séparation réelle).
        let src = tmp.join("in.wav");
        write_wav_stereo_i16(&src, &[0.0f32; 8], &[0.0f32; 8], OUTPUT_RATE).unwrap();
        let sha = sha256_hex_file(src.to_str().unwrap()).unwrap();
        let cache = stems_dir_for_sha(&sha);
        std::fs::create_dir_all(&cache).unwrap();
        for n in ["vocals", "drums", "bass", "other"] {
            let p = cache.join(format!("{n}.wav"));
            write_wav_stereo_i16(&p, &[0.1f32; 4], &[0.1f32; 4], OUTPUT_RATE).unwrap();
        }

        let dest = tmp.join("dest_out");
        // Préfixe volontairement « sale » pour tester l'assainissement Windows.
        let out = export_stems_to_folder(
            src.to_string_lossy().into(),
            dest.to_string_lossy().into(),
            Some("Artiste: Titre? - 01".into()),
        )
        .unwrap();
        assert_eq!(out.len(), 4);
        for (i, name) in ["vocals", "drums", "bass", "other"].iter().enumerate() {
            let expect = dest.join(format!("Artiste Titre - 01 - {name}.wav"));
            assert!(expect.exists(), "WAV exporté manquant : {name}");
            assert_eq!(Path::new(&out[i]), expect.as_path());
        }

        let _ = std::fs::remove_dir_all(&cache);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
