# Shared helpers for install.ps1 and uninstall.ps1. Plain ASCII only (Windows PowerShell 5.1).

$script:Root = Split-Path -Parent $PSScriptRoot
$script:Failures = New-Object System.Collections.ArrayList

function Say([string]$text = '') { Write-Host $text }
function Title([string]$text) {
  Write-Host ''
  Write-Host ('=' * 64) -ForegroundColor DarkCyan
  Write-Host ('  ' + $text) -ForegroundColor Cyan
  Write-Host ('=' * 64) -ForegroundColor DarkCyan
}
function Step([int]$n, [int]$total, [string]$what, [string]$why) {
  Write-Host ''
  Write-Host ("[Step $n of $total] " + $what) -ForegroundColor Yellow
  if ($why) { Write-Host ('  Why: ' + $why) -ForegroundColor Gray }
}
function Ok([string]$text) { Write-Host ('  OK: ' + $text) -ForegroundColor Green }
function Info([string]$text) { Write-Host ('  ' + $text) }
function Warn([string]$text) { Write-Host ('  Note: ' + $text) -ForegroundColor DarkYellow }
function Fail([string]$text, [string]$fix) {
  Write-Host ('  FAILED: ' + $text) -ForegroundColor Red
  if ($fix) { Write-Host ('  How to fix: ' + $fix) -ForegroundColor Red }
  [void]$script:Failures.Add($text)
}
function AskYes([string]$question, [bool]$defaultYes = $true) {
  $hint = '[Y/n]'
  if (-not $defaultYes) { $hint = '[y/N]' }
  $a = Read-Host ('  ' + $question + ' ' + $hint)
  if ([string]::IsNullOrWhiteSpace($a)) { return $defaultYes }
  return ($a.Trim().ToLower().StartsWith('y'))
}
function WaitEnter([string]$text = 'Press Enter to continue') { [void](Read-Host ('  ' + $text)) }

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $links = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
  $env:Path = ($machine, $user, $links -join ';')
}

function Get-RemotePort {
  $port = 8790
  $cfgPath = Join-Path $script:Root 'config.local.json'
  if (Test-Path $cfgPath) {
    try {
      $cfg = Get-Content -Raw -LiteralPath $cfgPath | ConvertFrom-Json
      if ($cfg.port) { $port = [int]$cfg.port }
    } catch { }
  }
  if ($env:YT_REMOTE_PORT) { $port = [int]$env:YT_REMOTE_PORT }
  return $port
}

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Runs scripts\open-firewall.ps1 with admin rights (Windows shows a "Yes/No" prompt).
function Invoke-FirewallScript([string[]]$extraArgs) {
  $fw = Join-Path $PSScriptRoot 'open-firewall.ps1'
  $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $fw + '"')) + $extraArgs
  if (Test-IsAdmin) {
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $psArgs -Wait -PassThru -WindowStyle Hidden
  } else {
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $psArgs -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  }
  return $p.ExitCode
}

# Stops only this app's server: the PID it wrote, or a node.exe running server.js on our port.
function Stop-RemoteServer([int]$port) {
  $stopped = $false
  $pidFile = Join-Path $script:Root '.server.pid'
  if (Test-Path $pidFile) {
    $procId = 0
    [void][int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(), [ref]$procId)
    if ($procId -gt 0) {
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $procId -ErrorAction SilentlyContinue; $stopped = $true }
    }
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
  }
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $proc = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $c.OwningProcess) -ErrorAction SilentlyContinue
    if ($proc -and $proc.Name -eq 'node.exe' -and $proc.CommandLine -match 'server\.js') {
      Stop-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      $stopped = $true
    }
  }
  if ($stopped) { Start-Sleep -Milliseconds 800 }
  return $stopped
}

function Get-Health([int]$port) {
  try { return Invoke-RestMethod -Uri ("http://127.0.0.1:$port/api/health") -TimeoutSec 3 } catch { return $null }
}

function Find-Chrome {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}
