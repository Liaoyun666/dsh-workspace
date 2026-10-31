# 把 patched/ 里的补丁文件覆盖回 DSH profile 的 node_modules。
# 插件升级后重跑本脚本即可恢复「一键停用全部人设」功能。
[CmdletBinding()]
param(
    [string]$Profile = "desktop",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$pkgName = "dsh-persona-dafeiyu"
$pinned = "0.6.0"
$root = $PSScriptRoot
$src = Join-Path $root "patched"
$pkgDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\node_modules\$pkgName"
$nodeExe = "E:\Deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

if (-not (Test-Path $pkgDir)) { throw "找不到插件目录：$pkgDir（先安装 $pkgName）" }

$pkgJson = [IO.File]::ReadAllText((Join-Path $pkgDir "package.json"), [Text.Encoding]::UTF8)
$pkg = ConvertFrom-Json $pkgJson
Write-Host "目标插件：$($pkg.name) $($pkg.version)"
if ($pkg.version -ne $pinned -and -not $Force) {
    throw "插件版本是 $($pkg.version)，补丁是按 $pinned 写的（不同版本的代码结构可能不同）。确认要硬套请加 -Force。"
}

$files = @("lib\index.js", "lib\client.js")
foreach ($rel in $files) {
    $from = Join-Path $src $rel
    $to = Join-Path $pkgDir $rel
    if (-not (Test-Path $from)) { throw "补丁文件缺失：$from" }
    if (Test-Path $to) { Copy-Item $to "$to.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" }
    Copy-Item $from $to -Force
    Write-Host "已覆盖：$rel"
}

if (Test-Path $nodeExe) {
    foreach ($rel in $files) {
        & $nodeExe --check (Join-Path $pkgDir $rel)
        if ($LASTEXITCODE -ne 0) { throw "语法检查失败：$rel" }
    }
    Write-Host "语法检查通过。"
}

Write-Host ""
Write-Host "下一步：在 GUI 插件页把 $pkgName 关一下再开（或重启 DSH），然后刷新页面（Ctrl+F5）。"
