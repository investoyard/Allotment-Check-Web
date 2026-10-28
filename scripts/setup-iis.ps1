#Requires -RunAsAdministrator
<#
  Publishes Allotment Checker through IIS on https://<HostName>, using a certificate that's already
  installed on this server. IIS forwards requests to the app on 127.0.0.1 (see iis\web.config).

  Needs: IIS URL Rewrite (installed) + Application Request Routing 3.0 (ARR).
  Run scripts\install-service.ps1 first so the app is running.

    powershell -ExecutionPolicy Bypass -File scripts\setup-iis.ps1 -HostName allotment.example.com
    # optional: -CertThumbprint <thumbprint>   (otherwise a matching certificate is found automatically)
#>
param(
  [Parameter(Mandatory = $true)][string]$HostName,
  [string]$CertThumbprint,
  [string]$SiteName = "AllotmentChecker"
)
$ErrorActionPreference = "Stop"
Import-Module WebAdministration
$root = Split-Path $PSScriptRoot -Parent
$sitePath = Join-Path $root "iis"
$appcmd = "$env:windir\system32\inetsrv\appcmd.exe"
$HostName = $HostName.Trim().ToLower()

# --- 1. Prerequisites ---
if (-not (Test-Path "$env:windir\System32\inetsrv\rewrite.dll")) {
  throw "IIS URL Rewrite is not installed: https://www.iis.net/downloads/microsoft/url-rewrite"
}
if (-not (Test-Path "$env:ProgramFiles\IIS\Application Request Routing\requestRouter.dll")) {
  throw "Application Request Routing (ARR) 3.0 is not installed. Install it from https://www.iis.net/downloads/microsoft/application-request-routing , then run this script again."
}

$port = 3100
$line = Select-String -Path (Join-Path $root ".env") -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
try { Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 5 | Out-Null }
catch { Write-Warning "The app isn't answering on http://127.0.0.1:$port yet. Run scripts\install-service.ps1 first (continuing anyway)." }

# --- 2. Turn on ARR proxying (server-wide setting; harmless for other sites) ---
& $appcmd set config -section:system.webServer/proxy /enabled:"True" /preserveHostHeader:"True" /reverseRewriteHostInResponseHeaders:"False" /commit:apphost | Out-Null
# Send the real client IP without ":port", so login rate-limiting sees real addresses.
& $appcmd set config -section:system.webServer/proxy /includePortInXForwardedFor:"False" /commit:apphost 2>$null | Out-Null
foreach ($var in "HTTP_X_FORWARDED_PROTO", "HTTP_X_FORWARDED_HOST") {
  $exists = Get-WebConfigurationProperty -PSPath "MACHINE/WEBROOT/APPHOST" -Filter "system.webServer/rewrite/allowedServerVariables" -Name "." |
    Select-Object -ExpandProperty Collection | Where-Object { $_.name -eq $var }
  if (-not $exists) {
    Add-WebConfigurationProperty -PSPath "MACHINE/WEBROOT/APPHOST" -Filter "system.webServer/rewrite/allowedServerVariables" -Name "." -Value @{ name = $var }
  }
}

# --- 3. web.config points at the app's port ---
$cfg = Join-Path $sitePath "web.config"
(Get-Content $cfg -Raw) -replace 'http://127\.0\.0\.1:\d+/', "http://127.0.0.1:$port/" | Set-Content $cfg -Encoding UTF8 -NoNewline

# --- 4. Certificate ---
$cert = $null
$stores = "Cert:\LocalMachine\My", "Cert:\LocalMachine\WebHosting"
if ($CertThumbprint) {
  $tp = ($CertThumbprint -replace '\s', '').ToUpper()
  foreach ($s in $stores) { $c = Get-ChildItem $s -ErrorAction SilentlyContinue | Where-Object Thumbprint -eq $tp; if ($c) { $cert = $c; break } }
  if (-not $cert) { throw "No certificate with thumbprint $tp in LocalMachine\My or WebHosting." }
} else {
  $wild = "*." + ($HostName -split '\.', 2)[1]
  $candidates = @(foreach ($s in $stores) {
    Get-ChildItem $s -ErrorAction SilentlyContinue | Where-Object {
      $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) -and
      ($_.DnsNameList.Unicode -contains $HostName -or $_.DnsNameList.Unicode -contains $wild)
    }
  })
  $cert = $candidates | Sort-Object NotAfter -Descending | Select-Object -First 1
  if (-not $cert) { throw "No valid certificate for $HostName (or $wild) found. Pass -CertThumbprint <thumbprint>." }
}
$certStore = if ($cert.PSParentPath -match 'WebHosting') { "WebHosting" } else { "My" }
Write-Host "Certificate: $($cert.Subject) (expires $($cert.NotAfter.ToString('dd MMM yyyy')))"

# --- 5. App pool (no .NET needed) and site ---
if (-not (Test-Path "IIS:\AppPools\$SiteName")) { New-WebAppPool -Name $SiteName | Out-Null }
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name managedRuntimeVersion -Value ""
if (-not (Get-Website -Name $SiteName)) {
  New-Website -Name $SiteName -PhysicalPath $sitePath -ApplicationPool $SiteName -HostHeader $HostName -Port 80 | Out-Null
} else {
  Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $sitePath
}
if (-not (Get-WebBinding -Name $SiteName -Protocol http -HostHeader $HostName)) {
  New-WebBinding -Name $SiteName -Protocol http -Port 80 -HostHeader $HostName
}
if (-not (Get-WebBinding -Name $SiteName -Protocol https -HostHeader $HostName)) {
  New-WebBinding -Name $SiteName -Protocol https -Port 443 -HostHeader $HostName -SslFlags 1   # SNI: shares 443 with other sites
}
(Get-WebBinding -Name $SiteName -Protocol https -HostHeader $HostName).AddSslCertificate($cert.Thumbprint, $certStore)

# IIS only needs to read web.config from the iis folder.
icacls $sitePath /grant "IIS AppPool\${SiteName}:(OI)(CI)RX" | Out-Null
Start-Website -Name $SiteName

Write-Host ""
Write-Host "Done. Open https://$HostName"
Write-Host "Make sure DNS for $HostName points to this server and ports 80/443 are open in the firewall."
