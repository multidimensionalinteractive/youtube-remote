# YouTube Remote uninstaller. Started by uninstall.cmd. Safe to run more than once.
# Removes autostart and the firewall rule and stops the server. Your files and
# settings in this folder are kept; delete the folder yourself to remove everything.
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'common-install.ps1')
$Root = $script:Root
$Port = Get-RemotePort
$Total = 4

Title 'YouTube Remote uninstaller'
Say ''
Say '  This will:'
Say '    1. Stop the remote if it is running'
Say '    2. Stop it from starting when you sign in'
Say ('    3. Remove the firewall rule for port ' + $Port + ' (needs admin, you will see a Windows prompt)')
Say '    4. Show you how to remove the Chrome extension'
Say '  Chrome is not closed, and the files in this folder are not deleted.'
Say ''
if (-not (AskYes 'Uninstall now?')) { Say '  OK, nothing was changed.'; WaitEnter 'Press Enter to close'; exit 0 }

Step 1 $Total 'Stopping the remote' 'So nothing keeps listening for your phone.'
if (Stop-RemoteServer $Port) { Ok 'The remote was stopped.' } else { Ok 'The remote was not running.' }

Step 2 $Total 'Removing autostart' 'So the remote no longer starts when you sign in to Windows.'
$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\YouTube Remote.lnk'
if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -ErrorAction SilentlyContinue }
if (Test-Path -LiteralPath $lnk) { Fail 'Could not remove the Startup shortcut.' ('Delete it by hand: ' + $lnk) } else { Ok 'Startup shortcut removed (or was not there).' }
$task = Get-ScheduledTask -TaskName 'YouTubeRemoteServer' -ErrorAction SilentlyContinue
if ($task) {
  try { Unregister-ScheduledTask -TaskName 'YouTubeRemoteServer' -Confirm:$false -ErrorAction Stop; Ok 'Scheduled task removed.' }
  catch { Fail 'Could not remove the scheduled task "YouTubeRemoteServer".' 'Open Task Scheduler, find "YouTubeRemoteServer", and delete it.' }
}

Step 3 $Total 'Removing the firewall rule' 'Your phone will no longer be able to reach this PC on that port.'
$rule = Get-NetFirewallRule -DisplayName ("YouTube Remote $Port") -ErrorAction SilentlyContinue
if (-not $rule) {
  Ok 'There was no firewall rule to remove.'
} else {
  try {
    [void](Invoke-FirewallScript @('-Port', "$Port", '-Remove'))
    if (Get-NetFirewallRule -DisplayName ("YouTube Remote $Port") -ErrorAction SilentlyContinue) {
      Fail 'The firewall rule is still there.' 'Run uninstall.cmd again and click Yes on the Windows prompt.'
    } else { Ok 'Firewall rule removed.' }
  } catch {
    Fail 'Admin permission was not given, so the firewall rule was kept.' 'Run uninstall.cmd again and click Yes when Windows asks.'
  }
}

Step 4 $Total 'Removing the Chrome extension (by hand)' 'Chrome only lets you remove extensions yourself.'
Say '    1. Open chrome://extensions in Chrome.'
Say '    2. Find "YouTube Remote Bridge" and click Remove.'
$chrome = Find-Chrome
if ($chrome -and (AskYes 'Open the Chrome Extensions page now?')) { Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions/' }

Title 'Done'
if ($script:Failures.Count -gt 0) {
  Write-Host ('  Finished with ' + $script:Failures.Count + ' problem(s). See the "How to fix" lines above.') -ForegroundColor Red
}
Say '  To remove everything, delete this folder (it holds your settings and token):'
Say ('    ' + $Root)
Say '  To install again later, double-click install.cmd.'
Say ''
WaitEnter 'Press Enter to close this window'
