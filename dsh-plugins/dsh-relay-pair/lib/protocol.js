// dsh-relay-pair / protocol.js
//
// 纯工具层：配置归一化、凭据读写、本地任务流水、消息框、HTTP 请求。
// 不 import 任何 @deepseek-ai/* 包（插件从工作区路径加载），只用 node: 内置模块和全局 fetch。

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'

export const PUBLIC_NAME = 'dsh-relay-pair'

const DEFAULTS = {
  relayUrl: '',
  deviceName: '',
  deviceKind: 'auto',
  autostart: true,
  localExec: true,
  heartbeatSeconds: 20,
  pollSeconds: 25,
  syncMode: 'manual',
  requestTimeoutMs: 30000,
  hostBase: '',
  sessionSnapshot: true,
  webTunnel: null,
}

/**
 * SSH 反向隧道（把本机 DSH 网页临时暴露到公网，让手机能打开）。
 * 默认关闭：只有填了 sshHost + keyPath 且 enabled=true 才会真的去起 ssh。
 */
const WEB_TUNNEL_DEFAULTS = {
  enabled: false,
  sshHost: '',
  sshUser: 'root',
  sshPort: 22,
  keyPath: '',
  remotePort: 18944,
  publicUrl: '',
  /** 任一条件不满足后，等这么久才真的关隧道（扛网络抖动）。 */
  closeGraceSeconds: 45,
  /** 要求中继上至少有一台手机端配对：手机没配对，隧道开着也没人用。 */
  requireMobilePeer: true,
  /** 这么久没有任何中继往来就关（0 = 不看空闲）。 */
  idleMinutes: 0,
}

export function normalizeWebTunnel(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const out = { ...WEB_TUNNEL_DEFAULTS }
  out.enabled = input.enabled === true
  if (typeof input.sshHost === 'string') out.sshHost = input.sshHost.trim()
  if (typeof input.sshUser === 'string' && input.sshUser.trim() !== '') out.sshUser = input.sshUser.trim()
  if (typeof input.keyPath === 'string') out.keyPath = input.keyPath.trim()
  if (typeof input.publicUrl === 'string') out.publicUrl = normalizeRelayUrl(input.publicUrl)
  out.sshPort = clampNumber(input.sshPort, 1, 65535, WEB_TUNNEL_DEFAULTS.sshPort)
  out.remotePort = clampNumber(input.remotePort, 1024, 65535, WEB_TUNNEL_DEFAULTS.remotePort)
  out.closeGraceSeconds = clampNumber(input.closeGraceSeconds, 0, 600, WEB_TUNNEL_DEFAULTS.closeGraceSeconds)
  out.idleMinutes = clampNumber(input.idleMinutes, 0, 1440, WEB_TUNNEL_DEFAULTS.idleMinutes)
  out.requireMobilePeer = input.requireMobilePeer !== false
  // 缺主机或缺私钥就当没配：不然会拿空参数去 spawn，报错信息很难看。
  if (out.sshHost === '' || out.keyPath === '') out.enabled = false
  return out
}

export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (input[key] !== undefined && input[key] !== null) out[key] = input[key]
  }
  out.relayUrl = normalizeRelayUrl(out.relayUrl)
  out.heartbeatSeconds = clampNumber(out.heartbeatSeconds, 5, 600, DEFAULTS.heartbeatSeconds)
  out.pollSeconds = clampNumber(out.pollSeconds, 5, 120, DEFAULTS.pollSeconds)
  out.requestTimeoutMs = clampNumber(out.requestTimeoutMs, 3000, 180000, DEFAULTS.requestTimeoutMs)
  out.autostart = out.autostart !== false
  out.localExec = out.localExec !== false
  out.sessionSnapshot = out.sessionSnapshot !== false
  out.webTunnel = normalizeWebTunnel(input.webTunnel)
  out.syncMode = out.syncMode === 'auto' ? 'auto' : 'manual'
  out.deviceKind = ['auto', 'desktop', 'mobile'].includes(out.deviceKind) ? out.deviceKind : 'auto'
  return out
}

export function normalizeRelayUrl(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if (!/^https?:\/\//i.test(text)) return ''
  return text.replace(/\/+$/, '')
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** auto 判定：DSHA 是 proot 里的 linux arm64 容器，其余当桌面端。 */
export function detectDeviceKind(preference, platform = process.platform, arch = process.arch) {
  if (preference === 'desktop' || preference === 'mobile') return preference
  return platform === 'linux' && arch === 'arm64' ? 'mobile' : 'desktop'
}

export function defaultDeviceName(kind, host = hostname()) {
  return (kind === 'mobile' ? 'DSHA@' : 'DSH@') + host
}

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

export function credentialsPath(env = process.env) {
  return join(dshHome(env), 'relay-device.json')
}

/**
 * 凭据备份。主文件丢了/坏了（关机没落盘、清理软件、杀毒误删）时，
 * 下次启动靠它自动接上，不用再找主人要配对码。内容与主文件完全一致。
 */
export function credentialsBackupPath(env = process.env) {
  return join(dshHome(env), 'relay-device.backup.json')
}

export function localTasksPath(env = process.env) {
  return join(dshHome(env), 'relay-local-tasks.jsonl')
}

/** 读一个凭据文件；不存在、不是 JSON、缺 relayUrl/token 一律当没有。 */
function parseCredentialsFile(path) {
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (!data || typeof data !== 'object') return null
    if (typeof data.relayUrl !== 'string' || typeof data.token !== 'string') return null
    // 清空过令牌的文件不能再当成「已配对」。
    if (data.token.trim() === '') return null
    return data
  } catch {
    return null
  }
}

export function readCredentials(env = process.env) {
  return parseCredentialsFile(credentialsPath(env))
}

/**
 * 启动时读凭据：主文件优先；主文件没了就用备份，并顺手把主文件写回去。
 * source = 'primary' | 'backup' | 'none' —— 写进启动日志，重启后配对丢了能一眼看出是哪一环。
 */
export function readCredentialsWithRecovery(env = process.env) {
  const primary = parseCredentialsFile(credentialsPath(env))
  if (primary) return { creds: primary, source: 'primary', restored: false }
  const backup = parseCredentialsFile(credentialsBackupPath(env))
  if (!backup) return { creds: null, source: 'none', restored: false }
  let restored = false
  try {
    writeCredentials(backup, env)
    restored = true
  } catch {
    // 写不回去也先用着：这一轮心跳能通就不耽误用。
  }
  return { creds: backup, source: 'backup', restored }
}

function writeFileAtomic(path, body) {
  const tmp = path + '.tmp'
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(tmp, path)
  } catch {
    writeFileSync(path, body, 'utf8')
  }
  try {
    // Windows 上 chmod 基本无效，但在 POSIX（DSHA 的 proot 容器）里有效。
    chmodSync(path, 0o600)
  } catch { /* 文件系统不支持就算了 */ }
}

export function writeCredentials(creds, env = process.env) {
  const path = credentialsPath(env)
  mkdirSync(dirname(path), { recursive: true })
  const body = JSON.stringify(creds, null, 2)
  writeFileAtomic(path, body)
  try {
    writeFileAtomic(credentialsBackupPath(env), body)
  } catch { /* 备份写不成不影响配对本身 */ }
  return path
}

export function clearCredentials(env = process.env) {
  let cleared = false
  // 备份必须一起删：否则「断开配对」之后重启会被备份悄悄复活。
  for (const path of [credentialsPath(env), credentialsBackupPath(env)]) {
    if (!existsSync(path)) continue
    try {
      unlinkSync(path)
      cleared = true
    } catch { /* 删不掉就留着，下次再说 */ }
  }
  return cleared
}

// --- 本地任务流水 ----------------------------------------------------------

/** 本机流水只留最近这么多条任务（同一个任务的多条状态变更算一条）。 */
export const MAX_LOCAL_TASKS = 20

/** 按「最新在前」保留最近 MAX_LOCAL_TASKS 个任务 id 的行，其余丢掉。 */
function pruneLocalTaskLines(lines) {
  const keep = new Set()
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let id = ''
    try {
      id = String(JSON.parse(lines[i]).id || '')
    } catch {
      continue
    }
    if (!id) continue
    if (keep.size >= MAX_LOCAL_TASKS && !keep.has(id)) continue
    keep.add(id)
  }
  return lines.filter((line) => {
    try {
      return keep.has(String(JSON.parse(line).id || ''))
    } catch {
      return false
    }
  })
}

export function appendLocalTask(record, env = process.env) {
  const path = localTasksPath(env)
  mkdirSync(dirname(path), { recursive: true })
  try {
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf8')
  } catch {
    return false
  }
  // 超出上限就重写一遍：本机任务列表只留最近 20 条，跟中继台的保留策略对齐。
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
    const kept = pruneLocalTaskLines(lines)
    if (kept.length !== lines.length) writeFileSync(path, kept.join('\n') + '\n', 'utf8')
  } catch {
    // 修剪失败不影响主流程：流水是给人看的，写不进去就算了。
  }
  return true
}

export function listLocalTasks(limit = 50, env = process.env) {
  const path = localTasksPath(env)
  if (!existsSync(path)) return []
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean).reverse()
  } catch {
    return []
  }
}

// --- 消息与文本 ------------------------------------------------------------

export function trimText(text, max = 4000) {
  const value = typeof text === 'string' ? text : ''
  return value.length > max ? value.slice(0, max) + '…' : value
}

/**
 * 转义会被下游当成标签的片段：prompt 里出现 `</task` / `<task`
 * （大小写无关）就在 `<` 前加反斜杠，免得闭合标签后注入伪系统指令。
 * 只动标签本身，其余文本原样保留（与 dsha-relay-pair 的同名函数一致）。
 */
export function escapeTaskTags(text) {
  const value = typeof text === 'string' ? text : ''
  return value.replace(/<(\/?task)/gi, '\\<$1')
}

/** 注入到会话里的任务说明：明确标注来源，避免模型把它当成用户亲口说的话。 */
export function frameTaskMessage(task, deviceName, modelNote) {
  const owner = typeof deviceName === 'string' && deviceName !== '' ? '（本机：' + deviceName + '）' : ''
  const source = task && typeof task === 'object' ? task : {}
  const model = String(source.modelName || '').trim()
  const effort = String(source.reasoningEffort || '').trim()
  const note = typeof modelNote === 'string' ? modelNote.trim() : ''
  // 模型是插件在投递前切好的（selectForNextRequest）；把选择写进消息里，
  // 这样会话记录本身就能说明「这一轮为什么用这个模型」。
  const modelLines = model
    ? ['本条工单由中继台指定了模型：' + (source.modelProvider ? source.modelProvider + '/' : '') + model
       + (effort ? '（思考强度 ' + effort + '）' : '') + '。']
    : []
  const noteLines = note ? ['注意：' + note + '。'] : []
  // 「接着做」现在是在原任务里加一轮（中继台的 round 字段）：告诉模型这是续做，
  // 别把前面几轮的工作重来一遍。
  const round = Number(source.round || 0)
  const roundLines = round > 0
    ? ['这是这条任务的第 ' + (round + 1) + ' 轮：前面几轮已经做过，接着往下做，别从头重来。']
    : []
  return [
    '`[relay] 来自 DSH 中继台的任务 ' + (source.id || '') + '`',
    '',
    '这条消息由 dsh-relay-pair 插件注入：用户在网页/另一端派发了任务，中继把它送到这台设备' + owner + '。',
    '它不是你面前的用户刚刚说的话；请把它当作一条待执行的工单。',
    '执行完请用一段简洁的中文汇报结果（这段汇报会回传到中继台）。',
    ...modelLines,
    ...noteLines,
    ...roundLines,
    '',
    '<task>',
    escapeTaskTags(source.prompt),
    '</task>',
  ].join('\n')
}

export function frameSubmitMessage(prompt) {
  return [
    '`[relay] 本机派发（由插件登记并执行）`',
    '',
    '用户在网页/中继台选择「本机执行」的工单。执行完请简洁汇报结果。',
    '',
    '<task>',
    escapeTaskTags(prompt),
    '</task>',
  ].join('\n')
}

export function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

// --- HTTP ------------------------------------------------------------------

export class RelayError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'RelayError'
    this.status = status
    this.code = code
  }
}

/**
 * 一次 JSON 请求。失败一律抛 RelayError，调用方决定吞掉还是上报。
 * 不依赖第三方库：Node 22+ 的全局 fetch。
 */
export async function jsonRequest(url, options = {}) {
  const { method = 'POST', token, body, timeoutMs = 30000, query, signal: outerSignal } = options
  let target = url
  if (query !== undefined && query !== null) {
    const parts = Object.entries(query).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    if (parts.length > 0) target += (target.includes('?') ? '&' : '?') + parts.join('&')
  }
  const headers = { Accept: 'application/json' }
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json'
  if (typeof token === 'string' && token !== '') headers.Authorization = 'Bearer ' + token
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // 外部 signal（停止循环时）也要能立刻掐断在途请求。
  const onOuterAbort = () => controller.abort()
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort()
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
  }
  // 超时必须覆盖到 body 读完：半开连接会让 response.text() 永久挂住，
  // 早 clearTimeout 就只剩响应头那一段受保护。
  try {
    let response
    let text
    try {
      response = await fetch(target, {
        method,
        headers,
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      text = await response.text()
    } catch (error) {
      const aborted = error && error.name === 'AbortError'
      throw new RelayError(aborted ? '请求超时' : '连不上中继：' + (error && error.message ? error.message : String(error)), 0, aborted ? 'TIMEOUT' : 'UNREACHABLE')
    }
    let data = null
    try {
      data = text === '' ? {} : JSON.parse(text)
    } catch {
      data = { raw: text }
    }
    if (!response.ok) {
      const err = data && data.error ? data.error : {}
      throw new RelayError(err.message || 'HTTP ' + response.status, response.status, err.code || 'HTTP_' + response.status)
    }
    return data
  } finally {
    clearTimeout(timer)
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort)
  }
}

/** 隧道只允许打本机回环地址，且路径必须落在白名单前缀里。 */
export const TUNNEL_PREFIXES = ['/schedule/api', '/relay/api', '/api/', '/v1/']

/**
 * 隧道帧里的 path 是**中继那边**给的，可能来自任何拿到令牌的客户端，
 * 所以先做结构校验再比白名单：
 *   任意 URL 规范化（`new URL(path, origin)`）都会把 `..` / `%2e%2e` 消解掉，
 *   只靠 startsWith 前缀就等于把本机全部 HTTP 接口开放出去。
 * 这里拒绝：非字符串、不以 / 开头、反斜杠、`..`、大小写无关的 %2e、`//`、控制字符。
 * 再拿 `?` 之前的 pathname 比前缀（query 不参与匹配）。
 */
export function splitTunnelPath(path) {
  if (typeof path !== 'string' || path === '') return null
  if (!path.startsWith('/')) return null
  if (path.includes('\\')) return null
  if (path.includes('..')) return null
  if (/%2e/i.test(path)) return null
  if (path.includes('//')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return null
  const cut = path.indexOf('?')
  const pathname = cut === -1 ? path : path.slice(0, cut)
  const search = cut === -1 ? '' : path.slice(cut)
  return { pathname, search }
}

export function isAllowedTunnelPath(path) {
  const parts = splitTunnelPath(path)
  if (parts === null) return false
  return TUNNEL_PREFIXES.some((prefix) => parts.pathname.startsWith(prefix))
}

/**
 * 把隧道路径拼到本机 Web 的带令牌地址上。校验不过直接抛，
 * 拼完再断言 origin 没变、pathname 还在白名单里（双保险）。
 */
export function buildTunnelUrl(base, path) {
  const parts = splitTunnelPath(path)
  if (parts === null || !isAllowedTunnelPath(parts.pathname)) {
    throw new Error('隧道路径不在白名单里：' + String(path))
  }
  const root = new URL(base)
  const out = new URL(root.origin)
  out.pathname = parts.pathname
  for (const [key, value] of root.searchParams) out.searchParams.set(key, value)
  if (out.origin !== root.origin) throw new Error('隧道目标 origin 变了：' + out.origin)
  if (!isAllowedTunnelPath(out.pathname)) throw new Error('隧道目标路径越界：' + out.pathname)
  return out.toString()
}

// --- 发件箱与重试节奏 ------------------------------------------------------

export const OUTBOX_LIMIT = 200

/** 发件箱去重键：整数 id 与字符串 id 视作同一条。 */
function outboxKey(taskId) {
  if (typeof taskId === 'number' && Number.isFinite(taskId)) return String(taskId)
  if (typeof taskId === 'string' && taskId !== '') return taskId
  return ''
}

/**
 * 内存发件箱（手机端才落盘，桌面端不需要）：同一 taskId 只保留最新状态，
 * 超过上限丢最旧的，返回因为超出上限被丢掉的条数。就地修改传入数组。
 * （同 taskId 的旧状态是被新状态取代，不算「丢」，所以不计数。）
 */
export function enqueueOutbox(list, entry) {
  if (!Array.isArray(list) || !entry) return 0
  // 中继的任务 id 是整数，别因为类型就把整条状态丢掉。
  const key = outboxKey(entry.taskId)
  if (key === '') return 0
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && outboxKey(list[i].taskId) === key) list.splice(i, 1)
  }
  list.push(entry)
  let dropped = 0
  while (list.length > OUTBOX_LIMIT) {
    list.shift()
    dropped += 1
  }
  return dropped
}

/**
 * 断网退避：500ms 起步，每轮翻倍，封顶 30s，带 ±20% 抖动。
 * `attempt` 是已经连续失败了几轮（0 = 第一次失败）。
 */
export function nextRetryDelay(attempt, options = {}) {
  const start = Number.isFinite(options.startMs) ? options.startMs : 500
  const cap = Number.isFinite(options.capMs) ? options.capMs : 30000
  const ratio = Number.isFinite(options.jitter) ? options.jitter : 0.2
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0
  const base = Math.min(cap, start * 2 ** Math.min(n, 20))
  const spread = base * ratio
  return Math.round(base - spread + Math.random() * spread * 2)
}
