# Instalar-Studio-Bridge.ps1 — Instalación de 1 clic para compartir Studio Bridge.
# Requisitos: Adobe Premiere Pro / After Effects y Node.js (https://nodejs.org, LTS).
# Ejecutar con doble clic en Instalar-Studio-Bridge.bat
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  Studio Bridge — Instalación" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

# 1) Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "ERROR: Node.js no está instalado." -ForegroundColor Red
    Write-Host "Descárgalo de https://nodejs.org (LTS), instálalo y vuelve a ejecutar este instalador." -ForegroundColor Yellow
    exit 1
}
Write-Host "Node.js: $(node -v)" -ForegroundColor Green

# 2) Panel CEP
$srcExt = Join-Path $root 'extension'
if (-not (Test-Path $srcExt)) {
    $candidate = Get-ChildItem -Path $root -Recurse -Directory -Filter 'com.antigravity.bridge' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate) { $srcExt = $candidate.FullName }
}
if (-not (Test-Path $srcExt)) {
    Write-Host "ERROR: no encuentro la carpeta del panel (extension)." -ForegroundColor Red
    exit 1
}

$cepRoot = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$target = Join-Path $cepRoot 'com.antigravity.bridge'
New-Item -ItemType Directory -Force -Path $cepRoot | Out-Null
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Copy-Item -Recurse -Force $srcExt $target
Write-Host "Panel instalado en: $target" -ForegroundColor Green

foreach ($v in 9..24) {
    $p = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }
    Set-ItemProperty -Path $p -Name PlayerDebugMode -Value "1" -Force -ErrorAction SilentlyContinue
}
Write-Host "PlayerDebugMode habilitado (CSXS 9-24)." -ForegroundColor Green

# 3) Dependencias del servidor
$srv = Join-Path $root 'mcp-video-server'
if (-not (Test-Path $srv)) {
    Write-Host "ERROR: no encuentro mcp-video-server junto al instalador." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $srv 'node_modules'))) {
    Write-Host "Instalando dependencias del servidor (npm install)..." -ForegroundColor Yellow
    Push-Location $srv
    & npm.cmd install --no-audit --no-fund
    Pop-Location
}
Write-Host "Dependencias listas." -ForegroundColor Green

# 4) Acceso directo en Inicio (arranque automático del broker)
$vbs = Join-Path $srv 'start-broker-hidden.vbs'
if (Test-Path $vbs) {
    try {
        $startup = [Environment]::GetFolderPath('Startup')
        $lnkPath = Join-Path $startup 'Studio Bridge Broker.lnk'
        $wsh = New-Object -ComObject WScript.Shell
        $lnk = $wsh.CreateShortcut($lnkPath)
        $lnk.TargetPath = $vbs
        $lnk.WorkingDirectory = $srv
        $lnk.Description = 'Arranca el broker de Studio Bridge'
        $lnk.Save()
        Write-Host "Arranque automático creado: $lnkPath" -ForegroundColor Green
    } catch {
        Write-Host "Aviso: no pude crear el arranque automático ($($_.Exception.Message))." -ForegroundColor Yellow
    }
}

# 5) Arrancar broker si no está activo
$running = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if (-not $running) {
    Write-Host "Arrancando el broker..." -ForegroundColor Yellow
    Start-Process -FilePath 'node' -ArgumentList 'broker.js' -WorkingDirectory $srv -WindowStyle Hidden
    Start-Sleep -Seconds 2
} else {
    Write-Host "El puerto 8765 ya está activo (otro proceso o el broker)." -ForegroundColor DarkGray
}

# 6) Verificación
$secretFile = Join-Path $HOME '.antigravity-studio-bridge\.bridge-secret'
$bridgeToken = ''
if (Test-Path $secretFile) { $bridgeToken = (Get-Content -Raw $secretFile).Trim() }
try {
    $h = Invoke-WebRequest -Uri 'http://127.0.0.1:8766/health' -UseBasicParsing -TimeoutSec 6 -Headers @{ Authorization = "Bearer $bridgeToken" }
    Write-Host "Broker OK -> $($h.Content)" -ForegroundColor Green
} catch {
    Write-Host "Aviso: no pude confirmar /health. Prueba start-broker.bat para ver el error." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  LISTO" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "1) Abre Premiere/AE > Ventana > Extensiones > Studio Bridge."
Write-Host "2) En tu agente registra el MCP HTTP:"
Write-Host "   http://127.0.0.1:8766/mcp" -ForegroundColor Cyan
Write-Host "3) Opcional (oídos): ejecuta setup-whisper.ps1 en mcp-video-server."
