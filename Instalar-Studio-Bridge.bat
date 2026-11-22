@echo off
chcp 65001 >nul
title Studio Bridge - Instalacion
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Instalar-Studio-Bridge.ps1"
echo.
pause
