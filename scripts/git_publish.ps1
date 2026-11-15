# ============================================================
# AlcheMix II — Script de publication Git / GitHub (ALC-011)
# À exécuter une fois git installé et avec un token/gh authentifié.
# ============================================================
$ErrorActionPreference = 'Stop'
$root = 'C:\Dev\alchemixII'
Set-Location $root

# 1) Vérifier git
git --version | Out-Null
if (-not $?) { throw "Git n'est pas installé. Installe-le depuis https://git-scm.com puis relance." }

# 2) Initialiser si nécessaire
if (-not (Test-Path "$root\.git")) {
  git init -b main
  Write-Host "✓ Dépôt git initialisé (branche main)"
}

# 3) .gitignore déjà présent à la racine (créé par l'IA) — sinon en créer un
if (-not (Test-Path "$root\.gitignore")) {
  @("node_modules/","dist/","build/",".svelte-kit/","src-tauri/target/",".env","*.log") | Set-Content "$root\.gitignore"
}

# 4) Branches : main + dev
$cur = (git branch --show-current).Trim()
if ($cur -ne 'main' -and $cur -ne 'master') { git branch -M main }
if (-not (git branch --list dev)) { git checkout -b dev | Out-Null; git checkout main | Out-Null }

# 5) Commit initial (tout ajouter : code, composants, rust, project-tracker, README)
git add -A
git status --short | Select-Object -First 25
git commit -m "chore: init AlcheMix II (SvelteKit 5 + Tauri 2 / Rust) — Venezia 1889"

# 6) Remote + push
$remote = git remote get-url origin 2>$null
if (-not $remote) {
  Write-Host "Remote absent. Crée d'abord le dépôt sur GitHub puis ajoute :"
  Write-Host "  git remote add origin git@github.com:<USER>/alchemix-ii.git"
  Write-Host "Puis relance ce script (ou lance manuellement les commandes push ci-dessous)."
}
else {
  git push -u origin main
  git push -u origin dev
  Write-Host "✓ Push effectué (main + dev)"
}
Write-Host "Terminé."