@echo off
chcp 65001 >nul
title Studio Bridge - Broker compartido
cd /d "%~dp0"
echo ========================================================
echo   Studio Bridge - Broker (multi-agente)
echo ========================================================
echo.
echo Puente Adobe:  127.0.0.1:8765
echo MCP HTTP:      127.0.0.1:8766/mcp
echo.
echo Deja esta ventana abierta mientras editas.
echo Para cerrar el broker: pulsa Ctrl+C o cierra esta ventana.
echo.
node broker.js
echo.
echo El broker se detuvo.
pause
