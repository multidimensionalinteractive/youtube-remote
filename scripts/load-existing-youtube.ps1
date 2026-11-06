# $TargetUrl and $ShowYouTubeScript are supplied by the server (HTTPS YouTube URLs only).
$ErrorActionPreference = 'Stop'
if (-not $ShowYouTubeScript) { throw 'ShowYouTubeScript path was not provided by the server' }
$showScript = $ShowYouTubeScript

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class YTKeys {
 [DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);
 [StructLayout(LayoutKind.Sequential)] public struct INPUT {public uint type;public UNION u;}
 [StructLayout(LayoutKind.Explicit)] public struct UNION {[FieldOffset(0)] public KEY k;[FieldOffset(0)] public MOUSE m;}
 [StructLayout(LayoutKind.Sequential)] public struct KEY {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] public struct MOUSE {public int x,y;public uint data,flags,time;public UIntPtr extra;}
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint n,INPUT[] a,int size);
 public static void Type(string s) {foreach(char c in s){var a=new INPUT[2];a[0].type=1;a[0].u.k.scan=c;a[0].u.k.flags=4;a[1]=a[0];a[1].u.k.flags=6;if(SendInput(2,a,Marshal.SizeOf(typeof(INPUT)))!=2)throw new Exception("Typing failed");}}
 public static void Key(byte k,bool up){keybd_event(k,0,up?2u:0u,UIntPtr.Zero);}
}
"@
$focus= & $showScript
if($focus -notmatch 'SELECTED:.*foreground=True') {throw 'Could not focus existing YouTube tab. No new tab opened.'}
[YTKeys]::Key(17,$false);[YTKeys]::Key(76,$false);[YTKeys]::Key(76,$true);[YTKeys]::Key(17,$true)
Start-Sleep -Milliseconds 300
[YTKeys]::Type($TargetUrl)
[YTKeys]::Key(13,$false);[YTKeys]::Key(13,$true)
Start-Sleep -Seconds 6
$root=[System.Windows.Automation.AutomationElement]::RootElement
$ids=@(Get-Process chrome).Id
$tabs=@()
foreach($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)) {
 if($ids -notcontains $w.Current.ProcessId){continue}
 $c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem)
 foreach($t in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,$c)) {
  if($t.Current.Name -match 'YouTube' -and $t.Current.Name -notmatch 'YouTube Remote') {$tabs+= $t}
 }
}
$kept=@($tabs|Where-Object {$p=$null; $_.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$p) -and $p.Current.IsSelected -and $_.Current.Name -match 'Audio playing'})
if($kept.Count -ne 1){Write-Output 'NAVIGATED; cleanup skipped: no unique selected playing YouTube';exit}
$closed=0
foreach($t in $tabs){if($t.Equals($kept[0])){continue}
 $c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)
 foreach($b in $t.FindAll([System.Windows.Automation.TreeScope]::Descendants,$c)){if($b.Current.Name -match '^Close'){$p=$null;if($b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$p)){$p.Invoke();$closed++;break}}}
}
Write-Output ('PLAYING:'+ $kept[0].Current.Name+';closedOthers='+$closed)
