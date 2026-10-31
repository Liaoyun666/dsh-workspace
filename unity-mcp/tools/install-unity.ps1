#requires -Version 5
# 安装 Unity 2019.4.15f1 到 E:\Unity\2019.4.15f1（会弹 UAC，需要点「是」）
$ErrorActionPreference = 'Stop'
$installer = 'E:\Unity\downloads\UnitySetup64-2019.4.15f1.exe'
$target = 'E:\Unity\2019.4.15f1'
$unity = Join-Path $target 'Editor\Unity.exe'
if (-not (Test-Path $installer)) { throw "安装包不存在: $installer" }
$size = (Get-Item $installer).Length
if ($size -ne 1986732664) { throw "安装包大小不对: $size (期望 1986732664)" }
if (Test-Path $unity) {
  $v = (Get-Item $unity).VersionInfo.FileVersion
  if ($v) { Write-Host "已安装: $unity ($v)"; exit 0 }
  Write-Host '已有 Unity.exe 但版本信息无效，继续重装'
}
New-Item -ItemType Directory -Force -Path $target | Out-Null
Write-Host '开始安装（UAC 弹窗请点「是」，约 3-8 分钟）...'
try {
  $p = Start-Process -FilePath $installer -ArgumentList '/S', "/D=$target" -Verb RunAs -Wait -PassThru
} catch {
  throw "启动安装器失败（UAC 被拒绝？）: $($_.Exception.Message)"
}
Write-Host "安装器退出码: $($p.ExitCode)"
if (-not (Test-Path $unity)) { throw "安装后找不到 $unity（退出码 $($p.ExitCode)）" }
$vi = (Get-Item $unity).VersionInfo
Write-Host "Unity.exe: $unity"
Write-Host "版本: $($vi.FileVersion) / $($vi.ProductVersion)"
