#requires -Version 5
# 生成 Unity 手动激活文件（.alf）。需要先安装好 Unity。
$ErrorActionPreference = 'Stop'
$unity = 'E:\Unity\2019.4.15f1\Editor\Unity.exe'
if (-not (Test-Path $unity)) { throw "找不到 $unity" }
$out = 'E:\Unity\license'
New-Item -ItemType Directory -Force -Path $out | Out-Null
Push-Location $out
try {
  & $unity -batchmode -nographics -quit -createManualActivationFile -logFile - 2>&1 | Tee-Object -FilePath (Join-Path $out 'activation.log')
} finally { Pop-Location }
$alf = Get-ChildItem $out -Filter '*.alf' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $alf) { throw '没有生成 .alf，见 activation.log' }
Write-Host "激活文件: $($alf.FullName)"
Write-Host '下一步：浏览器打开 https://license.unity3d.com/manual ，登录 Unity ID，上传这个 .alf，下载 .ulf，然后放进 C:\ProgramData\Unity\Unity_lic.ulf'
