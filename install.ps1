# Studio Bridge — Instalador de Extensión CEP para Premiere Pro y After Effects

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Instalando Studio Bridge                   " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ExtensionSrc = Join-Path $ScriptDir "extension"

# 1. Habilitar PlayerDebugMode en Adobe CSXS
Write-Host "`n[1/2] Configurando permisos CSXS de Adobe..." -ForegroundColor Yellow
$csxsVersions = 7..24
foreach ($ver in $csxsVersions) {
    $path = "HKCU:\Software\Adobe\CSXS.$ver"
    if (-not (Test-Path $path)) {
        New-Item -Path $path -Force | Out-Null
    }
    Set-ItemProperty -Path $path -Name "PlayerDebugMode" -Value "1" -Force -ErrorAction SilentlyContinue
}
Write-Host "✔ Permisos CSXS configurados." -ForegroundColor Green

# 2. Enlazar extensión CEP en Adobe
Write-Host "`n[2/2] Enlazando Studio Bridge en Adobe CEP..." -ForegroundColor Yellow
$cepDir = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.antigravity.bridge"
if (Test-Path $cepDir) {
    cmd /c rmdir "$cepDir"
}
cmd /c mklink /J "$cepDir" "$ExtensionSrc"
Write-Host "✔ Studio Bridge instalado en: $cepDir" -ForegroundColor Green

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "  ¡ANTIGRAVITY STUDIO BRIDGE INSTALADO!                   " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Abre Premiere Pro o After Effects > Ventana > Extensiones > Studio Bridge" -ForegroundColor Cyan
