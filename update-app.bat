@echo off
rem Double-click after any update: applies database changes and restarts Allotment Checker
rem (the background task behind IIS). Asks for administrator permission.
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo Asking for administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

title Update Allotment Checker
echo Updating Allotment Checker...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-service.ps1"
if errorlevel 1 (
  echo.
  echo UPDATE FAILED - see the messages above. The log is in logs\app.log
) else (
  echo.
  echo Update finished. Open https://allotment.investoyard.com and press Ctrl+F5.
)
echo.
pause
