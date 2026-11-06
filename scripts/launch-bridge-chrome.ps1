# Optional helper: launch a dedicated Chrome user-data-dir that auto-loads the bridge extension.
# Does NOT close your everyday Chrome windows.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$chrome = if ($env:CHROME_PATH) { $env:CHROME_PATH } else { 'C:\Program Files\Google\Chrome\Application\chrome.exe' }
$ext = Join-Path $root 'extension'
$profile = Join-Path $root 'chrome-profile'
New-Item -ItemType Directory -Force -Path $profile | Out-Null
Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=$profile",
  "--disable-extensions-except=$ext",
  "--load-extension=$ext",
  "--no-first-run",
  "--no-default-browser-check",
  'https://www.youtube.com/'
)
Write-Host 'Launched dedicated Chrome with YouTube Remote extension (isolated profile under ./chrome-profile).'
