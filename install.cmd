@echo off
setlocal
title YouTube Remote installer
cd /d "%~dp0"
if not exist "%~dp0server.js" (
  echo.
  echo It looks like this was opened from inside the ZIP file.
  echo Please right-click the ZIP, choose "Extract All...", open the extracted folder,
  echo and double-click install.cmd there.
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
endlocal
