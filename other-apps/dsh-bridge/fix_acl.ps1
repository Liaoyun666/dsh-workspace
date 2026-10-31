# fix_acl.ps1 - grant the current user explicit Full Control (incl. WRITE_DAC) on a tree.
# DSH's workspace-write sandbox must rewrite the DACL to grant itself write access;
# a folder that only inherits "Authenticated Users:(M)" denies that (Win32 5 =
# ERROR_ACCESS_DENIED from SetNamedSecurityInfoW), which breaks every shell call
# inside the job. An explicit Full Control ACE on the tree fixes it.
param([string]$Path = "E:/工作区/肥鱼之家")
$ErrorActionPreference = "Stop"
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
Write-Host "granting $me Full Control on $Path"
$out = icacls.exe $Path /grant ($me + ":(OI)(CI)F") /T 2>&1
$out | Select-Object -Last 4 | ForEach-Object { Write-Host $_ }
Write-Host "--- acl now ---"
icacls.exe $Path | Select-Object -First 6 | ForEach-Object { Write-Host $_ }
