# switch-to-broker.ps1 — Libera el 8765 (si lo tiene un node huérfano) y arranca el broker.
# Ejecutar en TU PowerShell normal (no sandbox):
#   powershell -ExecutionPolicy Bypass -File .\switch-to-broker.ps1
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host "== Studio Bridge: cambiar a modo broker ==" -ForegroundColor Cyan

$conn = Get-NetTCPConnection -LocalPort 8765 -State Listen
if ($conn) {
    $procs = $conn.OwningProcess | Select-Object -Unique
    foreach ($procId in $procs) {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'node') {
            Write-Host "Cerrando node.exe $procId (ocupaba 8765)..." -ForegroundColor Yellow
            Stop-Process -Id $procId -Force
        } else {
            $name = if ($p) { $p.ProcessName } else { 'desconocido' }
            Write-Host "El 8765 lo ocupa '$name' (PID $procId). Ciérralo manualmente y vuelve a ejecutar." -ForegroundColor Red
            exit 1
        }
    }
    Start-Sleep -Milliseconds 900
} else {
    Write-Host "El 8765 ya estaba libre." -ForegroundColor Green
}

Write-Host "Arrancando broker (oculto)..." -ForegroundColor Cyan
Start-Process -FilePath "node" -ArgumentList "broker.js" -WorkingDirectory $dir -WindowStyle Hidden
Start-Sleep -Seconds 2

$secretFile = Join-Path $HOME '.antigravity-studio-bridge\.bridge-secret'
$bridgeToken = ''
if (Test-Path $secretFile) { $bridgeToken = (Get-Content -Raw $secretFile).Trim() }

try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8766/health' -UseBasicParsing -TimeoutSec 6 -Headers @{ Authorization = "Bearer $bridgeToken" }
    Write-Host "Broker OK -> $($r.Content)" -ForegroundColor Green
} catch {
    Write-Host "No pude confirmar /health: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Prueba a ejecutar start-broker.bat para ver el error en consola." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Listo. Abre el panel: Ventana > Extensiones > Studio Bridge." -ForegroundColor Cyan
Write-Host "En cada agente registra el MCP HTTP: http://127.0.0.1:8766/mcp" -ForegroundColor Cyan
