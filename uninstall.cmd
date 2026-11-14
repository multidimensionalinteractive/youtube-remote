@echo off
setlocal
title YouTube Remote uninstaller
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1"
endlocal
