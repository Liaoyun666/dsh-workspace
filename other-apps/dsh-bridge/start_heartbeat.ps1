# start_heartbeat.ps1 - start/stop the standalone heartbeat-only process.
# Only needed when the main worker cannot be restarted (e.g. a long job is running);
# the normal worker already starts its own heartbeat thread.
param([switch]$Stop)
$ErrorActionPreference = "Stop"
$pyw = "$env:LOCALAPPDATA\Programs\Python\Python310\pythonw.exe"
if (-not (Test-Path $pyw)) { $pyw = "pythonw.exe" }
$worker = Join-Path $PSScriptRoot "worker.py"

if ($Stop) {
    Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
        Where-Object { $_.CommandLine -like "*--heartbeat-only*" } |
        ForEach-Object { taskkill /F /PID $_.ProcessId | Out-Null; Write-Host "stopped $($_.ProcessId)" }
    return
}

Start-Process -FilePath $pyw -ArgumentList @("-X", "utf8", $worker, "--heartbeat-only") -WindowStyle Hidden
Write-Host "heartbeat-only started"
