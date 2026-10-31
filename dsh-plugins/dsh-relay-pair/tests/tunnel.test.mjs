// dsh-relay-pair / tests/tunnel.test.mjs
//
// SSH 反向隧道管家：只在「该开」的时候开，条件一没就宽限后优雅关掉。
// 用假 spawn，不真的连服务器。
//
// 跑法：ELECTRON_RUN_AS_NODE=1 '/e/Deepseek/DeepSeek Harness.exe' tests/tunnel.test.mjs

import { EventEmitter } from 'node:events'

const T = await import('../lib/tunnel.js')

const fails = []
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + JSON.stringify(extra)))
  if (!cond) fails.push(name)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeSpawn() {
  const calls = []
  const procs = []
  const spawnImpl = (cmd, args, opts) => {
    const proc = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.signals = []
    proc.kill = (signal) => {
      proc.signals.push(signal)
      proc.emit('exit', 0, signal)
      return true
    }
    calls.push({ cmd, args, opts })
    procs.push(proc)
    return proc
  }
  return { spawnImpl, calls, procs }
}

const base = {
  enabled: true,
  sshHost: '203.0.113.10',
  sshUser: 'root',
  sshPort: 22,
  keyPath: 'C:/keys/id_ed25519',
  remotePort: 18944,
  publicUrl: 'https://dsh-tunnel.example.com',
  closeGraceSeconds: 0.05,
  requireMobilePeer: true,
  idleMinutes: 0,
}
const origin = 'http://127.0.0.1:57944'
const quiet = { warn() {}, info() {} }

// ---------- 参数拼装 ----------
{
  const args = T.sshArgs(base, 57944, 'linux')
  const text = args.join(' ')
  ok('ssh 用 -N 且远程只绑 127.0.0.1', args[0] === '-N' && text.includes('-R 127.0.0.1:18944:127.0.0.1:57944'), args)
  ok('BatchMode/IdentitiesOnly：绝不弹密码', text.includes('BatchMode=yes') && text.includes('IdentitiesOnly=yes'), args)
  ok('Linux 用 /dev/null 当 known_hosts', text.includes('UserKnownHostsFile=/dev/null'), args)
  ok('Windows 用 NUL 当 known_hosts', T.sshArgs(base, 57944, 'win32').join(' ').includes('UserKnownHostsFile=NUL'))
  ok('最后一参是 user@host', args[args.length - 1] === 'root@203.0.113.10', args[args.length - 1])
  ok('端口解析：带端口取端口', T.portOfOrigin('http://127.0.0.1:57944') === 57944)
  ok('端口解析：http 无端口取 80', T.portOfOrigin('http://x.local/') === 80)
  ok('端口解析：坏字符串取 0', T.portOfOrigin('nope') === 0)
}

// ---------- 关着就不起进程 ----------
{
  const fake = fakeSpawn()
  const sup = T.createTunnelSupervisor({ tunnel: { ...base, enabled: false }, logger: quiet, spawnImpl: fake.spawnImpl, platform: 'linux' })
  sup.update({ allowed: true, reason: 'ok', localOrigin: origin })
  ok('enabled=false：一次 spawn 都没有', fake.calls.length === 0)
  ok('enabled=false：状态是 disabled', sup.status().state === 'disabled', sup.status())
}

// ---------- 该开就开 ----------
{
  const fake = fakeSpawn()
  const sup = T.createTunnelSupervisor({ tunnel: base, logger: quiet, spawnImpl: fake.spawnImpl, platform: 'linux' })
  sup.update({ allowed: true, reason: 'ok', localOrigin: origin })
  ok('允许后立刻 spawn ssh', fake.calls.length === 1 && fake.calls[0].cmd === 'ssh')
  ok('ssh 带上了远程映射', fake.calls[0].args.join(' ').includes('127.0.0.1:18944:127.0.0.1:57944'))
  ok('起进程时状态是 starting', sup.status().state === 'starting', sup.status())
  await sleep(T.UP_AFTER_MS + 300)
  ok('稳住之后状态是 up', sup.status().state === 'up', sup.status())
  ok('upSince 有值', typeof sup.status().upSince === 'string')

  // 抖动：条件短暂失效，宽限期内恢复 → 不杀
  sup.update({ allowed: false, reason: 'relay-offline', localOrigin: origin })
  ok('条件失效先进 closing（不立刻杀）', sup.status().state === 'closing' && fake.procs[0].signals.length === 0, sup.status())
  await sleep(20)
  sup.update({ allowed: true, reason: 'ok', localOrigin: origin })
  ok('宽限期内恢复：进程还在、状态回 up', fake.procs[0].signals.length === 0 && sup.status().state === 'up', sup.status())

  // 真的失效：过宽限期 → SIGTERM
  sup.update({ allowed: false, reason: 'unpaired', localOrigin: origin })
  await sleep(120)
  ok('过了宽限期发 SIGTERM', fake.procs[0].signals[0] === 'SIGTERM', fake.procs[0].signals)
  ok('关完状态回到 idle', sup.status().state === 'idle', sup.status())
  ok('关掉后 reason 记着为什么', sup.status().reason === 'unpaired', sup.status().reason)
}

// ---------- ssh 自己挂了：退避重连 ----------
{
  const fake = fakeSpawn()
  const sup = T.createTunnelSupervisor({ tunnel: base, logger: quiet, spawnImpl: fake.spawnImpl, platform: 'linux' })
  sup.update({ allowed: true, reason: 'ok', localOrigin: origin })
  await sleep(T.UP_AFTER_MS + 200)
  fake.procs[0].emit('exit', 255, null)
  ok('进程意外退出：状态 restarting', sup.status().state === 'restarting', sup.status())
  ok('记了一次重连', sup.status().restarts === 1, sup.status().restarts)
  ok('退出码被记住', sup.status().lastExit && sup.status().lastExit.code === 255, sup.status().lastExit)
  ok('立刻不重启（等退避）', fake.calls.length === 1)
  sup.dispose()
}

// ---------- 端口变了就重开 ----------
{
  const fake = fakeSpawn()
  const sup = T.createTunnelSupervisor({ tunnel: base, logger: quiet, spawnImpl: fake.spawnImpl, platform: 'linux' })
  sup.update({ allowed: true, reason: 'ok', localOrigin: 'http://127.0.0.1:57944' })
  await sleep(T.UP_AFTER_MS + 200)
  sup.update({ allowed: true, reason: 'ok', localOrigin: 'http://127.0.0.1:60111' })
  ok('端口变了：旧进程被 SIGTERM', fake.procs[0].signals[0] === 'SIGTERM', fake.procs[0].signals)
  ok('端口变了：用新端口重开', fake.calls.length === 2 && fake.calls[1].args.join(' ').includes('127.0.0.1:18944:127.0.0.1:60111'), fake.calls.length)
  sup.dispose()
}

// ---------- dispose ----------
{
  const fake = fakeSpawn()
  const sup = T.createTunnelSupervisor({ tunnel: base, logger: quiet, spawnImpl: fake.spawnImpl, platform: 'linux' })
  sup.update({ allowed: true, reason: 'ok', localOrigin: origin })
  await sleep(T.UP_AFTER_MS + 200)
  sup.dispose()
  ok('dispose 立刻 SIGTERM', fake.procs[0].signals[0] === 'SIGTERM', fake.procs[0].signals)
  ok('dispose 后状态 disabled', sup.status().state === 'disabled', sup.status())
  ok('dispose 后不再持有进程', sup.running === false)
}

console.log('')
console.log(fails.length === 0 ? '全部通过（' + 24 + ' 项）' : '失败 ' + fails.length + ' 项：' + fails.join(' / '))
process.exit(fails.length === 0 ? 0 : 1)