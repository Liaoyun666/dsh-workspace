// dsha-relay-pair / index.js
//
// 手机端（DSHA）的中继配对插件。和桌面端 dsh-relay-pair 协议一致，但有四件事
// 只有手机需要操心：
//   1. 通知 —— 任务来了要弹到通知栏（App 在后台也看得见），走 3090 设备桥。
//   2. 落盘 —— 报告「跑完了」那一刻可能正好断网/进程被杀，所以先写发件箱再发，
//               发成功才删；下次启动重放。
//   3. 复原 —— 上次被系统杀掉时正在跑的任务，启动第一件事就是把它标成 failed，
//               不然中继那边永远挂着 running。
//   4. 省电 —— 空转久了把长轮询间隔拉长，有活立刻回到正常节奏。
//
// 工具：relay_pair / relay_status / relay_task_add / relay_tasks /
//       relay_sync_task / relay_unpair
//       （与桌面端同名同参，模型不用区分两头）。

import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import {
  appendLocalTask,
  appendOutbox,
  clearCredentials,
  countOutbox,
  defaultDeviceName,
  detectDeviceKind,
  formatAge,
  frameSubmitMessage,
  frameTaskMessage,
  isAllowedTunnelPath,
  jsonRequest,
  latestStatusByTask,
  listLocalTasks,
  listOutboxOldest,
  messageText,
  nextPollDelay,
  normalizeConfig,
  normalizeRelayUrl,
  pruneOutbox,
  queueOutbox,
  readCredentials,
  trimText,
  writeCredentials,
} from './protocol.js'
import { createBridge, notify, vibrate } from './bridge.js'
import { MAX_SNAPSHOT_SESSIONS, createSessionReader, frameHandoffMessage } from './sessions.js'
import { CATALOG_TTL_MS, applyChoice, buildCatalog, catalogSummary, normalizeChoice } from './models.js'

export const name = 'dsha-relay-pair'

export const inject = ['agents', 'tools']

const VERSION = '0.3.1'
const EXCERPT_LIMIT = 1200
// 发件箱重放单轮上限（按时间正序取最老的这一批，不按最新的）。
const FLUSH_BATCH = 200
// 会话快照：定时把本机最近几条会话同步到云端（只入库，不会发给任何设备）。
const SESSION_SYNC_SECONDS = 90
// 一轮说完就补同步一次的防抖窗口。
const SESSION_SYNC_DEBOUNCE_MS = 4000

/** 本地 shim：等价于 @deepseek-ai/dsh-tools 的 defineTool（紧凑参数表 → JSON Schema）。 */
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

/** 本地 shim：等价于 @deepseek-ai/dsh-llm 的 createUserMessage。 */
function createUserMessage(input) {
  return Object.freeze({ ...input, id: randomUUID(), role: 'user' })
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger ?? console
  const kind = detectDeviceKind(config.deviceKind)
  const deviceName = config.deviceName || defaultDeviceName(kind)
  const bridge = createBridge({ baseUrl: config.bridgeUrl, tokenPath: config.bridgeTokenPath })

  /** 当前凭据（可能来自上一次配对）；pairDevice 会覆盖它。 */
  let creds = readCredentials()

  const runtime = {
    stopped: true,
    heartbeatTimer: null,
    flushTimer: null,
    flushing: false,
    // 启动复原只做一次：重复配对/重连会把本进程正在跑的任务误判成失败。
    recoveredInterrupted: false,
    startedAt: 0,
    lastHeartbeatAt: 0,
    lastPollAt: 0,
    lastError: null,
    delivered: 0,
    idleSince: 0,
    // 同会话排队：一条会话一轮只跑一单，多出来的先排这里（任务隔离后每个会话各排各的）。
    queued: [],
    outboxPending: 0,
    notified: 0,
    // 模型目录：心跳上报给中继，网页派活时按它选模型/思考强度。
    catalog: null,
    catalogAt: 0,
    catalogError: null,
    catalogSentAt: '',
    catalogPending: '',
    // 会话快照同步（只上报云端，不投递）
    sessionTimer: null,
    sessionSoon: null,
    lastSessionSyncAt: 0,
    sessionCount: 0,
    sessionError: null,
    // 「送过去」的会话：收到几条、接上几条、失败几条
    handoffsIn: 0,
    handoffsOk: 0,
    handoffsFailed: 0,
  }

  /** 取服务：ctx.get 优先（cordis 标准），老宿主退回 ctx[name]。 */
  function pick(name) {
    try {
      const value = typeof ctx.get === 'function' ? ctx.get(name) : undefined
      if (value) return value
    } catch {
      /* 服务没注册时 ctx.get 可能抛，当作没有 */
    }
    return ctx[name]
  }

  const sessionReader = createSessionReader(ctx, logger)

  /** 已投递但还没跑完的轮次：messageId → { taskId, sessionId, session, excerpt } */
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
        logger.warn('dsha-relay-pair: ' + label + ' failed: ' + (error && error.message ? error.message : error))
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

  function baseUrl() {
    return (creds && creds.relayUrl) || config.relayUrl
  }

  function call(path, body, timeoutMs) {
    if (!creds || !creds.token) throw new Error('还没配对：先运行 relay_pair 填配对码')
    return jsonRequest(baseUrl() + path, { token: creds.token, body, timeoutMs })
  }

  // --- 拉起 DSHA App（网页「打开手机 DSHA」用）--------------------------------

  /**
   * 问设备桥要已安装 App 列表，挑一个最像 DSHA 的包名。
   *
   * 以前只认配置里的 appPackage，主人没填就永远 409 NO_APP_TARGET —— 网页上
   * 「打开手机 DSHA」等于摆设。设备桥本来就能列 App（/app/apps），自己找就行。
   */
  async function findAppPackage() {
    const listed = await bridge.call('/app/apps', { q: 'dsha', limit: 50 })
    if (!listed.ok) return ''
    const lines = String(listed.text || '').split('\n')
    const candidates = []
    for (const line of lines) {
      const match = /^([A-Za-z0-9_.]+)\s*=\s*(.*)$/.exec(line.trim())
      if (!match) continue
      candidates.push({ package: match[1], name: match[2] })
    }
    // 先认包名像 DSHA 的，再看应用名里带 DSHA / 中继的。
    const byPackage = candidates.find((app) => /dsha|deepseek|dsh\.|relay/i.test(app.package))
    if (byPackage) return byPackage.package
    const byName = candidates.find((app) => /dsha|deepseek|中继|harness/i.test(app.name))
    return byName ? byName.package : ''
  }

  /**
   * 把 DSHA App 拉到前台。
   *
   * 网页在中继那边，没办法直接拉起安卓 App，只能走这条链路：
   *   网页 → 中继隧道 → 手机插件 → 3090 设备桥 /app/launch（或 /app/open）。
   *
   * 顺序：配置的 appPackage → 配置的 appUrl（http/https 深链）→ 自己从 /app/apps
   * 里找 DSHA 包名。都失败时弹通知 + 震动，主人在手机上至少能看见。
   */
  async function openApp() {
    const tried = []
    if (config.appPackage) {
      const launched = await bridge.call('/app/launch', { pkg: config.appPackage }, { timeoutMs: 150000 })
      if (launched.ok) return { ok: true, how: 'package', package: config.appPackage, text: launched.text }
      // 桥不给面子（POLICY_BLOCKED 等）：记下来，接着试别的路，别自己编。
      tried.push({ how: 'package', target: config.appPackage, code: launched.code, text: launched.text })
    }
    if (config.appUrl) {
      const opened = await bridge.call('/app/open', { url: config.appUrl })
      if (opened.ok) return { ok: true, how: 'url', url: config.appUrl, text: opened.text }
      tried.push({ how: 'url', target: config.appUrl, code: opened.code, text: opened.text })
    }
    const found = await findAppPackage()
    if (found && found !== config.appPackage) {
      const launched = await bridge.call('/app/launch', { pkg: found }, { timeoutMs: 150000 })
      if (launched.ok) return { ok: true, how: 'discovered', package: found, text: launched.text }
      tried.push({ how: 'discovered', target: found, code: launched.code, text: launched.text })
    }
    // 实在拉不起来：通知 + 震动兜底，让主人知道网页上点过了。
    notify(bridge, '网页上点了「打开手机 DSHA」，但这台手机拉不起来：'
      + (tried.length > 0 ? trimText(String(tried[tried.length - 1].text || ''), 200) : '没找到 DSHA 的包名'), '中继台')
      .catch(() => { /* 通知失败就算了 */ })
    vibrate(bridge, 200).catch(() => { /* 震动失败就算了 */ })
    if (tried.length === 0) {
      return {
        ok: false,
        code: 'NO_APP_TARGET',
        text: '还没配 appPackage / appUrl，设备桥里也没找到 DSHA 的包名：在插件配置里填 DSHA 的包名（或它的深链）。',
      }
    }
    return {
      ok: false,
      code: tried[tried.length - 1].code || 'LAUNCH_FAILED',
      tried,
      text: '拉起 DSHA 失败：' + tried
        .map((item) => item.how + ' ' + item.target + ' → ' + (item.code || '') + ' ' + trimText(String(item.text || ''), 120))
        .join('；'),
    }
  }

  // --- 通知（手机端独有）-----------------------------------------------------

  /**
   * 弹通知。失败只记日志，绝不打断主流程 —— 通知是锦上添花，
   * 任务本身照样要跑到、结果照样要回传。
   */
  function pushNotice(text, title) {
    if (!config.notifyOnTask && !config.notifyOnResult) return
    notify(bridge, text, title)
      .then((result) => {
        if (result && result.ok) {
          runtime.notified += 1
        } else if (result && result.code !== 'SKIPPED') {
          logger.warn('dsha-relay-pair: 通知失败 ' + result.code + '：' + result.text)
        }
      })
      .catch((error) => {
        logger.warn('dsha-relay-pair: 通知异常：' + (error && error.message ? error.message : error))
      })
  }

  function noticeTask(task) {
    if (!config.notifyOnTask) return
    const title = String(task.title || '').trim() || trimText(String(task.prompt || ''), 40)
    pushNotice(trimText(String(task.prompt || ''), 300), '收到任务：' + title)
    if (config.vibrateOnTask) {
      vibrate(bridge, 150).catch(() => { /* 桥不在就算了 */ })
    }
  }

  function noticeResult(label, ok, excerpt) {
    if (!config.notifyOnResult) return
    pushNotice(trimText(excerpt || (ok ? '任务已完成' : '任务失败'), 200), (ok ? '已完成：' : '失败了：') + label)
  }

  // --- 投递 ------------------------------------------------------------------

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
      if (!agent) return { ok: false, error: '手机上还没有打开的会话：先在 DSHA 里开一个会话再派任务' }
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
        source: { kind: 'plugin:dsha-relay-pair' },
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
    runtime.idleSince = 0
    appendLocalTask({
      id: task.id || ('local-' + message.id),
      title: task.title || trimText(task.prompt || '', 60),
      prompt: trimText(task.prompt || '', 8000),
      target: 'mobile',
      origin: 'relay',
      status: 'running',
      createdAt: new Date().toISOString(),
      sessionId: sid,
      modelProvider: choice.provider,
      modelName: choice.model,
      reasoningEffort: applied.applied ? (applied.applied.reasoningEffort || '') : '',
    })
    noticeTask(task)
    return { ok: true, messageId: message.id, sessionId: sid, model: applied.applied, modelNote: applied.note }
  }

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
      logger.warn('dsha-relay-pair: 排队任务投递失败: ' + result.error)
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
        target: 'mobile',
        origin: 'relay',
        status: 'failed',
        output: reason,
        finishedAt: new Date().toISOString(),
        sessionId: item.sessionId || null,
      })
    }
    return queued.length
  }

  // --- 发件箱：报告先落盘再发 ------------------------------------------------

  /**
   * 把一条报告推进发件箱，然后立刻尝试发送。发不出去就留在盘上，
   * 下次心跳/轮询成功后统一重放（flushOutbox）。
   */
  function reportTask(taskId, status, output, error, sessionId) {
    if (!taskId) return
    const entry = appendOutbox({
      kind: 'report',
      taskId,
      status,
      output: output === undefined ? '' : trimText(output, 8000),
      error: error || '',
      // 带上会话 id：中继台靠它记下「这条任务跑在哪个会话」，网页才能「接着做」。
      sessionId: sessionId ? String(sessionId) : '',
    })
    if (!entry) {
      // 盘也写不了：退回直接发，至少别把结果彻底丢掉。
      sendReport({ taskId, status, output, error, sessionId: sessionId ? String(sessionId) : '' }).catch(() => {})
      return
    }
    sendReport(entry).then((ok) => {
      if (!ok) {
        refreshOutboxPending()
        return
      }
      // 删除也排队：prune 是「读全量 → 整文件重写」，不能和别的发件箱流程交错。
      return queueOutbox(() => pruneOutbox([entry.id])).then(() => { refreshOutboxPending() })
    }).catch(() => { refreshOutboxPending() })
  }

  /** 积压条数以盘上的文件为准：凭据为空时也数得准，界面不再骗人。 */
  function refreshOutboxPending() {
    try {
      runtime.outboxPending = countOutbox()
    } catch {
      runtime.outboxPending = 0
    }
    return runtime.outboxPending
  }

  function sendReport(entry) {
    if (!creds || !creds.token) return Promise.resolve(false)
    return call('/api/agent/report', {
      taskId: entry.taskId,
      status: entry.status,
      output: entry.output === undefined ? undefined : trimText(entry.output, 8000),
      error: entry.error || '',
    }, 15000).then(() => true).catch((error) => {
      runtime.lastError = '报告回传失败：' + (error && error.message ? error.message : String(error))
      logger.warn('dsha-relay-pair: report ' + entry.taskId + ' → ' + entry.status + ' failed: ' +
        (error && error.message ? error.message : error))
      return false
    })
  }

  /**
   * 重放发件箱。返回成功送出的条数。
   *
   * 按时间正序（最老的先发）：以前只看最后 200 条，积压一多老报告就永远卡死。
   * 每轮最多 FLUSH_BATCH 条，成功即删；遇到发不出去的那条就停，避免死循环。
   */
  async function flushOutbox() {
    if (!creds || !creds.token) {
      refreshOutboxPending()
      return 0
    }
    if (runtime.flushing) return 0
    runtime.flushing = true
    let total = 0
    try {
      for (;;) {
        const rows = listOutboxOldest(FLUSH_BATCH)
        // 报告和会话回执都走这条通道：一个任务结果、一次「送过去」的回执，丢哪条都不该。
        const batch = rows.filter((row) => row && (row.kind === 'report' || row.kind === 'handoff'))
        // 盘上只剩不认识的条目（历史遗留）：留着不动，本轮收工，不然会空转。
        if (batch.length === 0) break
        const sent = []
        let failed = false
        for (const row of batch) {
          const ok = row.kind === 'handoff' ? await sendHandoffAck(row)
            : await sendReport(row)
          if (!ok) {
            failed = true
            break
          }
          sent.push(row.id)
        }
        if (sent.length > 0) {
          await queueOutbox(() => pruneOutbox(sent))
          total += sent.length
        }
        if (failed || rows.length < FLUSH_BATCH) break
      }
    } finally {
      runtime.flushing = false
      refreshOutboxPending()
    }
    if (total > 0) logger.info('dsha-relay-pair: 发件箱重放 ' + total + ' 条')
    return total
  }

  /**
   * 启动复原：上一次进程被杀时，正在跑的任务永远等不到 turn/end。
   * 这里把它们标成 failed，让中继不再挂着 running。
   *
   * 两个前提，缺一个就会误伤：
   *   - 只碰本进程 pendingRuns 里没有的 taskId（重复配对/重连时正在跑的任务还在跑）；
   *   - 整个进程只做一次（runtime.recoveredInterrupted），第二次启动不再翻旧账。
   */
  function recoverInterrupted() {
    if (runtime.recoveredInterrupted) return 0
    runtime.recoveredInterrupted = true
    let rows
    try {
      rows = latestStatusByTask()
    } catch {
      return 0
    }
    // 本进程正在跑的任务：它们的 running 是真的，别动。
    const live = new Set()
    for (const run of pendingRuns.values()) {
      if (run && run.taskId) live.add(run.taskId)
    }
    let count = 0
    for (const [taskId, row] of rows) {
      if (!row || row.status !== 'running') continue
      if (!taskId) continue
      if (live.has(taskId)) continue
      appendLocalTask({
        id: taskId,
        title: row.title || '',
        prompt: '',
        target: 'mobile',
        origin: 'relay',
        status: 'failed',
        error: '插件重启，任务结果丢失',
        finishedAt: new Date().toISOString(),
      })
      reportTask(taskId, 'failed', '', '插件重启（手机端被系统回收），任务结果丢失，请重跑')
      count += 1
    }
    if (count > 0) logger.warn('dsha-relay-pair: 复原 ' + count + ' 个被中断的任务')
    return count
  }

  // --- 轮次收尾：把结果回传中继 ----------------------------------------------

  ctx.on('session/event', guarded('session/event', (session, event) => {
    const data = event && event.data ? event.data : {}

    // 一轮说完（哪怕没有中继任务）就把本机会话补同步一次，网页上的内容才新鲜。
    if (event && event.type === 'turn/end') scheduleSessionSync()

    if (pendingRuns.size === 0) return
    // 只认这个会话认领的那一单：同会话不会有两单并排跑（deliver 会排队）。
    const claimed = runForSession(session)
    if (claimed === null) return
    if (event.type === 'assistant/message') {
      const text = messageText(data.message)
      if (text) claimed.run.excerpt = text.slice(-EXCERPT_LIMIT)
      return
    }
    if (event.type !== 'turn/end') return
    pendingRuns.delete(claimed.messageId)
    const reasonKind = data.reason && typeof data.reason.kind === 'string' ? data.reason.kind : 'unknown'
    const ok = reasonKind === 'completed'
    const run = claimed.run
    if (run.taskId) {
      reportTask(run.taskId, ok ? 'done' : 'failed', run.excerpt,
        ok ? '' : 'turn ended: ' + reasonKind, run.sessionId)
    }
    appendLocalTask({
      id: run.taskId || ('local-' + claimed.messageId),
      title: run.title || '',
      prompt: '',
      target: 'mobile',
      origin: 'relay',
      status: ok ? 'done' : 'failed',
      output: trimText(run.excerpt, 2000),
      finishedAt: new Date().toISOString(),
      sessionId: run.sessionId || null,
    })
    noticeResult(run.title || run.taskId || '手机任务', ok, run.excerpt)
    // 这一单结算完，立刻投同会话排队里的下一单。
    drainQueue(run.session || session)
  }))

  // --- 隧道：中继把网页上的本机查询转进来 ------------------------------------

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
        delivered: runtime.delivered,
        outboxPending: refreshOutboxPending(),
        notified: runtime.notified,
      },
      // 本机模型目录：网页派活时按它给任务选模型/思考强度。
      models: {
        summary: catalogSummary(runtime.catalog),
        default: runtime.catalog ? runtime.catalog.default : null,
        error: runtime.catalogError,
      },
      sessions: list.map((agent) => ({
        id: agent.session && agent.session.id ? agent.session.id : null,
        title: null,
      })),
      pending: pendingRuns.size,
      app: {
        package: config.appPackage || null,
        url: config.appUrl || null,
        canOpen: Boolean(config.appPackage || config.appUrl),
      },
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

  async function handleTunnel(tunnel) {
    let status = 200
    let body = ''
    let headers = {}
    try {
      if (!isAllowedTunnelPath(tunnel.path)) {
        status = 403
        body = JSON.stringify({ ok: false, error: { code: 'PATH_NOT_ALLOWED', message: '隧道只允许访问白名单路径' } })
      } else if (tunnel.path === '/relay/api/state' || tunnel.path === '/relay/api/status') {
        body = JSON.stringify(localState())
      } else if (tunnel.path === '/relay/api/tasks') {
        body = JSON.stringify({ ok: true, tasks: listLocalTasks(50) })
      } else if (tunnel.path === '/relay/api/sessions') {
        body = JSON.stringify({ ok: true, sessions: await sessionReader.collect(MAX_SNAPSHOT_SESSIONS) })
      } else if (tunnel.path === '/relay/api/open') {
        // 网页「打开手机 DSHA」：网页没法直接拉起 App，只能让手机自己调本地桥。
        const result = await openApp()
        status = result.ok ? 200 : 409
        body = JSON.stringify(result)
      } else if (tunnel.path === '/relay/api/submit') {
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
        // 手机端没有可以被代理的本地 Web 服务（DSHA 的界面在 App 里，不是 56246）。
        // 其它白名单路径明确回 501，别让中继那边一直等到超时。
        status = 501
        body = JSON.stringify({
          ok: false,
          error: { code: 'TUNNEL_UNSUPPORTED', message: '手机端不代理 ' + tunnel.path + '：只支持 /relay/api/*' },
        })
      }
    } catch (error) {
      status = 502
      body = JSON.stringify({ ok: false, error: { code: 'TUNNEL_FAILED', message: error && error.message ? error.message : String(error) } })
    }
    headers = { 'content-type': 'application/json; charset=utf-8' }
    try {
      await call('/api/agent/tunnel/result', { tunnelId: tunnel.id, status, body, headers }, 15000)
    } catch (error) {
      logger.warn('dsha-relay-pair: tunnel result failed: ' + (error && error.message ? error.message : error))
    }
  }

  // --- 心跳 + 长轮询（带省电退避）-------------------------------------------

  /** 心跳/配对上报：网页靠这些字段点亮「打开手机 DSHA」，并知道手机上有没有活会话。 */
  function deviceMeta() {
    const meta = { platform: process.platform, arch: process.arch, host: hostname(), version: VERSION, kind }
    if (config.appPackage) meta.appPackage = config.appPackage
    if (config.appUrl) meta.appUrl = config.appUrl
    meta.canOpen = Boolean(config.appPackage || config.appUrl)
    meta.sessions = roots().length
    // 模型目录：网页靠它给任务选模型/思考强度。内容没变就不重复传（省流量）。
    if (runtime.catalog && runtime.catalog.generatedAt !== runtime.catalogSentAt) {
      meta.models = runtime.catalog
      runtime.catalogPending = runtime.catalog.generatedAt
    }
    return meta
  }

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
      const catalog = await buildCatalog(llm, selection, logger)
      runtime.catalog = catalog
      runtime.catalogAt = Date.now()
      runtime.catalogError = Array.isArray(catalog.failures) && catalog.failures.length > 0
        ? catalog.failures[0].error
        : null
      return catalog
    } catch (error) {
      runtime.catalogError = error && error.message ? error.message : String(error)
      logger.warn('dsha-relay-pair: 模型目录探测失败: ' + runtime.catalogError)
      return runtime.catalog
    }
  }

  async function heartbeatOnce() {
    if (!creds || runtime.stopped) return
    try {
      // 心跳顺带把模型目录刷一遍（有缓存，5 分钟内不重复探测）。
      await refreshCatalog(false)
      await call('/api/agent/heartbeat', {
        meta: deviceMeta(),
      }, 15000)
      // 目录确实发出去了才记版本：发失败下一轮还会再带一次。
      if (runtime.catalogPending) {
        runtime.catalogSentAt = runtime.catalogPending
        runtime.catalogPending = ''
      }
      runtime.lastHeartbeatAt = Date.now()
      runtime.lastError = null
      await flushOutbox()
    } catch (error) {
      runtime.lastError = error && error.message ? error.message : String(error)
    }
  }

  // --- 会话快照（最近 3 条会话，只上报云端）----------------------------------

  /**
   * 把本机最近 3 条会话的快照推给中继。
   *
   * 这里**只入库**：自动保存绝不会被投递给任何设备，主人在网页上点「送过去」
   * 才会生成一条 handoff。full=true 表示「这就是我本机全部的最新三条」，
   * 中继以这一份为准，不在列表里的旧快照会被删掉。
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
   * 同一个 sessionId 新建一条再接着聊——同一份会话送两次还是同一条，不会每送
   * 一次就多出一个「副本会话」。
   */
  async function handleHandoffs(handoffs) {
    for (const handoff of handoffs) {
      // 中继的 handoff id 是 "hd_xxxx" 字符串，别转数字（转了就是 NaN，整条被跳过）
      const id = handoff && handoff.id !== undefined && handoff.id !== null ? String(handoff.id) : ''
      if (!id) continue
      const done = handoffsDone.get(id)
      if (done) {
        // 中继没收到上次的 ack（断网/崩过），同一条又投来了：只补回执，不重复注入。
        logger.info('dsha-relay-pair: 会话 ' + id + ' 是重投，只补回执不重复注入')
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
          logger.warn('dsha-relay-pair: 送来的会话 ' + id + ' 接续失败: ' + applied.error)
          outcome = { status: 'failed', output: '', error: applied.error }
        } else {
          try {
            const message = createUserMessage({
              content: [{ type: 'text', text: frameHandoffMessage(handoff, deviceName) }],
              source: { kind: 'plugin:dsha-relay-pair', handoffId: id },
            })
            deliverQuietly(applied.agent, message)
            runtime.handoffsOk += 1
            if (applied.created) logger.info('dsha-relay-pair: 为送来的会话新建了 ' + applied.sessionId)
            pushNotice('会话已接上：' + (handoff.title || applied.sessionId), '中继 · 会话接续')
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
            logger.warn('dsha-relay-pair: 送来的会话 ' + id + ' 注入失败: ' + text)
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

  /**
   * 回执：不 ack 中继会一直重发（15 分钟没 ack 退回 pending，投满 3 次判失败）。
   * 手机断网是常态，所以先落发件箱再发，发不出去等下次心跳/轮询成功后重放。
   */
  async function ackHandoff(id, status, output, error) {
    const entry = appendOutbox({
      kind: 'handoff',
      handoffId: id,
      status: status === 'delivered' ? 'delivered' : 'failed',
      output: output || '',
      error: error || '',
    })
    if (!entry) {
      // 盘写不了：至少直接发一次，别把回执彻底丢掉。
      await sendHandoffAck({ handoffId: id, status, output, error })
      return
    }
    const ok = await sendHandoffAck(entry)
    if (!ok) {
      refreshOutboxPending()
      return
    }
    await queueOutbox(() => pruneOutbox([entry.id]))
    refreshOutboxPending()
  }

  function sendHandoffAck(entry) {
    if (!creds || !creds.token) return Promise.resolve(false)
    const body = { id: entry.handoffId, status: entry.status === 'delivered' ? 'delivered' : 'failed' }
    if (entry.output) body.output = trimText(entry.output, 2000)
    if (entry.error) body.error = trimText(entry.error, 2000)
    return call('/api/agent/handoffs/ack', body, 15000).then(() => true).catch((error) => {
      runtime.lastError = '会话回执失败：' + (error && error.message ? error.message : String(error))
      logger.warn('dsha-relay-pair: handoff ' + entry.handoffId + ' ack 失败，留在发件箱重放: ' +
        (error && error.message ? error.message : error))
      return false
    })
  }

  async function pollLoop() {
    while (!runtime.stopped && creds) {
      let got = false
      try {
        const data = await call('/api/agent/poll', {}, (config.pollSeconds + 20) * 1000)
        runtime.lastHeartbeatAt = Date.now()
        runtime.lastPollAt = Date.now()
        runtime.lastError = null
        for (const task of data.tasks || []) {
          got = true
          const result = await deliver(task)
          if (result.ok) {
            reportTask(task.id, 'running', undefined, '', result.sessionId)
          } else {
            reportTask(task.id, 'blocked', undefined, result.error)
            logger.warn('dsha-relay-pair: task ' + task.id + ' blocked: ' + result.error)
          }
        }
        for (const tunnel of data.tunnels || []) {
          got = true
          handleTunnel(tunnel).catch((error) => {
            logger.warn('dsha-relay-pair: tunnel failed: ' + (error && error.message ? error.message : error))
          })
        }
        if ((data.handoffs || []).length > 0) {
          got = true
          await handleHandoffs(data.handoffs || [])
        }
        if (runtime.outboxPending > 0) await flushOutbox()
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        runtime.lastError = message
        // 中继不通/网络抖动：退避 5 秒再试，绝不空转。
        await new Promise((resolve) => setTimeout(resolve, 5000))
        continue
      }

      if (got) {
        runtime.idleSince = 0
        continue
      }
      // 空转：从第一次空转开始计时，超过 idleBackoffAfterSeconds 后逐步拉长间隔。
      if (runtime.idleSince === 0) runtime.idleSince = Date.now()
      const idleSeconds = (Date.now() - runtime.idleSince) / 1000
      const delay = nextPollDelay(config, idleSeconds)
      if (delay > Math.max(5, config.pollSeconds) * 1000) {
        await new Promise((resolve) => setTimeout(resolve, delay - Math.max(5, config.pollSeconds) * 1000))
      }
    }
  }

  function startLoops() {
    if (!creds) return false
    stopLoops()
    runtime.stopped = false
    runtime.startedAt = Date.now()
    runtime.idleSince = 0
    recoverInterrupted()
    runtime.heartbeatTimer = setInterval(
      guarded('heartbeat', () => { heartbeatOnce() }),
      Math.max(5, config.heartbeatSeconds) * 1000,
    )
    // 发件箱在心跳之外也定期重放一次：心跳要等一个间隔，报告不该跟着一起卡。
    runtime.flushTimer = setInterval(
      guarded('flush', () => { flushOutbox() }),
      Math.max(30, config.heartbeatSeconds * 3) * 1000,
    )
    heartbeatOnce()
    if (config.sessionSnapshot !== false) {
      runtime.sessionTimer = setInterval(
        guarded('session-sync', () => { syncSessions() }),
        SESSION_SYNC_SECONDS * 1000,
      )
      // 配对/重连之后先推一次，网页上立刻能看到本机最近 3 条。
      syncSessions().catch(() => {})
    }
    pollLoop().catch((error) => {
      logger.warn('dsha-relay-pair: poll loop exited: ' + (error && error.message ? error.message : error))
    })
    return true
  }

  function stopLoops() {
    runtime.stopped = true
    failQueue('插件停止（解绑或重连），排队的任务没有执行')
    if (runtime.heartbeatTimer !== null) {
      clearInterval(runtime.heartbeatTimer)
      runtime.heartbeatTimer = null
    }
    if (runtime.flushTimer !== null) {
      clearInterval(runtime.flushTimer)
      runtime.flushTimer = null
    }
    if (runtime.sessionTimer !== null) {
      clearInterval(runtime.sessionTimer)
      runtime.sessionTimer = null
    }
    if (runtime.sessionSoon !== null) {
      clearTimeout(runtime.sessionSoon)
      runtime.sessionSoon = null
    }
  }

  // 关插件时把定时器和轮询一起收掉。
  ctx.effect(() => () => {
    stopLoops()
  })

  // --- 配对（工具与设置页共用）-----------------------------------------------

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
        meta: { platform: process.platform, arch: process.arch, host: hostname(), version: VERSION, kind },
      },
      timeoutMs: 15000,
    })
    creds = {
      relayUrl,
      deviceId: data.deviceId,
      token: data.deviceToken,
      name,
      kind,
      pairedAt: new Date().toISOString(),
    }
    writeCredentials(creds)
    // 新配对可能是另一个中继库（handoff id 会重来），旧去重表作废。
    handoffsDone.clear()
    startLoops()
    return creds
  }

  function unpairDevice() {
    stopLoops()
    const cleared = clearCredentials()
    creds = null
    handoffsDone.clear()
    return cleared
  }

  // --- 工具 ------------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'relay_pair',
    description: 'Pair this phone (DSHA) with the DSH relay (中继台): exchange a one-time pairing code from the relay web page for a device token, then start heartbeat + task polling. Run once per device; the token is stored in $DSH_HOME/relay-device.json.',
    parameters: {
      code: { type: 'string', required: true, description: 'One-time pairing code shown by the relay web page, e.g. "WFQT-GRKK-L3LK".' },
      relayUrl: { type: 'string', description: 'Relay base URL, e.g. https://relay.example.com. Defaults to the config relayUrl.' },
      name: { type: 'string', description: 'Device name shown on the relay. Defaults to DSHA@<hostname>.' },
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
        config.notifyOnTask ? '任务到达时会在通知栏提醒（设备桥可用时）。' : '提示：notifyOnTask=false，任务到达不会弹通知。',
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'relay_status',
    description: 'Show this phone\'s relay status: paired or not, relay URL, heartbeat age, polling state, pending task count, unreported outbox entries and the local task log tail.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      // 设备桥与本地流水跟配对无关：没配对也告诉用户「通知能用吗」「本机跑过什么」。
      const local = recentTasks(5)
      const localLines = [
        '本机最近任务（本地流水，未同步）' + (local.length === 0 ? '：无' : '：'),
        ...local.map((t) => '  · [' + (t.status || '?') + '] ' + (t.title || t.id || '')),
      ]
      const bridgeProbe = await bridge.call('/app/version').catch(() => null)
      const bridgeLine = '设备桥（通知/震动）：' + (bridgeProbe && bridgeProbe.ok
        ? '可用'
        : '不可用' + (bridgeProbe && bridgeProbe.code ? '（' + bridgeProbe.code + '）' : '') +
          (bridgeProbe && bridgeProbe.text ? ' —— ' + trimText(bridgeProbe.text, 120) : ''))
      const appLine = '打开手机 DSHA：' + (config.appPackage
        ? 'appPackage=' + config.appPackage
        : config.appUrl
          ? 'appUrl=' + config.appUrl
          : '没配（在插件配置里填 appPackage 或 appUrl，网页上的「打开手机 DSHA」才能用）')
      if (!creds) {
        return [
          '未配对。先在网页生成配对码，然后运行 relay_pair（code="XXXX-XXXX-XXXX"）。',
          bridgeLine,
          appLine,
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
        runtime.lastError = null
      } catch (error) {
        runtime.lastError = error && error.message ? error.message : String(error)
      }
      return [
        '中继：' + baseUrl() + (reachable ? '（可达）' : '（不可达：' + runtime.lastError + '）'),
        '设备：' + (creds.name || deviceName) + '（' + kind + '） · ' + creds.deviceId,
        '心跳：' + formatAge(runtime.lastHeartbeatAt) + ' · 长轮询：' + (runtime.stopped ? '停' : '运行中') +
          ' · 已投递 ' + runtime.delivered + ' 个任务',
        '模型：' + catalogSummary(runtime.catalog) + (runtime.catalogError ? '（' + runtime.catalogError + '）' : ''),
        '中继上排队任务：' + (pending === null ? '—' : pending) + ' · 未回传报告：' + refreshOutboxPending() + ' 条',
        bridgeLine,
        appLine,
        '',
        ...localLines,
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'relay_task_add',
    description: 'Save a task to the relay (it is stored, NOT executed): the user reviews it in the relay web UI and dispatches it manually. target is only a hint: local=desktop, dsha=this phone, cloud=storage only, auto.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What to do.' },
      title: { type: 'string', description: 'Short title shown in the task list.' },
      target: { type: 'string', description: 'local | mobile | desktop | cloud | auto (default auto).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const prompt = String(args.prompt || '').trim()
      if (!prompt) throw new Error('prompt 不能为空')
      const allowed = ['local', 'mobile', 'desktop', 'dsha', 'cloud', 'auto']
      let target = allowed.includes(args.target) ? args.target : 'auto'
      if (target === 'mobile') target = 'local'
      if (target === 'dsha') target = 'local'
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
      return tasks.map((t) => {
        const head = '[' + t.status + '] ' + (t.title || t.id) + ' · ' + t.target + ' · ' + (t.createdAt || '')
        const detail = t.status === 'failed' || t.status === 'blocked' ? t.error : t.output
        return head + (detail ? '\n    ' + trimText(String(detail).replace(/\s+/g, ' '), 160) : '')
      }).join('\n')
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
    description: 'Forget this device\'s relay pairing: clear the stored token and stop heartbeat/polling. Use when the phone is retired or the token leaked.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const cleared = unpairDevice()
      return cleared ? '已断开配对并清除本地凭据。' : '本来就没有配对凭据。'
    },
  }))

  // --- 给网页隧道/设置页用的本机 HTTP 路由 -----------------------------------
  //
  // 中继 tunnel 帧、以及 DSHA 的设置页都用这两个路由读状态。
  // 围栏与桌面端一致：只认 loopback / trustedHosts，拒绝跨站。

  ctx.inject(['webServer'], (webCtx) => {
    const trustedHosts = () => {
      const startup = ctx.get('webStartup')
      if (startup !== undefined && startup !== null) return startup.trustedHosts ?? []
      const runtimeSvc = ctx.get('webRuntime')
      if (runtimeSvc !== undefined && runtimeSvc !== null) return runtimeSvc.trustedHosts ?? []
      return []
    }
    const fence = (req) => isTrustedApiRequest(req, trustedHosts())

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/relay/api',
      handler: async (req, res) => {
        try {
          if (!fence(req)) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          if (pathname === '/relay/api/state' || pathname === '/relay/api/status') {
            writeJson(res, 200, localState())
            return
          }
          if (pathname === '/relay/api/tasks') {
            writeJson(res, 200, { ok: true, tasks: listLocalTasks(50) })
            return
          }
          if (pathname === '/relay/api/sessions') {
            writeJson(res, 200, { ok: true, sessions: await sessionReader.collect(MAX_SNAPSHOT_SESSIONS) })
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
            if (req.method !== 'POST') {
              writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'POST only' } })
              return
            }
            const cleared = unpairDevice()
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
    }), 'dsha-relay-pair: /relay/api routes')

    logger.info('dsha-relay-pair: HTTP API mounted at /relay/api')
  })

  // --- 自动启动 --------------------------------------------------------------

  if (config.autostart && creds && creds.token) {
    ctx.effect(() => {
      startLoops()
      return () => stopLoops()
    })
  }

  logger.info('dsha-relay-pair: ' + (creds
    ? 'paired as ' + (creds.name || deviceName) + ' → ' + creds.relayUrl
    : 'not paired yet'))
}

// --- HTTP 小工具（与 dsh-relay-pair / dsh-schedule 同一套围栏代码）-----------

function headerValue(headers, headerName) {
  const value = headers[headerName]
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

/**
 * Origin 头存在时必须与 Host 同源（主机、端口都要对得上）。
 * 只看 sec-fetch-site 不够：老浏览器、非浏览器客户端、以及被改过的请求都可能没有它。
 */
function sameOriginAs(originValue, hostUrl) {
  let originUrl
  try {
    originUrl = new URL(originValue)
  } catch {
    return false
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false
  if (originUrl.hostname !== hostUrl.hostname) return false
  if (hostUrl.port !== '') return originUrl.port === hostUrl.port
  const defaultPort = originUrl.protocol === 'https:' ? '443' : '80'
  return originUrl.port === '' || originUrl.port === defaultPort
}

function isTrustedApiRequest(req, trustedHosts) {
  const host = headerValue(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts ?? [])) return false
  const origin = headerValue(req.headers, 'origin')
  if (origin !== undefined && !sameOriginAs(origin, hostUrl)) return false
  if (headerValue(req.headers, 'sec-fetch-site') === 'cross-site') return false
  return true
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
