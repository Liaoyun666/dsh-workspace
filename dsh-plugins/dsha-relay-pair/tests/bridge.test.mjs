// dsha-relay-pair / tests/bridge.test.mjs
//
// 设备桥（通知/震动）测试：凭据解析、结果归类、HTTP 失败降级。
// 全部用假 fetch，不碰网络、不碰 App。
//
// 跑法：ELECTRON_RUN_AS_NODE=1 '/e/Deepseek/DeepSeek Harness.exe' tests/bridge.test.mjs

import { classifyResult, createBridge, notify, parseTokenFile, vibrate } from '../lib/bridge.js'

const fails = []
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + JSON.stringify(extra)))
  if (!cond) fails.push(name)
}

delete process.env.DSHA_BRIDGE_TOKEN
delete process.env.DSHA_BRIDGE_URL

// ---------- 凭据解析 ----------
ok('裸 token 文件', parseTokenFile('/root/.dsh/.bridge_token', 'abc123\n') === 'abc123')
ok('headers 文件取 X-Token', parseTokenFile('/x/.bridge_headers', 'Host: 127.0.0.1\nX-Token: tok-9\n') === 'tok-9')
ok('headers 文件允许引号', parseTokenFile('/x/.bridge_headers', 'X-Token: "q-1"') === 'q-1')
ok('headers 里没有 X-Token → 空串', parseTokenFile('/x/.bridge_headers', 'Host: h\n') === '')
ok('裸 token 文件按整行取', parseTokenFile('/root/.dsh/.bridge_token', '  t-7  \n') === 't-7')

// ---------- 结果归类 ----------
ok('空结果算成功', classifyResult('').ok === true && classifyResult('').code === 'OK')
ok('方括号码算失败', (() => {
  const r = classifyResult('[NO_SESSION] 没有打开的会话')
  return r.ok === false && r.code === 'NO_SESSION' && r.text.includes('没有打开')
})())
ok('裸 OK 前缀算成功', classifyResult('OK: 已发送').ok === true)
ok('裸码算失败（码后面必须跟冒号或行尾）', (() => {
  const r = classifyResult('BRIDGE_BUSY: 正忙')
  return r.ok === false && r.code === 'BRIDGE_BUSY'
})())
ok('码后面直接跟正文算普通文本', classifyResult('BRIDGE_BUSY 正忙').ok === true)
ok('普通文本算成功', classifyResult('通知已弹出').ok === true)

// ---------- 造桥 ----------
function bridgeWith(fetchImpl, options = {}) {
  return createBridge({ baseUrl: 'http://127.0.0.1:3090', token: 'tok', fetchImpl, timeoutMs: 500, ...options })
}
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

const seen = []
const b1 = bridgeWith(async (url, init) => {
  seen.push({ url: String(url), init })
  return jsonResponse({ result: '通知已发送' })
})
const r1 = await notify(b1, '任务来了：统计日志', '收到任务')
ok('通知成功', r1.ok === true && r1.status === 200, r1)
ok('走 GET /app/notify 且带 X-Token', seen[0] && seen[0].url.startsWith('http://127.0.0.1:3090/app/notify?') &&
  seen[0].init.method === 'GET' && seen[0].init.headers['X-Token'] === 'tok', seen[0] && seen[0].url)
ok('正文与标题进 query', decodeURIComponent(seen[0].url).includes('任务来了：统计日志') &&
  decodeURIComponent(seen[0].url).includes('收到任务'), decodeURIComponent(seen[0].url))

const longText = 'x'.repeat(2000)
const bLong = bridgeWith(async (url) => {
  seen.push({ url: String(url) })
  return jsonResponse({ result: 'ok' })
})
await notify(bLong, longText)
ok('超长正文被截到 900 字', decodeURIComponent(seen[1].url).includes('x'.repeat(900)) &&
  !decodeURIComponent(seen[1].url).includes('x'.repeat(901)), decodeURIComponent(seen[1].url).length)

const bEmpty = bridgeWith(async () => jsonResponse({ result: 'ok' }))
const rEmpty = await notify(bEmpty, '   ')
ok('空正文直接跳过、不打桥', rEmpty.ok === true && rEmpty.code === 'SKIPPED', rEmpty)

// ---------- 失败降级（call 永不 reject）----------
const b401 = bridgeWith(async () => new Response('', { status: 401 }))
const r401 = await b401.call('/app/notify', { text: 'x' })
ok('401 归为 BRIDGE_UNAUTHORIZED', r401.ok === false && r401.code === 'BRIDGE_UNAUTHORIZED', r401)

const bDown = bridgeWith(async () => {
  const error = new Error('fetch failed')
  error.code = 'ECONNREFUSED'
  throw error
})
const rDown = await bDown.call('/app/notify', { text: 'x' })
ok('连不上归为 BRIDGE_DOWN', rDown.ok === false && rDown.code === 'BRIDGE_DOWN' && rDown.text.includes('切回前台'), rDown)

const bTimeout = bridgeWith(async () => {
  const error = new Error('timeout')
  error.name = 'TimeoutError'
  throw error
})
const rTimeout = await bTimeout.call('/app/notify', { text: 'x' })
ok('超时归为 BRIDGE_TIMEOUT', rTimeout.ok === false && rTimeout.code === 'BRIDGE_TIMEOUT', rTimeout)

const b500 = bridgeWith(async () => new Response('炸了', { status: 500 }))
const r500 = await b500.call('/app/notify', { text: 'x' })
ok('HTTP 500 归为 BRIDGE_HTTP', r500.ok === false && r500.code === 'BRIDGE_HTTP' && r500.text.includes('500'), r500)

const bCode = bridgeWith(async () => jsonResponse({ result: '[NO_APP] 通知被系统拦截' }))
const rCode = await bCode.call('/app/notify', { text: 'x' })
ok('桥自报错码被识别', rCode.ok === false && rCode.code === 'NO_APP', rCode)

// ---------- 没有凭据 ----------
const bNoToken = createBridge({ baseUrl: 'http://127.0.0.1:3090', tokenPath: '/nonexistent/bridge.token', fetchImpl: async () => jsonResponse({ result: 'ok' }) })
const rNoToken = await bNoToken.call('/app/version')
ok('读不到凭据归为 BRIDGE_UNAVAILABLE', rNoToken.ok === false && rNoToken.code === 'BRIDGE_UNAVAILABLE' && rNoToken.text.includes('设备桥'), rNoToken)

// ---------- 震动 ----------
const bVib = bridgeWith(async (url) => {
  seen.push({ url: String(url) })
  return jsonResponse({ result: 'ok' })
})
await vibrate(bVib, 150)
ok('震动走 /app/vibrate 带 ms', seen[seen.length - 1].url.includes('/app/vibrate') &&
  seen[seen.length - 1].url.includes('ms=150'), seen[seen.length - 1].url)

// ---------- 基址归一 ----------
ok('baseUrl 去掉尾斜杠', createBridge({ baseUrl: 'http://127.0.0.1:3090///' }).baseUrl === 'http://127.0.0.1:3090')
ok('缺省基址 3090', createBridge({}).baseUrl === 'http://127.0.0.1:3090')

console.log(fails.length === 0 ? '\n全部通过' : '\n失败: ' + fails.join(', '))
process.exit(fails.length === 0 ? 0 : 1)
