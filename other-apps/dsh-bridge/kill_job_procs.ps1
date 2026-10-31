param([string]$JobId = "j20261030-222317-3e68")
$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$JobId*" })
foreach ($p in $procs) { Write-Host "kill $($p.ProcessId) $($p.Name)"; taskkill /F /T /PID $p.ProcessId 2>&1 | Out-Null }
Start-Sleep -Seconds 1
$left = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$JobId*" })
Write-Host "left=$($left.Count)"
foreach ($p in $left) { Write-Host "  still: $($p.ProcessId) $($p.Name)" }
