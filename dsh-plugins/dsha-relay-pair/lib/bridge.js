/**
 * dsha-relay-pair / bridge.js
 *
 * 只做一件事：把「通知 / 震动」通过 DSHA App 的本地设备桥（默认 127.0.0.1:3090）
 * 送到安卓系统。中继配对本身走公网 HTTP，不经过这里。
 *
 * 为什么单独一个文件：
 *   - 桥失败绝不能拖垮轮询主循环。这里所有异常都被压成 BridgeResult，
 *     调用方 await 一眼就能看出「没通知成」而不用 try/catch 包三层。
 *   - 桥凭据（token）只在内存缓存，不落盘、不进 URL。
 */

import { readFile } from 'node:fs/promises'

export const DEFAULT_BASE_URL = 'http://127.0.0.1:3090'
export const TOKEN_FILES = ['/root/.dsh/.bridge_token', '/root/.dsh/.bridge_headers']
export const DEFAULT_TIMEOUT_MS = 8000

export class BridgeError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    if (extra.status !== undefined) this.status = extra.status
    if (extra.cause !== undefined) this.cause = extra.cause
  }
}

/**
 * 从凭据文件内容里取 token。
 * .bridge_headers 是 curl 的头文件（一行 `X-Token: xxx`），其余文件是裸 token。
 */
export function parseTokenFile(path, raw) {
  const text = String(raw ?? '')
  if (/\.bridge_headers$/i.test(path) || /\bX-Token\s*:/i.test(text)) {
    const match = /^[ \t]*X-Token[ \t]*:[ \t]*(.+?)[ \t]*$/im.exec(text)
    return match ? match[1].replace(/^["']|["']$/g, '') : ''
  }
  return text.trim()
}

/** 读桥凭据：显式参数 > 环境变量 DSHA_BRIDGE_TOKEN > 宿主写的位置。 */
export async function resolveToken(options = {}) {
  if (options.token) return String(options.token)
  const fromEnv = process.env.DSHA_BRIDGE_TOKEN
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  const candidates = options.tokenPath ? [options.tokenPath, ...TOKEN_FILES] : TOKEN_FILES
  for (const path of candidates) {
    let raw
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const token = parseTokenFile(path, raw)
    if (token) return token
  }
  throw new BridgeError(
    'BRIDGE_UNAVAILABLE',
    '读不到 DSHA 设备桥凭据（试过 ' + candidates.join('、') + '）。' +
      '通知功能需要 DSHA App 正在运行并已启动设备桥（设置 → 设备能力）。',
  )
}

function networkError(error, url) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new BridgeError('BRIDGE_TIMEOUT', '设备桥在期限内没有回应（' + url + '）。', { cause: error })
  }
  const codes = []
  const messages = []
  let current = error
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.code) codes.push(String(current.code))
    if (current.message) messages.push(String(current.message))
    current = current.cause
  }
  const joined = messages.join(' ')
  const downCodes = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']
  if (codes.some((code) => downCodes.includes(code)) || /ECONNREFUSED|bad port|socket hang up|other side closed/i.test(joined)) {
    return new BridgeError(
      'BRIDGE_DOWN',
      '连不上 DSHA 设备桥（' + url + '）。' + (joined ? joined.slice(0, 120) + ' —— ' : '') +
        'App 可能退到后台或被系统回收，切回前台再试。',
      { cause: error },
    )
  }
  return new BridgeError('BRIDGE_NETWORK', '访问设备桥失败：' + (error?.message || error), { cause: error })
}

/**
 * 把桥返回的文本归类：以大写码开头（`[CODE]` 或裸 `CODE:`）= 失败，否则成功。
 * 与 dsha-native-tools 保持同一套约定，免得两个插件对同一座桥给出不同的判断。
 */
export function classifyResult(raw) {
  const text = String(raw ?? '')
  if (!text.trim()) return { ok: true, code: 'OK', text: '' }
  const bracketed = /^\s*\[([A-Z][A-Z0-9_]+)\]\s*([\s\S]*)$/.exec(text)
  if (bracketed) {
    let code = bracketed[1]
    if (code === 'ERR' || code === 'RESULT_UNKNOWN') {
      const inner = /^\s*([A-Z][A-Z0-9_]{2,})(?::|\s*$)/.exec(bracketed[2])
      if (inner) code = inner[1]
    }
    return { ok: false, code, text }
  }
  const bare = /^\s*([A-Z][A-Z0-9_]{2,})(?::|\s*$)/.exec(text)
  if (bare) {
    const code = bare[1]
    return { ok: code === 'OK', code, text }
  }
  return { ok: true, code: 'OK', text }
}

/**
 * 造桥客户端。call 永不 reject —— 失败返回 { ok:false, code, text }。
 * @param {{ baseUrl?: string, token?: string, tokenPath?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 */
export function createBridge(options = {}) {
  const baseUrl = String(options.baseUrl || process.env.DSHA_BRIDGE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const doFetch = options.fetchImpl || globalThis.fetch
  /** @type {string | null} */
  let cachedToken = null

  async function token() {
    if (cachedToken) return cachedToken
    cachedToken = await resolveToken(options)
    return cachedToken
  }

  async function call(route, params = {}, callOptions = {}) {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue
      query.set(key, String(value))
    }
    const qs = query.toString()
    const url = baseUrl + route + (qs ? '?' + qs : '')
    let auth
    try {
      auth = await token()
    } catch (error) {
      return { ok: false, code: error?.code || 'BRIDGE_UNAVAILABLE', text: error?.message || String(error) }
    }

    let response
    try {
      response = await doFetch(url, {
        method: 'GET',
        headers: { 'X-Token': auth, accept: 'application/json' },
        signal: AbortSignal.timeout(callOptions.timeoutMs ?? timeoutMs),
      })
    } catch (error) {
      const wrapped = networkError(error, url)
      return { ok: false, code: wrapped.code, text: wrapped.message }
    }

    const body = await response.text().catch(() => '')
    if (response.status === 401 || response.status === 403) {
      // token 可能轮换了：清缓存，下次重读文件。
      cachedToken = null
      return {
        ok: false,
        code: 'BRIDGE_UNAUTHORIZED',
        text: '设备桥拒绝了凭据（HTTP ' + response.status + '）。让 DSHA 重启一次桥，本插件下次会重新读取 token。',
      }
    }
    if (!response.ok) {
      return { ok: false, code: 'BRIDGE_HTTP', text: '设备桥返回 HTTP ' + response.status + (body ? '：' + body.slice(0, 200) : '') }
    }

    let text = body
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === 'object' && typeof parsed.result === 'string') text = parsed.result
    } catch {
      /* 不是 JSON 就当纯文本结果 */
    }
    return { ...classifyResult(text), status: response.status }
  }

  return { baseUrl, call, token }
}

/**
 * 给中继任务用的通知封装：一条通知 = 标题 + 正文（正文别超过 200 字，
 * 安卓通知栏会截断，把关键信息放前面）。
 */
export async function notify(bridge, text, title) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return { ok: true, code: 'SKIPPED', text: '通知正文为空，跳过' }
  return bridge.call('/app/notify', { text: trimmed.slice(0, 900), title: title || 'DSH 中继' })
}

/** 震动：手机端默认不震，用户显式开了才调用。 */
export async function vibrate(bridge, ms = 120) {
  return bridge.call('/app/vibrate', { ms })
}
