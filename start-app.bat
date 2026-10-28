@echo off
rem Double-click to start the Allotment Checker and open it in the browser.
rem Keep this window open while you use the app: closing it stops the app and its automatic checks.
setlocal
title Allotment Checker
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org and try again.
  goto :fail
)

if not exist ".env" (
  echo The .env file is missing. See README.md, "Setup".
  goto :fail
)

rem Port from .env (PORT=...), default 3100
set "PORT=3100"
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PORT=" ".env"') do set "PORT=%%b"
set "URL=http://localhost:%PORT%"

rem Already running? Then just open it. A second copy would run every check twice.
powershell -NoProfile -Command "try { if ((Invoke-WebRequest '%URL%/' -UseBasicParsing -TimeoutSec 3).Content -match 'Allotment Checker') { exit 0 } } catch {}; exit 1"
if not errorlevel 1 (
  echo Allotment Checker is already running. Opening %URL% ...
  start "" "%URL%"
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

if not exist "node_modules" (
  echo Installing dependencies, first run only...
  call npm install
  if errorlevel 1 goto :fail
)

echo Applying database updates...
call npx prisma migrate deploy
if errorlevel 1 (
  echo.
  echo Could not reach the database. Is the Postgres service running?
  goto :fail
)

rem Open the browser as soon as the server answers (waits up to 60 s, in the background).
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest '%URL%/' -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process '%URL%'; break } catch { Start-Sleep -Seconds 1 } }"

echo.
echo Starting Allotment Checker on %URL%
echo Keep this window open. Close it (or press Ctrl+C) to stop the app.
echo.
call npm start
echo.
echo The app has stopped.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
