#Requires -RunAsAdministrator
<#
  Runs Allotment Checker in the background, always: starts at boot (before anyone logs in),
  restarts if it stops, and keeps allotment-day checks running. Uses Windows Task Scheduler,
  so nothing extra needs installing.

    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1             # install / update
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Uninstall  # remove
    Logs: logs\app.log
#>
param([switch]$Uninstall, [string]$TaskName = "AllotmentChecker")
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$port = 3100
$line = Select-String -Path (Join-Path $root ".env") -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }

function Stop-AppOnPort {
  # Only stops this app (e.g. a copy started with start-app.bat), never anything else on the port.
  $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"
  if ($p.CommandLine -match 'AutoCheckAllotment|src[/\\]server\.ts') {
    Stop-Process -Id $p.ProcessId, $p.ParentProcessId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-Host "Stopped the copy that was already running on port $port."
  } else {
    throw "Port $port is used by another program: $($p.CommandLine)"
  }
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Stop-AppOnPort
  Write-Host "Removed background task '$TaskName'."
  exit 0
}

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
New-Item -ItemType Directory -Force (Join-Path $root "logs") | Out-Null

Write-Host "Applying database updates..."
Push-Location $root
& $npm exec -- prisma migrate deploy
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Database update failed - is the Postgres service running?" }
Pop-Location

$cmd = "/c cd /d `"$root`" && `"$npm`" start >> `"$root\logs\app.log`" 2>&1"
$action    = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmd -WorkingDirectory $root
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
               -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries `
               -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "Allotment Checker web app (http://127.0.0.1:$port), served through IIS." -Force | Out-Null

Stop-AppOnPort
Start-ScheduledTask -TaskName $TaskName

Write-Host "Starting..."
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try {
    if ((Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 3).Content -match 'Allotment Checker') {
      Write-Host "Allotment Checker is running in the background on http://127.0.0.1:$port (task '$TaskName')."
      Write-Host "It starts automatically after every reboot. Logs: $root\logs\app.log"
      exit 0
    }
  } catch {}
}
throw "The app didn't answer on port $port within 60 seconds. Check $root\logs\app.log"
