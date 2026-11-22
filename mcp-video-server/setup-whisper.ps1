# =============================================================================
#  setup-whisper.ps1 — Instala whisper.cpp + modelo local para el Bridge MCP
#  (transcripción "oídos" 100% offline, sin costo por audio)
#
#  Uso:
#    .\setup-whisper.ps1                 # binario + modelo base (multilingüe)
#    .\setup-whisper.ps1 -Model small    # binario + modelo small (mejor calidad)
#    .\setup-whisper.ps1 -Model tiny     # binario + modelo tiny (más rápido)
# =============================================================================
param(
    [ValidateSet('tiny','base','small','medium','large')]
    [string]$Model = 'base'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$BinDir  = Join-Path $ScriptDir 'bin'
$ModelDir = Join-Path $ScriptDir 'models'
New-Item -ItemType Directory -Force -Path $BinDir, $ModelDir | Out-Null

Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "  Instalando whisper.cpp (transcripción local)               " -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 1. Binario whisper.cpp (precompilado para Windows)
# ---------------------------------------------------------------------------
$cliPath = Join-Path $BinDir 'whisper-cli.exe'
if (Test-Path $cliPath) {
    Write-Host "✔ whisper-cli.exe ya existe: $cliPath" -ForegroundColor Green
} else {
    Write-Host "`n[1/2] Buscando binario whisper.cpp (Windows x64)..." -ForegroundColor Yellow

    # El release "latest" puede no incluir binarios; probamos una lista de versiones conocidas.
    $candidateTags = @('latest', 'v1.8.2', 'v1.8.1', 'v1.8.0', 'v1.7.6')
    $asset = $null
    $releaseTag = $null
    foreach ($tag in $candidateTags) {
        try {
            if ($tag -eq 'latest') {
                $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest' -TimeoutSec 60
            } else {
                $release = Invoke-RestMethod -Uri "https://api.github.com/repos/ggerganov/whisper.cpp/releases/tags/$tag" -TimeoutSec 60
            }
            $found = $release.assets | Where-Object { $_.name -eq 'whisper-bin-x64.zip' } | Select-Object -First 1
            if ($found) { $asset = $found; $releaseTag = $release.tag_name; break }
        } catch {
            Write-Host "   (aviso) no se pudo consultar '$tag': $($_.Exception.Message)" -ForegroundColor DarkGray
        }
    }
    if (-not $asset) {
        throw "No se encontró 'whisper-bin-x64.zip' en ningún release probado. Revisa https://github.com/ggerganov/whisper.cpp/releases"
    }

    Write-Host "   Descargando $($asset.name) desde $releaseTag ..." -ForegroundColor DarkGray
    $zipPath = Join-Path $BinDir 'whisper-bin.zip'
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -TimeoutSec 600

    $extractDir = Join-Path $BinDir '_extract'
    if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    # El zip trae una carpeta con el .exe y sus DLLs: copiamos esa carpeta completa.
    $exe = Get-ChildItem -Recurse -File $extractDir -Include 'whisper-cli.exe','main.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) {
        throw "No se encontró whisper-cli.exe/main.exe dentro del zip."
    }
    Copy-Item -Force (Join-Path $exe.DirectoryName '*') $BinDir
    Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
    Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
    Write-Host "✔ Binario instalado en: $BinDir" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 2. Modelo ggml (multilingüe) desde HuggingFace
# ---------------------------------------------------------------------------
$modelFile = "ggml-$Model.bin"
$modelPath = Join-Path $ModelDir $modelFile
if (Test-Path $modelPath) {
    Write-Host "✔ Modelo ya existe: $modelPath" -ForegroundColor Green
} else {
    Write-Host "`n[2/2] Descargando modelo $modelFile (multilingüe)..." -ForegroundColor Yellow
    $modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$modelFile"
    Invoke-WebRequest -Uri $modelUrl -OutFile $modelPath -TimeoutSec 1800
    Write-Host "✔ Modelo instalado: $modelPath" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 3. Verificación rápida
# ---------------------------------------------------------------------------
Write-Host "`n==============================================================" -ForegroundColor Green
Write-Host "  VERIFICACIÓN" -ForegroundColor Green
Write-Host "==============================================================" -ForegroundColor Green
& $cliPath --version 2>&1 | Select-Object -First 2
Write-Host "Modelo: $modelPath" -ForegroundColor Cyan
Write-Host "`nListo. El MCP server usará automáticamente bin/ y models/." -ForegroundColor Green
Write-Host "Prueba: usa la herramienta 'video_transcribe' desde tu agente." -ForegroundColor DarkGray
