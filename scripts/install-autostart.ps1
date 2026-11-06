$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$server = Join-Path $root 'server.js'
$taskName = 'YouTubeRemoteServer'
$port = 8790
if ($env:YT_REMOTE_PORT) { $port = [int]$env:YT_REMOTE_PORT }

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$server`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Scheduled task registered: $taskName (runs at logon)"

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Start-Process -FilePath $node -ArgumentList "`"$server`"" -WorkingDirectory $root -WindowStyle Hidden
  Write-Host 'Server started in background'
} else {
  Write-Host "Server already listening on $port"
}
