// dsh-relay-pair / index.js
//
// 把本机 DSH（或手机 DSHA 里的同一个包）配到 DSH 中继台：
//   - relay_pair      用一次性配对码换设备令牌，落盘 $DSH_HOME/relay-device.json
//   - relay_status    看连接状态、待办数、最近心跳
//   - relay_task_add  派一个任务：本机自己跑，或交给云端/另一端
//   - relay_tasks     看中继上的任务（含云端结果）
//   - relay_sync_task 只把你想同步的本地任务 pushes 上云（默认不同步）
//   - relay_unpair    断开并清凭据
//
// 网络模型：设备只做出站请求（心跳 + 长轮询），所以 NAT 后面也能工作；
// 网页想读本机信息时，中继在长轮询回包里带一个 tunnel 帧，本机处理完再回传。
//
// 这个插件不 import 任何 @deepseek-ai/* 包（从工作区路径加载），
// 工具注册和用户消息构造用下面的本地 shim，与 dsh-schedule 同一套写法。

import { randomUUID } from 'node:crypto'
import { appendFileSync, statSync, truncateSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { hostname } from 'node:os'
import { join } from 'node:path'

import {
  buildTunnelUrl,
  clearCredentials,
  credentialsBackupPath,
  credentialsPath,
  defaultDeviceName,
  dshHome,
  detectDeviceKind,
  enqueueOutbox,
  frameSubmitMessage,
  frameTaskMessage,
  isAllowedTunnelPath,
  jsonRequest,
  listLocalTasks,
  appendLocalTask,
  messageText,
  nextRetryDelay,
  normalizeConfig,
  normalizeRelayUrl,
  readCredentialsWithRecovery,
  splitTunnelPath,
  trimText,
  writeCredentials,
} from './protocol.js'
import {
  MAX_SNAPSHOT_SESSIONS,
  createSessionReader,
  frameHandoffMessage,
} from './sessions.js'
import { createTunnelSupervisor } from './tunnel.js'
import {
  CATALOG_TTL_MS,
  applyChoice,
  buildCatalog,
  catalogSummary,
  choiceLabel,
  normalizeChoice,
} from './models.js'

export const name = 'relay-pair'

export const inject = ['agents', 'tools']

// 改版本号时和 package.json 一起改（以前忘了同步，中继上一直显示旧版本）。
const VERSION = '0.4.1'
const EXCERPT_LIMIT = 1200
/**
 * 模型目录探测的硬超时。buildCatalog 会挨个问 provider 和模型，
 * llm 服务刚起或者某个 provider 不响应时能挂上十分钟 ——
 * 以前它就在心跳前面 await，一挂住心跳一次都发不出去，网页那边就成了「离线」。
 */
const CATALOG_TIMEOUT_MS = 20000
/** 会话快照多久自动同步一次（秒）；轮次结束后另有一次 4 秒防抖的补同步。 */
const SESSION_SYNC_SECONDS = 90
const SESSION_SYNC_DEBOUNCE_MS = 4000
/** SSH 隧道多久复核一次该不该开着（秒）。 */
const TUNNEL_TICK_SECONDS = 10
/** 中继多久没往来就算「不可达」，隧道跟着关。 */
const TUNNEL_HEARTBEAT_STALE_MS = 60000
/** 隧道通了以后，用公网 Host 复核一次 DSH 的 /api 信任栅栏，多久复核一次（毫秒）。 */
const FENCE_PROBE_INTERVAL_MS = 120000
const FENCE_PROBE_TIMEOUT_MS = 4000

/** 本地 shim：与 @deepseek-ai/dsh-tools 的 defineTool 等价（编译紧凑参数表 → JSON Schema）。 */
function defineTool(options) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(options.parameters ?? {})) {
    const { required: isRequired, ...rest } = spec
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  return {
    name: options.name,
    description: options.description,
    parameters: { type: 'object', properties, ...required.length > 0 ? { required } : {} },
    output: { schema: options.output.schema, render: options.output.render },
    execute: options.execute,
  }
}

/**
 * 本地流水按任务折叠：一个任务只留最后一条（流水是追加写的，同一个 taskId
 * 会有 running 和 done 两条）。给「本机最近任务」这类人看的列表用。
 */
function recentTasks(limit, env = process.env) {
  const rows = listLocalTasks(Math.max(limit * 8, 50), env)
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const key = row && typeof row.id === 'string' && row.id !== '' ? row.id : null
    if (key !== null) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(row)
    if (out.length >= limit) break
  }
  return out
}

/** 本地 shim：与 @deepseek-ai/dsh-llm 的 createUserMessage 等价。 */
function createUserMessage(input) {
  return Object.freeze({ ...input, id: randomUUID(), role: 'user' })
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger ?? console
  const kind = detectDeviceKind(config.deviceKind)
  const deviceName = config.deviceName || defaultDeviceName(kind)

  /**
   * 当前凭据（可能来自上一次配对）；relay_pair 会覆盖它。
   * 主文件没了就用备份兜底：重启后要重新配对的老问题就断在这一步。
   */
  const loaded = readCredentialsWithRecovery()
  let creds = loaded.creds
  /** 凭据来自哪：'primary' | 'backup' | 'none'。写进启动日志和 /relay/api/state。 */
  let credsSource = loaded.source

  const runtime = {
    stopped: true,
    heartbeatTimer: null,
    pollAbort: null,
    pollTask: null,
    outboxTimer: null,
    outboxRetry: 0,
    retryAttempt: 0,
    startedAt: 0,
    lastHeartbeatAt: 0,
    lastPollAt: 0,
    lastError: null,
    /** 首次心跳结果只写一次启动日志，别每 20 秒刷一行。 */
    heartbeatLogged: false,
    delivered: 0,
    /** 内存发件箱：报告发不出去就留在这里，心跳成功/退避计时器里重放。 */
    outbox: [],
    /** 按 sessionId 排的待投任务（同会话同一时刻只跑一单）。 */
    queued: [],
    /** 会话快照：定时器、补同步定时器、上次同步时间、上报条数、最近一次错误。 */
    sessionTimer: null,
    sessionSoon: null,
    lastSessionSyncAt: 0,
    sessionCount: 0,
    sessionError: null,
    /** 「送过去」的会话：收下几条、成功接上几条、失败几条。 */
    handoffsIn: 0,
    handoffsOk: 0,
    handoffsFailed: 0,
    /** 中继上其它设备（poll 回包里带的 peers）：判断「对面还在不在」。 */
    peers: [],
    /** SSH 隧道复核定时器 + 最近一次门禁原因（给 relay_status 看）。 */
    tunnelTimer: null,
    tunnelGate: 'idle',
    /** 本机模型目录（上报给中继，网页靠它给任务选模型）；catalogAt=上次探测时间。 */
    catalog: null,
    catalogAt: 0,
    catalogError: null,
    /** 上次成功上报的目录版本（generatedAt）：没变就不重复传，省心跳流量。 */
    catalogSentAt: '',
    catalogPending: '',
    /** 后台目录探测是否在跑：同一时刻只跑一个，别越堆越多。 */
    catalogInFlight: false,
    /** 自动续期：在途标记、成功次数、最近一次时间。 */
    renewInFlight: false,
    renewCount: 0,
    renewAt: 0,
    /** 令牌被判失效且自愈没成功：面板据此把「心跳中断」说成「令牌失效」。 */
    lastAuthError: false,
    /** 隧道下 /api 信任栅栏的探测结果：{ok, status, host, checkedAt, hint}。ok=null 表示没探到。 */
    fence: null,
    fenceProbeAt: 0,
    fenceProbeInFlight: false,
    /** 中继网页「可信地址」白名单（心跳回包下发）：这些域名的中转页放行、并注入 /api 信任名单。 */
    relayTrustedHosts: [],
    /** 其中由本插件注入到 connection.trustedHosts 的那几条：只撤自己加的，不碰配置里的。 */
    relayTrustedInjected: [],
  }

  /** 读本机会话用的门面（DSH 没给服务时全部安全降级，不抛）。 */
  const sessionReader = createSessionReader(ctx, logger)

  /**
   * SSH 反向隧道：把本机 DSH 网页临时映射到公网服务器，手机浏览器就能打开。
   *
   * 它是个「按需进程」，不是常驻服务：下面四条同时成立才起 ssh，任一条塌了
   * 就先进 closing、等 closeGraceSeconds（默认 45 秒）再优雅关掉 —— 这样
   * Wi-Fi/5G 切换那种一两秒的瞬断不会把隧道反复启停，而真的没人用的时候
   * 公网那头也不会一直挂着一个能打进来的口子。
   */
  const tunnel = createTunnelSupervisor({ tunnel: config.webTunnel, logger })

  function tunnelGate() {
    if (config.webTunnel.enabled !== true) return { allowed: false, reason: 'disabled' }
    if (!creds) return { allowed: false, reason: 'unpaired' }
    if (runtime.stopped) return { allowed: false, reason: 'stopped' }
    const now = Date.now()
    if (runtime.lastHeartbeatAt === 0 || now - runtime.lastHeartbeatAt > TUNNEL_HEARTBEAT_STALE_MS) {
      return { allowed: false, reason: 'relay-offline' }
    }
    if (config.webTunnel.requireMobilePeer) {
      const mobiles = runtime.peers.filter((peer) => peer && peer.kind === 'mobile')
      if (mobiles.length === 0) return { allowed: false, reason: 'no-mobile-peer' }
      const idleMinutes = config.webTunnel.idleMinutes
      if (idleMinutes > 0) {
        const newest = Math.max(...mobiles.map((peer) => Number(peer.lastSeen) || 0))
        if (newest > 0 && now - newest > idleMinutes * 60000) return { allowed: false, reason: 'mobile-idle' }
      }
    }
    return { allowed: true, reason: 'ok' }
  }

  function tunnelTick() {
    const gate = tunnelGate()
    runtime.tunnelGate = gate.reason
    tunnel.update({ allowed: gate.allowed, reason: gate.reason, localOrigin: webOrigin() })
    probeApiFence()
  }

  /**
   * 隧道通了 ≠ 能用：DSH 的 /api 有一道 Host/Origin 信任栅栏，只认 loopback、
   * 监听地址和 connection 插件的 trustedHosts。隧道下 nginx 透传的是公网域名，
   * 没配 trustedHosts 时每个 /api 都 403 —— 手机上就是「无法打开文件夹」加
   * 底部一直「重新连接中」。这里拿公网 Host 打一次本机 /api 探明真相：
   * 403 = 被栅栏拒绝，401/404 = 栅栏放行（只是没带登录 cookie）。
   */
  function probeApiFence() {
    const state = tunnel.status()
    if (state.state !== 'up' || !state.localPort) {
      // 隧道没开：下次开起来立刻重探。
      runtime.fenceProbeAt = 0
      return
    }
    const host = publicHostOf(state.publicUrl)
    if (host === '' || runtime.fenceProbeInFlight) return
    const now = Date.now()
    if (runtime.fence !== null && now - runtime.fenceProbeAt < FENCE_PROBE_INTERVAL_MS) return
    runtime.fenceProbeInFlight = true
    runtime.fenceProbeAt = now
    const finish = (status, hint) => {
      if (!runtime.fenceProbeInFlight) return
      runtime.fenceProbeInFlight = false
      runtime.fence = {
        ok: status === 0 ? null : status !== 403,
        status,
        host,
        checkedAt: new Date().toISOString(),
        hint,
      }
      if (status === 403) logger.warn('relay-pair: ' + hint)
    }
    let req
    try {
      req = httpRequest({
        host: '127.0.0.1',
        port: state.localPort,
        path: '/api/relay-pair-fence-probe',
        method: 'GET',
        timeout: FENCE_PROBE_TIMEOUT_MS,
        headers: { host, 'sec-fetch-site': 'same-origin', accept: 'application/json' },
      }, (res) => {
        res.resume()
        const status = res.statusCode ?? 0
        finish(status, status === 403
          ? '公网域名不在 DSH 的 /api 信任名单里：给桌面 profile 的 connection 插件加 trustedHosts: [' + host + ']，重启 DSH 后生效'
          : '')
      })
    } catch (error) {
      finish(0, '探测本机 /api 失败：' + (error && error.message ? error.message : error))
      return
    }
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', (error) => { finish(0, '探测本机 /api 失败：' + (error && error.message ? error.message : error)) })
    req.end()
  }

  /** 已投递但还没跑完的轮次：messageId → { taskId, title, sessionId, session, excerpt } */
  const pendingRuns = new Map()
  /**
   * 已经处理过的 handoff（id → 回执内容）。中继 15 分钟收不到 ack 会把同一条退回 pending 重投，
   * 这里记住结果：再来只补回执，绝不把同一段会话再注入一遍。
   */
  const handoffsDone = new Map()
  const HANDOFFS_DONE_LIMIT = 50

  function guarded(label, fn) {
    return (...args) => {
      try {
        return fn(...args)
      } catch (error) {
        logger.warn('relay-pair: ' + label + ' failed: ' + (error && error.message ? error.message : error))
        return undefined
      }
    }
  }

  // --- 会话选择 --------------------------------------------------------------

  let lastActiveRoot = null
  ctx.on('agent/created', guarded('agent/created', ({ agent }) => {
    if (agent && roots().includes(agent)) lastActiveRoot = agent
  }))
  ctx.on('agent/status', guarded('agent/status', ({ agent }) => {
    if (agent && roots().includes(agent)) lastActiveRoot = agent
  }))

  function roots() {
    try {
      return ctx.agents.roots()
    } catch {
      return []
    }
  }

  function pickAgent() {
    const list = roots()
    if (lastActiveRoot && list.includes(lastActiveRoot)) return lastActiveRoot
    return list.length > 0 ? list[list.length - 1] : null
  }

  // --- 和中继说话 ------------------------------------------------------------

  /**
   * 启动对账日志：往 $DSH_HOME/relay-pair.log 追加一行 JSON。
   *
   * 「重启后配对丢了」这种问题没有别的日志可查（DSH 自己不落启动日志），
   * 留一行就够分清是「凭据没读到」还是「插件压根没加载」。超过 64KB 清空重写。
   */
  function noteBoot(event, extra) {
    try {
      const file = join(dshHome(), 'relay-pair.log')
      let size = 0
      try {
        size = statSync(file).size
      } catch { /* 还没有这个文件 */ }
      if (size > 64 * 1024) truncateSync(file, 0)
      appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, version: VERSION, ...extra }) + String.fromCharCode(10), 'utf8')
    } catch { /* 日志写不进去不该影响配对 */ }
  }

  function baseUrl() {
    return (creds && creds.relayUrl) || config.relayUrl
  }

  function call(path, body, timeoutMs, signal) {
    if (!creds || !creds.token) throw new Error('还没配对：先运行 relay_pair 填配对码')
    return jsonRequest(baseUrl() + path, { token: creds.token, body, timeoutMs, signal })
  }

  function sessionKeyOf(agent) {
    return agent && agent.session && agent.session.id ? agent.session.id : null
  }

  /**
   * 同会话同一时刻只跑一单：事件里没有能区分「这条消息属于哪一单」的字段，
   * 两单并排跑只会互相覆盖 excerpt、一起结算。所以按 sessionId 认领那一单。
   */
  function runForAgent(agent) {
    const sessionId = sessionKeyOf(agent)
    for (const [messageId, run] of pendingRuns) {
      if (sessionId !== null ? run.sessionId === sessionId : run.agent === agent) return { messageId, run }
    }
    return null
  }

  function runForSession(session) {
    const sessionId = session && session.id ? session.id : null
    for (const [messageId, run] of pendingRuns) {
      if (run.session === session || (sessionId !== null && run.sessionId === sessionId)) return { messageId, run }
    }
    return null
  }

  /**
   * 把任务投进本机：**一条任务一个全新会话**（任务隔离，互不串味）。
   *
   * 中继台会把「这条任务跑在哪个会话」记下来（tasks.session_id）。网页上点
   * 「接着做」时带着同一个 sessionId 回来，这里就 resume 那条会话，而不是再开一条。
   * 同一个会话里已经有一单在跑，就把新单排进队列，等那一轮结束再投。
   */
  async function deliver(task) {
    if (!config.localExec) return { ok: false, error: '配置 localExec=false，本机不接收中继任务' }
    const title = String((task && task.title) || '').trim() || trimText((task && task.prompt) || '', 40)
    const wanted = String((task && task.sessionId) || '').trim()
    let agent = null
    let sessionId = null
    if (sessionReader.available()) {
      let target
      try {
        target = wanted
          ? await sessionReader.ensureSession(wanted, { title })
          : await sessionReader.createSession({ title })
      } catch (error) {
        return { ok: false, error: '开会话失败：' + (error && error.message ? error.message : String(error)) }
      }
      if (!target || target.ok !== true) {
        return { ok: false, error: (target && target.error) || '开会话失败' }
      }
      agent = target.agent
      sessionId = target.sessionId || sessionKeyOf(agent)
    } else {
      // 宿主没给会话服务（精简宿主/老版本）：退回「投给最活跃会话」，
      // 至少任务能跑起来，不会因为拿不到 sessionController 就整条卡死。
      agent = pickAgent()
      if (!agent) return { ok: false, error: '本机没有打开的 DSH 会话：先在本机 Web GUI 里开一个会话再派任务' }
      sessionId = sessionKeyOf(agent)
    }
    if (runForAgent(agent) !== null) {
      runtime.queued.push({ task, agent, sessionId })
      return { ok: true, queued: true, queuedCount: runtime.queued.length, sessionId }
    }
    return deliverNow(task, agent, sessionId)
  }

  function deliverNow(task, agent, sessionId) {
    const sid = sessionId || sessionKeyOf(agent) || null
    // 先切模型再投消息：selectForNextRequest 只影响「下一次请求」，
    // 所以必须在 followup 之前设置，否则这一轮还用旧模型跑。
    const choice = normalizeChoice(task)
    const applied = applyChoice(pick('sessionController'), agent, choice, runtime.catalog)
    if (applied.error) return { ok: false, error: applied.error }
    let message
    try {
      message = createUserMessage({
        content: [{ type: 'text', text: frameTaskMessage(task, deviceName, applied.note) }],
        source: { kind: 'plugin:dsh-relay-pair' },
      })
      agent.followup(message)
    } catch (error) {
      return { ok: false, error: '投递失败：' + (error && error.message ? error.message : String(error)) }
    }
    pendingRuns.set(message.id, {
      taskId: task.id || '',
      title: String(task.title || '').trim() || trimText(task.prompt || '', 40),
      sessionId: sid,
      session: agent.session ?? null,
      agent,
      excerpt: '',
      model: applied.applied,
    })
    runtime.delivered += 1
    appendLocalTask({
      id: task.id || ('local-' + message.id),
      title: task.title || trimText(task.prompt || '', 60),
      prompt: trimText(task.prompt || '', 8000),
      target: 'local',
      origin: 'relay',
      status: 'running',
      createdAt: new Date().toISOString(),
      sessionId: sid,
      modelProvider: choice.provider,
      modelName: choice.model,
      reasoningEffort: applied.applied ? (applied.applied.reasoningEffort || '') : '',
    })
    return { ok: true, messageId: message.id, sessionId: sid, model: applied.applied, modelNote: applied.note }
  }

  // --- 上报结果：发不出去就进内存发件箱 --------------------------------------

  function postReport(entry) {
    return call('/api/agent/report', entry, 15000)
  }

  function scheduleOutboxFlush() {
    if (runtime.outboxTimer !== null || runtime.outbox.length === 0 || !creds || runtime.stopped) return
    const delay = nextRetryDelay(runtime.outboxRetry)
    runtime.outboxRetry += 1
    runtime.outboxTimer = setTimeout(() => {
      runtime.outboxTimer = null
      flushOutbox().catch((error) => {
        logger.warn('relay-pair: 发件箱重放失败: ' + (error && error.message ? error.message : error))
      })
    }, delay)
    if (typeof runtime.outboxTimer.unref === 'function') runtime.outboxTimer.unref()
  }

  /** 重放发件箱：一条条发，还是不通就整批放回去等下一轮。 */
  async function flushOutbox() {
    if (!creds || runtime.outbox.length === 0) return
    const batch = runtime.outbox.splice(0, runtime.outbox.length)
    const failed = []
    for (const entry of batch) {
      try {
        await postReport(entry)
      } catch {
        failed.push(entry)
      }
    }
    for (const entry of failed) enqueueOutbox(runtime.outbox, entry)
    if (failed.length === 0) runtime.outboxRetry = 0
    scheduleOutboxFlush()
  }

  /**
   * 上报任务状态。网络一抖就永久丢结果会让中继那头一直 running，
   * 所以失败先进内存发件箱（同 taskId 只留最新状态），心跳成功时重放。
   */
  function reportTask(taskId, status, output, error, sessionId) {
    if (!taskId) return
    const entry = { taskId, status }
    // 带上会话 id：中继台靠它记下「这条任务跑在哪个会话」，网页才能「接着做」。
    if (sessionId) entry.sessionId = String(sessionId)
    if (output !== undefined && output !== null && output !== '') entry.output = trimText(output, 8000)
    entry.error = error || ''
    if (!creds) {
      enqueueOutbox(runtime.outbox, entry)
      return
    }
    postReport(entry).catch((e) => {
      logger.warn('relay-pair: report ' + taskId + ' → ' + status + ' 没发出去，先存发件箱: ' + (e && e.message ? e.message : e))
      const dropped = enqueueOutbox(runtime.outbox, entry)
      if (dropped > 0) logger.warn('relay-pair: 发件箱丢弃了 ' + dropped + ' 条旧记录')
      scheduleOutboxFlush()
    })
  }

  // --- 轮次收尾：把结果回传中继 ----------------------------------------------

  ctx.on('session/event', guarded('session/event', (session, event) => {
    const data = event && event.data ? event.data : {}
    const text = event.type === 'assistant/message' ? messageText(data.message) : ''

    if (event.type === 'turn/end') {
      // 刚聊完的这一轮要让网页上的快照跟着变（4 秒防抖，别每条消息都发一遍）。
      scheduleSessionSync()
    }
    if (pendingRuns.size === 0) return
    // 只认这个会话认领的那一单：同会话不会有两单并排跑（deliver 会排队）。
    const claimed = runForSession(session)
    if (claimed === null) return
    if (event.type === 'assistant/message') {
      if (text) claimed.run.excerpt = text.slice(-EXCERPT_LIMIT)
      return
    }
    if (event.type !== 'turn/end') return
    pendingRuns.delete(claimed.messageId)
    const reasonKind = data.reason && typeof data.reason.kind === 'string' ? data.reason.kind : 'unknown'
    const run = claimed.run
    if (run.taskId) {
      reportTask(run.taskId, reasonKind === 'completed' ? 'done' : 'failed',
        run.excerpt, reasonKind === 'completed' ? '' : 'turn ended: ' + reasonKind, run.sessionId)
    }
    appendLocalTask({
      id: run.taskId || ('local-' + claimed.messageId),
      title: run.title || '',
      prompt: '',
      target: 'local',
      origin: 'relay',
      status: reasonKind === 'completed' ? 'done' : 'failed',
      output: trimText(run.excerpt, 2000),
      finishedAt: new Date().toISOString(),
      sessionId: run.sessionId || null,
    })
    // 这一单结算完，立刻投同会话排队里的下一单。
    drainQueue(run.session || session)
  }))

  /** 把排在这个会话后面的任务投出去；投不进去就报到中继上（blocked）继续下一个。 */
  function drainQueue(session) {
    const sessionId = session && session.id ? session.id : null
    for (let i = 0; i < runtime.queued.length; i += 1) {
      const item = runtime.queued[i]
      if (item.sessionId !== sessionId) continue
      runtime.queued.splice(i, 1)
      const result = deliverNow(item.task, item.agent, item.sessionId)
      if (result.ok || result.queued) return result
      if (item.task && item.task.id) reportTask(item.task.id, 'blocked', undefined, result.error, item.sessionId)
      logger.warn('relay-pair: 排队任务投递失败: ' + result.error)
      return result
    }
    return null
  }

  /** 断开配对/关插件时清空队列，别让中继那头一直等一个永远不会跑的任务。 */
  function failQueue(reason) {
    const queued = runtime.queued.splice(0, runtime.queued.length)
    for (const item of queued) {
      const taskId = item.task && item.task.id ? item.task.id : ''
      if (taskId) reportTask(taskId, 'failed', undefined, reason, item.sessionId)
      appendLocalTask({
        id: taskId || ('local-queued-' + Date.now()),
        title: item.task && item.task.title ? item.task.title : '',
        prompt: '',
        target: 'local',
        origin: 'relay',
        status: 'failed',
        output: reason,
        finishedAt: new Date().toISOString(),
        sessionId: item.sessionId || null,
      })
    }
    return queued.length
  }

  // --- 隧道：网页要看本机信息时 ----------------------------------------------

  /**
   * 本机 DSH Web 的根地址（协议 + 主机 + 端口）。
   *
   * 以前这里只认 webStartup/webRuntime 的 port，取不到就落到写死的 56246 ——
   * 那个端口只是早年的默认值，实际监听端口每次启动都可能变，于是网页上
   * 「打开本机 DSH」和隧道都打到空端口上（ERR_CONNECTION_REFUSED / 502）。
   * 现在以 ctx.webServer.getOrigin() 为准（它把协议 + 监听地址 + 端口组合好），
   * 只有拿不到时才退回旧的推导。
   */
  /**
   * ctx.get(name) 是主路径；某些宿主只把服务挂在 ctx 上，补一个兜底。
   *
   * 兜底那次属性访问必须包 try：cordis 里没写进 inject 的服务，`ctx.foo`
   * 会直接抛 `cannot get property "foo" without inject`（不是返回 undefined）。
   * 以前这行裸写，webOrigin() → tunnelTick() → startLoops() 一路抛出去，
   * 自动启动当成失败，心跳和轮询一次都没起来，中继网页上就成了「心跳中断」。
   */
  function pick(name) {
    try {
      const viaGet = ctx.get(name)
      if (viaGet) return viaGet
    } catch {
      // 没注册这个服务：忽略。
    }
    try {
      return ctx && ctx[name] ? ctx[name] : undefined
    } catch {
      // 没 inject 的服务：cordis 抛错，当作没有。
      return undefined
    }
  }

  function webOrigin() {
    if (config.hostBase) return config.hostBase.replace(/\/+$/, '')
    const webServer = pick('webServer')
    if (webServer) {
      try {
        if (typeof webServer.getOrigin === 'function') {
          const origin = webServer.getOrigin()
          if (origin) return String(origin).replace(/\/+$/, '')
        }
      } catch {
        // 端口还没绑定 / 非 URL 形式：往下走兜底推导。
      }
      const protocol = typeof webServer.protocol === 'string' ? webServer.protocol.replace(/:$/, '') : ''
      const host = typeof webServer.host === 'string' && webServer.host ? webServer.host : '127.0.0.1'
      if (webServer.port) return (protocol || 'http') + '://' + host + ':' + webServer.port
    }
    const startup = ctx.get('webStartup')
    const runtimeSvc = ctx.get('webRuntime')
    const port = (startup && (startup.port || (startup.config && startup.config.port)))
      || (runtimeSvc && (runtimeSvc.port || (runtimeSvc.config && runtimeSvc.config.port)))
    return port ? 'http://127.0.0.1:' + port : 'http://127.0.0.1:56246'
  }

  /**
   * 带登录令牌的本机地址：DSH Web 只认进程启动时那枚 launch token
   * （GET / 带 ?token= 才签发 cookie，其它一律 401）。所以给网页「打开本机
   * DSH」的必须是 authenticatedUrl() 拼出来的链接，光有端口还是打不开。
   */
  function webLinkUrl() {
    const base = webOrigin()
    const connection = pick('connection')
    try {
      if (connection && typeof connection.authenticatedUrl === 'function') {
        const link = connection.authenticatedUrl(base)
        if (typeof link === 'string' && link) return link
      }
    } catch (error) {
      logger.warn('relay-pair: authenticatedUrl failed: ' + (error && error.message ? error.message : error))
    }
    return base
  }

  /**
   * 本机中转页：网页「打开本机 DSH」指向这里，而不是带令牌的地址。
   *
   * 为什么必须绕一层：中继网页是 https://<公网 IP>，跳到 http://127.0.0.1:port/?token=
   * 属于跨站顶层导航，浏览器按 SameSite=Strict 不发送/不接收 DSH 的登录 cookie，
   * DSH 那边只看到「没有 cookie」，回一句 dsh web authentication required … 401。
   * 中转页是本机 origin，页面里的 location.replace 是同站导航，cookie 正常落地。
   */
  function enterPageUrl() {
    return webOrigin() + '/relay/api/enter'
  }

  /**
   * 隧道代理用的完整地址：路径 + 同一个 launch token。
   *
   * 路径是中继那边给的，可能带 `..` / `%2e%2e`；交给 new URL(path, origin)
   * 会被规范化消解掉，前缀白名单就形同虚设。所以这里先校验 pathname，
   * 再用`只写 pathname 和 query`的方式拼，最后断言 origin 和前缀都没跑掉。
   */
  function hostUrl(pathname) {
    const base = webLinkUrl()
    const url = buildTunnelUrl(base, pathname)
    const root = new URL(base)
    const out = new URL(url)
    if (out.origin !== root.origin) throw new Error('隧道路径越界：origin 变成了 ' + out.origin)
    if (!isAllowedTunnelPath(out.pathname)) throw new Error('隧道路径越界：' + out.pathname)
    return out.toString()
  }

  /**
   * 心跳/配对上报的设备信息：网页靠 meta.webUrl 点亮「打开本机 DSH」。
   *
   * 上报的是本机中转页 /relay/api/enter（不带令牌）：带 ?token= 的地址一旦进了
   * 中继，等于把这台机器的 DSH 登录权交给所有看得到设备信息的人；而上报裸 origin
   * 又会让浏览器停在 401（跨站导航 + SameSite=Strict，见 enterPageUrl）。
   */
  function deviceMeta() {
    const meta = {
      platform: process.platform,
      arch: process.arch,
      host: hostname(),
      version: VERSION,
    }
    const tunnelState = tunnel.status()
    if (tunnelState.state === 'up' && tunnelState.publicUrl !== '') {
      // 隧道开着：上报公网中转页。手机点「打开本机 DSH」才有意义 ——
      // 127.0.0.1 在手机上指的是手机自己，永远打不开。
      meta.webUrl = tunnelState.publicUrl + '/relay/api/enter'
      meta.webTunnel = {
        state: tunnelState.state,
        publicUrl: tunnelState.publicUrl,
        remotePort: tunnelState.remotePort,
        // 中继网页据此提示「隧道通了但 DSH 还挡着公网域名」。
        fence: runtime.fence === null ? 'unknown' : runtime.fence.ok === true ? 'ok' : runtime.fence.ok === false ? 'blocked' : 'unknown',
      }
    } else if (webOrigin()) {
      meta.webUrl = enterPageUrl()
      if (tunnelState.enabled) meta.webTunnel = { state: tunnelState.state, reason: tunnelState.reason }
    }
    // 模型目录：网页靠它给任务选模型/思考强度。内容没变就不重复传（省心跳流量）。
    if (runtime.catalog && runtime.catalog.generatedAt !== runtime.catalogSentAt) {
      meta.models = runtime.catalog
      runtime.catalogPending = runtime.catalog.generatedAt
    }
    return meta
  }

  function localState() {
    const list = roots()
    return {
      ok: true,
      device: {
        id: creds ? creds.deviceId : null,
        name: deviceName,
        kind,
        version: VERSION,
      },
      relay: {
        url: baseUrl(),
        paired: Boolean(creds && creds.token),
        online: runtime.stopped === false && (Date.now() - runtime.lastHeartbeatAt) < 60000,
        lastHeartbeatAt: runtime.lastHeartbeatAt ? new Date(runtime.lastHeartbeatAt).toISOString() : null,
        lastError: runtime.lastError,
        // 令牌 401 且自愈失败：面板据此说「令牌失效」，而不是笼统的「心跳中断」。
        lastAuthError: runtime.lastAuthError,
        // 自动续期用掉了几次、最近一次什么时候（自愈真的生效过就能看见）。
        renewCount: runtime.renewCount,
        renewAt: runtime.renewAt ? new Date(runtime.renewAt).toISOString() : null,
        delivered: runtime.delivered,
        // 凭据落在哪、这次是从哪读来的（排「重启后要重新配对」用）。
        credsPath: credentialsPath(),
        credsBackupPath: credentialsBackupPath(),
        credsSource,
        bootLog: join(dshHome(), 'relay-pair.log'),
      },
      sessions: list.map((agent) => ({
        id: agent.session && agent.session.id ? agent.session.id : null,
        title: null,
      })),
      pending: pendingRuns.size,
      // url 也必须是裸 origin：这份 JSON 会经隧道/网页回吐，绝不能带令牌。
      // entry 是本机中转页（/relay/api/enter）：网页从 https 跨站跳到这里，
      // 由本机自己再跳一次带令牌的地址，登录 cookie 才落得下（SameSite=Strict）。
      web: {
        origin: webOrigin(),
        url: webOrigin(),
        entry: enterPageUrl(),
        publicUrl: config.webTunnel.publicUrl || '',
        tunnel: tunnel.status(),
        gate: runtime.tunnelGate,
        // 隧道下 /api 有没有被 DSH 的 Host 栅栏挡掉（手机打不开时先看这里）。
        fence: runtime.fence,
      },
      // 本机模型目录：网页派活时按它给任务选模型/思考强度。
      models: {
        summary: catalogSummary(runtime.catalog),
        default: runtime.catalog ? runtime.catalog.default : null,
        error: runtime.catalogError,
      },
      // 云端只存最近 3 条会话；这里报的是「同步了什么」，不是「收到了什么」。
      sessionSync: {
        enabled: config.sessionSnapshot !== false,
        limit: MAX_SNAPSHOT_SESSIONS,
        count: runtime.sessionCount,
        lastAt: runtime.lastSessionSyncAt ? new Date(runtime.lastSessionSyncAt).toISOString() : null,
        lastError: runtime.sessionError,
      },
      handoffs: {
        inbound: runtime.handoffsIn,
        attached: runtime.handoffsOk,
        failed: runtime.handoffsFailed,
      },
      tasks: recentTasks(20),
    }
  }

  async function proxyToHost(tunnel) {
    const url = hostUrl(tunnel.path)
    const init = { method: tunnel.method || 'GET', headers: { Accept: 'application/json' } }
    if (init.method !== 'GET' && init.method !== 'HEAD' && tunnel.body) {
      init.headers['Content-Type'] = 'application/json'
      init.body = typeof tunnel.body === 'string' ? tunnel.body : JSON.stringify(tunnel.body)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      const text = await response.text()
      return { status: response.status, body: text, headers: { 'content-type': response.headers.get('content-type') || 'application/json' } }
    } finally {
      clearTimeout(timer)
    }
  }

  async function handleTunnel(tunnel) {
    let status = 200
    let body = ''
    let headers = {}
    try {
      // 本地短路只按 pathname 判断（query 不参与），不然 /relay/api/state?x=1
      // 会被当成「不在白名单」，白跑一趟代理。
      const parts = splitTunnelPath(tunnel.path)
      const target = parts === null ? '' : parts.pathname
      if (parts === null || !isAllowedTunnelPath(parts.pathname)) {
        status = 403
        body = JSON.stringify({ ok: false, error: { code: 'PATH_NOT_ALLOWED', message: '隧道只允许访问白名单路径' } })
      } else if (target === '/relay/api/state') {
        body = JSON.stringify(localState())
      } else if (target === '/relay/api/tasks') {
        body = JSON.stringify({ ok: true, tasks: listLocalTasks(50) })
      } else if (target === '/relay/api/sessions') {
        // 本机最近 3 条会话（与上报给中继的是同一份内容），排障/对账用。
        const sessions = await sessionReader.collect(MAX_SNAPSHOT_SESSIONS)
        body = JSON.stringify({ ok: true, limit: MAX_SNAPSHOT_SESSIONS, sessions })
      } else if (target === '/relay/api/submit') {
        let payload = {}
        try {
          payload = typeof tunnel.body === 'string' ? JSON.parse(tunnel.body) : (tunnel.body || {})
        } catch {
          payload = {}
        }
        const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
        if (!prompt) {
          status = 400
          body = JSON.stringify({ ok: false, error: { code: 'EMPTY_PROMPT', message: 'prompt 不能为空' } })
        } else {
          const result = await deliver({ id: '', title: trimText(prompt, 60), prompt })
          status = result.ok ? 200 : 409
          body = JSON.stringify(result)
        }
      } else {
        const proxied = await proxyToHost(tunnel)
        status = proxied.status
        body = proxied.body
        headers = proxied.headers
      }
    } catch (error) {
      status = 502
      body = JSON.stringify({ ok: false, error: { code: 'TUNNEL_FAILED', message: error && error.message ? error.message : String(error) } })
    }
    try {
      await call('/api/agent/tunnel/result', { tunnelId: tunnel.id, status, body, headers }, 15000)
    } catch (error) {
      logger.warn('relay-pair: tunnel result failed: ' + (error && error.message ? error.message : error))
    }
  }

  // --- 会话快照（只上报，不投递）-------------------------------------------
  //
  // 主人要的是：两端各自把本机最近的 3 条**会话**存到中继台，只存云端，不发给
  // 任何设备；等他在网页上选一条、点「送过去」，才定向投到某一台。所以这里
  // 只有上报，没有任何主动下发路径——投递全靠中继的 handoff 帧，由人触发。

  /**
   * 把本机最近 3 条会话（标题 + 最近若干条消息）上报中继。
   *
   * full=true：中继以这一份为准，不在列表里的旧快照会被删掉，所以本机永远只
   * 有最新 3 条留在云端（不是攒着长成几十条）。
   */
  async function syncSessions() {
    if (!creds || runtime.stopped || config.sessionSnapshot === false) return false
    try {
      const sessions = await sessionReader.collect(MAX_SNAPSHOT_SESSIONS)
      const data = await call('/api/agent/sessions/sync', { sessions, full: true }, 30000)
      runtime.lastSessionSyncAt = Date.now()
      runtime.sessionCount = Number(data && data.kept) || sessions.length
      runtime.sessionError = null
      return true
    } catch (error) {
      runtime.sessionError = error && error.message ? error.message : String(error)
      return false
    }
  }

  /** 一轮说完就补同步一次（4 秒防抖），别让网页上的会话标题/内容停在旧版本。 */
  function scheduleSessionSync() {
    if (config.sessionSnapshot === false || !creds || runtime.stopped) return
    if (runtime.sessionSoon !== null) clearTimeout(runtime.sessionSoon)
    runtime.sessionSoon = setTimeout(guarded('session-sync-soon', () => {
      runtime.sessionSoon = null
      syncSessions().catch(() => {})
    }), SESSION_SYNC_DEBOUNCE_MS)
  }

  /**
   * 网页上点了「送过去」的会话到这里。
   *
   * 目标设备是本机时：有这条 sessionId 就接着聊（resume 原来那条），没有就用
   * 同一个 sessionId 新建一条再接着聊——这样同一份会话送两次还是同一条，不会
   * 每送一次就多出一个「副本会话」。
   */
  async function handleHandoffs(handoffs) {
    for (const handoff of handoffs) {
      // 中继的 handoff id 是 "hd_xxxx" 字符串，别转数字（转了就是 NaN，整条被跳过）
      const id = handoff && handoff.id !== undefined && handoff.id !== null ? String(handoff.id) : ''
      if (!id) continue
      const done = handoffsDone.get(id)
      if (done) {
        // 中继没收到上次的 ack（断网/崩过），同一条又投来了：只补回执，不重复注入。
        logger.info('relay-pair: 会话 ' + id + ' 是重投，只补回执不重复注入')
        await ackHandoff(id, done.status, done.output, done.error)
        continue
      }
      runtime.handoffsIn += 1
      let outcome
      if (config.localExec === false) {
        runtime.handoffsFailed += 1
        outcome = { status: 'failed', output: '', error: '本机关闭了执行（localExec=false），会话没有接上' }
      } else {
        let applied
        try {
          applied = await sessionReader.applyHandoff(handoff, { title: handoff.title })
        } catch (error) {
          applied = { ok: false, error: error && error.message ? error.message : String(error) }
        }
        if (!applied.ok) {
          runtime.handoffsFailed += 1
          logger.warn('relay-pair: 送来的会话 ' + id + ' 接续失败: ' + applied.error)
          outcome = { status: 'failed', output: '', error: applied.error }
        } else {
          try {
            const message = createUserMessage({
              content: [{ type: 'text', text: frameHandoffMessage(handoff, deviceName) }],
              source: { kind: 'plugin:dsh-relay-pair', handoffId: id },
            })
            deliverQuietly(applied.agent, message)
            runtime.handoffsOk += 1
            if (applied.created) logger.info('relay-pair: 为送来的会话新建了 ' + applied.sessionId)
            outcome = {
              status: 'delivered',
              output: (applied.created
                ? '已新建会话 ' + applied.sessionId + ' 并接上'
                : '已接上原会话 ' + applied.sessionId) + '（只传对话，不自动运行）',
              error: '',
            }
          } catch (error) {
            runtime.handoffsFailed += 1
            const text = error && error.message ? error.message : String(error)
            logger.warn('relay-pair: 送来的会话 ' + id + ' 注入失败: ' + text)
            outcome = { status: 'failed', output: '', error: text }
          }
        }
      }
      rememberHandoff(id, outcome)
      await ackHandoff(id, outcome.status, outcome.output, outcome.error)
    }
  }

  /**
   * 只把消息摆进会话，**不唤醒 agent** —— 「传递对话」只搬记录，不替你开跑。
   *
   * agent.followup(m) 其实就是 send(m, 'next-turn', true)，会立刻起一轮；
   * 这里显式 wakeup=false：消息进收件箱，等你下次说话时才一起带上。
   */
  function deliverQuietly(agent, message) {
    if (agent && typeof agent.send === 'function') {
      agent.send(message, 'next-turn', false)
      return
    }
    if (agent && typeof agent.inject === 'function') {
      agent.inject(message)
      return
    }
    throw new Error('这个会话不支持静默投递（没有 send/inject）')
  }

  function rememberHandoff(id, outcome) {
    handoffsDone.set(id, outcome)
    while (handoffsDone.size > HANDOFFS_DONE_LIMIT) {
      const oldest = handoffsDone.keys().next().value
      handoffsDone.delete(oldest)
    }
  }

  /** 回执：不 ack 中继会一直重发（15 分钟没 ack 退回 pending，投满 3 次判失败）。 */
  async function ackHandoff(id, status, output, error) {
    try {
      await call('/api/agent/handoffs/ack', {
        id,
        status,
        ...(output ? { output } : {}),
        ...(error ? { error } : {}),
      }, 15000)
    } catch (e) {
      logger.warn('relay-pair: handoff ack 失败，中继会重发: ' + (e && e.message ? e.message : e))
    }
  }

  // --- 心跳 + 长轮询 ---------------------------------------------------------

  /**
   * 探测本机模型目录（5 分钟一次，别让 20 秒一次的心跳去问 llm 服务）。
   *
   * 目录 = 每个 provider 的模型清单 + 每个模型的思考强度选项，上报给中继后
   * 网页上的「模型 / 思考强度」下拉才有内容。拿不到 llm 服务就降级成空目录：
   * 任务照样能跑，只是不能指定模型。
   */
  async function refreshCatalog(force) {
    const fresh = runtime.catalog !== null && (Date.now() - runtime.catalogAt) < CATALOG_TTL_MS
    if (fresh && force !== true) return runtime.catalog
    const llm = pick('llm')
    if (!llm || typeof llm.listProviders !== 'function') {
      runtime.catalogError = '这个 DSH 没有提供 llm 服务，模型目录不可用'
      return runtime.catalog
    }
    const defaults = pick('agentDefaultModel')
    let selection = null
    try {
      if (defaults && typeof defaults.currentSelection === 'function') selection = defaults.currentSelection()
    } catch {
      selection = null
    }
    try {
      // 竞速：探测慢就放弃这一轮，保留旧目录。心跳绝不能等它（见 CATALOG_TIMEOUT_MS）。
      const catalog = await Promise.race([
        buildCatalog(llm, selection, logger),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), CATALOG_TIMEOUT_MS)
          // Node 的 timer 默认会吊住进程；这里不要。
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
      if (catalog === null) {
        runtime.catalogError = '模型目录探测超时（' + Math.round(CATALOG_TIMEOUT_MS / 1000) + ' 秒），先沿用上次的结果'
        logger.warn('relay-pair: ' + runtime.catalogError)
        return runtime.catalog
      }
      runtime.catalog = catalog
      runtime.catalogAt = Date.now()
      runtime.catalogError = Array.isArray(catalog.failures) && catalog.failures.length > 0
        ? catalog.failures[0].error
        : null
      return catalog
    } catch (error) {
      runtime.catalogError = error && error.message ? error.message : String(error)
      logger.warn('relay-pair: 模型目录探测失败: ' + runtime.catalogError)
      return runtime.catalog
    }
  }

  /**
   * 后台刷一次模型目录：不 await、不挡心跳。
   *
   * 以前 heartbeatOnce 第一句就是 await refreshCatalog(false)，而 buildCatalog 里
   * 每个 provider、每个模型都要问一次 llm 服务、且没有超时。llm 服务刚起来没就绪
   * 的时候它会挂上十分钟，这期间一次心跳都发不出去 —— 网页上就是「离线」，
   * 主人只能手动重新配对。目录晚一轮发出去完全没关系，心跳不能等。
   */
  function scheduleCatalogRefresh(force) {
    if (runtime.catalogInFlight) return
    const fresh = runtime.catalog !== null && (Date.now() - runtime.catalogAt) < CATALOG_TTL_MS
    if (fresh && force !== true) return
    runtime.catalogInFlight = true
    refreshCatalog(force)
      .catch((error) => {
        logger.warn('relay-pair: 模型目录后台刷新失败: ' + (error && error.message ? error.message : error))
      })
      .finally(() => {
        runtime.catalogInFlight = false
      })
  }

  /**
   * 中继网页「可信地址」白名单的落地。
   *
   * 网页上存下来的域名，光中继网页放行还不够：本机插件的中转页只认
   * webTunnel.publicUrl 那一条，DSH 自己的 /api 栅栏只认 connection.trustedHosts。
   * 所以把中继下发的名单两处都补上 —— 不然点「打开本机 DSH」必然 403。
   *
   * 为什么敢照着中继的名单放行：中继本来就是这台机器的控制面（它能派任意任务
   * 给本机执行），域名交给它判断不额外扩大风险；而改名单只有拿着 webToken
   * 在网页上能做。
   */
  function applyRelayTrustedHosts(raw) {
    if (!Array.isArray(raw)) return
    const hosts = []
    for (const entry of raw) {
      const host = normalizeHostEntry(entry)
      if (host !== '' && !hosts.includes(host)) hosts.push(host)
    }
    const changed = hosts.join(',') !== runtime.relayTrustedHosts.join(',')
    runtime.relayTrustedHosts = hosts
    const connection = ctx.get('connection')
    if (connection !== undefined && connection !== null && Array.isArray(connection.trustedHosts)) {
      const list = connection.trustedHosts
      // 先撤掉自己加过、现在名单里已经没了的那些（配置里的绝不动）。
      for (const host of [...runtime.relayTrustedInjected]) {
        if (hosts.includes(host)) continue
        const at = list.indexOf(host)
        if (at >= 0) list.splice(at, 1)
        runtime.relayTrustedInjected = runtime.relayTrustedInjected.filter((item) => item !== host)
      }
      for (const host of hosts) {
        if (list.includes(host)) continue
        list.push(host)
        if (!runtime.relayTrustedInjected.includes(host)) runtime.relayTrustedInjected.push(host)
      }
    }
    if (changed) {
      logger.info('relay-pair: 中继可信地址已更新（' + (hosts.length === 0 ? '空' : hosts.join(', ')) + '）')
    }
  }

  /**
   * 令牌被判失效（401）时用 renewSecret 换一张新的。
   *
   * 配对时中继下发过 renewSecret，插件把它存在 relay-device.json 里。
   * 中继换库/设备行被删/令牌被轮换之后，重启 DSH 最怕的就是「请重新配对」——
   * 主人多半在手机上，够不着本机面板。有了这条，掉线能自己接上。
   * 换不到（没 renewSecret、中继也不认识这台）就如实留着 401 让人知道要配。
   */
  async function renewCredentials(reason) {
    if (!creds || runtime.renewInFlight) return false
    const secret = typeof creds.renewSecret === 'string' ? creds.renewSecret.trim() : ''
    if (!creds.deviceId || secret === '') return false
    runtime.renewInFlight = true
    try {
      const data = await jsonRequest(baseUrl() + '/api/device/renew', {
        body: {
          deviceId: creds.deviceId,
          renewSecret: secret,
          name: deviceName,
          kind,
          meta: deviceMeta(),
        },
        timeoutMs: 15000,
      })
      if (!data || typeof data.deviceToken !== 'string' || data.deviceToken === '') return false
      creds = {
        ...creds,
        token: data.deviceToken,
        renewSecret: typeof data.renewSecret === 'string' ? data.renewSecret : '',
      }
      writeCredentials(creds)
      runtime.renewCount += 1
      runtime.renewAt = Date.now()
      runtime.lastAuthError = false
      runtime.lastError = null
      runtime.heartbeatLogged = false
      logger.info('relay-pair: 设备令牌已自动续期（' + reason + '），不必重新配对')
      noteBoot('renew', { ok: true, deviceId: creds.deviceId, relayUrl: baseUrl(), reason })
      return true
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      logger.warn('relay-pair: 自动续期失败: ' + message)
      noteBoot('renew', { ok: false, deviceId: creds.deviceId, relayUrl: baseUrl(), reason, error: message })
      return false
    } finally {
      runtime.renewInFlight = false
    }
  }

  /**
   * depth：续期成功后立刻补发一拍（最多补一次）。
   * 不补的话要等下一个心跳周期（默认 20 秒）才恢复，面板上先红一下再绿，看着像还是没连上。
   */
  async function heartbeatOnce(depth = 0) {
    if (!creds || runtime.stopped) return
    try {
      const beat = await call('/api/agent/heartbeat', { meta: deviceMeta() }, 15000)
      // 心跳回包带中继网页上存的可信地址：这里同步到放行名单。
      applyRelayTrustedHosts(beat && beat.trustedHosts)
      // 目录确实发出去了才记版本：发失败下一轮还会再带一次。
      if (runtime.catalogPending) {
        runtime.catalogSentAt = runtime.catalogPending
        runtime.catalogPending = ''
      }
      runtime.lastHeartbeatAt = Date.now()
      runtime.lastError = null
      runtime.lastAuthError = false
      if (!runtime.heartbeatLogged) {
        runtime.heartbeatLogged = true
        noteBoot('heartbeat', { ok: true, deviceId: creds ? creds.deviceId : null, relayUrl: baseUrl() })
      }
      // 心跳通了才去后台刷目录：下一轮心跳自然带上新目录（见 scheduleCatalogRefresh）。
      scheduleCatalogRefresh(false)
      // 中继通了：顺手复核一次隧道门禁（可能刚配对/刚上线，隧道该起来了）。
      tunnelTick()
      // 心跳通了说明中继可达：顺手把攒着的任务状态补发出去。
      if (runtime.outbox.length > 0) {
        flushOutbox().catch((error) => {
          logger.warn('relay-pair: 发件箱重放失败: ' + (error && error.message ? error.message : error))
        })
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      // 401 = 中继那边没有这个令牌（设备行被删、换了库）。先自己续一次；
      // 续不上才提示重新配对 —— 那才是真的需要人动手的情况。
      const status = error && typeof error.status === 'number' ? error.status : 0
      if (status === 401) {
        runtime.lastAuthError = true
        if (await renewCredentials('heartbeat 401')) {
          // 已经拿到新令牌：这一轮就当没失败，立刻补发一拍（只补一次，防死循环）。
          scheduleCatalogRefresh(false)
          if (depth < 1) await heartbeatOnce(depth + 1)
          return
        }
        runtime.lastError = '设备令牌已失效，自动续期也没成功（请重新配对）：' + message
      } else {
        runtime.lastError = message
      }
      if (!runtime.heartbeatLogged) {
        runtime.heartbeatLogged = true
        noteBoot('heartbeat', {
          ok: false,
          status: error && typeof error.status === 'number' ? error.status : 0,
          error: message,
          deviceId: creds ? creds.deviceId : null,
          relayUrl: baseUrl(),
        })
      }
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal && signal.aborted) {
        resolve()
        return
      }
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', done)
        resolve()
      }
      if (signal) signal.addEventListener('abort', done, { once: true })
    })
  }

  async function pollLoop(signal) {
    while (!runtime.stopped && creds && !signal.aborted) {
      try {
        const data = await call('/api/agent/poll', {}, (config.pollSeconds + 20) * 1000, signal)
        runtime.lastHeartbeatAt = Date.now()
        runtime.lastPollAt = Date.now()
        runtime.lastError = null
        if (Array.isArray(data.peers)) runtime.peers = data.peers
        tunnelTick()
        // 成功一轮就把退避归零，别让上一次断网拖慢后面的节奏。
        runtime.retryAttempt = 0
        for (const task of data.tasks || []) {
          const result = await deliver(task)
          if (result.ok) {
            // 把会话 id 一起报上去，网页才能「接着做」这条任务。
            reportTask(task.id, 'running', undefined, '', result.sessionId)
          } else {
            reportTask(task.id, 'blocked', undefined, result.error)
            logger.warn('relay-pair: task ' + task.id + ' blocked: ' + result.error)
          }
        }
        // 「送过去」的会话：一条一条接（接续要 resume/新建，不能并发抢同一个会话）。
        if (Array.isArray(data.handoffs) && data.handoffs.length > 0) {
          handleHandoffs(data.handoffs).catch((error) => {
            logger.warn('relay-pair: 会话接续失败: ' + (error && error.message ? error.message : error))
          })
        }
        for (const tunnel of data.tunnels || []) {
          handleTunnel(tunnel).catch((error) => {
            logger.warn('relay-pair: tunnel failed: ' + (error && error.message ? error.message : error))
          })
        }
      } catch (error) {
        if (signal.aborted || runtime.stopped) break
        const message = error && error.message ? error.message : String(error)
        // 长轮询也会吃到 401（令牌被轮换/换了库）：跟心跳一样先自己续期再重来，
        // 别让轮询就此退避、任务一直挂着没人领。
        if (error && error.status === 401) {
          runtime.lastAuthError = true
          if (await renewCredentials('poll 401')) {
            runtime.retryAttempt = 0
            continue
          }
        }
        runtime.lastError = message
        // 断网时不能按固定 5 秒空转：指数退避 + 抖动，封顶 30 秒。
        const delay = nextRetryDelay(runtime.retryAttempt)
        runtime.retryAttempt += 1
        // 退避的空当顺手把发件箱再试一次，省得等下一个心跳。
        if (runtime.outbox.length > 0) scheduleOutboxFlush()
        await sleep(delay, signal)
      }
    }
  }

  async function startLoops() {
    if (!creds) return false
    // 先把旧循环彻底停掉：不 abort、不 await 就起新循环，重配对后会有两个 poll
    // 同时领任务，任务被重复执行。
    await stopLoops()
    runtime.stopped = false
    runtime.retryAttempt = 0
    runtime.startedAt = Date.now()
    const controller = new AbortController()
    runtime.pollAbort = controller
    runtime.heartbeatTimer = setInterval(guarded('heartbeat', () => { heartbeatOnce() }), Math.max(5, config.heartbeatSeconds) * 1000)
    heartbeatOnce()
    // 会话快照：只上报、不投递。主人不点「送过去」，它就只是云端的一份清单。
    if (config.sessionSnapshot !== false) {
      runtime.sessionTimer = setInterval(guarded('session-sync', () => { syncSessions() }), SESSION_SYNC_SECONDS * 1000)
      syncSessions().catch((error) => {
        logger.warn('relay-pair: 首次会话同步失败: ' + (error && error.message ? error.message : error))
      })
    }
    // 隧道门禁：10 秒复核一次，比心跳快，条件一塌就能在宽限期内反应。
    runtime.tunnelTimer = setInterval(guarded('tunnel', () => { tunnelTick() }), TUNNEL_TICK_SECONDS * 1000)
    tunnelTick()
    const task = pollLoop(controller.signal)
    runtime.pollTask = task
    task.catch((error) => {
      logger.warn('relay-pair: poll loop exited: ' + (error && error.message ? error.message : error))
    }).finally(() => {
      if (runtime.pollTask === task) runtime.pollTask = null
    })
    return true
  }

  /**
   * 停心跳与轮询。dropQueue=true 是真停（关插件）：排队中的单子再没有 turn/end
   * 来触发，清掉并如实报到中继，别让它一直挂号。startLoops 内部重启传 false。
   */
  async function stopLoops(dropQueue = false) {
    runtime.stopped = true
    if (runtime.heartbeatTimer !== null) {
      clearInterval(runtime.heartbeatTimer)
      runtime.heartbeatTimer = null
    }
    if (runtime.outboxTimer !== null) {
      clearTimeout(runtime.outboxTimer)
      runtime.outboxTimer = null
    }
    if (runtime.sessionTimer !== null) {
      clearInterval(runtime.sessionTimer)
      runtime.sessionTimer = null
    }
    if (runtime.sessionSoon !== null) {
      clearTimeout(runtime.sessionSoon)
      runtime.sessionSoon = null
    }
    if (runtime.tunnelTimer !== null) {
      clearInterval(runtime.tunnelTimer)
      runtime.tunnelTimer = null
    }
    // 停循环就等于是「不开了」：走正常宽限流程，不在这里硬杀。
    runtime.tunnelGate = 'stopped'
    tunnel.update({ allowed: false, reason: 'stopped', localOrigin: webOrigin() })
    const controller = runtime.pollAbort
    runtime.pollAbort = null
    if (controller) controller.abort()
    const task = runtime.pollTask
    runtime.pollTask = null
    if (task) {
      try {
        await task
      } catch {
        // 循环自己会吞错；这里只是等它真的退出。
      }
    }
    if (dropQueue) {
      const dropped = failQueue('插件已停止，排队任务被取消')
      if (dropped > 0) logger.warn('relay-pair: 停止时取消了 ' + dropped + ' 个排队任务')
    }
  }

  // 关插件时把定时器和轮询一起收掉。
  ctx.effect(() => () => {
    stopLoops(true).catch(() => {})
  })

  // --- 配对（工具与设置页共用）-----------------------------------------------

  /**
   * 用一次性配对码换设备令牌，落盘并启动心跳/轮询。
   * 设置页（客户端 UI）和 relay_pair 工具走的是同一个函数，行为不会漂。
   */
  async function pairDevice(rawCode, rawRelayUrl, rawName) {
    const relayUrl = normalizeRelayUrl(rawRelayUrl || config.relayUrl)
    if (!relayUrl) {
      throw new Error('缺少中继地址：在设置里填 relayUrl，例如 https://relay.example.com')
    }
    const code = String(rawCode || '').trim()
    if (!code) throw new Error('配对码不能为空')
    const name = (rawName || '').trim() || deviceName
    const data = await jsonRequest(relayUrl + '/api/device/pair', {
      body: {
        code,
        name,
        kind,
        meta: deviceMeta(),
      },
      timeoutMs: 15000,
    })
    creds = {
      relayUrl,
      deviceId: data.deviceId,
      token: data.deviceToken,
      // 自愈券：以后令牌失效可以换新的，不用再找主人要配对码。
      renewSecret: typeof data.renewSecret === 'string' ? data.renewSecret : '',
      name,
      kind,
      pairedAt: new Date().toISOString(),
    }
    writeCredentials(creds)
    credsSource = 'pair'
    runtime.lastAuthError = false
    // 新配对可能是另一个中继库（handoff id 会从 1 重来），旧去重表作废。
    handoffsDone.clear()
    await startLoops()
    return creds
  }

  async function unpairDevice() {
    const cleared = clearCredentials()
    creds = null
    credsSource = 'none'
    handoffsDone.clear()
    // stopLoops 会把队列里的单子清掉并报到中继（不然它们永远挂号）。
    await stopLoops(true)
    return cleared
  }

  // --- 工具 ------------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'relay_pair',
    description: 'Pair this DSH device with the DSH relay (中继台): exchange a one-time pairing code from the web page for a device token and start heartbeat + task polling. Run once per machine; the token is stored in $DSH_HOME/relay-device.json.',
    parameters: {
      code: { type: 'string', required: true, description: 'One-time pairing code shown by the relay web page, e.g. "WFQT-GRKK-L3LK".' },
      relayUrl: { type: 'string', description: 'Relay base URL, e.g. https://relay.example.com. Defaults to the config relayUrl.' },
      name: { type: 'string', description: 'Device name shown on the relay. Defaults to DSH@<hostname>.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const paired = await pairDevice(args.code, args.relayUrl, args.name)
      return [
        '配对成功。',
        '  中继：' + paired.relayUrl,
        '  设备：' + paired.name + '（' + paired.kind + '）',
        '  设备 ID：' + paired.deviceId,
        '凭据已存到 $DSH_HOME/relay-device.json；心跳与长轮询已启动。',
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'relay_status',
    description: 'Show the relay connection status of this device: paired or not, relay URL, heartbeat age, pending task count, and the local task log tail.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      // 本地流水跟配对无关：没配对也告诉用户「本机跑过什么」。
      const local = recentTasks(5)
      const localLines = [
        '本机最近任务（本地流水，未同步）' + (local.length === 0 ? '：无' : '：'),
        ...local.map((t) => '  · [' + (t.status || '?') + '] ' + (t.title || t.id || '')),
      ]
      // 网页「打开本机 DSH」用的就是这个地址；把端口和有没有令牌一起报出来，
      // 排查「点了打不开」时一眼就能看出是端口过期还是缺令牌。
      const link = webLinkUrl()
      const webLine = link
        ? '本机 Web：' + link.replace(/([?&]token=)[^&]+/, '$1***')
        : '本机 Web：未知'
      const entryLine = webOrigin() ? '本机中转页：' + enterPageUrl() : '本机中转页：未知'
      // 隧道开着不等于手机能用：DSH 的 /api 有 Host 信任栅栏，没配 trustedHosts 时
      // 每个请求都 403（手机上就是「无法打开文件夹」+「重新连接中」）。把探测结果直接报出来。
      const tun = tunnel.status()
      const tunnelLines = tun.enabled
        ? [
            '隧道：' + tun.state + (tun.publicUrl ? ' · ' + tun.publicUrl : '') +
              (tun.reason && tun.reason !== 'ok' ? ' · ' + tun.reason : ''),
            ...(runtime.fence === null
              ? []
              : ['隧道 /api：' + (runtime.fence.ok === true
                  ? '正常（DSH 接受 ' + runtime.fence.host + '）'
                  : '⚠ ' + (runtime.fence.hint || '探测失败'))]),
          ]
        : []
      if (!creds) {
        return [
          '未配对。先在网页生成配对码，然后运行 relay_pair（code="XXXX-XXXX-XXXX"）。',
          webLine,
          entryLine,
          '',
          ...localLines,
        ].join('\n')
      }
      let pending = null
      let reachable = false
      try {
        const beat = await call('/api/agent/heartbeat', {}, 10000)
        pending = beat.pending
        reachable = true
        runtime.lastHeartbeatAt = Date.now()
      } catch (error) {
        runtime.lastError = error && error.message ? error.message : String(error)
      }
      const age = runtime.lastHeartbeatAt ? Math.round((Date.now() - runtime.lastHeartbeatAt) / 1000) + ' 秒前' : '从未'
      return [
        '中继：' + baseUrl() + (reachable ? '（可达）' : '（不可达：' + runtime.lastError + '）'),
        '设备：' + (creds.name || deviceName) + '（' + kind + '） · ' + creds.deviceId,
        '心跳：' + age + ' · 轮询运行中：' + (runtime.stopped ? '否' : '是') + ' · 已投递 ' + runtime.delivered + ' 个任务',
        '模型：' + catalogSummary(runtime.catalog) + (runtime.catalogError ? '（' + runtime.catalogError + '）' : ''),
        '中继上排队任务：' + (pending === null ? '—' : pending),
        webLine,
        entryLine,
        ...tunnelLines,
        '',
        ...localLines,
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'relay_task_add',
    description: 'Save a task to the relay (it is stored, NOT executed): the user reviews it in the relay web UI and dispatches it manually. target is only a hint: local=this machine, dsha=phone, cloud=storage only, auto.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What to do.' },
      title: { type: 'string', description: 'Short title shown in the task list.' },
      target: { type: 'string', description: 'local | cloud | dsha | auto (default auto).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const prompt = String(args.prompt || '').trim()
      if (!prompt) throw new Error('prompt 不能为空')
      const target = ['local', 'cloud', 'dsha', 'auto'].includes(args.target) ? args.target : 'auto'
      if (!creds) {
        const result = await deliver({ id: '', title: String(args.title || '').trim() || trimText(prompt, 60), prompt })
        if (!result.ok) throw new Error(result.error)
        return '未配对，直接投给本机会话（不经过中继）。会话：' + (result.sessionId || '当前会话')
      }
      const data = await call('/api/agent/tasks', {
        title: String(args.title || '').trim(),
        prompt,
        target,
      }, 20000)
      appendLocalTask({
        id: data.taskId,
        title: String(args.title || '').trim() || trimText(prompt, 60),
        prompt: trimText(prompt, 8000),
        target: data.target || target,
        origin: 'local',
        status: 'stored',
        synced: true,
        createdAt: new Date().toISOString(),
      })
      return '已存入中继：' + data.taskId + '（目标 ' + (data.target || target) + '，等待你在中继台手动派发）。用 relay_tasks 查看。'
    },
  }))

  ctx.tools.register(defineTool({
    name: 'relay_tasks',
    description: 'List tasks known to the relay (title, target, status, short result) so the user can see what ran on the cloud or the other device.',
    parameters: {
      limit: { type: 'number', description: 'How many tasks to show (default 20).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      if (!creds) throw new Error('还没配对：先运行 relay_pair')
      const data = await call('/api/agent/state', { limit: Number(args.limit) || 20 }, 20000)
      const tasks = data.tasks || []
      if (tasks.length === 0) return '中继上还没有任务。'
      const lines = tasks.map((t) => {
        const head = '[' + t.status + '] ' + (t.title || t.id) + ' · ' + t.target + ' · ' + (t.createdAt || '')
        const detail = t.status === 'failed' || t.status === 'blocked' ? t.error : t.output
        return head + (detail ? '\n    ' + trimText(detail.replace(/\s+/g, ' '), 160) : '')
      })
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'relay_sync_task',
    description: 'Push local task history to the relay (only what the user asks to sync; nothing is uploaded by default). Deduplicated by task id on the relay.',
    parameters: {
      limit: { type: 'number', description: 'How many recent local records to push (default 20).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      if (!creds) throw new Error('还没配对：先运行 relay_pair')
      const records = listLocalTasks(Number(args.limit) || 20).filter((t) => t && t.id)
      if (records.length === 0) return '本地还没有可同步的任务。'
      const data = await call('/api/agent/sync', { records }, 20000)
      return '已同步：新导入 ' + (data.imported || 0) + ' 条，跳过重复 ' + (data.skipped || 0) + ' 条。'
    },
  }))

  ctx.tools.register(defineTool({
    name: 'relay_unpair',
    description: 'Forget this device\'s relay pairing: clear the stored token and stop heartbeat/polling. Use when the device is retired or the relay token leaked.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const cleared = await unpairDevice()
      return cleared ? '已断开配对并清除本地凭据。' : '本来就没有配对凭据。'
    },
  }))

  // --- 给网页隧道用的本机 HTTP 路由 ------------------------------------------
  //
  // 网页「读取本机状态」按钮 → 中继 tunnel 帧 → 本机 /relay/api/state。
  // 必须和 /schedule/api 一样做信任围栏：只认 loopback / trustedHosts，拒绝跨站。

  ctx.inject(['webServer'], (webCtx) => {
    // connection 服务才是真正给 /api 网关看门的那位，它的 trustedHosts 里除了 CLI
    // --trusted-host，还有 connection 插件自己配置里声明的公网域名（桌面 profile 的
    // cordis.patch.yml）。只读 webStartup/webRuntime 的话，经反代/隧道打开网页时
    // 这里一律 403，而界面其余部分正常 —— 必须合并进来。
    const trustedHosts = () => {
      const hosts = []
      const startup = ctx.get('webStartup')
      if (startup !== undefined && startup !== null) hosts.push(...(startup.trustedHosts ?? []))
      const runtimeSvc = ctx.get('webRuntime')
      if (runtimeSvc !== undefined && runtimeSvc !== null) hosts.push(...(runtimeSvc.trustedHosts ?? []))
      const connection = ctx.get('connection')
      if (connection !== undefined && connection !== null && Array.isArray(connection.trustedHosts)) {
        hosts.push(...connection.trustedHosts)
      }
      return [...new Set(hosts)]
    }
    const fence = (req) => isTrustedApiRequest(req, trustedHosts())

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/relay/api',
      handler: async (req, res) => {
        try {
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          // 中转页必须在 fence 之前：它是被中继网页（另一个 origin）跨站导航过来的，
          // 浏览器会带 sec-fetch-site: cross-site，走 fence 只会 403。所以它只要求
          // Host 是本机回环（外面的人打不到），页面本身也不吐任何机密。
          if (pathname === '/relay/api/enter') {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'GET only' } })
              return
            }
            // 本机回环、本机配的那条隧道公网主机，或者中继网页「可信地址」里存的域名
            // （Host 由 nginx 原样透传；后者由心跳下发，见 applyRelayTrustedHosts）。
            if (!isLoopbackRequest(req)
              && !isTunnelEntryRequest(req, config.webTunnel.publicUrl)
              && !isRelayTrustedEntry(req, runtime.relayTrustedHosts)) {
              writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'entry page is loopback or tunnel only' } })
              return
            }
            writeEnterPage(res, webLinkUrl(), webOrigin())
            return
          }
          if (!fence(req)) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          if (pathname === '/relay/api/state' || pathname === '/relay/api/status') {
            writeJson(res, 200, localState())
            return
          }
          if (pathname === '/relay/api/tasks') {
            writeJson(res, 200, { ok: true, tasks: listLocalTasks(50) })
            return
          }
          if (pathname === '/relay/api/sessions') {
            const sessions = await sessionReader.collect(MAX_SNAPSHOT_SESSIONS)
            writeJson(res, 200, { ok: true, limit: MAX_SNAPSHOT_SESSIONS, sessions })
            return
          }
          if (pathname === '/relay/api/submit') {
            if (req.method !== 'POST') {
              writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'POST only' } })
              return
            }
            const payload = await readJsonBody(req)
            const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
            if (!prompt) {
              writeJson(res, 400, { ok: false, error: { code: 'EMPTY_PROMPT', message: 'prompt 不能为空' } })
              return
            }
            const result = await deliver({ id: '', title: trimText(prompt, 60), prompt })
            writeJson(res, result.ok ? 200 : 409, result)
            return
          }
          if (pathname === '/relay/api/pair') {
            // 设置页的配对表单打这里：填配对码 → 换令牌 → 立刻开始心跳。
            if (req.method !== 'POST') {
              writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'POST only' } })
              return
            }
            const payload = await readJsonBody(req)
            try {
              const paired = await pairDevice(payload.code, payload.relayUrl, payload.name)
              writeJson(res, 200, {
                ok: true,
                relayUrl: paired.relayUrl,
                device: { id: paired.deviceId, name: paired.name, kind: paired.kind },
              })
            } catch (error) {
              writeJson(res, 400, {
                ok: false,
                error: { code: 'PAIR_FAILED', message: error && error.message ? error.message : String(error) },
              })
            }
            return
          }
          if (pathname === '/relay/api/unpair') {
            // 解绑是破坏性写操作：只认 POST，GET 能解绑等于给了任何页面一个坑。
            if (req.method !== 'POST') {
              writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'POST only' } })
              return
            }
            const cleared = await unpairDevice()
            writeJson(res, 200, { ok: true, cleared })
            return
          }
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown relay API method' } })
        } catch (error) {
          try {
            if (!res.headersSent) writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: error && error.message ? error.message : String(error) } })
            else res.end()
          } catch { /* socket 已经断了 */ }
        }
      },
    }), 'dsh-relay-pair: /relay/api routes')

    logger.info('relay-pair: HTTP API mounted at /relay/api')
  })

  // --- 自动启动 --------------------------------------------------------------

  if (config.autostart && creds && creds.token) {
    ctx.effect(() => {
      startLoops().catch((error) => {
        const message = error && error.message ? error.message : String(error)
        logger.warn('relay-pair: autostart failed: ' + message)
        // 启动失败必须落盘：宿主日志看不到的时候，这里是唯一能对账的地方
        // （0.4.1 之前就是这么被 pick() 的裸属性访问静默吞掉的）。
        noteBoot('autostart-failed', { error: message, deviceId: creds ? creds.deviceId : null })
      })
      return () => {
        stopLoops(true).catch(() => {})
      }
    })
  } else if (config.autostart) {
    // 没配对也盯着凭据文件：DSH 先起来、凭据晚到（或刚被备份恢复、被手拷回来）时
    // 自动接上，不用再重启一次 DSH。30 秒看一眼，代价就是一个 existsSync。
    ctx.effect(() => {
      let timer = setInterval(() => {
        const found = readCredentialsWithRecovery()
        if (!found.creds || !found.creds.token) return
        clearInterval(timer)
        creds = found.creds
        credsSource = found.source
        runtime.heartbeatLogged = false
        noteBoot('recovered', { deviceId: creds.deviceId, source: found.source, restored: found.restored })
        logger.info('relay-pair: 发现凭据（' + found.source + '），开始心跳')
        startLoops().catch((error) => {
          const message = error && error.message ? error.message : String(error)
          logger.warn('relay-pair: 发现凭据后启动失败: ' + message)
          noteBoot('autostart-failed', { error: message, deviceId: creds ? creds.deviceId : null, after: 'recovered' })
        })
      }, 30000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    })
  }

  // 每次加载都留一行：下次重启对账时，先看这里有没有这一行（没有 = 插件没加载）。
  noteBoot('apply', {
    creds: Boolean(creds && creds.token),
    deviceId: creds ? creds.deviceId : null,
    source: credsSource,
    restored: loaded.restored,
    autostart: Boolean(config.autostart),
    home: dshHome(),
    credsPath: credentialsPath(),
    credsBackupPath: credentialsBackupPath(),
  })

  logger.info('relay-pair: ' + (creds ? 'paired as ' + (creds.name || deviceName) + ' → ' + creds.relayUrl : 'not paired yet'))
}

// --- HTTP 小工具（与 dsh-schedule 同一套围栏代码） ---------------------------

function headerValue(headers, name) {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL('http://' + authority)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostnameValue) {
  if (hostnameValue === 'localhost' || hostnameValue === '[::1]') return true
  const parts = hostnameValue.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL('https://' + entry).port
  return port === '' ? entryUrl.hostname : entryUrl.hostname + ':' + port
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedApiRequest(req, trustedHosts) {
  const host = headerValue(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts ?? [])) return false
  if (headerValue(req.headers, 'sec-fetch-site') === 'cross-site') return false
  // 带了 Origin 就必须和 Host 同源（协议一致）：跨站页面就算能伪造 Host，
  // 也没法把 Origin 一起改掉，这样写操作才不会被别处页面借用浏览器的身份触发。
  const origin = headerValue(req.headers, 'origin')
  if (origin !== undefined) {
    if (!isSameOrigin(origin, host)) return false
  }
  return true
}

/**
 * Origin 是不是这个 Host 的同源来源。
 * 比 host（含端口）就够了：端口不同就是别的来源；协议只放行 http/https
 * （本机 Web 可能被反代成 https，而 Host 头里看不到协议，不好硬比）。
 */
function isSameOrigin(origin, host) {
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.origin === 'null') return false
  if (parsed.host !== host) return false
  const scheme = parsed.protocol.replace(/:$/, '')
  return scheme === 'http' || scheme === 'https'
}

/**
 * 中转页专用的宽松判据：只看 Host 是不是本机回环。
 * 不看 sec-fetch-site —— 它本来就是跨站跳过来的。
 */
function isLoopbackRequest(req) {
  const host = headerValue(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  return isLoopbackHostname(hostUrl.hostname)
}

/** 中转页在隧道下的放行判据：Host 必须是配置里那条公网主机名。 */
function isTunnelEntryRequest(req, publicUrl) {
  const expected = publicHostOf(publicUrl)
  if (expected === '') return false
  const host = headerValue(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  return hostUrl.hostname.toLowerCase() === expected
}

/** 中转页放行判据之二：Host 在中继网页「可信地址」白名单里。 */
function isRelayTrustedEntry(req, hosts) {
  const host = headerValue(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  return (hosts ?? []).includes(hostUrl.hostname.toLowerCase())
}

/**
 * 「可信地址」条目规整：去掉协议/端口/路径，只留小写主机名。
 * 只认域名或 IPv4（不接受通配符、单个下划线主机名之外的怪东西），不像就返回 ''。
 */
function normalizeHostEntry(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return ''
  const stripped = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '')
  const host = stripped.replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase()
  if (host === '' || host.length > 253) return ''
  const labels = host.split('.')
  if (labels.some((label) => label === '' || label.length > 63
    || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))) return ''
  return host
}

function publicHostOf(publicUrl) {
  const text = typeof publicUrl === 'string' ? publicUrl : ''
  if (text === '') return ''
  try {
    return new URL(text).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 塞进 <script> 的字符串字面量：转成 JSON 再把 < 变义，免得 </script> 提前截断。 */
function jsLiteral(value) {
  return JSON.stringify(String(value)).replace(/</g, '\\u003c')
}

/**
 * 中转页：中继网页把浏览器送到这里，页面自己在同一个 origin 里 replace 到
 * 带令牌的地址。跨站直接跳会让 DSH 的 SameSite=Strict cookie 不落地 → 401。
 */
function writeEnterPage(res, target, origin) {
  const absolute = typeof target === 'string' && target !== '' ? target : origin
  // 必须用相对路径跳：走隧道时浏览器在 https://<公网主机>，页面里再写
  // http://127.0.0.1:<端口> 会跳到「浏览器所在的那台机器」——手机上是手机自己，
  // 永远打不开。只留 path + query，cookie 就落在当前这个 origin 上。
  let href = absolute
  try {
    const url = new URL(absolute)
    href = '/' + (url.search === '' ? '' : url.search)
  } catch {
    // 解析不了就用原样（本机回环下也是对的）。
  }
  const html = [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>正在打开本机 DSH…</title>',
    '<style>',
    'html,body{height:100%;margin:0}',
    'body{display:flex;align-items:center;justify-content:center;background:#0b1015;color:#cfd8e3;',
    'font:15px/1.7 system-ui,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}',
    'main{max-width:34rem;padding:2rem;text-align:center}',
    'h1{font-size:1.05rem;font-weight:600;margin:0 0 .6rem}',
    'p{margin:.4rem 0;color:#8fa0b3}',
    'a{color:#63b3ff;word-break:break-all}',
    '.spin{width:1.2rem;height:1.2rem;margin:0 auto 1rem;border:2px solid #2a3946;',
    'border-top-color:#63b3ff;border-radius:50%;animation:r .8s linear infinite}',
    '@keyframes r{to{transform:rotate(360deg)}}',
    '@media (prefers-reduced-motion:reduce){.spin{animation:none}}',
    '</style></head><body><main>',
    '<div class="spin" aria-hidden="true"></div>',
    '<h1>正在打开本机 DSH…</h1>',
    '<p>这一步由本机插件中转，只为了在本机域名下换发登录 cookie。</p>',
    '<p><a id="go" href="' + escapeHtml(href) + '">没自动跳转？点这里</a></p>',
    '</main>',
    '<script>location.replace(' + jsLiteral(href) + ')</script>',
    '</body></html>',
  ].join('\n')
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(html))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.end(html)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(text))
  res.end(text)
}
