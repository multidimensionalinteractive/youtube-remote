# YouTube Remote one-click installer. Started by install.cmd. Safe to run again any time.
# It never force-closes Chrome and never prints your access token.
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'common-install.ps1')
$Root = $script:Root
Set-Location -LiteralPath $Root
$Total = 9

Title 'YouTube Remote installer'
Say ''
Say '  YouTube Remote turns your phone into a remote for YouTube playing in'
Say '  Chrome on this PC: search, play, pause, skip, volume, bass, screens off,'
Say '  and "stop after this video". Your phone only needs its web browser.'
Say ''
Say '  This installer will:'
Say '    1. Check for Node.js (the engine the remote runs on) and offer to install it'
Say '    2. Check for yt-dlp (used for search) and offer to install it'
Say '    3. Download the remote''s small add-on libraries (npm install)'
Say '    4. Turn on phone access with a private access token'
Say '    5. Let your phone reach this PC on your home Wi-Fi (Windows firewall, needs admin)'
Say '    6. Start the remote automatically when you sign in to Windows'
Say '    7. Start the remote now, in the background'
Say '    8. Walk you through adding the Chrome extension (2 clicks)'
Say '    9. Open the "Connect your phone" page with a QR code'
Say ''
Say '  You can run this again any time; it keeps your settings and token.'
Say '  To remove it later, double-click uninstall.cmd in this folder.'
Say ''
if (-not (AskYes 'Ready to start?')) { Say '  OK, nothing was changed.'; WaitEnter 'Press Enter to close'; exit 0 }

# Files from a downloaded ZIP are marked "from the internet"; clear that so the
# helper scripts can run without extra Windows warnings.
Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
  Unblock-File -ErrorAction SilentlyContinue

# ---------------------------------------------------------------- 1. Node.js
Step 1 $Total 'Checking for Node.js 18 or newer' 'The remote is a small Node.js program that runs on this PC.'
Refresh-Path
function Get-NodeMajor {
  try {
    $v = (& node -v 2>$null)
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
  } catch { }
  return 0
}
$nodeMajor = Get-NodeMajor
$haveWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
if ($nodeMajor -ge 18) {
  Ok ("Node.js " + (& node -v) + " is installed.")
} else {
  if ($nodeMajor -gt 0) { Info ("Found Node.js " + (& node -v) + ", which is too old (need 18 or newer).") } else { Info 'Node.js is not installed.' }
  if ($haveWinget -and (AskYes 'Install the current Node.js LTS now with winget? (Windows may ask for permission)')) {
    Info 'Installing Node.js. This can take a minute...'
    & winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
    Refresh-Path
    $nodeMajor = Get-NodeMajor
  }
  if ($nodeMajor -ge 18) {
    Ok ("Node.js " + (& node -v) + " is installed.")
  } else {
    Fail 'Node.js 18 or newer is not available.' 'Install the LTS version from https://nodejs.org/ (keep the default options), then double-click install.cmd again.'
    Say ''
    WaitEnter 'The installer cannot continue without Node.js. Press Enter to close'
    exit 1
  }
}

# ---------------------------------------------------------------- 2. yt-dlp
Step 2 $Total 'Checking for yt-dlp' 'The remote uses yt-dlp to search YouTube from your phone. Everything else works without it.'
if (Get-Command yt-dlp -ErrorAction SilentlyContinue) {
  Ok 'yt-dlp is installed.'
} else {
  Info 'yt-dlp is not installed.'
  if ($haveWinget -and (AskYes 'Install yt-dlp now with winget?')) {
    & winget install --id yt-dlp.yt-dlp -e --source winget --accept-package-agreements --accept-source-agreements
    Refresh-Path
  }
  if (Get-Command yt-dlp -ErrorAction SilentlyContinue) {
    Ok 'yt-dlp is installed.'
  } else {
    Warn 'Search will not work until yt-dlp is installed. Get it from https://github.com/yt-dlp/yt-dlp or run: winget install yt-dlp.yt-dlp'
  }
}

# ---------------------------------------------------------------- 3. npm install
Step 3 $Total 'Downloading the add-on libraries (npm install)' 'The remote needs two small open source libraries: one for live updates and one for QR codes.'
& npm.cmd install --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -eq 0) {
  Ok 'Libraries are ready.'
} else {
  Fail 'npm install did not finish.' 'Check that this PC is online, then run install.cmd again. If it keeps failing, open a terminal in this folder and run: npm install'
}

# ---------------------------------------------------------------- 4. Phone access
Step 4 $Total 'Turning on phone access' 'This lets the remote listen on your home network and creates a private access token, so only your phones can use it.'
$out = & node (Join-Path $PSScriptRoot 'setup-phone.js') --quiet
if ($LASTEXITCODE -eq 0) {
  Ok ($out -join ' ')
  Info 'Your token is saved in config.local.json in this folder. Keep that file private.'
} else {
  Fail ($out -join ' ') 'Fix or delete config.local.json in this folder, then run install.cmd again.'
}
$Port = Get-RemotePort

# ---------------------------------------------------------------- 5. Firewall
Step 5 $Total 'Allowing your phone to reach this PC on your home Wi-Fi' ('This adds a Windows firewall rule for port ' + $Port + ' on Private (home) networks only. It needs admin, so you will see a Windows prompt; click Yes.')
$public = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' })
$fwArgs = @('-Port', "$Port")
if ($public.Count -gt 0) {
  Warn ("Your network '" + ($public | Select-Object -First 1).Name + "' is set to Public, which blocks phones from reaching this PC.")
  if (AskYes 'Is this your own home network? If yes, the installer will switch it to Private.' $false) { $fwArgs += '-MakePrivate' }
  else { Info 'Leaving it as Public. Phone access will only work on a network set to Private.' }
}
try {
  $code = Invoke-FirewallScript $fwArgs
  $rule = Get-NetFirewallRule -DisplayName ("YouTube Remote $Port") -ErrorAction SilentlyContinue
  if ($code -eq 0 -and $rule) { Ok ("Firewall rule 'YouTube Remote $Port' is set (Private networks only).") }
  else { Fail 'The firewall rule was not created.' 'Run install.cmd again and click Yes on the Windows prompt, or right-click scripts\open-firewall.ps1 and choose "Run with PowerShell" as admin.' }
} catch {
  Fail 'Admin permission was not given, so the firewall rule was skipped.' 'Run install.cmd again and click Yes when Windows asks. The remote still works on this PC itself.'
}

# ---------------------------------------------------------------- 6. Autostart
Step 6 $Total 'Starting the remote automatically when you sign in' 'A shortcut in your Startup folder starts the remote quietly in the background, so your phone always finds it.'
try {
  & (Join-Path $PSScriptRoot 'install-startup-folder.ps1') | Out-Null
  Ok 'Added "YouTube Remote" to your Startup folder.'
} catch {
  Fail ('Could not add the Startup shortcut: ' + $_.Exception.Message) 'You can start the remote by hand any time by double-clicking start-hidden.vbs in this folder.'
}

# ---------------------------------------------------------------- 7. Start server
Step 7 $Total 'Starting the remote now, in the background' 'If an older copy is already running, it is restarted so it picks up the new settings. Chrome is not touched.'
if (Stop-RemoteServer $Port) { Info 'Stopped the copy that was already running.' }
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Fail ("Another program is already using port $Port.") ('Close that program, or set a different "port" in config.local.json, then run install.cmd again.')
} else {
  Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + (Join-Path $Root 'start-hidden.vbs') + '"') -WorkingDirectory $Root
  $health = $null
  for ($i = 0; $i -lt 20 -and -not $health; $i++) { Start-Sleep -Milliseconds 750; $health = Get-Health $Port }
  if ($health) { Ok ("The remote is running on port $Port.") }
  else { Fail 'The remote did not start.' 'Open a terminal in this folder and run: npm start   It will show the error.' }
}

# ---------------------------------------------------------------- 8. Chrome extension
Step 8 $Total 'Adding the Chrome extension' 'The extension is the part that actually presses play, changes volume, and reads what is playing inside your YouTube tab.'
$chrome = Find-Chrome
$extDir = Join-Path $Root 'extension'
if (-not $chrome) {
  Fail 'Google Chrome was not found.' 'Install Chrome from https://www.google.com/chrome/ and then run install.cmd again.'
} else {
  Say ''
  Say '  Chrome does not let any program install an extension by itself (that protects'
  Say '  you from malware), so this one-time part takes a few clicks from you.'
  Say '  The Extensions page is opening in Chrome now, and the folder path is copied.'
  try { Set-Clipboard -Value $extDir } catch { }
  Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions/'
  Say ''
  Say '  In Chrome (if the Extensions page did not open, type chrome://extensions in the address bar):'
  Say '    1. Turn on "Developer mode" with the switch at the top right of the Extensions page.'
  Say '    2. Click "Load unpacked" at the top left.'
  Say '    3. In the folder window, click the address bar at the top (or the "Folder" box at'
  Say '       the bottom), press Ctrl+V to paste this folder, then click "Select Folder":'
  Say ('         ' + $extDir)
  Say '    4. "YouTube Remote Bridge" now shows in the list. Make sure its switch is on.'
  Say '       Already added it before? Click its round reload arrow instead, to update it.'
  Say '    5. Leave Chrome open. The installer will open a YouTube tab for you next.'
  Say ''
  WaitEnter 'When you have done steps 1 to 4, press Enter here'
  Start-Process -FilePath $chrome -ArgumentList 'https://www.youtube.com/'
  Info 'Opened YouTube. Waiting for the extension to connect...'
  $bridge = $false
  for ($i = 0; $i -lt 20 -and -not $bridge; $i++) {
    Start-Sleep -Seconds 1
    $h = Get-Health $Port
    if ($h -and $h.bridgeConnected) { $bridge = $true }
  }
  if ($bridge) { Ok 'The extension is connected to the remote.' }
  else { Fail 'The extension has not connected yet.' 'Check chrome://extensions shows "YouTube Remote Bridge" switched on, then refresh the YouTube tab. You can finish the rest; the status on your phone turns green once it connects.' }
}

# ---------------------------------------------------------------- 9. Connect page
Step 9 $Total 'Opening the "Connect your phone" page' 'It shows a QR code your phone can scan to open the remote, already signed in.'
$connectUrl = "http://127.0.0.1:$Port/#connect"
if ($chrome) { Start-Process -FilePath $chrome -ArgumentList $connectUrl } else { Start-Process $connectUrl }
Ok ('Opened ' + $connectUrl)

# Phone address for the summary. The token is deliberately left out of this window.
$phoneAddress = $null
try {
  $info = Invoke-RestMethod -Uri ("http://127.0.0.1:$Port/api/phone-link") -TimeoutSec 3
  $links = @($info.links)
  if ($links.Count -gt 0 -and $links[0].address) { $phoneAddress = 'http://' + $links[0].address + ':' + $Port + '/' }
} catch { }

Title 'All set'
Say ''
if ($script:Failures.Count -gt 0) {
  Write-Host ('  Finished with ' + $script:Failures.Count + ' problem(s):') -ForegroundColor Red
  foreach ($f in $script:Failures) { Write-Host ('    - ' + $f) -ForegroundColor Red }
  Say '  See the "How to fix" lines above, then run install.cmd again. It is safe to repeat.'
  Say ''
}
if ($phoneAddress) {
  Say ('  Phone address:  ' + $phoneAddress)
} else {
  Say '  Phone address:  not found. Connect this PC to Wi-Fi or Ethernet and run install.cmd again.'
}
Say ''
Say '  On your phone (same Wi-Fi as this PC):'
Say '    1. Scan the QR code on the page that just opened in Chrome, using the phone camera.'
Say '       The QR code includes your private access token, so it signs the phone in.'
Say '       (Typing the address above works too; then paste the token from'
Say '       config.local.json when the remote asks for it.)'
Say '    2. Add it to your home screen so it opens like an app:'
Say '       iPhone (Safari):  tap Share, then "Add to Home Screen".'
Say '       Android (Chrome): tap the three-dot menu, then "Add to Home screen" (or "Install app").'
Say ''
Say '  The remote starts by itself whenever you sign in to Windows.'
Say ('  Lost the QR code? Open http://127.0.0.1:' + $Port + '/ on this PC.')
Say '  To uninstall: double-click uninstall.cmd in this folder.'
Say ''
WaitEnter 'Press Enter to close this window'
