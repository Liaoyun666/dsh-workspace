# 探针: 观察 N 秒内是否出现可见的控制台窗口(会弹窗的迹象)。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File tests\console_flash_probe.ps1 -Seconds 70
# 正常(无弹窗)应只输出 "start baseline=N" 和 "=== end ==="。
param([int]$Seconds = 60)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W2 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> Snap() {
    List<string> outp = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      string cls = sb.ToString();
      if (cls != "ConsoleWindowClass" && cls != "CASCADIA_HOSTING_WINDOW_CLASS") return true;
      StringBuilder tb = new StringBuilder(256);
      GetWindowText(h, tb, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      outp.Add(pid + "|" + cls + "|" + tb.ToString());
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
'@
$seen = @{}
foreach ($x in [W2]::Snap()) { $seen[$x] = $true }
"start baseline=" + $seen.Count
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  Start-Sleep -Milliseconds 120
  foreach ($x in [W2]::Snap()) {
    if (-not $seen.ContainsKey($x)) {
      $seen[$x] = $true
      $parts = $x.Split("|")
      $pr = Get-Process -Id ([int]$parts[0]) -ErrorAction SilentlyContinue
      $pn = if ($pr) { $pr.ProcessName } else { "?" }
      $par = (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $parts[0]) -ErrorAction SilentlyContinue).ParentProcessId
      $pn2 = (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $par) -ErrorAction SilentlyContinue).Name
      "{0:HH:mm:ss.fff} FLASH pid={1}({2}) parent={3}({4}) cls={5} title='{6}'" -f (Get-Date), $parts[0], $pn, $par, $pn2, $parts[1], $parts[2]
    }
  }
}
"=== end ==="