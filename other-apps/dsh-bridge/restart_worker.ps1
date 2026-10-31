$ErrorActionPreference = "Stop"
# restart the DSH bridge worker: kill pythonw running worker.py, then start via scheduled task
$procs = Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
    Where-Object { $_.CommandLine -like "*worker.py*" }
foreach ($p in $procs) {
    Write-Output ("stop pid=" + $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force
}
Start-Sleep -Seconds 2
schtasks /Run /TN DshFishBridge | Out-Null
Start-Sleep -Seconds 12
$now = Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
    Where-Object { $_.CommandLine -like "*worker.py*" }
foreach ($p in $now) { Write-Output ("running pid=" + $p.ProcessId + " at " + $p.CreationDate) }
if (-not $now) { Write-Output "!! worker did not start" }
