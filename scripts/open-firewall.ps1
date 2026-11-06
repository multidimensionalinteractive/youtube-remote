# Requires elevated PowerShell. Creates a Private-profile-only inbound rule.
$ErrorActionPreference = 'Stop'
$port = 8790
if ($env:YT_REMOTE_PORT) { $port = [int]$env:YT_REMOTE_PORT }
$ruleName = "YouTube Remote $port"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $port `
  -Profile Private `
  -Program 'Any' `
  -Description 'Allow LAN access to YouTube Remote on private networks only. Do not expose this port to the internet.' | Out-Null
Write-Host "Firewall rule created: $ruleName (TCP $port, Private profile only)"
Write-Host 'Reminder: set allowLan/authToken in config.local.json before binding beyond loopback.'
