# Allowlisted helper: turns the monitors off only. Does not sleep or lock the PC,
# so audio and video keep playing. Run by the server via powershell -File in the
# logged-in (interactive) desktop session. Move the mouse, press a key, or use
# the remote's wake action (status pill) to turn the screens back on.
$ErrorActionPreference = 'Continue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MonitorPowerEx {
  public const uint WM_SYSCOMMAND = 0x0112;
  public const int SC_MONITORPOWER = 0xF170;
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  public static void OffOnce() {
    IntPtr broadcast = (IntPtr)0xFFFF; // HWND_BROADCAST
    IntPtr wParam = (IntPtr)SC_MONITORPOWER;
    IntPtr lParam = (IntPtr)2;         // 2 = power off
    PostMessage(broadcast, WM_SYSCOMMAND, wParam, lParam);
    SendMessage(broadcast, WM_SYSCOMMAND, wParam, lParam);
    IntPtr tray = FindWindow("Shell_TrayWnd", null);
    if (tray != IntPtr.Zero) {
      PostMessage(tray, WM_SYSCOMMAND, wParam, lParam);
      SendMessage(tray, WM_SYSCOMMAND, wParam, lParam);
    }
  }
}
"@

# Re-assert for about 4 seconds: Chrome and YouTube often request display-on
# right after the monitors go off while a video is playing.
for ($i = 0; $i -lt 8; $i++) {
  [MonitorPowerEx]::OffOnce()
  Start-Sleep -Milliseconds 500
}
Write-Output 'MONITORS_OFF_DONE'
