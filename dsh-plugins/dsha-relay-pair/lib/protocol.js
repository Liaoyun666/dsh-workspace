// dsha-relay-pair / protocol.js
//
// 纯工具层：配置归一化、凭据读写、任务流水、发件箱、消息框、HTTP 请求。
// 不 import 任何 @deepseek-ai/* 包（插件从工作区/手机本地路径加载），
// 只用 node: 内置模块和全局 fetch —— 手机容器里装不了原生模块。

import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'

export const PUBLIC_NAME = 'dsha-relay-pair'

const DEFAULTS = {
  relayUrl: '',
  deviceName: '',
  deviceKind: 'mobile',
  autostart: true,
  localExec: true,
  // 最近 3 条会话的快照自动同步到云端（只入库，主人点了「送过去」才投递）。
  sessionSnapshot: true,
  heartbeatSeconds: 20,
  pollSeconds: 25,
  idleBackoffAfterSeconds: 180,
  idleBackoffMaxSeconds: 120,
  syncMode: 'manual',
  notifyOnTask: true,
  notifyOnResult: true,
  vibrateOnTask: false,
  requestTimeoutMs: 30000,
  // 网页「打开手机 DSHA」要靠它：手机端没法被浏览器直接唤起，只能让本机插件
  // 走 3090 设备桥 …/app/launch（包名）或 …/app/open（深链）。都没配就如实报错。
  appPackage: '',
  appUrl: '',
  bridgeUrl: 'http://127.0.0.1:3090',
  bridgeTokenPath: '/root/.dsh/.bridge_token',
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
  out.idleBackoffAfterSeconds = clampNumber(out.idleBackoffAfterSeconds, 0, 86400, DEFAULTS.idleBackoffAfterSeconds)
  out.idleBackoffMaxSeconds = clampNumber(out.idleBackoffMaxSeconds, 5, 3600, DEFAULTS.idleBackoffMaxSeconds)
  out.requestTimeoutMs = clampNumber(out.requestTimeoutMs, 3000, 180000, DEFAULTS.requestTimeoutMs)
  out.autostart = out.autostart !== false
  out.localExec = out.localExec !== false
  out.sessionSnapshot = out.sessionSnapshot !== false
  out.notifyOnTask = out.notifyOnTask !== false
  out.notifyOnResult = out.notifyOnResult !== false
  out.vibrateOnTask = out.vibrateOnTask === true
  out.syncMode = out.syncMode === 'auto' ? 'auto' : 'manual'
  out.deviceKind = ['auto', 'desktop', 'mobile'].includes(out.deviceKind) ? out.deviceKind : 'mobile'
  out.bridgeUrl = typeof out.bridgeUrl === 'string' && /^https?:\/\//i.test(out.bridgeUrl.trim())
    ? out.bridgeUrl.trim().replace(/\/+$/, '')
    : DEFAULTS.bridgeUrl
  out.bridgeTokenPath = typeof out.bridgeTokenPath === 'string' && out.bridgeTokenPath.trim() !== ''
    ? out.bridgeTokenPath.trim()
    : DEFAULTS.bridgeTokenPath
  out.appPackage = typeof out.appPackage === 'string' ? out.appPackage.trim() : ''
  out.appUrl = typeof out.appUrl === 'string' ? out.appUrl.trim() : ''
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

/**
 * auto 判定：DSHA 是 proot 里的 linux arm64 容器，其余当桌面端。
 * 手机端插件把缺省写成 mobile（cordis 里写死），auto 只给「同一个包装到电脑上调试」用。
 */
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

export function localTasksPath(env = process.env) {
  return join(dshHome(env), 'relay-local-tasks.jsonl')
}

export function outboxPath(env = process.env) {
  return join(dshHome(env), 'relay-outbox.jsonl')
}

export function readCredentials(env = process.env) {
  const path = credentialsPath(env)
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

export function writeCredentials(creds, env = process.env) {
  const path = credentialsPath(env)
  writeAtomic(path, JSON.stringify(creds, null, 2), 0o600)
  return path
}

export function clearCredentials(env = process.env) {
  const path = credentialsPath(env)
  if (!existsSync(path)) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * 原子写：同目录临时文件 → rename。
 * 手机上被系统杀掉进程是常态，写一半的凭据/发件箱会让下次启动直接崩，所以不能直接 writeFile。
 */
function writeAtomic(path, body, mode) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.' + process.pid + '.tmp'
  try {
    writeFileSync(tmp, body, { encoding: 'utf8', mode })
    try {
      chmodSync(tmp, mode)
    } catch { /* 文件系统不支持就算了 */ }
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch { /* 临时文件可能就没建起来 */ }
    throw error
  }
  try {
    // Windows 上 chmod 基本无效，但在 POSIX（DSHA 的 proot 容器）里有效。
    chmodSync(path, mode)
  } catch { /* 文件系统不支持就算了 */ }
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

/** 把流水压成「一个任务一条最终态」，启动时用来找被系统杀掉的任务。 */
export function latestStatusByTask(env = process.env) {
  const rows = listLocalTasks(1000, env)
  const seen = new Map()
  for (const row of rows.slice().reverse()) {
    if (!row || typeof row.id !== 'string' || row.id === '') continue
    const prev = seen.get(row.id)
    if (prev === undefined || prev.status !== 'done') seen.set(row.id, row)
  }
  return seen
}

// --- 发件箱（手机端独有）---------------------------------------------------
//
// 手机的网络和进程都不牢靠：报告「跑完了」的那一发如果正好赶上断网，
// 中继那边这个任务就永远挂在 running。所以先落盘、再发；发成功才删。

export function appendOutbox(entry, env = process.env) {
  const path = outboxPath(env)
  const row = {
    id: entry.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
    at: new Date().toISOString(),
    ...entry,
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(row) + '\n', 'utf8')
    return row
  } catch {
    return null
  }
}

/** 读出整个发件箱（时间正序，最老的在前）。 */
function readOutboxAll(env = process.env) {
  const path = outboxPath(env)
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8').split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export function listOutbox(limit = 200, env = process.env) {
  return readOutboxAll(env).slice(-limit)
}

/** 最老优先取一批：重放要按时间正序，否则积压超过 200 条时老报告永远轮不到。 */
export function listOutboxOldest(limit = 200, env = process.env) {
  return readOutboxAll(env).slice(0, limit)
}

export function countOutbox(env = process.env) {
  return readOutboxAll(env).length
}

// 发件箱的写操作串行化：prune 要「读全量 → 整文件重写」，
// 正好和 append（reportTask 的 then、flushOutbox 的删除）撞在一起时，
// 后写的整文件快照会把先追加的行盖掉。所有跨 await 的发件箱流程都排进这条
// promise 链，同一时刻只有一段在读-改-写。
let outboxChain = Promise.resolve()

export function queueOutbox(task) {
  const run = outboxChain.then(() => task(), () => task())
  outboxChain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 从发件箱里删掉已送达的条目，保留其余。
 * 读-改-写之间不锁文件：这个文件只有本插件一个写者（单进程），
 * 而且整段是同步的，不会和其它写操作交错；跨 await 的调用方要用 queueOutbox 包住。
 */
export function pruneOutbox(sentIds, env = process.env) {
  const sent = new Set(sentIds)
  if (sent.size === 0) return 0
  const path = outboxPath(env)
  if (!existsSync(path)) return 0
  // 不能截断：listOutbox(1000) 会把更老的行直接写没，积压一多就永久丢报告。
  const keep = readOutboxAll(env).filter((row) => !sent.has(row.id))
  try {
    writeAtomic(path, keep.map((row) => JSON.stringify(row)).join('\n') + (keep.length > 0 ? '\n' : ''), 0o600)
  } catch {
    return 0
  }
  return sent.size
}

// --- 消息与文本 ------------------------------------------------------------

export function trimText(text, max = 4000) {
  const value = typeof text === 'string' ? text : ''
  return value.length > max ? value.slice(0, max) + '…' : value
}

/**
 * 把 prompt 里形似 <task> / </task> 的标签转义掉（大小写无关，<tasks> 也算）。
 * 不转义的话，用户（或中继另一端）可以在正文里伪造一个假的闭标签再拼伪系统指令，
 * 让模型把后面的内容当成插件自己的话。纯函数，桌面插件用同一份实现，别各改各的。
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
    '这条消息由 dsha-relay-pair 插件注入：用户在网页/另一端派发了任务，中继把它送到这台手机' + owner + '。',
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
    '用户在网页/中继台选择「手机执行」的工单。执行完请简洁汇报结果。',
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
 * 不依赖第三方库：Node 20+ 的全局 fetch。
 */
export async function jsonRequest(url, options = {}) {
  const { method = 'POST', token, body, timeoutMs = 30000, query } = options
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
  let response
  try {
    response = await fetch(target, {
      method,
      headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    const aborted = error && error.name === 'AbortError'
    throw new RelayError(
      aborted ? '请求超时' : '连不上中继：' + (error && error.message ? error.message : String(error)),
      0,
      aborted ? 'TIMEOUT' : 'UNREACHABLE',
    )
  }
  // 超时必须覆盖到响应体读完：只包住响应头的话，半开连接（header 已回、body 卡住）
  // 会让 poll 循环永远挂在 await response.text() 上，心跳和重放一起停摆。
  let text
  try {
    text = await response.text()
  } catch (error) {
    clearTimeout(timer)
    const aborted = error && error.name === 'AbortError'
    throw new RelayError(
      aborted ? '读取响应超时' : '读中继响应失败：' + (error && error.message ? error.message : String(error)),
      0,
      aborted ? 'TIMEOUT' : 'UNREACHABLE',
    )
  }
  clearTimeout(timer)
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
}

/** 隧道只允许打本机回环地址，且路径必须落在白名单前缀里。 */
export const TUNNEL_PREFIXES = ['/schedule/api', '/relay/api', '/api/', '/v1/']

export function isAllowedTunnelPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return false
  return TUNNEL_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/**
 * 手机端空转退避：连续 N 秒没领到任务就把轮询间隔拉长，最多到 max。
 * 返回下一次轮询前该等多久（毫秒）；idleSeconds 是「已经空转了多少秒」。
 */
export function nextPollDelay(config, idleSeconds) {
  const base = Math.max(5, config.pollSeconds) * 1000
  const after = Number(config.idleBackoffAfterSeconds)
  if (!Number.isFinite(after) || after <= 0) return base
  if (idleSeconds < after) return base
  // 进入退避之后按 1×/2×/4× 拉长，用已空转时长决定档位，省得再维护一个计数器。
  const over = idleSeconds - after
  const step = Math.min(4, Math.floor(over / Math.max(30, after / 4)))
  const factor = 2 ** step
  const capped = Math.max(base, Math.min(base * factor, Math.max(5, config.idleBackoffMaxSeconds) * 1000))
  return capped
}

/** 「12 秒前」这种人话，给工具和状态页的文本输出用。 */
export function formatAge(timestamp) {
  if (!timestamp) return '从未'
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return seconds + ' 秒前'
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前'
  return Math.floor(seconds / 3600) + ' 小时前'
}
