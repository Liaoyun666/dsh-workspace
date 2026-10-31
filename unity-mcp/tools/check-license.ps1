param([string]$Project = 'E:\Unity\DSHProject')
$ErrorActionPreference = 'Stop'
$lic = 'C:\ProgramData\Unity\Unity_lic.ulf'
if (-not (Test-Path $lic)) {
  Write-Host "未找到许可证：$lic"
  Write-Host "请先完成手动激活：https://license.unity3d.com/manual"
  exit 2
}
Write-Host ("许可证文件: {0} ({1} bytes)" -f $lic, (Get-Item $lic).Length)
$log = 'E:\Unity\tmp-test\license-check.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
& 'E:\Unity\2019.4.15f1\Editor\Unity.exe' -batchmode -nographics -quit -projectPath $Project -logFile $log
Write-Host ("Unity 退出码: {0}" -f $LASTEXITCODE)
$text = Get-Content $log -Raw -ErrorAction SilentlyContinue
if ($text -match 'No valid Unity Editor license') { Write-Host '结果: 许可证无效'; exit 1 }
if ($text -match 'Exiting without the bug reporter') { Write-Host '结果: 启动成功（许可证有效）'; exit 0 }
Write-Host '结果: 无法判断，请查看日志 ' $log
exit 3
