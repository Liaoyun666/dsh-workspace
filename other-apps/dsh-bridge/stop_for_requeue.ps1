# stop_for_requeue.ps1 - stop the worker and the DSH child of one job, so the job
# can be re-queued with a fixed timeout/env. Nothing is published to the cloud
# because the worker never wrote result.json (we kill it first, no /T).
param([string]$JobId = "j20261030-222317-3e68")
$ErrorActionPreference = "Continue"

# 1) worker (pythonw) - kill WITHOUT /T so its DSH child is not force-killed mid-write
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
  Where-Object { $_.CommandLine -like "*worker.py*" -and $_.CommandLine -notlike "*heartbeat-only*" } |
  ForEach-Object { Write-Host "kill worker $($_.ProcessId)"; taskkill /F /PID $_.ProcessId | Out-Null }

Start-Sleep -Milliseconds 400

# 2) the DSH processes of that job (Electron headless + its children)
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*$JobId*" } |
  ForEach-Object { Write-Host "kill dsh $($_.ProcessId) $($_.Name)"; taskkill /F /T /PID $_.ProcessId | Out-Null }

Start-Sleep -Seconds 1
$left = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$JobId*" })
Write-Host "left=$($left.Count)"
