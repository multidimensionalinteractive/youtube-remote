param([double]$Level=-1,[string]$Mute='')
Add-Type @"
using System;
using System.Runtime.InteropServices;
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ComImport] class DeviceEnumerator {}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDeviceEnumerator {
 int EnumAudioEndpoints(int d,int s,out IntPtr p);
 int GetDefaultAudioEndpoint(int d,int r,out IDevice p);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevice {
 int Activate(ref Guid iid,int cls,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)] out object o);
}
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IEndpointVolume {
 int RegisterControlChangeNotify(IntPtr p); int UnregisterControlChangeNotify(IntPtr p); int GetChannelCount(out uint n);
 int SetMasterVolumeLevel(float n,Guid g); int SetMasterVolumeLevelScalar(float n,Guid g);
 int GetMasterVolumeLevel(out float n); int GetMasterVolumeLevelScalar(out float n);
 int SetChannelVolumeLevel(uint c,float n,Guid g); int SetChannelVolumeLevelScalar(uint c,float n,Guid g);
 int GetChannelVolumeLevel(uint c,out float n); int GetChannelVolumeLevelScalar(uint c,out float n);
 int SetMute([MarshalAs(UnmanagedType.Bool)] bool b,Guid g); int GetMute([MarshalAs(UnmanagedType.Bool)] out bool b);
}
public class SystemAudio {
 static IEndpointVolume Endpoint() {
  var en=(IDeviceEnumerator)new DeviceEnumerator(); IDevice dev;
  Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0,1,out dev));
  var iid=typeof(IEndpointVolume).GUID; object obj;
  Marshal.ThrowExceptionForHR(dev.Activate(ref iid,23,IntPtr.Zero,out obj)); return (IEndpointVolume)obj;
 }
 public static float Get(){float f;Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out f));return f;}
 public static bool Muted(){bool b;Marshal.ThrowExceptionForHR(Endpoint().GetMute(out b));return b;}
 public static void Set(float n){Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(n,Guid.Empty));}
 public static void Mute(bool b){Marshal.ThrowExceptionForHR(Endpoint().SetMute(b,Guid.Empty));}
}
"@
if($Level -ge 0){[SystemAudio]::Set([float][Math]::Min([double]1,[double]$Level))}
if($Mute -eq 'true'){[SystemAudio]::Mute($true)}
if($Mute -eq 'false'){[SystemAudio]::Mute($false)}
@{volume=[SystemAudio]::Get();muted=[SystemAudio]::Muted()} | ConvertTo-Json -Compress
