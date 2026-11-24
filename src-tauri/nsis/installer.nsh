; ALC-163 / ALC-270 — Module optionnel "IA Chef d'Orchestre" (installateur NSIS multilingue).
;
; Section OPTIONNELLE (décochée par défaut via `Section /o`) :
;   "IA Chef d'Orchestre (~1,9 Go — Génération hors-ligne de partitions mashup)"
;
; Si l'utilisateur coche l'option, on télécharge le modèle GGUF dans
; %LOCALAPPDATA%\AlcheMixII\models\ (NSISdl, barre de progression native) et on écrit
; {"optInState":"installed"} dans ai_module_prefs.json. Sinon, à la fin de l'installation,
; on écrit {"optInState":"declined"} pour ne pas redemander au premier lancement.
;
; NOTE : inclus par Tauri (clef `bundle.windows.nsis.installerHooks`). NSIS ne fait pas partie
; des validations `cargo`/`npm` — le script est appliqué lors de la génération de l'installateur.

!include "Sections.nsh"
!include "LogicLib.nsh"

!define AI_MODEL_NAME "qwen2.5-coder-3b-instruct-q4_k_m.gguf"
!define AI_MODEL_URL "https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf"

; ── Traductions (LangString) de la section optionnelle ────────────────────────────────────────
LangString ALC_AI_TITLE ${LANG_FRENCH}   "IA Chef d'Orchestre (~1,9 Go — Génération hors-ligne de partitions mashup)"
LangString ALC_AI_TITLE ${LANG_ENGLISH}  "AI Chef d'Orchestre (~1.9 GB — Offline mashup generation)"
LangString ALC_AI_TITLE ${LANG_SPANISH}  "IA Chef de Orquesta (~1,9 GB — Generación offline de mashups)"
LangString ALC_AI_TITLE ${LANG_GERMAN}   "KI Chef d'Orchestre (~1,9 GB — Offline Mashup-Generierung)"
LangString ALC_AI_TITLE ${LANG_ITALIAN}  "IA Chef d'Orchestre (~1,9 GB — Generazione offline di mashup)"

LangString ALC_AI_DESC ${LANG_FRENCH}   "Module optionnel : génération hors-ligne (local, aucun service externe) de partitions mashup par l'IA Chef d'Orchestre. Télécharge ~1,9 Go une seule fois. Décochez pour un mode léger (ré-installable à tout moment depuis l'application)."
LangString ALC_AI_DESC ${LANG_ENGLISH}  "Optional module : offline (local, no external service) mashup arrangement generation by the Chef AI. Downloads ~1.9 GB once. Untick for a light mode (re-installable anytime from the app)."
LangString ALC_AI_DESC ${LANG_SPANISH}  "Módulo opcional : generación offline de mashups por la IA. Descarga ~1,9 GB una vez. Desmárquelo para modo ligero (reinstalable desde la app)."
LangString ALC_AI_DESC ${LANG_GERMAN}   "Optional : Offline-Mashup-Erzeugung durch die Chef-KI. Lädt ~1,9 GB einmalig. Deaktivieren für den Leichtmodus (jederzeit in der App installierbar)."
LangString ALC_AI_DESC ${LANG_ITALIAN}  "Modulo opzionale : generazione offline di mashup da parte dell'IA. Scarica ~1,9 GB una volta. Deseleziona per la modalità leggera (reinstallabile dall'app)."

; ── Chemin de base [%LOCALAPPDATA%\AlcheMixII] ────────────────────────────────────────────────
Function GetChefAiBase
  StrCpy $0 $LOCALAPPDATA
  StrCmp $0 "" 0 +2
    StrCpy $0 "$APPDATA"
  StrCpy $1 "$0\AlcheMixII"
FunctionEnd

Function ChefAi_WriteInstalled
  Call GetChefAiBase
  CreateDirectory "$1"
  FileOpen $4 "$1\ai_module_prefs.json" w
  FileWrite $4 '{"optInState":"installed"}'
  FileClose $4
FunctionEnd

Function ChefAi_WriteDeclined
  Call GetChefAiBase
  CreateDirectory "$1"
  FileOpen $4 "$1\ai_module_prefs.json" w
  FileWrite $4 '{"optInState":"declined"}'
  FileClose $4
FunctionEnd

; ── Section optionnelle (décochée par défaut) : télécharge le modèle & marque "installed" ─────
Section /o "$(ALC_AI_TITLE)" SEC_CHEF_AI
  Call GetChefAiBase
  CreateDirectory "$1"
  CreateDirectory "$1\models"
  ; NSISdl native : télécharge avec barre de progression, fichier rendu visible seulement complet.
  NSISdl::download "${AI_MODEL_URL}" "$1\models\${AI_MODEL_NAME}.part"
  Pop $3
  ${If} $3 = "success"
    Rename "$1\models\${AI_MODEL_NAME}.part" "$1\models\${AI_MODEL_NAME}"
  ${EndIf}
  Call ChefAi_WriteInstalled
SectionEnd

; ── Finalisation (hook natif Tauri) : si la section optionnelle n'a pas été cochée → "declined" ─
!macro customInstall
  ${IfNot} ${SectionIsSelected} ${SEC_CHEF_AI}
    Call ChefAi_WriteDeclined
  ${EndIf}
!macroend