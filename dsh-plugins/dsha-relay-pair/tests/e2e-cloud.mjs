// dsha-relay-pair / tests/e2e-cloud.mjs
//
// 拿一台真中继跑一遍手机端插件的完整链路（RELAY_BASE 指向它）：
// 网页生成配对码 → 插件 relay_pair 工具配对 → 心跳 → 网页按 dsha 派活 →
// 插件长轮询领单并投进会话 → turn/end 收尾 → 中继里看到 done + 输出 →
// 隧道 /relay/api/state 拿到插件本地状态 → 断开配对。
//
// 跑法：
//   RELAY_BASE=http://1.2.3.4 RELAY_WEB_TOKEN=<网页令牌> \
//     ELECTRON_RUN_AS_NODE=1 '/e/Deepseek/DeepSeek Harness.exe' tests/e2e-cloud.mjs
//
// 安全性：只用临时 DSH_HOME，跑完删掉；会在中继里留下一个名带「E2E」的设备记录，
// 任务标题也带 E2E 前缀，方便对账后清理。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = (process.env.RELAY_BASE || '').replace(/\/+$/, '')
const webToken = process.env.RELAY_WEB_TOKEN || ''
if (!base) {
  console.error('缺 RELAY_BASE：指到你要联调的那台中继，例如 RELAY_BASE=http://<中继地址>')
  process.exit(2)
}
if (!webToken) {
  console.error('缺 RELAY_WEB_TOKEN：先在中继网页上拿到令牌（config.json 的 webToken）')
  process.exit(2)
}
const home = mkdtempSync(join(tmpdir(), 'dsha-cloud-'))
process.env.DSH_HOME = home

const P = await import('../lib/protocol.js')
const M = await import('../lib/index.js')

const fails = []
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + JSON.stringify(extra)))
  if (!cond) fails.push(name)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(150)
  }
  return false
}

async function web(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Token': webToken },
    body: JSON.stringify(body ?? {}),
  })
  const data = await response.json()
  if (!response.ok) {
    const error = new Error((data && data.error && data.error.message) || ('HTTP ' + response.status))
    error.status = response.status
    throw error
  }
  return data
}

/** 最小 ctx：够 apply() 用（与 tests/apply.test.mjs 同构，去掉桥）。 */
function makeContext() {
  const listeners = new Map()
  const tools = []
  const routes = []
  const cleanups = []
  const deliveries = []
  const agent = { session: { id: 'cloud-sess-1' }, followup(message) { deliveries.push(message) } }
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
    emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args) },
    dispose() { for (const fn of cleanups.reverse()) fn() },
  }
}

const env = makeContext()
M.apply(env.ctx, {
  relayUrl: base,
  autostart: false,
  deviceName: 'E2E 手机端',
  deviceKind: 'mobile',
  pollSeconds: 5,
  heartbeatSeconds: 5,
  notifyOnTask: false,
  notifyOnResult: false,
  idleBackoffAfterSeconds: 0,
})
ok('插件 apply 成功、注册 6 工具', env.tools.length === 6, env.tools.map((t) => t.name))

let taskId = ''
let deviceId = ''
try {
  // 1) 网页生成配对码 → 插件 relay_pair 配对（走真实 /api/device/pair）
  const pc = await web('/api/web/paircode', {})
  ok('云端生成配对码', typeof pc.code === 'string' && pc.code.length === 9, pc)
  const pairTool = env.tools.find((t) => t.name === 'relay_pair')
  const pairText = await pairTool.execute({ code: pc.code })
  ok('relay_pair 配对成功', /配对成功|已配对/.test(pairText), pairText)
  const creds = P.readCredentials()
  deviceId = creds && creds.deviceId ? creds.deviceId : ''
  ok('凭据落盘（kind=mobile）', Boolean(deviceId) && creds.kind === 'mobile', creds)

  // 2) 心跳让中继把设备标在线
  const online = await until(async () => {
    const state = await web('/api/web/state', {})
    const row = (state.devices || []).find((d) => d.id === deviceId)
    return Boolean(row && row.online)
  }, 20000)
  ok('心跳后中继显示设备在线', online)

  // 3) 网页按 dsha 派活（auto 也应落到手机）
  const created = await web('/api/web/tasks', { title: 'E2E 手机任务', prompt: '数一下今天吃了几碗白饭', target: 'dsha' })
  taskId = created.taskId
  ok('网页建任务 target=dsha', Boolean(taskId) && created.target === 'dsha', created)

  // 4) 插件长轮询领单 + 投进会话
  const got = await until(() => env.deliveries.length > 0, 20000)
  ok('长轮询领到任务并投进会话', got, env.deliveries.length)
  const injected = (env.deliveries[0] && env.deliveries[0].content ? env.deliveries[0].content : []).map((b) => b.text || '').join('')
  ok('注入消息带 prompt', injected.includes('数一下今天吃了几碗白饭'), injected.slice(0, 160))
  ok('注入消息带中继任务号', injected.includes(taskId), injected.slice(0, 200))
  ok('注入消息标注来源插件', env.deliveries[0].source && env.deliveries[0].source.kind === 'plugin:dsha-relay-pair', env.deliveries[0].source)

  const running = await until(async () => {
    const state = await web('/api/web/state', {})
    const row = (state.tasks || []).find((t) => t.id === taskId)
    return Boolean(row && row.status === 'running')
  }, 15000)
  ok('中继里任务变 running', running)

  // 5) 隧道：网页要本机状态，插件在轮询里收帧并回 /relay/api/state
  const tunnelPromise = web('/api/web/tunnel', { deviceId, path: '/relay/api/state', method: 'GET' })
  let tunnel = null
  try { tunnel = await tunnelPromise } catch (error) { tunnel = { error: error.message } }
  ok('隧道往返拿到插件本地状态', Boolean(tunnel && tunnel.ok && String(tunnel.body).includes('E2E 手机端')),
    tunnel && String(tunnel.body).slice(0, 200))

  // 6) 收尾：turn/end 后报告 done + 输出
  env.emit('session/event', env.agent.session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '数完了：今天 3 碗白饭。' }] } },
  })
  env.emit('session/event', env.agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  const done = await until(async () => {
    const state = await web('/api/web/state', {})
    const row = (state.tasks || []).find((t) => t.id === taskId)
    return Boolean(row && row.status === 'done' && String(row.output || '').includes('3 碗白饭'))
  }, 20000)
  const finalState = await web('/api/web/state', {})
  const finalRow = (finalState.tasks || []).find((t) => t.id === taskId)
  ok('中继里任务 done 且带回输出', done, finalRow && { status: finalRow.status, output: String(finalRow.output).slice(0, 120) })
  ok('本地流水记了这次任务', P.listLocalTasks(10).some((r) => r.id === taskId && r.status === 'done'))
  ok('发件箱已清空（报告发出去了）', P.listOutbox(10).length === 0, P.listOutbox(5))

  // 7) 断开配对
  const unpairText = await env.tools.find((t) => t.name === 'relay_unpair').execute({})
  ok('relay_unpair 断开配对', P.readCredentials() === null && /断开|清除|已解绑/.test(unpairText), unpairText)
} finally {
  env.dispose()
  P.clearCredentials()
  rmSync(home, { recursive: true, force: true })
}

console.log(fails.length === 0 ? '云端 E2E 全部通过' : '云端 E2E 失败: ' + fails.join(', '))
process.exit(fails.length === 0 ? 0 : 1)
