// dsh-relay-pair / tunnel.js
//
// SSH 反向隧道管家：把本机 DSH 网页 127.0.0.1:<本机端口> 临时映射到公网服务器的
// 127.0.0.1:<remotePort>，服务器上的 nginx 再用 https 反代出去，手机浏览器就能打开。
//
// 设计原则：
//  1. 不是常驻进程 —— 任一端没配对中继、中继不可达、没人用，都要把隧道关掉；
//  2. 关之前先等 closeGraceSeconds（默认 45 秒），扛住 Wi-Fi/5G 切换这种瞬断；
//  3. 关的时候先 SIGTERM 让 ssh 自己收尾，5 秒还不退才 SIGKILL；
//  4. ssh 自己挂了（断网、服务器重启）按 2s→4s→…→30s 退避重连，不狂刷。

import { spawn as nodeSpawn } from 'node:child_process'

export const KILL_GRACE_MS = 5000
export const UP_AFTER_MS = 1200
export const BACKOFF_START_MS = 2000
export const BACKOFF_MAX_MS = 30000

/** 端口从 origin 里取；取不到返回 0（上层据此判 waiting）。 */
export function portOfOrigin(origin) {
  const text = typeof origin === 'string' ? origin : ''
  if (text === '') return 0
  try {
    const url = new URL(text)
    if (url.port !== '') return Number(url.port) || 0
    return url.protocol === 'https:' ? 443 : 80
  } catch {
    return 0
  }
}

/** 拼 ssh 参数。BatchMode + IdentitiesOnly 保证它永远不会停下来问密码。 */
export function sshArgs(tunnel, localPort, platform = process.platform) {
  const knownHosts = platform === 'win32' ? 'NUL' : '/dev/null'
  return [
    '-N',
    '-i', tunnel.keyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=' + knownHosts,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-p', String(tunnel.sshPort),
    '-R', '127.0.0.1:' + tunnel.remotePort + ':127.0.0.1:' + localPort,
    tunnel.sshUser + '@' + tunnel.sshHost,
  ]
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

export function createTunnelSupervisor(options = {}) {
  const tunnel = options.tunnel || {}
  const logger = options.logger || console
  const spawnImpl = options.spawnImpl || nodeSpawn
  const platform = options.platform || process.platform
  const now = options.now || (() => Date.now())
  const graceMs = Math.max(0, Number(tunnel.closeGraceSeconds || 0)) * 1000

  const status = {
    state: tunnel.enabled === true ? 'idle' : 'disabled',
    reason: tunnel.enabled === true ? 'starting' : 'disabled',
    localPort: 0,
    upSince: null,
    changedAt: now(),
    lastExit: null,
    lastError: null,
    restarts: 0,
  }

  let child = null
  let allowedNow = false
  let graceTimer = null
  let retryTimer = null
  let backoffMs = 0

  function setState(state, reason) {
    if (status.state !== state) status.changedAt = now()
    status.state = state
    if (typeof reason === 'string' && reason !== '') status.reason = reason
  }

  function clearTimer(name) {
    const timer = name === 'grace' ? graceTimer : retryTimer
    if (timer === null) return
    clearTimeout(timer)
    if (name === 'grace') graceTimer = null
    else retryTimer = null
  }

  function scheduleRetry() {
    clearTimer('retry')
    const delay = backoffMs
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (allowedNow && child === null) spawnChild()
    }, delay)
    if (retryTimer.unref) retryTimer.unref()
  }

  function killChild(reason) {
    const proc = child
    if (proc === null) {
      setState('idle', reason)
      return
    }
    child = null
    // 先摘掉「该开」的旗子：kill 触发的 exit 是同步的，不改的话 onGone 会以为
    // 是意外掉线，反手排一个退避重连，把正常的主动关闭变成重连风暴。
    allowedNow = false
    setState('closing', reason)
    try {
      proc.kill('SIGTERM')
    } catch (error) {
      logger.warn('relay-pair: tunnel SIGTERM failed: ' + messageOf(error))
    }
    const hard = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // 早就退了：正常路径。
      }
    }, KILL_GRACE_MS)
    if (hard.unref) hard.unref()
    setState('idle', reason)
  }

  function spawnChild() {
    if (child !== null) return
    if (status.localPort === 0) {
      setState('waiting', 'no-local-port')
      return
    }
    const args = sshArgs(tunnel, status.localPort, platform)
    setState('starting', 'spawn')
    let proc
    try {
      proc = spawnImpl('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (error) {
      status.lastError = messageOf(error)
      setState('failed', 'spawn-failed')
      backoffMs = backoffMs === 0 ? BACKOFF_START_MS : Math.min(BACKOFF_MAX_MS, backoffMs * 2)
      scheduleRetry()
      return
    }
    child = proc
    let stderr = ''
    let gone = false
    if (proc.stderr && typeof proc.stderr.on === 'function') {
      proc.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-400)
      })
    }
    const upTimer = setTimeout(() => {
      if (child === proc && status.state === 'starting') {
        setState('up', 'up')
        status.upSince = now()
        backoffMs = 0
        logger.info('relay-pair: tunnel up on ' + tunnel.sshHost + ' port ' + tunnel.remotePort)
      }
    }, UP_AFTER_MS)
    if (upTimer.unref) upTimer.unref()
    const onGone = (code, signal) => {
      if (gone) return
      gone = true
      clearTimeout(upTimer)
      if (child === proc) child = null
      status.upSince = null
      status.lastExit = { code: code === undefined ? null : code, signal: signal === undefined ? null : signal, at: now() }
      if (stderr.trim() !== '') status.lastError = stderr.trim()
      if (allowedNow) {
        status.restarts += 1
        backoffMs = backoffMs === 0 ? BACKOFF_START_MS : Math.min(BACKOFF_MAX_MS, backoffMs * 2)
        setState('restarting', 'exited')
        scheduleRetry()
      } else {
        setState('idle', status.reason)
      }
    }
    if (typeof proc.on === 'function') {
      proc.on('exit', onGone)
      proc.on('error', (error) => {
        status.lastError = messageOf(error)
        onGone(null, null)
      })
    }
  }

  /**
   * 每个 tick 调一次：告诉管家「现在该不该开着」和「本机端口是多少」。
   * allowed=false 不会立刻杀进程，而是先挂一个 grace 定时器。
   */
  function update(next = {}) {
    const allowed = next.allowed === true
    const reason = typeof next.reason === 'string' && next.reason !== '' ? next.reason : (allowed ? 'ok' : 'blocked')
    if (typeof next.localOrigin === 'string' && next.localOrigin !== '') {
      const port = portOfOrigin(next.localOrigin)
      if (port !== status.localPort) {
        // 端口变了（DSH 重启换了端口）：旧隧道指向空号，直接关掉重开。
        if (child !== null) killChild('port-changed')
        status.localPort = port
      }
    }
    if (tunnel.enabled !== true) {
      allowedNow = false
      clearTimer('grace')
      clearTimer('retry')
      if (child !== null) killChild('disabled')
      setState('disabled', 'disabled')
      return statusView()
    }
    status.reason = reason
    if (!allowed) {
      allowedNow = false
      clearTimer('retry')
      if (child === null) {
        setState('idle', reason)
        return statusView()
      }
      if (graceTimer === null) {
        setState('closing', reason)
        if (graceMs <= 0) {
          killChild(reason)
        } else {
          graceTimer = setTimeout(() => {
            graceTimer = null
            if (!allowedNow) killChild(reason)
          }, graceMs)
          if (graceTimer.unref) graceTimer.unref()
        }
      }
      return statusView()
    }
    allowedNow = true
    clearTimer('grace')
    if (child !== null) {
      if (status.state === 'closing') setState('up', 'ok')
      return statusView()
    }
    if (retryTimer !== null) return statusView()
    spawnChild()
    return statusView()
  }

  function statusView() {
    return {
      enabled: tunnel.enabled === true,
      state: status.state,
      reason: status.reason,
      publicUrl: typeof tunnel.publicUrl === 'string' ? tunnel.publicUrl : '',
      sshHost: typeof tunnel.sshHost === 'string' ? tunnel.sshHost : '',
      remotePort: tunnel.remotePort,
      localPort: status.localPort,
      upSince: status.upSince ? new Date(status.upSince).toISOString() : null,
      lastExit: status.lastExit,
      lastError: status.lastError,
      restarts: status.restarts,
      changedAt: status.changedAt ? new Date(status.changedAt).toISOString() : null,
    }
  }

  function dispose() {
    allowedNow = false
    clearTimer('grace')
    clearTimer('retry')
    if (child !== null) killChild('dispose')
    setState('disabled', 'dispose')
  }

  return {
    update,
    status: statusView,
    dispose,
    get running() {
      return child !== null
    },
  }
}