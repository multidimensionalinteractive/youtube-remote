$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$cmdPath = Join-Path $root 'start-hidden.vbs'
$vbs = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "$root"
WshShell.Run "node server.js", 0, False
"@
Set-Content -Path $cmdPath -Value $vbs -Encoding ASCII
$shortcutPath = Join-Path $startupDir 'YouTube Remote.lnk'
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($shortcutPath)
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = '"' + $cmdPath + '"'
$sc.WorkingDirectory = $root
$sc.WindowStyle = 7
$sc.Description = 'Start YouTube Remote server'
$sc.Save()
Write-Host "Startup shortcut created: $shortcutPath"
Write-Host "VBS launcher: $cmdPath"
