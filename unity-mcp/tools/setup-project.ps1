#requires -Version 5
# 创建 Unity 工程骨架并把 DSH 桥包装进 Packages/
$ErrorActionPreference = 'Stop'
$project = 'E:\Unity\DSHProject'
$packageSrc = 'E:\工作区\unity-mcp\unity-package'
$dest = Join-Path $project 'Packages\com.dsh.unitybridge'

New-Item -ItemType Directory -Force -Path (Join-Path $project 'Assets') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $project 'Packages') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $project 'ProjectSettings') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $project 'Logs') | Out-Null

$manifest = Join-Path $project 'Packages\manifest.json'
if (-not (Test-Path $manifest)) {
  '{' + "`n" + '  "dependencies": {}' + "`n" + '}' | Set-Content -Path $manifest -Encoding UTF8
}

$versionFile = Join-Path $project 'ProjectSettings\ProjectVersion.txt'
if (-not (Test-Path $versionFile)) {
  'm_EditorVersion: 2019.4.15f1' + "`n" + 'm_EditorVersionWithRevision: 2019.4.15f1 (fbf367ac14e9)' | Set-Content -Path $versionFile -Encoding UTF8
}

if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Copy-Item -Recurse -Force $packageSrc $dest
Write-Host "工程就绪: $project"
Write-Host "桥包: $dest"
Write-Host 'Unity.exe: E:\Unity\2019.4.15f1\Editor\Unity.exe'
