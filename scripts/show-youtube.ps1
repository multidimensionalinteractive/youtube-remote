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
foreach($win in $windows) {
 try {
  $pidValue=$win.Current.ProcessId
  if (-not ($chrome.Id -contains $pidValue)) { continue }
  $tabCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem)
  $tabs=$win.FindAll([System.Windows.Automation.TreeScope]::Descendants,$tabCondition)
  foreach($tab in $tabs) {
   $name=$tab.Current.Name
   if($name -notmatch 'YouTube' -or $name -match 'YouTube Remote') { continue }
   $pattern=$null
   if($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) {
    $pattern.Select()
   } elseif($tab.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {
    $pattern.Invoke()
   } else { continue }
   $hwnd=[IntPtr]$win.Current.NativeWindowHandle
   [YTWindow]::ShowWindow($hwnd,9) | Out-Null
   $focus=[YTWindow]::SetForegroundWindow($hwnd)
   Write-Output ('SELECTED:'+ $name + ';foreground=' + $focus)
   exit
  }
 } catch { }
}
foreach($proc in $chrome) {
 if($proc.MainWindowHandle -ne 0) {
  [YTWindow]::ShowWindow($proc.MainWindowHandle,9) | Out-Null
  $focus=[YTWindow]::SetForegroundWindow($proc.MainWindowHandle)
  Write-Output ('CHROME_FOCUSED_NO_TAB_MATCH;foreground='+$focus)
  exit
 }
}
Write-Output 'CHROME_RUNNING_NO_ACCESSIBLE_WINDOW'
