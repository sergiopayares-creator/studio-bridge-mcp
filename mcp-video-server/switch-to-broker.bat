@echo off
chcp 65001 >nul
title Studio Bridge - Cambiar a broker
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch-to-broker.ps1"
echo.
pause
