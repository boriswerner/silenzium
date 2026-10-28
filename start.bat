@echo off
rem Startet Silenzium und oeffnet den Browser.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js wurde nicht gefunden. Bitte von https://nodejs.org installieren ^(Version 18 oder neuer^).
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installiere Abhaengigkeiten ...
  call npm install --omit=dev
)
node server.js --open
pause
