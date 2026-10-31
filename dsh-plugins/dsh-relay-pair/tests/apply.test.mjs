// dsh-relay-pair / tests/apply.test.mjs
//
// 不用真的 DSH：造一个最小 ctx，验证 apply() 注册了 6 个工具、/relay/api 路由、
// 能把任务投进会话、能在 turn/end 收尾，以及信任围栏生效。
//
// 跑法：ELECTRON_RUN_AS_NODE=1 '/e/Deepseek/DeepSeek Harness.exe' tests/apply.test.mjs
// （或用任意 Node 22+：node tests/apply.test.mjs）

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'relay-apply-'))
process.env.DSH_HOME = home

const P = await import('../lib/protocol.js')
const S = await import('../lib/sessions.js')
const M = await import('../lib/index.js')

const fails = []
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + JSON.stringify(extra)))
  if (!cond) fails.push(name)
}

/** 最小 ctx：够 apply() 用。
 *  options.webOrigin  —— 桩掉 ctx.webServer.getOrigin()（模拟真实监听地址）
 *  options.launchToken —— 桩掉 ctx.connection.authenticatedUrl()（DSH 的登录令牌）
 */
function makeContext(options = {}) {
  const { webOrigin, launchToken } = options
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
    get(name) {
      if (name === 'webServer' && webOrigin) {
        return {
          protocol: 'http',
          host: '127.0.0.1',
          port: Number(new URL(webOrigin).port),
          getOrigin: () => webOrigin,
          register(route) { routes.push(route) },
        }
      }
      if (name === 'connection' && launchToken) {
        return {
          authenticatedUrl(base) {
            const url = new URL(base)
            url.searchParams.set('token', launchToken)
            return url.href
          },
        }
      }
      return undefined
    },
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

/** 起一个假中继：只认 /api/device/pair，返回固定令牌。 */
async function fakeRelay() {
  const server = createServer((req, res) => {
    if (req.url === '/api/device/pair' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, deviceId: 'd_fake', deviceToken: 'tok-fake-123' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: { code: 'NO_ROUTE', message: '没有这个接口' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: 'http://127.0.0.1:' + server.address().port }
}

/** 起一个假中继：配对后每次心跳都把 body 记进 beats（验证设备上报的 meta）。 */
async function fakeHeartbeatRelay(beats) {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const body = raw ? JSON.parse(raw) : {}
      if (req.url === '/api/device/pair') {
        send(200, { ok: true, deviceId: 'd_beat', deviceToken: 'tok-beat' })
        return
      }
      if (req.url === '/api/agent/heartbeat') {
        beats.push(body)
        send(200, { ok: true, pending: 0 })
        return
      }
      if (req.url === '/api/agent/poll') {
        // 长轮询：压住一会儿再回空，别让循环把 CPU 跑满。
        setTimeout(() => send(200, { ok: true, tasks: [], tunnels: [] }), 100)
        return
      }
      send(200, { ok: true })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: 'http://127.0.0.1:' + server.address().port }
}

/**
 * 起一个假中继：令牌会「过期」—— 用旧令牌心跳/轮询一律 401，
 * 只有拿 renewSecret 走 /api/device/renew 换到的新令牌才算数。
 * 用来验「重启后令牌失效能自己接上，不用主人重新配对」。
 *  options.catalogDelay / catalog  —— 桩一个慢吞吞的 llm 服务，验心跳不等模型目录
 */
async function fakeExpiringRelay(options = {}) {
  const state = {
    // 中继这边认的令牌和本机存的不一样 —— 这就是「重启后令牌对不上」的样子。
    token: 'tok-live',
    renewSecret: 'sec-1',
    renews: [],
    beats: [],
    renewStatus: 401,
    // 目录探测慢的时候，心跳还能不能按时到达 —— 这里记时间点。
    firstBeatAt: 0,
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const body = raw ? JSON.parse(raw) : {}
      const auth = String(req.headers.authorization || '')
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (req.url === '/api/device/pair') {
        state.token = 'tok-new'
        send(200, { ok: true, deviceId: 'd_exp', deviceToken: state.token, renewSecret: state.renewSecret })
        return
      }
      if (req.url === '/api/device/renew') {
        state.renews.push(body)
        if (body.deviceId !== 'd_exp' || body.renewSecret !== state.renewSecret) {
          send(401, { ok: false, error: { code: 'RENEW_DENIED', message: '自愈券不对' } })
          return
        }
        // 换新令牌 + 轮换自愈券：旧的立刻作废（真中继就是这么做的）。
        state.token = 'tok-renewed-' + state.renews.length
        state.renewSecret = 'sec-' + (state.renews.length + 1)
        send(200, { ok: true, deviceId: 'd_exp', deviceToken: state.token, renewSecret: state.renewSecret })
        return
      }
      if (req.url === '/api/agent/heartbeat' || req.url === '/api/agent/poll') {
        if (token !== state.token) {
          send(401, { ok: false, error: { code: 'BAD_DEVICE_TOKEN', message: '设备令牌无效' } })
          return
        }
        if (req.url === '/api/agent/poll') {
          setTimeout(() => send(200, { ok: true, tasks: [], tunnels: [] }), 80)
          return
        }
        if (state.firstBeatAt === 0) state.firstBeatAt = Date.now()
        state.beats.push(body)
        send(200, { ok: true, pending: 0 })
        return
      }
      send(200, { ok: true })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, state, url: 'http://127.0.0.1:' + server.address().port }
}

/** 起一个假中继：记录会话快照同步体、handoff ack，poll 里回一批「送过去」的会话。 */
async function fakeSessionRelay(options = {}) {
  const syncs = []
  const acks = []
  const queue = (options.handoffs || []).slice()
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
      if (req.url === '/api/device/pair') {
        send(200, { ok: true, deviceId: 'd_sess', deviceToken: 'tok-sess' })
        return
      }
      if (req.url === '/api/agent/sessions/sync') {
        syncs.push(body)
        send(200, { ok: true, kept: (body.sessions || []).length, dropped: 0, limit: 3 })
        return
      }
      if (req.url === '/api/agent/handoffs/ack') {
        acks.push(body)
        send(200, { ok: true })
        return
      }
      if (req.url === '/api/agent/poll') {
        const batch = queue.splice(0, queue.length)
        send(200, { ok: true, tasks: [], tunnels: [], handoffs: batch })
        return
      }
      send(200, { ok: true })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, syncs, acks, url: 'http://127.0.0.1:' + server.address().port }
}

/** 起一个「轮询很慢」的假中继，用来数同时有几个 poll 在飞。 */
async function fakePollRelay(holdMs = 200) {
  const stats = { polls: 0, inFlight: 0, maxInFlight: 0, aborted: 0 }
  const live = new Set()
  // 客户端 abort 之后，服务端要等 FIN 到达才触发 res 的 close 事件；新一代 poll
  // 可能早那几毫秒就发出来（客户端已经 await 过旧请求，时序没问题）。所以只统计
  // 连接还活着的 poll，否则量到的是网络时延，不是客户端的并发。
  const prune = () => {
    for (const item of live) if (item.req.destroyed || item.res.destroyed) live.delete(item)
    stats.inFlight = live.size
  }
  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    req.resume()
    req.on('end', () => {
      if (req.url === '/api/device/pair') {
        send(200, { ok: true, deviceId: 'd_poll', deviceToken: 'tok-poll' })
        return
      }
      if (req.url === '/api/agent/poll') {
        prune()
        stats.polls += 1
        const entry = { req, res }
        live.add(entry)
        stats.inFlight = live.size
        if (stats.inFlight > stats.maxInFlight) stats.maxInFlight = stats.inFlight
        let finished = false
        const release = () => {
          if (finished) return
          finished = true
          live.delete(entry)
          stats.inFlight = live.size
        }
        // 客户端 abort 断开时立刻销账，才能看出「旧循环真的被中止了」。
        res.on('close', () => {
          if (!finished) stats.aborted += 1
          release()
        })
        setTimeout(() => {
          release()
          if (res.destroyed) return
          send(200, { ok: true, tasks: [], tunnels: [] })
        }, holdMs)
        return
      }
      send(200, { ok: true })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, stats, url: 'http://127.0.0.1:' + server.address().port }
}

/** 起一个前几次 /api/agent/report 都 500 的假中继，验证结果会进发件箱并重放。 */
async function fakeFlakyReportRelay(failTimes = 2, tasks = []) {
  const reports = []
  let polls = 0
  let failsLeft = failTimes
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.url === '/api/agent/report') {
        const entry = raw ? JSON.parse(raw) : {}
        const accepted = failsLeft <= 0
        if (!accepted) failsLeft -= 1
        reports.push({ entry, accepted })
        if (accepted) send(200, { ok: true })
        else send(503, { ok: false, error: { code: 'BUSY', message: '暂时不可用' } })
        return
      }
      if (req.url === '/api/agent/poll') {
        polls += 1
        // 只在第一轮派任务，之后空转（慢一点回，别让轮询空转打满 CPU）。
        setTimeout(() => send(200, { ok: true, tasks: polls === 1 ? tasks : [], tunnels: [] }), 50)
        return
      }
      send(200, { ok: true })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, reports, url: 'http://127.0.0.1:' + server.address().port }
}

/** 起一个会派隧道帧的假中继：只派一次，收回来的结果存在 results 里。 */
async function fakeTunnelRelay(tunnels) {
  const results = []
  let polls = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.url === '/api/device/pair') {
        send(200, { ok: true, deviceId: 'd_tunnel', deviceToken: 'tok-tunnel' })
        return
      }
      if (req.url === '/api/agent/poll') {
        polls += 1
        setTimeout(() => send(200, {
          ok: true,
          tasks: [],
          tunnels: polls === 1 ? tunnels : [],
        }), 20)
        return
      }
      if (req.url === '/api/agent/tunnel/result') {
        results.push(raw ? JSON.parse(raw) : {})
        send(200, { ok: true })
        return
      }
      send(200, { ok: true })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, results, url: 'http://127.0.0.1:' + server.address().port }
}

/** 假 sessionController：能新建会话、能按 id 拿 agent，记录每个会话收到的消息。 */
function fakeSessionController() {
  const sessions = []
  const created = []
  const agents = new Map()
  let seq = 0
  const ctrl = {
    async list() { return { items: sessions.map((item) => ({ ...item })) } },
    async create(input) {
      created.push(input || {})
      const sessionId = String((input && input.sessionId) || '') || 'sess-auto-' + (++seq)
      sessions.push({ sessionId, updatedAt: Date.now() })
      return { sessionId }
    },
    async resolveAgent(sessionId) {
      if (!agents.has(sessionId)) {
        const box = []
        agents.set(sessionId, {
          session: { id: sessionId },
          box,
          followup(message) { box.push(message) },
        })
      }
      return agents.get(sessionId)
    },
  }
  return { ctrl, created, sessions, agents }
}

/** 起一个假中继：poll 领任务、report 记流水，可随时 push 新任务。 */
async function fakeTaskRelay(initial) {
  const queue = (initial || []).slice()
  const reports = []
  let polls = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
      if (req.url === '/api/device/pair') {
        send(200, { ok: true, deviceId: 'd_iso', deviceToken: 'tok-iso' })
        return
      }
      if (req.url === '/api/agent/poll') {
        polls += 1
        const batch = queue.splice(0, queue.length)
        setTimeout(() => send(200, { ok: true, tasks: batch, tunnels: [], handoffs: [], peers: [] }),
          batch.length > 0 ? 0 : 30)
        return
      }
      if (req.url === '/api/agent/report') {
        reports.push(body)
        send(200, { ok: true, taskId: body.taskId, status: body.status })
        return
      }
      if (req.url === '/api/agent/heartbeat') {
        send(200, { ok: true, pending: 0 })
        return
      }
      send(200, { ok: true })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    reports,
    url: 'http://127.0.0.1:' + server.address().port,
    push(task) { queue.push(task) },
    polls() { return polls },
  }
}

/** 等一个条件成立（轮询几十毫秒），用于验证后台循环的行为。 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

/** 造一个够 readJsonBody 用的请求对象。 */
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

/** 打本机的 /relay/api/state，拿 JSON 状态（relay_status 返回的是给人看的文本）。 */
async function readState(env) {
  const route = env.routes[0]
  const res = fakeRes()
  await route.handler(fakeReq({ url: '/relay/api/state', headers: { host: '127.0.0.1:56246' } }), res)
  try {
    return JSON.parse(res.body)
  } catch {
    return null
  }
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

// ---------- 1) 未配对：工具齐全、还能本地派活 ----------
const env1 = makeContext()
M.apply(env1.ctx, { relayUrl: '', autostart: true })

const names = env1.tools.map((t) => t.name).sort()
ok('注册 6 个工具', JSON.stringify(names) === JSON.stringify(
  ['relay_pair', 'relay_status', 'relay_sync_task', 'relay_task_add', 'relay_tasks',
    'relay_unpair']), names)
ok('每个工具都有 description 与 parameters', env1.tools.every((t) => typeof t.description === 'string' && t.parameters && t.parameters.type === 'object'), names)
ok('relay_pair 必填 code', (() => {
  const t = env1.tools.find((x) => x.name === 'relay_pair')
  return t && t.parameters.required && t.parameters.required.includes('code') && t.parameters.properties.code.type === 'string'
})())
ok('注册 /relay/api 路由', env1.routes.length === 1 && env1.routes[0].path === '/relay/api' && env1.routes[0].kind === 'prefix', env1.routes.map((r) => r.path))

const status = env1.tools.find((t) => t.name === 'relay_status')
const statusText = await status.execute({})
ok('未配对时 relay_status 提示先配对', /未配对/.test(statusText), statusText)

const add = env1.tools.find((t) => t.name === 'relay_task_add')
const addText = await add.execute({ prompt: '统计一下今天的工作量' })
ok('未配对时 relay_task_add 直接投本机', /直接投给本机会话/.test(addText) && env1.deliveries.length === 1, { addText, n: env1.deliveries.length })
const injected = env1.deliveries[0]
const injectedText = (injected.content ?? []).map((b) => b.text ?? '').join('')
ok('注入消息带 prompt', injectedText.includes('统计一下今天的工作量'), injectedText.slice(0, 120))
ok('注入消息标注来源插件', injected.source && injected.source.kind === 'plugin:dsh-relay-pair', injected.source)

// 收尾：assistant/message → turn/end 要把挂起的轮次清掉
env1.emit('session/event', env1.agent.session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '今天干了三件事' }] } } })
env1.emit('session/event', env1.agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
ok('turn/end 后挂起清空（本地流水留下结果）', env1.deliveries.length === 1 && (() => {
  const rows = P.listLocalTasks(5)
  return rows.some((r) => r.status === 'done' && String(r.output ?? '').includes('三件事'))
})(), P.listLocalTasks(5))

ok('本地流水的结果行保留了任务标题', (() => {
  const done = P.listLocalTasks(5).find((r) => r.status === 'done')
  return Boolean(done) && String(done.title ?? '').includes('统计一下今天的工作量')
})(), P.listLocalTasks(5))

const statusOne = await env1.tools.find((t) => t.name === 'relay_status').execute({})
const titleHits = String(statusOne).split('\n').filter((line) => line.includes('统计一下今天的工作量')).length
ok('relay_status 的最近任务按任务折叠（同一任务只占一行）', titleHits === 1, { titleHits, statusOne, rows: P.listLocalTasks(5) })

// HTTP 路由：信任围栏 + 状态
const route = env1.routes[0]
async function hit(headers, method = 'GET', body) {
  const res = fakeRes()
  const req = { url: '/relay/api/state', method, headers, on() {}, destroy() {} }
  await route.handler(req, res)
  return res
}
let res = await hit({ host: '127.0.0.1:56246' })
ok('本机 loopback 访问 /relay/api/state → 200', res.statusCode === 200 && JSON.parse(res.body).ok === true, res.body.slice(0, 120))
res = await hit({ host: 'evil.example.com' })
ok('外部 Host 被拒 → 403', res.statusCode === 403, res.body)
res = await hit({ host: '127.0.0.1:56246', 'sec-fetch-site': 'cross-site' })
ok('cross-site 被拒 → 403', res.statusCode === 403, res.body)
res = await hit({ host: '127.0.0.1:56246', origin: 'http://127.0.0.1:56246' })
ok('同源 Origin 放行 → 200', res.statusCode === 200, res.body.slice(0, 120))
res = await hit({ host: '127.0.0.1:56246', origin: 'http://evil.example.com' })
ok('跨站 Origin 被拒 → 403', res.statusCode === 403, res.body)

// 设置页配对：POST /relay/api/pair → 换令牌 → 落盘 → 返回设备信息
const relay = await fakeRelay()
try {
  const pairRes = fakeRes()
  await route.handler(fakeReq({
    url: '/relay/api/pair',
    method: 'POST',
    headers: { host: '127.0.0.1:56246', 'content-type': 'application/json' },
    json: { code: 'WFQT-GRKK-L3LK', relayUrl: relay.url, name: '设置页配对' },
  }), pairRes)
  const pairBody = JSON.parse(pairRes.body || '{}')
  ok('设置页调用 /relay/api/pair 成功', pairRes.statusCode === 200 && pairBody.ok === true &&
    pairBody.device && pairBody.device.id === 'd_fake', pairRes.body)
  const stored = P.readCredentials()
  ok('配对后凭据落盘', stored && stored.deviceId === 'd_fake' && stored.token === 'tok-fake-123', stored)

  const stateRes = fakeRes()
  await route.handler(fakeReq({ url: '/relay/api/state', headers: { host: '127.0.0.1:56246' } }), stateRes)
  const stateBody = JSON.parse(stateRes.body || '{}')
  ok('状态里显示已配对', stateBody.relay && stateBody.relay.paired === true &&
    stateBody.device && stateBody.device.id === 'd_fake', stateBody.relay)
  ok('配对时同时留了备份', existsSync(P.credentialsBackupPath()) &&
    JSON.parse(readFileSync(P.credentialsBackupPath(), 'utf8')).deviceId === 'd_fake')
  ok('状态里报了凭据来源与路径', stateBody.relay.credsSource === 'pair' &&
    stateBody.relay.credsPath === P.credentialsPath(), stateBody.relay)

  const badRes = fakeRes()
  await route.handler(fakeReq({
    url: '/relay/api/pair',
    method: 'POST',
    headers: { host: '127.0.0.1:56246', 'content-type': 'application/json' },
    json: { code: '', relayUrl: relay.url },
  }), badRes)
  const badBody = JSON.parse(badRes.body || '{}')
  ok('空配对码 → 400 且给出原因', badRes.statusCode === 400 &&
    String(badBody.error && badBody.error.message).includes('配对码'), badRes.body)

  // GET 能解绑等于给了任何页面一个坑：必须先挡住。
  const getUnpairRes = fakeRes()
  await route.handler(fakeReq({ url: '/relay/api/unpair', method: 'GET', headers: { host: '127.0.0.1:56246' } }), getUnpairRes)
  ok('GET /relay/api/unpair → 405 且凭据还在', getUnpairRes.statusCode === 405 && P.readCredentials() !== null, getUnpairRes.body)

  const unpairRes = fakeRes()
  await route.handler(fakeReq({ url: '/relay/api/unpair', method: 'POST', headers: { host: '127.0.0.1:56246' } }), unpairRes)
  ok('设置页断开配对', JSON.parse(unpairRes.body || '{}').ok === true && P.readCredentials() === null, unpairRes.body)
} finally {
  relay.server.close()
}

env1.dispose()

// ---------- 1b) 主文件丢了：靠备份自动接上（「重启后要重新配对」就断在这一步）----------
P.writeCredentials({ relayUrl: 'http://127.0.0.1:1', deviceId: 'd_restore', token: 'tok-restore', name: '备份本机', kind: 'desktop' })
unlinkSync(P.credentialsPath())
const envB = makeContext()
M.apply(envB.ctx, { relayUrl: 'http://127.0.0.1:1', autostart: false })
const stateBRes = fakeRes()
await envB.routes[0].handler(fakeReq({ url: '/relay/api/state', headers: { host: '127.0.0.1:56246' } }), stateBRes)
const stateB = JSON.parse(stateBRes.body || '{}')
ok('主文件没了启动时用备份接上', stateB.relay && stateB.relay.paired === true && stateB.relay.credsSource === 'backup', stateB.relay)
ok('接上后主文件被写回', P.readCredentials() !== null && P.readCredentials().deviceId === 'd_restore')
ok('启动时写了对账日志', existsSync(join(home, 'relay-pair.log')) &&
  readFileSync(join(home, 'relay-pair.log'), 'utf8').includes('"event":"apply"'), join(home, 'relay-pair.log'))
envB.dispose()
P.clearCredentials()

// ---------- 2) 已配对（autostart=false，不起网络循环）----------
P.writeCredentials({ relayUrl: 'http://127.0.0.1:1', deviceId: 'dev-test', token: 'tok-test', name: '测试本机', kind: 'desktop' })
const env2 = makeContext()
M.apply(env2.ctx, { relayUrl: 'http://127.0.0.1:1', autostart: false, localExec: true })
const status2 = env2.tools.find((t) => t.name === 'relay_status')
const text2 = await status2.execute({})
ok('已配对时 relay_status 显示设备与不可达', /测试本机/.test(text2) && /不可达|不可/.test(text2), text2.split('\n').slice(0, 3))

const unpair = env2.tools.find((t) => t.name === 'relay_unpair')
await unpair.execute({})
ok('relay_unpair 清掉凭据', P.readCredentials() === null && /已断开|没有配对/.test(await unpair.execute({})))

// ---------- 3) localExec=false 不接活（未配对，走本机直投路径）----------
P.clearCredentials()
const env3 = makeContext()
M.apply(env3.ctx, { relayUrl: 'http://127.0.0.1:1', autostart: false, localExec: false })
const add3 = env3.tools.find((t) => t.name === 'relay_task_add')
let blocked = ''
try {
  await add3.execute({ prompt: '不该跑的任务' })
} catch (error) {
  blocked = error.message
}
ok('localExec=false 时拒绝接活', /localExec=false/.test(blocked) && env3.deliveries.length === 0, blocked)
env3.dispose()
P.clearCredentials()

// ---------- 4) 本机 Web 地址：要带 launch token，不能是写死的 56246 ----------
// 网页「打开本机 DSH」用的就是 localState().web.url；端口每次启动都会变，
// 而且不带 ?token= 一律 401，所以这里两件事都要钉住。
const env4 = makeContext({ webOrigin: 'http://127.0.0.1:60422', launchToken: 'tok-launch-abc' })
M.apply(env4.ctx, { relayUrl: 'http://127.0.0.1:1', autostart: false })
const route4 = env4.routes[0]
const state4 = fakeRes()
await route4.handler(fakeReq({ url: '/relay/api/state', headers: { host: '127.0.0.1:60422' } }), state4)
const body4 = JSON.parse(state4.body || '{}')
ok('state.web.origin 用真实监听地址', body4.web && body4.web.origin === 'http://127.0.0.1:60422', body4.web)
// 这份 JSON 会经 /api/agent/state 与隧道回吐给网页：带 token 就等于把本机登录口令交出去了，
// 所以 web.url 只能是 origin，用户点进去自己登录。
ok('state.web.url 只有 origin，不带令牌', body4.web && body4.web.url === 'http://127.0.0.1:60422', body4.web)
ok('整个 state JSON 里都不出现令牌', !String(JSON.stringify(body4)).includes('tok-launch-abc'), body4.web)
ok('state.web.url 不再是 56246', !String(JSON.stringify(body4.web)).includes('56246'), body4.web)
// 网页「打开本机 DSH」现在指向本机中转页：跨站直接跳带令牌地址会 401（SameSite=Strict）。
ok('state.web.entry 是本机中转页（不带令牌）',
  body4.web && body4.web.entry === 'http://127.0.0.1:60422/relay/api/enter', body4.web)
ok('中转页地址里没有令牌', body4.web && !String(body4.web.entry).includes('token'), body4.web)

// 中转页本身：跨站也能打开（它就是被中继网页跨站跳过来的），页面自己同站 replace。
{
  const page = fakeRes()
  await route4.handler(fakeReq({
    url: '/relay/api/enter',
    headers: { host: '127.0.0.1:60422', 'sec-fetch-site': 'cross-site' },
  }), page)
  const html = String(page.body || '')
  ok('中转页返回 HTML', page.statusCode === 200
    && String(page.headers['Content-Type'] || '').startsWith('text/html'), page.headers)
  ok('中转页同站 replace 到带令牌地址（相对路径）',
    html.includes('location.replace("/?token=tok-launch-abc")'), html.slice(-300))
  ok('中转页留了手动入口', html.includes('id="go"') && html.includes('href="/?token=tok-launch-abc"'), html.slice(-300))
  ok('中转页不写死 127.0.0.1（隧道下会跳到手机自己）', !html.includes('http://127.0.0.1:60422'), html.slice(-300))
  ok('中转页不缓存', page.headers['Cache-Control'] === 'no-store', page.headers)

  const body = fakeRes()
  await route4.handler(fakeReq({ url: '/relay/api/enter', method: 'POST', headers: { host: '127.0.0.1:60422' } }), body)
  ok('中转页只认 GET/HEAD', body.statusCode === 405 && /GET only/.test(body.body), body.body)

  const foreign = fakeRes()
  await route4.handler(fakeReq({ url: '/relay/api/enter', headers: { host: 'evil.example.com' } }), foreign)
  ok('中转页非回环 Host 被拒', foreign.statusCode === 403, foreign.body)
}

// 隧道场景：Host 是配置里那条公网主机名 → 放行；别的主机照旧 403。
{
  const envT = makeContext({ webOrigin: 'http://127.0.0.1:60422', launchToken: 'tok-launch-abc' })
  M.apply(envT.ctx, {
    relayUrl: 'http://127.0.0.1:1',
    autostart: false,
    webTunnel: {
      enabled: true,
      sshHost: '203.0.113.10',
      keyPath: 'C:/keys/id_ed25519',
      publicUrl: 'https://dsh-tunnel.example.com',
    },
  })
  const routeT = envT.routes.find((route) => route.path === '/relay/api')
  const viaTunnel = fakeRes()
  await routeT.handler(fakeReq({ url: '/relay/api/enter', headers: { host: 'dsh-tunnel.example.com' } }), viaTunnel)
  ok('隧道 Host 能打开中转页', viaTunnel.statusCode === 200
    && String(viaTunnel.body).includes('location.replace("/?token=tok-launch-abc")'), viaTunnel.body)
  const stranger = fakeRes()
  await routeT.handler(fakeReq({ url: '/relay/api/enter', headers: { host: 'evil.example.com' } }), stranger)
  ok('隧道以外的主机名还是 403', stranger.statusCode === 403, stranger.body)
  envT.dispose()
}

// 心跳上报的 meta.webUrl 也要是中转页，绝不能带令牌
{
  const envMeta = makeContext({ webOrigin: 'http://127.0.0.1:60422', launchToken: 'tok-launch-abc' })
  const beats = []
  const relay = await fakeHeartbeatRelay(beats)
  M.apply(envMeta.ctx, { relayUrl: relay.url, autostart: false })
  await envMeta.tools.find((t) => t.name === 'relay_pair').execute({ code: 'AAAA-BBBB' })
  await waitFor(() => beats.length > 0, 2000)
  const meta = (beats[0] && beats[0].meta) || {}
  ok('心跳上报 webUrl 是中转页', meta.webUrl === 'http://127.0.0.1:60422/relay/api/enter', meta)
  ok('心跳 meta 里没有令牌', !JSON.stringify(meta).includes('tok-launch-abc'), meta)
  envMeta.dispose()
  relay.server.close()
  P.clearCredentials()
  await new Promise((resolve) => setTimeout(resolve, 60))
}

const status4 = await env4.tools.find((t) => t.name === 'relay_status').execute({})
ok('relay_status 显示本机 Web 地址', /60422/.test(String(status4)), String(status4).slice(0, 300))
env4.dispose()

// 拿不到 webServer 时也要能降级，而不是抛错
const env5 = makeContext()
M.apply(env5.ctx, { relayUrl: 'http://127.0.0.1:1', autostart: false })
const state5 = fakeRes()
await env5.routes[0].handler(fakeReq({ url: '/relay/api/state', headers: { host: '127.0.0.1:56246' } }), state5)
const body5 = JSON.parse(state5.body || '{}')
ok('没有 webServer 时不崩，退回兜底地址', state5.statusCode === 200 && typeof (body5.web && body5.web.origin) === 'string' && body5.web.origin.length > 0, body5.web)
env5.dispose()

// ---------- 5) 同会话排队：一单没结算，第二单不能并排跑 ----------
{
  P.clearCredentials()
  const env5q = makeContext({ webOrigin: 'http://127.0.0.1:60423' })
  M.apply(env5q.ctx, { relayUrl: '', autostart: false })
  const route5q = env5q.routes[0]
  const submit = async (prompt) => {
    const res5 = fakeRes()
    await route5q.handler(fakeReq({
      url: '/relay/api/submit',
      method: 'POST',
      headers: { host: '127.0.0.1:60423', 'content-type': 'application/json' },
      json: { prompt },
    }), res5)
    return { status: res5.statusCode, body: JSON.parse(res5.body || '{}') }
  }
  const first = await submit('第一单')
  const second = await submit('第二单')
  ok('第一单直接投进会话', first.status === 200 && first.body.ok === true && !first.body.queued, first)
  ok('同会话第二单排队而不是并排跑', second.status === 200 && second.body.queued === true && env5q.deliveries.length === 1, second)
  // 收尾第一单：队列里的第二单要立刻接上
  env5q.emit('session/event', env5q.agent.session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '第一单结果' }] } } })
  env5q.emit('session/event', env5q.agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  ok('第一单结算后自动投第二单', env5q.deliveries.length === 2 &&
    JSON.stringify(env5q.deliveries[1]).includes('第二单'), env5q.deliveries.length)
  ok('第一单结果记到自己那一行', P.listLocalTasks(5).some((r) => String(r.title).includes('第一单') && r.status === 'done'), P.listLocalTasks(5).length)
  // 第二单还在跑、再派第三单排队 → 插件停止：排队那单必须清掉并记成 failed，
  // 不能留一个永远没人跑的挂号任务。
  const third = await submit('第三单')
  ok('第三单进队列', third.body.queued === true, third)
  env5q.dispose()
  await new Promise((resolve) => setTimeout(resolve, 80))
  ok('停止时排队任务被记成 failed',
    P.listLocalTasks(10).some((r) => String(r.title).includes('第三单') && r.status === 'failed'),
    P.listLocalTasks(10).map((r) => r.title + ':' + r.status))
  P.clearCredentials()
}

// ---------- 6) 重配对不能留下两个 poll；停止要真的中止在途请求 ----------
// 以前 startLoops 只置 stopped 就起新循环，旧循环还挂在 fetch 上，重配对后两个 poll
// 同时领任务；stopLoops 也不 await，关插件后请求还在飞。
{
  P.clearCredentials()
  const relay8 = await fakePollRelay(150)
  try {
    const env8 = makeContext()
    M.apply(env8.ctx, { relayUrl: relay8.url, autostart: false, pollSeconds: 5, heartbeatSeconds: 600 })
    const pair8 = env8.tools.find((t) => t.name === 'relay_pair')
    await pair8.execute({ code: 'CODE-1' })
    ok('配对后开始长轮询', await waitFor(() => relay8.stats.polls >= 1), relay8.stats)
    // 同一套 ctx 再配一次：这就是「重配对」。
    await pair8.execute({ code: 'CODE-2' })
    await waitFor(() => relay8.stats.polls >= 4)
    ok('重配对后同一时刻只有一次 poll 在飞', relay8.stats.maxInFlight <= 1, relay8.stats)
    ok('重配对会中止旧循环的在途请求', relay8.stats.aborted >= 1, relay8.stats)
    env8.dispose()
    const quiet = await waitFor(() => relay8.stats.inFlight === 0)
    ok('停止后没有残留的在途 poll', quiet && relay8.stats.inFlight === 0, relay8.stats)
  } finally {
    relay8.server.close()
    P.clearCredentials()
  }
}

// ---------- 7) 上报失败进发件箱，退避后补发 ----------
// reportTask 以前 catch 里只 warn：网络一抖结果就永久丢，中继那头一直 running。
{
  P.clearCredentials()
  const relay9 = await fakeFlakyReportRelay(2, [{ id: 91, title: '会失败的一单', prompt: '干活' }])
  P.writeCredentials({ relayUrl: relay9.url, deviceId: 'd_out', token: 'tok-out', name: '发件箱', kind: 'desktop' })
  try {
    const env9 = makeContext()
    M.apply(env9.ctx, { relayUrl: relay9.url, autostart: true, pollSeconds: 5, heartbeatSeconds: 600 })
    const attempted = await waitFor(() => relay9.reports.some((r) => r.entry.taskId === 91))
    ok('任务投递后会上报 running', attempted, relay9.reports.length)
    ok('第一次上报失败（假中继 503）', relay9.reports.some((r) => r.entry.taskId === 91 && !r.accepted), relay9.reports.map((r) => r.accepted))
    const replayed = await waitFor(() => relay9.reports.some((r) => r.accepted && r.entry.taskId === 91 && r.entry.status === 'running'))
    ok('失败的上报会从发件箱补发成功', replayed, relay9.reports)
    env9.dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    relay9.server.close()
    P.clearCredentials()
  }
}

// ---------- 8) 隧道穿越：白名单路径之外的帧一律 403 ----------
// 以前 hostUrl 用 new URL(path, origin)，.. / %2e%2e 会被规范化消解，前缀白名单形同虚设；
// 中继侧任何人发一帧就能读写本机全部 HTTP 接口。
{
  P.clearCredentials()
  const relay10 = await fakeTunnelRelay([
    { id: 't1', path: '/api/../../evil', method: 'GET' },
    { id: 't2', path: '/api/%2e%2e/x', method: 'GET' },
    { id: 't3', path: '//evil.example.com/x', method: 'GET' },
    { id: 't4', path: '/etc/passwd', method: 'GET' },
    { id: 't5', path: '/relay/api/state?x=1', method: 'GET' },
  ])
  P.writeCredentials({ relayUrl: relay10.url, deviceId: 'd_tunnel', token: 'tok-tunnel', name: '隧道', kind: 'desktop' })
  try {
    const launch = 'tok-launch-tunnel'
    const env10 = makeContext({ webOrigin: 'http://127.0.0.1:60430', launchToken: launch })
    M.apply(env10.ctx, { relayUrl: relay10.url, autostart: true, pollSeconds: 5, heartbeatSeconds: 600 })
    const got10 = await waitFor(() => relay10.results.length >= 5, 5000)
    ok('五个隧道帧都有回执', got10, relay10.results.length)
    const byId = new Map(relay10.results.map((r) => [r.tunnelId, r]))
    ok('穿越路径被 403 挡住', ['t1', 't2', 't3', 't4'].every((id) => byId.has(id) && byId.get(id).status === 403),
      relay10.results.map((r) => r.tunnelId + ':' + r.status))
    ok('穿越路径的错误码是 PATH_NOT_ALLOWED', ['t1', 't2', 't3', 't4'].every((id) => String((byId.get(id) || {}).body).includes('PATH_NOT_ALLOWED')),
      String((byId.get('t1') || {}).body).slice(0, 120))
    ok('白名单路径带 query 也照常处理', byId.has('t5') && byId.get('t5').status === 200, byId.get('t5'))
    ok('隧道回执里不含登录令牌', !JSON.stringify(relay10.results).includes(launch), 'leak')
    env10.dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    relay10.server.close()
    P.clearCredentials()
  }
}

// ---------- 9) 最近 8 条会话：配对后自动同步到云端（只入库，不投递）----------
{
  P.clearCredentials()
  const relay16 = await fakeSessionRelay()
  try {
    const env16 = makeContext()
    env16.ctx.sessions = { list: () => [{ id: 'sess-a' }, { id: 'sess-b' }] }
    M.apply(env16.ctx, { relayUrl: relay16.url, autostart: false, pollSeconds: 5, heartbeatSeconds: 600 })
    const pair16 = env16.tools.find((t) => t.name === 'relay_pair')
    await pair16.execute({ code: 'CODE-1' })
    const synced = await waitFor(() => relay16.syncs.length > 0, 3000)
    ok('配对后自动把本机会话同步到云端', synced && relay16.syncs[0].full === true, relay16.syncs[0])
    ok('同步的是会话快照（sessionId + 标题 + 消息）',
      Array.isArray(relay16.syncs[0].sessions) && relay16.syncs[0].sessions.length === 2
      && relay16.syncs[0].sessions[0].sessionId === 'sess-a', relay16.syncs[0].sessions)
    ok('自动同步不往本机投递任何东西', env16.deliveries.length === 0, env16.deliveries.length)
    env16.emit('session/event', env16.agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    const again = await waitFor(() => relay16.syncs.length >= 2, 6000)
    ok('一轮说完会补同步一次（防抖）', again, relay16.syncs.length)
    env16.dispose()
  } finally {
    relay16.server.close()
    P.clearCredentials()
  }
}

// sessionSnapshot=false：不自动上报（有人只想手动用中继）
{
  P.clearCredentials()
  const relay17 = await fakeSessionRelay()
  try {
    const env17 = makeContext()
    env17.ctx.sessions = { list: () => [{ id: 'sess-a' }] }
    M.apply(env17.ctx, { relayUrl: relay17.url, autostart: false, pollSeconds: 5, heartbeatSeconds: 600, sessionSnapshot: false })
    await env17.tools.find((t) => t.name === 'relay_pair').execute({ code: 'CODE-1' })
    await new Promise((resolve) => setTimeout(resolve, 400))
    ok('sessionSnapshot=false 时不上报会话快照', relay17.syncs.length === 0, relay17.syncs.length)
    env17.dispose()
  } finally {
    relay17.server.close()
    P.clearCredentials()
  }
}

// 本机 12 条会话 → 只上报 8 条（主人要 5~8，取上限 8）
{
  P.clearCredentials()
  const relayCap = await fakeSessionRelay()
  try {
    const envCap = makeContext()
    envCap.ctx.sessions = { list: () => Array.from({ length: 12 }, (_, i) => ({ id: 'sess-cap-' + i })) }
    M.apply(envCap.ctx, { relayUrl: relayCap.url, autostart: false, pollSeconds: 5, heartbeatSeconds: 600 })
    await envCap.tools.find((t) => t.name === 'relay_pair').execute({ code: 'CODE-1' })
    const syncedCap = await waitFor(() => relayCap.syncs.length > 0, 3000)
    const sentCap = ((relayCap.syncs[0] || {}).sessions) || []
    ok('本机 12 条会话只上报 8 条', syncedCap && sentCap.length === 8, sentCap.length)
    ok('上报条数与协议常量对齐（8）', sentCap.length === S.MAX_SNAPSHOT_SESSIONS, S.MAX_SNAPSHOT_SESSIONS)
    envCap.dispose()
  } finally {
    relayCap.server.close()
    P.clearCredentials()
  }
}

// 归档（回档）的会话不算「最近」：主人收起来的东西不该再冒出来
{
  P.clearCredentials()
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    global: { archivedSessionIds: ['sess-arch'], pinnedSessionIds: [] },
  }))
  const relayArch = await fakeSessionRelay()
  try {
    const envArch = makeContext()
    envArch.ctx.sessions = { list: () => [{ id: 'sess-arch' }, { id: 'sess-live' }] }
    M.apply(envArch.ctx, { relayUrl: relayArch.url, autostart: false, pollSeconds: 5, heartbeatSeconds: 600 })
    await envArch.tools.find((t) => t.name === 'relay_pair').execute({ code: 'CODE-1' })
    const syncedArch = await waitFor(() => relayArch.syncs.length > 0, 3000)
    const idsArch = (((relayArch.syncs[0] || {}).sessions) || []).map((s) => s.sessionId)
    ok('归档的会话不上报，只报没归档的',
      syncedArch && idsArch.includes('sess-live') && !idsArch.includes('sess-arch'), idsArch)
    ok('readArchivedIds 读到了 workspace.json 里的归档名单',
      S.readArchivedIds().has('sess-arch'), [...S.readArchivedIds()])
    envArch.dispose()
  } finally {
    relayArch.server.close()
    rmSync(join(home, 'storages'), { recursive: true, force: true })
    P.clearCredentials()
  }
}

// ---------- 10) 送过来的会话：本机没有就新建，有就接上，接完必须 ack ----------
{
  P.clearCredentials()
  const handoff = {
    id: 'hd_9', sessionId: 'sess-hand', title: '送过来的会话',
    messages: [{ role: 'user', text: '接着聊这个' }],
  }
  const relay18 = await fakeSessionRelay({ handoffs: [handoff] })
  try {
    const env18 = makeContext()
    const made = []
    const injected = []
    const wakes = []
    const handAgent = {
      session: { id: 'sess-hand' },
      send(message, target, wakeup) { injected.push(message); wakes.push({ target, wakeup }) },
    }
    env18.ctx.get = (name) => {
      if (name !== 'sessionController') return undefined
      return {
        async list() { return { items: [] } },
        async create(input) { made.push(input); return { sessionId: input.sessionId } },
        async resolveAgent() { return handAgent },
      }
    }
    M.apply(env18.ctx, { relayUrl: relay18.url, autostart: false, pollSeconds: 5, heartbeatSeconds: 600 })
    await env18.tools.find((t) => t.name === 'relay_pair').execute({ code: 'CODE-1' })
    const got18 = await waitFor(() => relay18.acks.length > 0, 4000)
    ok('本机没有这条会话 → 用同一个 sessionId 新建', made.length === 1 && made[0].sessionId === 'sess-hand', made)
    ok('接上后把快照内容注入新会话',
      injected.length === 1 && JSON.stringify(injected[0]).includes('送过来的会话')
      && JSON.stringify(injected[0]).includes('接着聊这个'), String(JSON.stringify(injected[0])).slice(0, 200))
    // 主人要求：传递对话只搬记录，不许自己开跑 —— 所以必须是 wakeup=false。
    ok('传过去不唤醒 agent（wakeup=false）',
      wakes.length === 1 && wakes[0].wakeup === false, wakes)
    ok('接完回执 delivered（中继不用再重发）', got18 && relay18.acks[0].id === 'hd_9' && relay18.acks[0].status === 'delivered', relay18.acks)
    env18.dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    relay18.server.close()
    P.clearCredentials()
  }
}

// 本机已经有这条会话：直接接上，不新建
{
  P.clearCredentials()
  const relay19 = await fakeSessionRelay({ handoffs: [{ id: 'hd_11', sessionId: 'sess-old', title: '老会话', messages: [] }] })
  try {
    const env19 = makeContext()
    const made = []
    const injected = []
    const wakes = []
    const oldAgent = {
      session: { id: 'sess-old' },
      send(message, target, wakeup) { injected.push(message); wakes.push({ target, wakeup }) },
    }
    env19.ctx.get = (name) => {
      if (name !== 'sessionController') return undefined
      return {
        async list() { return { items: [{ sessionId: 'sess-old', updatedAt: 1 }] } },
        async create(input) { made.push(input); return { sessionId: input.sessionId } },
        async resolveAgent() { return oldAgent },
      }
    }
    M.apply(env19.ctx, { relayUrl: relay19.url, autostart: false, pollSeconds: 5, heartbeatSeconds: 600 })
    await env19.tools.find((t) => t.name === 'relay_pair').execute({ code: 'CODE-1' })
    const got19 = await waitFor(() => relay19.acks.length > 0, 4000)
    ok('本机已有这条会话 → 不新建，直接接上', made.length === 0 && injected.length === 1, { made: made.length, injected: injected.length })
    ok('接上原会话后回执 delivered', got19 && relay19.acks[0].status === 'delivered', relay19.acks)
    ok('接上原会话也不唤醒（wakeup=false）',
      wakes.length === 1 && wakes[0].wakeup === false, wakes)
    env19.dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    relay19.server.close()
    P.clearCredentials()
  }
}

// 同一条 handoff 被中继重投（上次 ack 丢了）：只注入一次，回执补上
{
  P.clearCredentials()
  const dup = { id: 'hd_dup', sessionId: 'sess-dup', title: '重复投递', messages: [{ role: 'user', text: '只接一次' }] }
  const relay20 = await fakeSessionRelay({ handoffs: [dup, { ...dup }] })
  try {
    const env20 = makeContext()
    const made = []
    const injected = []
    const wakes = []
    const dupAgent = {
      session: { id: 'sess-dup' },
      send(message, target, wakeup) { injected.push(message); wakes.push({ target, wakeup }) },
    }
    env20.ctx.get = (name) => {
      if (name !== 'sessionController') return undefined
      return {
        async list() { return { items: [] } },
        async create(input) { made.push(input); return { sessionId: input.sessionId } },
        async resolveAgent() { return dupAgent },
      }
    }
    M.apply(env20.ctx, { relayUrl: relay20.url, autostart: false, pollSeconds: 5, heartbeatSeconds: 600 })
    await env20.tools.find((t) => t.name === 'relay_pair').execute({ code: 'CODE-1' })
    const got20 = await waitFor(() => relay20.acks.length >= 2, 5000)
    ok('同一条 handoff 重投只新建一次会话', made.length === 1, made)
    ok('同一条 handoff 重投只注入一次', injected.length === 1, injected.length)
    ok('重投也只静默注入（wakeup=false）', wakes.every((w) => w.wakeup === false), wakes)
    ok('重投只补回执，两次都是 delivered',
      got20 && relay20.acks.length === 2 && relay20.acks.every((a) => a.id === 'hd_dup' && a.status === 'delivered'), relay20.acks)
    env20.dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    relay20.server.close()
    P.clearCredentials()
  }
}
// ---------- 11) 任务隔离：一单一个会话，接着做落回原会话 ----------
{
  P.clearCredentials()
  const relay21 = await fakeTaskRelay([
    { id: 't_iso_1', title: '任务一', prompt: '做第一件事', target: 'local' },
    { id: 't_iso_2', title: '任务二', prompt: '做第二件事', target: 'local' },
  ])
  const env21 = makeContext()
  const sc = fakeSessionController()
  env21.ctx.get = (name) => (name === 'sessionController' ? sc.ctrl : undefined)
  try {
    M.apply(env21.ctx, { relayUrl: relay21.url, autostart: false, pollSeconds: 5, heartbeatSeconds: 600 })
    await env21.tools.find((t) => t.name === 'relay_pair').execute({ code: 'ISO-CODE' })
    const both = await waitFor(
      () => relay21.reports.filter((r) => r.status === 'running').length >= 2, 6000)
    ok('两条任务各开一个新会话', both && sc.created.length === 2, sc.created)
    const ids = sc.sessions.map((item) => item.sessionId)
    ok('两条任务没落到同一个会话', ids.length === 2 && ids[0] !== ids[1], ids)
    const running = relay21.reports.filter((r) => r.status === 'running')
    ok('上报 running 时带上各自 sessionId',
      running.length === 2 && running[0].sessionId === ids[0] && running[1].sessionId === ids[1],
      running)
    ok('两条任务各自投进自己那条会话',
      sc.agents.get(ids[0]).box.length === 1 && sc.agents.get(ids[1]).box.length === 1,
      { a: sc.agents.get(ids[0]).box.length, b: sc.agents.get(ids[1]).box.length })
    ok('本机流水也带 sessionId',
      P.listLocalTasks(10).some((row) => row.sessionId === ids[0])
      && P.listLocalTasks(10).some((row) => row.sessionId === ids[1]),
      P.listLocalTasks(10).map((row) => row.title + ':' + String(row.sessionId)))

    // 先把两条会话的第一轮收尾，否则「接着做」会被同会话排队规则挡住（那是另一条测试）。
    for (const sid of ids) {
      env21.emit('session/event', sc.agents.get(sid).session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    }
    await waitFor(() => relay21.reports.filter((r) => r.status === 'done').length >= 2, 4000)
    ok('两条任务都收尾成 done',
      relay21.reports.filter((r) => r.status === 'done').length === 2,
      relay21.reports.map((r) => r.status + ':' + String(r.sessionId)))

    // 「接着做」：中继派来带 sessionId 的任务，必须落回原会话，不许再开新的。
    relay21.push({
      id: 't_iso_3', title: '接着做任务一', prompt: '第一件事接着做',
      target: 'local', sessionId: ids[0],
    })
    const resumed = await waitFor(
      () => relay21.reports.filter((r) => r.status === 'running').length >= 3, 6000)
    ok('接着做不再新建会话', resumed && sc.created.length === 2, sc.created)
    ok('接着做落回原会话', sc.agents.get(ids[0]).box.length === 2
      && String(JSON.stringify(sc.agents.get(ids[0]).box[1])).includes('第一件事接着做'),
      sc.agents.get(ids[0]).box.length)
    ok('接着做那条会话收到的是新任务',
      !String(JSON.stringify(sc.agents.get(ids[0]).box[1])).includes('做第二件事'),
      String(JSON.stringify(sc.agents.get(ids[0]).box[1])).slice(0, 160))
    const last = relay21.reports.filter((r) => r.status === 'running').pop() || {}
    ok('接着做的 running 回报仍是原 sessionId', last.sessionId === ids[0], last)
  } finally {
    env21.dispose()
    await new Promise((resolve) => setTimeout(resolve, 80))
    relay21.server.close()
    P.clearCredentials()
  }
}

// ---------- 12) 令牌失效：自己用自愈券续期，不必重新配对 ----------
// 以前 401 只会在面板上写「请重新配对」——重启 DSH / 中继换库之后主人只能
// 跑到本机（或者手机上那个 DSHA 面板）重新拿配对码，中继网页就一直离线。
{
  P.clearCredentials()
  const relay22 = await fakeExpiringRelay()
  // 本机存的是过期令牌 + 自愈券，这就是「重启后拿到旧凭据」的样子。
  P.writeCredentials({
    relayUrl: relay22.url, deviceId: 'd_exp', token: 'tok-old',
    renewSecret: 'sec-1', name: '自愈', kind: 'desktop',
  })
  try {
    const env22 = makeContext()
    M.apply(env22.ctx, { relayUrl: relay22.url, autostart: true, pollSeconds: 5, heartbeatSeconds: 600 })
    const healed = await waitFor(() => relay22.state.beats.length >= 1, 6000)
    ok('旧令牌 401 后自动续期，心跳立刻补上', healed, { renews: relay22.state.renews.length, beats: relay22.state.beats.length })
    ok('续期用的是本机存的自愈券', relay22.state.renews.length === 1 && relay22.state.renews[0].renewSecret === 'sec-1',
      relay22.state.renews)
    const saved = P.readCredentials()
    ok('新令牌与新自愈券都落盘了（下次重启还能用）',
      saved && saved.token === 'tok-renewed-1' && saved.renewSecret === 'sec-2', saved)
    const st = await readState(env22)
    ok('状态里能看见续期过、且不再报令牌失效',
      st && st.relay && st.relay.renewCount === 1 && st.relay.lastAuthError === false,
      st && st.relay)
    env22.dispose()
    await new Promise((resolve) => setTimeout(resolve, 60))
  } finally {
    relay22.server.close()
    P.clearCredentials()
  }
}

// 自愈券也无效（中继换了库、设备行被删）→ 老实告诉主人要重新配对，不许假装在线。
{
  P.clearCredentials()
  const relay23 = await fakeExpiringRelay()
  P.writeCredentials({
    relayUrl: relay23.url, deviceId: 'd_exp', token: 'tok-old',
    renewSecret: 'sec-wrong', name: '自愈失败', kind: 'desktop',
  })
  try {
    const env23 = makeContext()
    M.apply(env23.ctx, { relayUrl: relay23.url, autostart: true, pollSeconds: 5, heartbeatSeconds: 600 })
    const tried = await waitFor(() => relay23.state.renews.length >= 1, 5000)
    ok('自愈券不对时仍会尝试续期', tried, relay23.state.renews.length)
    let st = null
    for (let i = 0; i < 120; i += 1) {
      st = await readState(env23)
      if (st && st.relay && st.relay.lastAuthError === true) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    ok('续期失败后状态标成令牌失效', st && st.relay && st.relay.lastAuthError === true, st && st.relay)
    ok('续期失败时错误文案让人重新配对',
      Boolean(st && st.relay && /重新配对/.test(String(st.relay.lastError || ''))), st && st.relay && st.relay.lastError)
    env23.dispose()
    await new Promise((resolve) => setTimeout(resolve, 60))
  } finally {
    relay23.server.close()
    P.clearCredentials()
  }
}

// ---------- 13) 心跳不许等模型目录：llm 服务卡死也要按时上报 ----------
// 这是「重启后网页一直离线」的真正原因：heartbeatOnce 第一句 await refreshCatalog，
// buildCatalog 挨个问 provider/模型又没有超时，llm 刚起没就绪能挂十分钟。
{
  P.clearCredentials()
  const relay24 = await fakeExpiringRelay()
  P.writeCredentials({
    relayUrl: relay24.url, deviceId: 'd_exp', token: 'tok-old',
    renewSecret: 'sec-1', name: '慢目录', kind: 'desktop',
  })
  try {
    const env24 = makeContext()
    // 一个永远不返回的 llm 服务：listProviders 挂住。
    env24.ctx.get = ((original) => (name) => (name === 'llm'
      ? { listProviders: () => new Promise(() => {}), listModels: async () => [] }
      : original(name)))(env24.ctx.get)
    const startedAt = Date.now()
    M.apply(env24.ctx, { relayUrl: relay24.url, autostart: true, pollSeconds: 5, heartbeatSeconds: 600 })
    const beat = await waitFor(() => relay24.state.beats.length >= 1, 6000)
    const elapsed = Date.now() - startedAt
    ok('llm 卡死时心跳照样发出去', beat, relay24.state.beats.length)
    ok('心跳没有等在模型目录后面（3 秒内到达）', beat && elapsed < 3000, elapsed)
    const st = await readState(env24)
    ok('心跳正常时不再报错', st && st.relay && st.relay.online === true, st && st.relay)
    env24.dispose()
    await new Promise((resolve) => setTimeout(resolve, 60))
  } finally {
    relay24.server.close()
    P.clearCredentials()
  }
}


// ---------- 14) 宿主没提供 webServer 时也要能起来（cordis 里 ctx.xxx 会直接抛） ----------
// 这是「重启 DSH 后中继一直心跳中断」的真因：pick() 的兜底写成裸的 ctx[name]，
// 而 cordis 对没写进 inject 的服务是 throw「cannot get property "webServer" without inject」，
// 于是 webOrigin() → tunnelTick() → startLoops() 一路抛，autostart 被当成失败，
// 心跳和长轮询一次都没起来。真宿主里 webServer 要等 Web 层就绪才 provide，apply 时通常还没有。
{
  P.clearCredentials()
  const beats25 = []
  const relay25 = await fakeHeartbeatRelay(beats25)
  P.writeCredentials({
    relayUrl: relay25.url, deviceId: 'd_nos', token: 'tok-beat', name: '没服务', kind: 'desktop',
  })
  try {
    const env25 = makeContext()
    const warns = []
    // 模拟 cordis 的语义：没 inject 的服务读属性直接抛，ctx.get 返回 undefined。
    const raw = env25.ctx
    const hostServices = new Set(['webServer', 'connection', 'webStartup', 'webRuntime'])
    env25.ctx = new Proxy(raw, {
      get(target, key, receiver) {
        if (typeof key === 'string' && hostServices.has(key) && !(key in target)) {
          throw new Error('cannot get property "' + key + '" without inject')
        }
        return Reflect.get(target, key, receiver)
      },
    })
    env25.ctx.logger = { info() {}, warn(msg) { warns.push(String(msg)) } }
    env25.ctx.get = () => undefined
    M.apply(env25.ctx, {
      relayUrl: relay25.url, autostart: true, pollSeconds: 5, heartbeatSeconds: 600,
      webTunnel: { enabled: true, sshHost: '127.0.0.1', sshUser: 'nobody', remotePort: 1 },
    })
    const beat25 = await waitFor(() => beats25.length >= 1, 6000)
    ok('宿主没有 webServer 服务时心跳照样发出去', beat25, warns.join(' | '))
    ok('没有 webServer 服务时不算自动启动失败',
      !warns.some((line) => /autostart failed/.test(line)), warns)
    const boot25 = existsSync(join(home, 'relay-pair.log'))
      ? readFileSync(join(home, 'relay-pair.log'), 'utf8') : ''
    ok('启动日志里有心跳成功那一行', boot25.includes('"event":"heartbeat"'), boot25.trim().slice(-200))
    env25.dispose()
    await new Promise((resolve) => setTimeout(resolve, 60))
  } finally {
    relay25.server.close()
    P.clearCredentials()
  }
}

rmSync(home, { recursive: true, force: true })
console.log(fails.length === 0 ? '\n全部通过' : '\n失败: ' + fails.join(', '))
process.exit(fails.length === 0 ? 0 : 1)
