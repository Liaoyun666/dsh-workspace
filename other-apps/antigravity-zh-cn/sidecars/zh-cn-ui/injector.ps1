$ErrorActionPreference = 'SilentlyContinue'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$translatorPath = Join-Path $scriptDir 'translator.js'
$dictPath = Join-Path $scriptDir 'translations.json'

function Get-Expression {
  if (-not (Test-Path -LiteralPath $translatorPath)) { return $null }
  if (-not (Test-Path -LiteralPath $dictPath)) { return $null }
  $translator = Get-Content -LiteralPath $translatorPath -Raw -Encoding UTF8
  $dict = Get-Content -LiteralPath $dictPath -Raw -Encoding UTF8
  return "window.__AGY_ZH_CN_ACTIVE__ = false; window.__AGY_ZH_CN_DICT__ = " + $dict + ";" + [Environment]::NewLine + $translator
}

function Send-Cdp($ws, $id, $method, $params) {
  $payload = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Compress -Depth 8
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$bytes)
  $task = $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None)
  $task.Wait(5000) | Out-Null
}

function Find-PageTarget {
  $portFile = Join-Path $env:APPDATA 'Antigravity\DevToolsActivePort'
  if (-not (Test-Path -LiteralPath $portFile)) { return $null }
  $port = (Get-Content -LiteralPath $portFile -TotalCount 1).Trim()
  if (-not $port) { return $null }
  try {
    $targets = Invoke-RestMethod -Uri ("http://127.0.0.1:$port/json/list") -TimeoutSec 5
  } catch { return $null }
  $page = $targets | Where-Object { $_.type -eq 'page' -and ($_.url -like 'https://127.0.0.1*') } | Select-Object -First 1
  if (-not $page) { return $null }
  return @{ port = $port; wsUrl = $page.webSocketDebuggerUrl }
}

$lastPort = ''
$msgId = 0
while ($true) {
  $expr = Get-Expression
  if (-not $expr) { Start-Sleep -Seconds 3; continue }
  $target = Find-PageTarget
  if (-not $target) { Start-Sleep -Seconds 2; continue }
  try {
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ws.ConnectAsync([Uri]$target.wsUrl, [System.Threading.CancellationToken]::None).Wait(5000) | Out-Null
    $lastPort = $target.port
    $msgId++
    Send-Cdp $ws $msgId 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true }
    $msgId++
    Send-Cdp $ws $msgId 'Page.addScriptToEvaluateOnNewDocument' @{ source = $expr }

    $buffer = New-Object byte[] 131072
    $lastCheck = Get-Date
    while ($true) {
      if (-not ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open)) { break }
      $cts = New-Object System.Threading.CancellationTokenSource
      $cts.CancelAfter(1500)
      $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$buffer)
      $task = $ws.ReceiveAsync($segment, $cts.Token)
      try { $task.Wait(2000) | Out-Null } catch {}
      if ($task.IsFaulted) { $cts.Dispose(); break }
      if ($task.IsCanceled) {
        $cts.Dispose()
        if (((Get-Date) - $lastCheck).TotalSeconds -gt 3) {
          $check = Find-PageTarget
          if (-not $check -or $check.port -ne $lastPort) { break }
          $lastCheck = Get-Date
        }
        continue
      }
      if ($task.Result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { $cts.Dispose(); break }
      $cts.Dispose()
    }
    try { $ws.Dispose() } catch {}
  } catch {
    try { if ($ws) { $ws.Dispose() } } catch {}
    Start-Sleep -Seconds 2
  }
  Start-Sleep -Milliseconds 500
}
