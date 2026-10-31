// dsha-relay-pair / tests/apply.test.mjs
//
// 不用真的 DSHA：造一个最小 ctx、一个假中继、一个假设备桥，
// 验证 apply() 注册了 6 个工具与 /relay/api 路由、能投递任务、能在 turn/end 收尾、
// 报告进发件箱、启动时复原被中断的任务，以及信任围栏生效。
//
// 跑法：ELECTRON_RUN_AS_NODE=1 '/e/Deepseek/DeepSeek Harness.exe' tests/apply.test.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsha-apply-'))
process.env.DSH_HOME = home
process.env.DSHA_BRIDGE_TOKEN = 'bridge-tok'
delete process.env.DSHA_BRIDGE_URL

const P = await import('../lib/protocol.js')
const M = await import('../lib/index.js')

const fails = []
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + JSON.stringify(extra)))
  if (!cond) fails.push(name)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等某个条件成立（异步链路：通知、报告都是后台跑的）。 */
async function until(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(25)
  }
  return false
}

/** 最小 ctx：够 apply() 用。 */
function makeContext() {
  const listeners = new Map()
  const tools = []
  const routes = []
  const cleanups = []
  const deliveries = []
  const agent = {
    session: { id: 'sess-1' },
    followup(message) { deliveries.push(message) },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
    },
    get() { return undefined },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    agents: { roots: () => [agent] },
    tools: { register(tool) { tools.push(tool) } },
    inject(_names, cb) {
      cb({
        effect(fn) {
          const cleanup = fn()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        },
        webServer: { register(route) { routes.push(route) } },
      })
    },
  }
  return {
    ctx, tools, routes, deliveries, agent,
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
    dispose() {
      for (const fn of cleanups.reverse()) fn()
    },
  }
}

/** 假中继：设备端点全认，任务表里能塞预设任务。 */
async function fakeRelay(state) {
  const hits = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://relay.test')
    hits.push(url.pathname)
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = null
      try { body = raw === '' ? null : JSON.parse(raw) } catch { body = null }
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const path = url.pathname
      if (path === '/api/device/pair') return send(200, { ok: true, deviceId: 'd_fake', deviceToken: 'tok-fake-123' })
      if (path === '/api/agent/heartbeat') {
        if (!state.heartbeats) state.heartbeats = []
        state.heartbeats.push(body)
        return send(200, { ok: true, pending: state.pendingTasks.length })
      }
      if (path === '/api/agent/poll') {
        const tasks = state.pendingTasks.splice(0, state.pendingTasks.length)
        const tunnels = (state.pendingTunnels || []).splice(0, state.pendingTunnels.length)
        const handoffs = state.pendingHandoffs ? state.pendingHandoffs.splice(0, state.pendingHandoffs.length) : []
        return send(200, { ok: true, tasks, tunnels, handoffs })
      }
      if (path === '/api/agent/report') {
        state.reports.push({ body, token: req.headers.authorization })
        return send(200, { ok: true })
      }
      if (path === '/api/agent/tasks') {
        state.submitted.push(body)
        return send(200, { ok: true, taskId: 't-sub-1', target: 'auto' })
      }
      if (path === '/api/agent/state') return send(200, { ok: true, tasks: state.relayTasks })
      if (path === '/api/agent/sync') {
        state.synced.push(body)
        return send(200, { ok: true, imported: 0, skipped: 0 })
      }
      if (path === '/api/agent/sessions/sync') {
        if (!state.sessionSyncs) state.sessionSyncs = []
        state.sessionSyncs.push(body)
        return send(200, { ok: true, kept: (body && body.sessions || []).length, dropped: 0, limit: 3 })
      }
      if (path === '/api/agent/handoffs/ack') {
        if (!state.handoffAcks) state.handoffAcks = []
        state.handoffAcks.push(body)
        return send(200, { ok: true })
      }
      if (path === '/api/agent/tunnel/result') {
        if (!state.tunnelResults) state.tunnelResults = []
        state.tunnelResults.push(body)
        return send(200, { ok: true })
      }
      return send(404, { ok: false, error: { code: 'NO_ROUTE', message: '没有这个接口' } })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: 'http://127.0.0.1:' + server.address().port, hits }
}

/** 假设备桥：只记 /app/notify 与 /app/version。 */
async function fakeBridge() {
  const calls = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://bridge.test')
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
    calls.push({
      path: url.pathname,
      method: req.method,
      text: url.searchParams.get('text'),
      title: url.searchParams.get('title'),
      pkg: url.searchParams.get('pkg'),
      url: url.searchParams.get('url'),
      token: req.headers['x-token'],
      body: raw,
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    const appsText = 'com.deepseek.dsha = DSHA\ncom.tencent.mm = 微信\ncom.android.settings = 设置'
    res.end(JSON.stringify({
      result: url.pathname === '/app/version'
        ? 'OK 1.0.0'
        : url.pathname === '/app/apps'
          ? appsText
          : (url.pathname === '/app/launch' || url.pathname === '/app/open' ? '已拉起' : '通知已发送'),
    }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: 'http://127.0.0.1:' + server.address().port, calls }
}

function fakeReq({ url = '/relay/api/state', method = 'GET', headers = {}, json } = {}) {
  const handlers = {}
  const req = {
    url,
    method,
    headers,
    on(event, fn) {
      handlers[event] = handlers[event] || []
      handlers[event].push(fn)
      if (event === 'end') {
        setImmediate(() => {
          if (json !== undefined) {
            const buf = Buffer.from(JSON.stringify(json))
            for (const fn2 of handlers.data || []) fn2(buf)
          }
          for (const fn3 of handlers.end || []) fn3()
        })
      }
      return req
    },
    destroy() {},
  }
  return req
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key] = value },
    end(text) { this.body = text ?? '' },
  }
}

const relayState = { pendingTasks: [], pendingTunnels: [], reports: [], submitted: [], relayTasks: [], synced: [] }

/** 一套干净的中继状态（每段场景各用一套，免得互相污染）。 */
function freshState(tunnels = []) {
  return { pendingTasks: [], pendingTunnels: tunnels, reports: [], submitted: [], relayTasks: [], synced: [], heartbeats: [], tunnelResults: [] }
}
const bridge = await fakeBridge()
let relay = null

// ---------- 1) 未配对：工具齐全、能本地派活、通知照发 ----------
const env1 = makeContext()
M.apply(env1.ctx, { relayUrl: '', autostart: false, bridgeUrl: bridge.url, pollSeconds: 5, idleBackoffAfterSeconds: 0 })

const names = env1.tools.map((t) => t.name).sort()
ok('注册 6 个工具（与桌面端同名）', JSON.stringify(names) === JSON.stringify(
  ['relay_pair', 'relay_status', 'relay_sync_task', 'relay_task_add', 'relay_tasks', 'relay_unpair']), names)
ok('每个工具都有 description 与 parameters', env1.tools.every((t) => typeof t.description === 'string' && t.parameters && t.parameters.type === 'object'), names)
ok('relay_pair 必填 code', (() => {
  const t = env1.tools.find((x) => x.name === 'relay_pair')
  return t && t.parameters.required && t.parameters.required.includes('code') && t.parameters.properties.code.type === 'string'
})())
ok('注册 /relay/api 路由', env1.routes.length === 1 && env1.routes[0].path === '/relay/api' && env1.routes[0].kind === 'prefix', env1.routes.map((r) => r.path))

const statusTool = env1.tools.find((t) => t.name === 'relay_status')
const statusText = await statusTool.execute({})
ok('未配对时 relay_status 提示先配对', /未配对/.test(statusText) && /relay_pair/.test(statusText), statusText)
ok('未配对时 relay_status 也报设备桥状态', /设备桥（通知\/震动）：可用/.test(statusText), statusText.split(String.fromCharCode(10)))
ok('relay_status 探测到桥的版本', bridge.calls.some((c) => c.path === '/app/version' && c.token === 'bridge-tok'), bridge.calls.map((c) => c.path))

const add = env1.tools.find((t) => t.name === 'relay_task_add')
const addText = await add.execute({ prompt: '把今天的日志扫一遍' })
ok('未配对时 relay_task_add 直接投本机', /直接投给本机会话/.test(addText) && env1.deliveries.length === 1, { addText, n: env1.deliveries.length })
const injected = env1.deliveries[0]
const injectedText = (injected.content ?? []).map((b) => b.text ?? '').join('')
ok('注入消息带 prompt', injectedText.includes('把今天的日志扫一遍'), injectedText.slice(0, 120))
ok('注入消息标注来源插件', injected.source && injected.source.kind === 'plugin:dsha-relay-pair', injected.source)
ok('注入消息说明是手机端在跑', injectedText.includes('dsha-relay-pair'), injectedText.slice(0, 160))

const notified = await until(() => bridge.calls.some((c) => c.path === '/app/notify'))
ok('任务到达时发通知', notified && bridge.calls.some((c) => c.path === '/app/notify' && String(c.text).includes('把今天的日志扫一遍')), bridge.calls.map((c) => c.path))

// 收尾：assistant/message → turn/end 要把挂起的轮次清掉，结果推进发件箱
env1.emit('session/event', env1.agent.session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '日志扫完了，今天没事' }] } } })
env1.emit('session/event', env1.agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
ok('turn/end 后本地流水留下结果', (() => {
  const rows = P.listLocalTasks(10)
  return rows.some((r) => r.status === 'done' && String(r.output ?? '').includes('日志扫完了'))
})(), P.listLocalTasks(3))
ok('本机派发的活没有中继任务号，不产生报告', P.listOutbox(10).length === 0, P.listOutbox(5))

// 积压条数以盘为准：没配对（发不出去）时也要数得出来，界面不能显示 0。
P.appendOutbox({ kind: 'report', taskId: 't-orphan', status: 'done' })
ok('完成时也发通知', await until(() => bridge.calls.filter((c) => c.path === '/app/notify').length >= 2), bridge.calls.filter((c) => c.path === '/app/notify').length)

// HTTP 路由：信任围栏 + 状态
const route = env1.routes[0]
async function hit(headers, path = '/relay/api/state', method = 'GET', json) {
  const res = fakeRes()
  await route.handler(fakeReq({ url: path, method, headers, json }), res)
  return res
}
let res = await hit({ host: '127.0.0.1:56246' })
ok('本机 loopback 访问 /relay/api/state → 200', res.statusCode === 200 && JSON.parse(res.body).ok === true, res.body.slice(0, 120))
ok('/state 带 kind=mobile 与设备名', (() => {
  const body = JSON.parse(res.body)
  return body.device.kind === 'mobile' && body.device.name.startsWith('DSHA@') && body.relay.paired === false
})(), res.body.slice(0, 200))
res = await hit({ host: 'evil.example.com' })
ok('外部 Host 被拒 → 403', res.statusCode === 403, res.body)
res = await hit({ host: '127.0.0.1:56246' })
ok('未配对时 /state 也报出发件箱积压', JSON.parse(res.body).relay.outboxPending === 1, res.body.slice(0, 200))
res = await hit({ host: '127.0.0.1:56246', 'sec-fetch-site': 'cross-site' })
ok('cross-site 被拒 → 403', res.statusCode === 403, res.body)
res = await hit({ host: '127.0.0.1:56246', origin: 'http://127.0.0.1:56246' })
ok('同源 Origin 放行 → 200', res.statusCode === 200, res.body.slice(0, 120))
res = await hit({ host: '127.0.0.1:56246', origin: 'http://evil.example.com' })
ok('外部 Origin 被拒 → 403', res.statusCode === 403, res.body)
res = await hit({ host: '127.0.0.1:56246', origin: 'http://127.0.0.1:56247' })
ok('同主机不同端口也算跨源 → 403', res.statusCode === 403, res.body)

// 设置页派活：POST /relay/api/submit
res = await hit({ host: '127.0.0.1:56246', 'content-type': 'application/json' }, '/relay/api/submit', 'POST', { prompt: '   ' })
ok('空 prompt → 400 EMPTY_PROMPT', res.statusCode === 400 && JSON.parse(res.body).error.code === 'EMPTY_PROMPT', res.body)
res = await hit({ host: '127.0.0.1:56246', 'content-type': 'application/json' }, '/relay/api/submit', 'POST', { prompt: '设置页派个活' })
ok('设置页派活成功', res.statusCode === 200 && JSON.parse(res.body).ok === true && env1.deliveries.length === 2, res.body)
res = await hit({ host: '127.0.0.1:56246' }, '/relay/api/whatever')
ok('未知路径 → 404', res.statusCode === 404 && JSON.parse(res.body).error.code === 'not-found', res.body)

// 设置页配对 → 换令牌 → 落盘
relay = await fakeRelay(relayState)
try {
  res = await hit({ host: '127.0.0.1:56246', 'content-type': 'application/json' }, '/relay/api/pair', 'POST', { code: 'WFQT-GRKK-L3LK', relayUrl: relay.url, name: '我的手机' })
  const pairBody = JSON.parse(res.body || '{}')
  ok('设置页调用 /relay/api/pair 成功', res.statusCode === 200 && pairBody.ok === true && pairBody.device && pairBody.device.id === 'd_fake', res.body)
  const stored = P.readCredentials()
  ok('配对后凭据落盘', stored && stored.deviceId === 'd_fake' && stored.token === 'tok-fake-123', stored)
  ok('配对用手机设备名与类型', stored.kind === 'mobile' && stored.name === '我的手机', stored)

  res = await hit({ host: '127.0.0.1:56246' })
  const stateBody = JSON.parse(res.body || '{}')
  ok('状态里显示已配对', stateBody.relay.paired === true && stateBody.device.id === 'd_fake', stateBody.relay)

  res = await hit({ host: '127.0.0.1:56246', 'content-type': 'application/json' }, '/relay/api/pair', 'POST', { code: '', relayUrl: relay.url })
  ok('空配对码 → 400 且给出原因', res.statusCode === 400 && String(JSON.parse(res.body).error.message).includes('配对码'), res.body)

  // 配对后工具走中继
  const tasksTool = env1.tools.find((t) => t.name === 'relay_tasks')
  relayState.relayTasks = [{ id: 't-cloud', title: '云端任务', status: 'done', target: 'cloud', output: '跑完了', createdAt: '2026-10-28T00:00:00Z' }]
  const tasksText = await tasksTool.execute({ limit: 5 })
  ok('relay_tasks 从云端读任务', tasksText.includes('云端任务') && tasksText.includes('[done]') && tasksText.includes('跑完了'), tasksText)

  const addPaired = await add.execute({ prompt: '交给云端跑', title: '云端活', target: 'cloud' })
  ok('已配对时 relay_task_add 提交到中继', /t-sub-1/.test(addPaired) && relayState.submitted.length === 1, { addPaired, submitted: relayState.submitted })
  ok('提交带 title、prompt 与 target', relayState.submitted[0] && relayState.submitted[0].prompt === '交给云端跑' &&
    relayState.submitted[0].title === '云端活' && relayState.submitted[0].target === 'cloud', relayState.submitted)

  const syncText = await env1.tools.find((t) => t.name === 'relay_sync_task').execute({ limit: 5 })
  ok('relay_sync_task 汇报导入/跳过数', /已同步/.test(syncText) && /跳过重复 0 条/.test(syncText), syncText)
  ok('同步把本地流水发给中继', relayState.synced.length === 1 && Array.isArray(relayState.synced[0].records) && relayState.synced[0].records.length > 0, relayState.synced)

  // 中继派活：配对成功后轮询自己会领任务
  // 先把本机先前那一单收尾：同会话一轮只跑一单，没收尾的话中继这单会排队（那是另一条测试）。
  env1.emit('session/event', env1.agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await sleep(50)
  relayState.pendingTasks.push({ id: 't-poll-1', title: '中继派的活', prompt: '数一下白饭' })
  const polled = await until(() => env1.deliveries.some((m) => (m.content ?? []).map((b) => b.text ?? '').join('').includes('数一下白饭')), 9000)
  ok('轮询领到中继任务并投进会话', polled, env1.deliveries.length)
  ok('领到任务后回传 running', await until(() => relayState.reports.some((r) => r.body && r.body.taskId === 't-poll-1' && r.body.status === 'running'), 3000), relayState.reports)

  // 中继这时挂了：结果必须留在发件箱，等下次连上再补发
  relay.server.close()
  await sleep(120)
  const polledMsg = env1.deliveries[env1.deliveries.length - 1]
  env1.emit('session/event', env1.agent.session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '白饭数了 3 碗' }] } } })
  env1.emit('session/event', env1.agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const kept = await until(() => P.listOutbox(10).some((row) => row.taskId === 't-poll-1' && row.status === 'done'), 3000)
  ok('中继不通时报告留在发件箱', kept, { outbox: P.listOutbox(5), msg: Boolean(polledMsg) })
  ok('落盘的报告带汇报正文', (P.listOutbox(10).find((row) => row.taskId === 't-poll-1') || {}).output === '白饭数了 3 碗', P.listOutbox(5))

  res = await hit({ host: '127.0.0.1:56246' }, '/relay/api/unpair', 'GET')
  ok('unpair 只接受 POST（GET → 405）', res.statusCode === 405 && P.readCredentials() !== null, { status: res.statusCode, body: res.body })

  res = await hit({ host: '127.0.0.1:56246', 'content-type': 'application/json' }, '/relay/api/unpair', 'POST', {})
  ok('设置页断开配对', JSON.parse(res.body || '{}').ok === true && P.readCredentials() === null, res.body)
} finally {
  if (relay) relay.server.close()
}

env1.dispose()

// ---------- 2) localExec=false 不接活 ----------
P.clearCredentials()
const env3 = makeContext()
M.apply(env3.ctx, { relayUrl: 'http://127.0.0.1:1', autostart: false, localExec: false, bridgeUrl: bridge.url })
const add3 = env3.tools.find((t) => t.name === 'relay_task_add')
let blocked = ''
try {
  await add3.execute({ prompt: '不该跑的任务' })
} catch (error) {
  blocked = error.message
}
ok('localExec=false 时拒绝接活', /localExec=false/.test(blocked) && env3.deliveries.length === 0, blocked)
env3.dispose()

// ---------- 2f) 「打开手机 DSHA」：/relay/api/open 隧道 + 心跳 meta ----------
P.clearCredentials()
{
  const state = freshState()
  const relayO = await fakeRelay(state)
  const envO = makeContext()
  try {
    P.writeCredentials({ relayUrl: relayO.url, deviceId: 'd_open', token: 'tok-open', name: '测试手机', kind: 'mobile' })
    M.apply(envO.ctx, { relayUrl: relayO.url, autostart: true, bridgeUrl: bridge.url, pollSeconds: 5, idleBackoffAfterSeconds: 0 })
    await until(() => (state.heartbeats || []).length > 0, 5000)
    const meta = (state.heartbeats[0] || {}).meta || {}
    ok('心跳上报 canOpen=false（没配目标）', meta.canOpen === false && meta.appPackage === undefined, meta)

    const res = await (async () => {
      const r = fakeRes()
      await envO.routes[0].handler(fakeReq({ url: '/relay/api/state', headers: { host: '127.0.0.1:56246' } }), r)
      return r
    })()
    ok('/state 带 app.canOpen=false', JSON.parse(res.body).app && JSON.parse(res.body).app.canOpen === false, res.body.slice(0, 200))
    envO.dispose()
  } finally {
    envO.dispose()
    relayO.server.close()
  }

  // 配了 appPackage：心跳带包名，隧道 /relay/api/open 会去拉 App。
  const state2 = freshState()
  const relayO2 = await fakeRelay(state2)
  const envO2 = makeContext()
  try {
    P.writeCredentials({ relayUrl: relayO2.url, deviceId: 'd_open2', token: 'tok-open2', name: '测试手机', kind: 'mobile' })
    M.apply(envO2.ctx, { relayUrl: relayO2.url, autostart: true, bridgeUrl: bridge.url, appPackage: 'com.deepseek.dsha', pollSeconds: 5, idleBackoffAfterSeconds: 0 })
    await until(() => (state2.heartbeats || []).length > 0, 5000)
    const meta2 = (state2.heartbeats[0] || {}).meta || {}
    ok('心跳上报 appPackage 与 canOpen=true', meta2.appPackage === 'com.deepseek.dsha' && meta2.canOpen === true, meta2)

    state2.pendingTunnels.push({ id: 'tu-1', path: '/relay/api/open' })
    const handled = await until(() => (state2.tunnelResults || []).length > 0, 9000)
    const result = (state2.tunnelResults || [])[0] || {}
    ok('网页点「打开手机 DSHA」→ 隧道被处理', handled && result.tunnelId === 'tu-1', result)
    const payload = JSON.parse(result.body || '{}')
    ok('隧道回 200 且把包名交给设备桥', result.status === 200 && payload.ok === true && payload.how === 'package', result)
    ok('设备桥收到 /app/launch?pkg=包名', bridge.calls.some((c) => c.path === '/app/launch' && c.pkg === 'com.deepseek.dsha'), bridge.calls.slice(-3))
    envO2.dispose()
  } finally {
    envO2.dispose()
    relayO2.server.close()
  }

  // 只配了深链：走 /app/open?url=
  const state3 = freshState([{ id: 'tu-2', path: '/relay/api/open' }])
  const relayO3 = await fakeRelay(state3)
  const envO3 = makeContext()
  try {
    P.writeCredentials({ relayUrl: relayO3.url, deviceId: 'd_open3', token: 'tok-open3', name: '测试手机', kind: 'mobile' })
    M.apply(envO3.ctx, { relayUrl: relayO3.url, autostart: true, bridgeUrl: bridge.url, appUrl: 'dsha://chat', pollSeconds: 5, idleBackoffAfterSeconds: 0 })
    const handled = await until(() => (state3.tunnelResults || []).length > 0, 9000)
    const payload = JSON.parse(((state3.tunnelResults || [])[0] || {}).body || '{}')
    ok('没配包名时走深链 /app/open', handled && payload.ok === true && payload.how === 'url', payload)
    ok('设备桥收到 /app/open?url=dsha://chat', bridge.calls.some((c) => c.path === '/app/open' && c.url === 'dsha://chat'), bridge.calls.slice(-3))
    envO3.dispose()
  } finally {
    envO3.dispose()
    relayO3.server.close()
  }

  // 什么都没配：从设备桥的 App 列表里自己找 DSHA 包名（以前这里永远 409）
  const state4 = freshState([{ id: 'tu-3', path: '/relay/api/open' }])
  const relayO4 = await fakeRelay(state4)
  const envO4 = makeContext()
  try {
    P.writeCredentials({ relayUrl: relayO4.url, deviceId: 'd_open4', token: 'tok-open4', name: '测试手机', kind: 'mobile' })
    M.apply(envO4.ctx, { relayUrl: relayO4.url, autostart: true, bridgeUrl: bridge.url, pollSeconds: 5, idleBackoffAfterSeconds: 0 })
    const handled = await until(() => (state4.tunnelResults || []).length > 0, 9000)
    const payload = JSON.parse(((state4.tunnelResults || [])[0] || {}).body || '{}')
    ok('没配目标也能打开：从 /app/apps 里自己找到 DSHA 包名',
      handled && payload.ok === true && payload.how === 'discovered' && payload.package === 'com.deepseek.dsha', payload)
    envO4.dispose()
  } finally {
    envO4.dispose()
    relayO4.server.close()
  }
}

// ---------- 3) 启动复原：上次被系统杀掉时正在跑的任务标 failed 并回传 ----------
relayState.pendingTasks.length = 0
relayState.reports.length = 0
relay = await fakeRelay(relayState)
P.writeCredentials({ relayUrl: relay.url, deviceId: 'd_recover', token: 'tok-recover', name: '测试手机', kind: 'mobile' })
P.appendLocalTask({ id: 't-stale', title: '上次没跑完的任务', prompt: 'x', target: 'mobile', origin: 'relay', status: 'running' })
const env4 = makeContext()
M.apply(env4.ctx, { relayUrl: relay.url, autostart: true, bridgeUrl: bridge.url })
const recovered = await until(() => P.listLocalTasks(20).some((row) => row.id === 't-stale' && row.status === 'failed'))
ok('启动时把残留 running 标成 failed', recovered, P.listLocalTasks(5))
const reported = await until(() => relayState.reports.some((row) => row.body && row.body.taskId === 't-stale' && row.body.status === 'failed'))
ok('被中断的任务会回传中继', reported, relayState.reports)
ok('上次没发出去的旧报告被重放掉', await until(() => P.listOutbox(10).length === 0), P.listOutbox(5))
ok('启动后心跳打到了中继', relay.hits.includes('/api/agent/heartbeat'), relay.hits)
env4.dispose()
relay.server.close()

// ---------- 4) 重复配对/重连不能把本进程正在跑的任务判死 ----------
relayState.pendingTasks.length = 0
relayState.reports.length = 0
P.clearCredentials()
const relay4 = await fakeRelay(relayState)
try {
  P.writeCredentials({ relayUrl: relay4.url, deviceId: 'd_live', token: 'tok-live', name: '测试手机', kind: 'mobile' })
  const env5 = makeContext()
  M.apply(env5.ctx, { relayUrl: relay4.url, autostart: true, bridgeUrl: bridge.url, pollSeconds: 5, idleBackoffAfterSeconds: 0 })
  relayState.pendingTasks.push({ id: 't-live', title: '正在跑的任务', prompt: '慢慢跑，别急' })
  const liveOk = await until(() => P.listLocalTasks(50).some((row) => row.id === 't-live' && row.status === 'running'), 9000)
  ok('中继任务投递后本地记 running', liveOk, P.listLocalTasks(5))
  // 用户又点了一次配对：startLoops 会重跑一遍 startup 复原，正在跑的任务不能被标死。
  await env5.tools.find((t) => t.name === 'relay_pair').execute({ code: 'WFQT-GRKK-L3LK', relayUrl: relay4.url })
  await sleep(300)
  const liveRow = P.listLocalTasks(50).find((row) => row.id === 't-live')
  ok('重复配对后正在跑的任务没被判 failed', liveRow && liveRow.status === 'running', liveRow)
  ok('也没有给正在跑的任务回传 failed', !relayState.reports.some((r) => r.body && r.body.taskId === 't-live' && r.body.status === 'failed'), relayState.reports)
  env5.dispose()
} finally {
  relay4.server.close()
}

// ---------- 5) 发件箱积压超过单轮上限时，最老的报告也要重放 ----------
relayState.reports.length = 0
P.clearCredentials()
const relay5 = await fakeRelay(relayState)
try {
  const seeded = []
  for (let i = 0; i < 250; i += 1) {
    const row = P.appendOutbox({ kind: 'report', taskId: 't-back-' + i, status: 'done', output: '第 ' + i + ' 条' })
    if (row) seeded.push(row)
  }
  ok('发件箱塞满 250 条积压', P.countOutbox() === 250 && seeded.length === 250, P.countOutbox())
  P.writeCredentials({ relayUrl: relay5.url, deviceId: 'd_back', token: 'tok-back', name: '测试手机', kind: 'mobile' })
  const env6 = makeContext()
  M.apply(env6.ctx, { relayUrl: relay5.url, autostart: true, bridgeUrl: bridge.url })
  const drained = await until(() => P.countOutbox() === 0, 15000)
  ok('250 条积压全部清空（单轮 200 条上限不再卡死）', drained, P.countOutbox())
  const seen = new Set(relayState.reports
    .filter((r) => r.body && typeof r.body.taskId === 'string' && r.body.taskId.startsWith('t-back-'))
    .map((r) => r.body.taskId))
  ok('最老的一条也重放了', seen.has('t-back-0'), [...seen].slice(0, 5))
  ok('最新的一条也重放了', seen.has('t-back-249'), [...seen].slice(-5))
  ok('250 条全到中继', seen.size === 250, seen.size)
  env6.dispose()
} finally {
  relay5.server.close()
}
bridge.server.close()

P.clearCredentials()
// ---------- 9) 最近 3 条会话：配对后自动同步（只入库，不投递）----------
{
  P.clearCredentials()
  const stateS = freshState()
  const relayS = await fakeRelay(stateS)
  try {
    const envS = makeContext()
    envS.ctx.sessions = { list: () => [{ id: 'sess-a' }, { id: 'sess-b' }] }
    M.apply(envS.ctx, { relayUrl: relayS.url, autostart: false, bridgeUrl: bridge.url, pollSeconds: 5, heartbeatSeconds: 600 })
    await envS.tools.find((t) => t.name === 'relay_pair').execute({ code: 'CODE-1' })
    const synced = await until(() => (stateS.sessionSyncs || []).length > 0, 3000)
    ok('配对后自动把本机会话同步到云端', synced && stateS.sessionSyncs[0].full === true, stateS.sessionSyncs)
    ok('同步的是会话快照（sessionId + 消息）',
      Array.isArray(stateS.sessionSyncs[0].sessions) && stateS.sessionSyncs[0].sessions.length === 2
      && stateS.sessionSyncs[0].sessions[0].sessionId === 'sess-a', stateS.sessionSyncs[0].sessions)
    ok('自动同步不往本机投递任何东西', envS.deliveries.length === 0, envS.deliveries.length)
    envS.emit('session/event', envS.agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    ok('一轮说完会补同步一次（防抖）', await until(() => stateS.sessionSyncs.length >= 2, 6000), stateS.sessionSyncs.length)
    envS.dispose()
  } finally {
    relayS.server.close()
    P.clearCredentials()
  }
}

// ---------- 10) 送过来的会话：本机没有就新建，有就接上，接完必须 ack ----------
{
  P.clearCredentials()
  const stateH = freshState()
  stateH.pendingHandoffs = [{ id: 'hd_7', sessionId: 'sess-hand', title: '送过来的会话', messages: [{ role: 'user', text: '接着聊这个' }] }]
  const relayH = await fakeRelay(stateH)
  try {
    const envH = makeContext()
    const made = []
    const injected = []
    const wakes = []
    const handAgent = {
      session: { id: 'sess-hand' },
      send(message, target, wakeup) { injected.push(message); wakes.push({ target, wakeup }) },
    }
    envH.ctx.get = (name) => {
      if (name !== 'sessionController') return undefined
      return {
        async list() { return { items: [] } },
        async create(input) { made.push(input); return { sessionId: input.sessionId } },
        async resolveAgent() { return handAgent },
      }
    }
    M.apply(envH.ctx, { relayUrl: relayH.url, autostart: false, bridgeUrl: bridge.url, pollSeconds: 5, heartbeatSeconds: 600 })
    await envH.tools.find((t) => t.name === 'relay_pair').execute({ code: 'CODE-1' })
    const gotH = await until(() => (stateH.handoffAcks || []).length > 0, 5000)
    ok('手机端本机没有这条会话 → 用同一个 sessionId 新建', made.length === 1 && made[0].sessionId === 'sess-hand', made)
    ok('接上后把快照内容注入新会话',
      injected.length === 1 && JSON.stringify(injected[0]).includes('送过来的会话')
      && JSON.stringify(injected[0]).includes('接着聊这个'), String(JSON.stringify(injected[0])).slice(0, 200))
    ok('传过去不唤醒 agent（wakeup=false）',
      wakes.length === 1 && wakes[0].wakeup === false, wakes)
    ok('接完回执 delivered', gotH && stateH.handoffAcks[0].id === 'hd_7' && stateH.handoffAcks[0].status === 'delivered', stateH.handoffAcks)
    envH.dispose()
  } finally {
    relayH.server.close()
    P.clearCredentials()
  }
}

// 本机已经有这条会话：直接接上，不新建
{
  P.clearCredentials()
  const stateO = freshState()
  stateO.pendingHandoffs = [{ id: 'hd_8', sessionId: 'sess-old', title: '老会话', messages: [] }]
  const relayO2 = await fakeRelay(stateO)
  try {
    const envO2 = makeContext()
    const made = []
    const injected = []
    const wakes = []
    const oldAgent = {
      session: { id: 'sess-old' },
      send(message, target, wakeup) { injected.push(message); wakes.push({ target, wakeup }) },
    }
    envO2.ctx.get = (name) => {
      if (name !== 'sessionController') return undefined
      return {
        async list() { return { items: [{ sessionId: 'sess-old', updatedAt: 1 }] } },
        async create(input) { made.push(input); return { sessionId: input.sessionId } },
        async resolveAgent() { return oldAgent },
      }
    }
    M.apply(envO2.ctx, { relayUrl: relayO2.url, autostart: false, bridgeUrl: bridge.url, pollSeconds: 5, heartbeatSeconds: 600 })
    await envO2.tools.find((t) => t.name === 'relay_pair').execute({ code: 'CODE-1' })
    const gotO2 = await until(() => (stateO.handoffAcks || []).length > 0, 5000)
    ok('手机端本机已有这条会话 → 不新建，直接接上', made.length === 0 && injected.length === 1, { made: made.length, injected: injected.length })
    ok('接上原会话也不唤醒（wakeup=false）', wakes.length === 1 && wakes[0].wakeup === false, wakes)
    ok('接上原会话后回执 delivered', gotO2 && stateO.handoffAcks[0].status === 'delivered', stateO.handoffAcks)
    envO2.dispose()
  } finally {
    relayO2.server.close()
    P.clearCredentials()
  }
}

// 同一条 handoff 被中继重投（上次 ack 丢了）：只注入一次，回执补上
{
  P.clearCredentials()
  const stateD = freshState()
  const dup = { id: 'hd_dup', sessionId: 'sess-dup', title: '重复投递', messages: [{ role: 'user', text: '只接一次' }] }
  stateD.pendingHandoffs = [dup, { ...dup }]
  const relayD = await fakeRelay(stateD)
  try {
    const envD = makeContext()
    const made = []
    const injected = []
    const wakes = []
    const dupAgent = {
      session: { id: 'sess-dup' },
      send(message, target, wakeup) { injected.push(message); wakes.push({ target, wakeup }) },
    }
    envD.ctx.get = (name) => {
      if (name !== 'sessionController') return undefined
      return {
        async list() { return { items: [] } },
        async create(input) { made.push(input); return { sessionId: input.sessionId } },
        async resolveAgent() { return dupAgent },
      }
    }
    M.apply(envD.ctx, { relayUrl: relayD.url, autostart: false, bridgeUrl: bridge.url, pollSeconds: 5, heartbeatSeconds: 600 })
    await envD.tools.find((t) => t.name === 'relay_pair').execute({ code: 'CODE-1' })
    const gotD = await until(() => (stateD.handoffAcks || []).length >= 2, 6000)
    ok('手机端同一条 handoff 重投只新建一次会话', made.length === 1, made)
    ok('手机端同一条 handoff 重投只注入一次', injected.length === 1, injected.length)
    ok('重投也只静默注入（wakeup=false）', wakes.length === 1 && wakes[0].wakeup === false, wakes)
    // 中继每轮长轮询都会把没 ack 的 handoff 再送一遍，所以回执条数取决于
    // 「测试跑到断言时已经轮询了几次」——这里只要求每条都是 delivered，不锁条数。
    ok('重投只补回执，每次都还是 delivered',
      gotD && stateD.handoffAcks.length >= 2 && stateD.handoffAcks.every((a) => a.id === 'hd_dup' && a.status === 'delivered'), stateD.handoffAcks)
    ok('回执发出去之后发件箱是空的', P.countOutbox() === 0, P.listOutbox(5))
    envD.dispose()
  } finally {
    relayD.server.close()
    P.clearCredentials()
  }
}
rmSync(home, { recursive: true, force: true })
console.log(fails.length === 0 ? String.fromCharCode(10) + '全部通过' : String.fromCharCode(10) + '失败: ' + fails.join(', '))
process.exit(fails.length === 0 ? 0 : 1)
