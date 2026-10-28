# One-time database setup on the existing Postgres server (port 5433).
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\setup-db.ps1 -SuperUser <postgres superuser>
param(
  [Parameter(Mandatory = $true)][string]$SuperUser,
  [string]$PsqlPath = "D:\Investoyard\.tools\pgsql\bin\psql.exe",
  [int]$Port = 5433
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$line = Select-String -Path (Join-Path $root ".env") -Pattern '^DATABASE_URL=' | Select-Object -First 1
if (-not $line) { throw "DATABASE_URL not found in .env" }
$m = [regex]::Match($line.Line, 'postgresql://allotment:([^@]+)@')
if (-not $m.Success) { throw "DATABASE_URL in .env must use the 'allotment' user" }
$password = [uri]::UnescapeDataString($m.Groups[1].Value)
if ($password -eq "CHANGE_ME") { throw "Set a real password in DATABASE_URL in .env first" }

& $PsqlPath -h 127.0.0.1 -p $Port -U $SuperUser -d postgres -v ON_ERROR_STOP=1 -v "app_password=$password" -f (Join-Path $PSScriptRoot "create-db.sql")
if ($LASTEXITCODE -ne 0) { throw "psql failed (exit $LASTEXITCODE)" }
