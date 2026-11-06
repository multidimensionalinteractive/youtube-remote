Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class YTWindow {
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$chrome = @(Get-Process chrome -ErrorAction SilentlyContinue)
if ($chrome.Count -eq 0) { Write-Output 'NO_CHROME'; exit }
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
$matchesList=@()
foreach($win in $windows) {
 try {
  if(-not ($chrome.Id -contains $win.Current.ProcessId)) {continue}
  $c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem)
  foreach($tab in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants,$c)) {
   $n=$tab.Current.Name
   if($n -match 'YouTube' -and $n -notmatch 'YouTube Remote') {$matchesList += $n}
  }
 } catch {}
}
$best=$matchesList | Where-Object {$_ -match 'Audio playing'} | Select-Object -First 1
if(-not $best) {$best=$matchesList | Select-Object -First 1}
if($best) {
 $title=($best -replace ' - YouTube.*$','' -replace '^\(\d+\) ','')
 @{title=$title;paused=($best -notmatch 'Audio playing');basic=$true;volume=$null;currentTime=0;duration=0} | ConvertTo-Json -Compress
} else { Write-Output 'null' }
