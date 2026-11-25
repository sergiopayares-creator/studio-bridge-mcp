# Studio Bridge — Instalador de Extensión CEP y Servidor MCP (Windows)

$ErrorActionPreference = 'Stop'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Instalando Studio Bridge MCP                           " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ExtensionSrc = Join-Path $ScriptDir "extension"
$ServerDir = Join-Path $ScriptDir "mcp-video-server"

# 0. Verificar Node.js y FFmpeg
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "ERROR: Node.js 20+ no está instalado o no está en PATH." -ForegroundColor Red
    Write-Host "Instálalo desde https://nodejs.org (LTS) y vuelve a ejecutar este instalador." -ForegroundColor Yellow
    exit 1
}
Write-Host "✔ Node.js detectado: $(node -v)" -ForegroundColor Green

$ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpegCmd) {
    Write-Host "⚠ FFmpeg no detectado en PATH (necesario para contactSheet, compare, recompresión JPEG y tools locales de audio/video)." -ForegroundColor Yellow
    Write-Host "  Instálalo con: winget install Gyan.FFmpeg" -ForegroundColor Yellow
} else {
    Write-Host "✔ FFmpeg detectado." -ForegroundColor Green
}

# 1. Habilitar PlayerDebugMode en Adobe CSXS (7-24)
Write-Host "`n[1/3] Configurando permisos CSXS de Adobe..." -ForegroundColor Yellow
$csxsVersions = 7..24
foreach ($ver in $csxsVersions) {
    $path = "HKCU:\Software\Adobe\CSXS.$ver"
    if (-not (Test-Path $path)) {
        New-Item -Path $path -Force | Out-Null
    }
    Set-ItemProperty -Path $path -Name "PlayerDebugMode" -Value "1" -Force -ErrorAction SilentlyContinue
}
Write-Host "✔ Permisos CSXS configurados." -ForegroundColor Green

# 2. Enlazar extensión CEP en Adobe (crear carpeta padre si no existe)
Write-Host "`n[2/3] Enlazando Studio Bridge en Adobe CEP..." -ForegroundColor Yellow
$cepRoot = Join-Path $env:APPDATA "Adobe\CEP\extensions"
if (-not (Test-Path $cepRoot)) {
    New-Item -ItemType Directory -Force -Path $cepRoot | Out-Null
}
$cepDir = Join-Path $cepRoot "com.antigravity.bridge"
$existing = Get-Item $cepDir -Force -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.LinkType -eq 'Junction' -or $existing.LinkType -eq 'SymbolicLink') {
        cmd /c rmdir "$cepDir"
        if ($LASTEXITCODE -ne 0) { throw "No se pudo eliminar el enlace previo: $cepDir" }
    } else {
        Remove-Item -Recurse -Force "$cepDir"
    }
}
cmd /c mklink /J "$cepDir" "$ExtensionSrc"
if ($LASTEXITCODE -ne 0) {
    throw "No se pudo crear el junction CEP en $cepDir"
}
Write-Host "✔ Studio Bridge enlazado en: $cepDir" -ForegroundColor Green

# 3. Instalar dependencias de Node en mcp-video-server si faltan
Write-Host "`n[3/3] Verificando dependencias de mcp-video-server..." -ForegroundColor Yellow
if (Test-Path $ServerDir) {
    $nodeModules = Join-Path $ServerDir "node_modules"
    if (-not (Test-Path $nodeModules)) {
        Push-Location $ServerDir
        try {
            & npm.cmd install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm install falló en $ServerDir" }
        } finally {
            Pop-Location
        }
    }
    Write-Host "✔ Dependencias de mcp-video-server listas." -ForegroundColor Green
}

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "  ¡STUDIO BRIDGE MCP INSTALADO!                           " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Siguiente paso: reinicia Premiere Pro / After Effects y abre:" -ForegroundColor Cyan
Write-Host "  Ventana > Extensiones > Studio Bridge" -ForegroundColor Cyan
