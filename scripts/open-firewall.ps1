# Requires elevated PowerShell. Creates (or removes) a Private-profile-only inbound rule
# so phones on your home Wi-Fi can reach the remote. Never opens Public/Domain networks.
#   -Port <n>       port to allow (default: YT_REMOTE_PORT or 8790)
#   -Remove         remove the rule instead of creating it
#   -MakePrivate    also switch currently connected "Public" networks to "Private"
param([int]$Port = 0, [switch]$Remove, [switch]$MakePrivate)
$ErrorActionPreference = 'Stop'
if ($Port -le 0) {
  $Port = 8790
  if ($env:YT_REMOTE_PORT) { $Port = [int]$env:YT_REMOTE_PORT }
}
$ruleName = "YouTube Remote $Port"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
if ($Remove) {
  Write-Host "Firewall rule removed (if it existed): $ruleName"
  exit 0
}
New-NetFirewallRule -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -Profile Private `
  -Program 'Any' `
  -Description 'Allow LAN access to YouTube Remote on private networks only. Do not expose this port to the internet.' | Out-Null
Write-Host "Firewall rule created: $ruleName (TCP $Port, Private profile only)"
if ($MakePrivate) {
  Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' } | ForEach-Object {
    Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private
    Write-Host ("Network '" + $_.Name + "' is now set to Private.")
  }
}
Write-Host 'Reminder: set allowLan/authToken in config.local.json before binding beyond loopback (npm run setup-phone does this).'
