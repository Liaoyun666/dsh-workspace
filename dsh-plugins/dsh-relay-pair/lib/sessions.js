/**
 * 会话快照（不是对话流水）。
 *
 * 主人要的是：两端各自把本机**最近的 8 条会话**存到中继台，只存云端、不发给
 * 任何设备；等他在网页上选一条、点「送过去」，才定向投给某一台设备。目标设备
 * 已经有这个 sessionId 就直接接续，没有就新建一条再接着聊。两端各存一份，谁也
 * 不覆盖谁（隔离靠中继的 UNIQUE(device_id, session_id)）。
 *
 * 已归档/回档的会话不算「最近」——它们已经被主人收起来了，不该再冒出来。
 * 归档名单在 $DSH_HOME/storages/workspace.json 的 global.archivedSessionIds。
 *
 * 正文全额保存：不按 6000 字砍，上限跟中继的 MAX_SESSION_MESSAGES / MAX_SESSION_TEXT 对齐。
 *
 * 这个文件只做两件事：
 *  1. 从本机 DSH 里读出「最近 8 条会话 + 标题 + 全部消息」；
 *  2. 把一条送过来的会话接上（有则续、无则建）。
 *
 * 读会话走 ctx.sessionController / ctx.sessionQuery（DSH 自带服务，Web 侧边栏
 * 用的就是同一套）。拿不到服务时返回空数组而不是抛错：会话同步是锦上添花，
 * 不能因为它把任务通道搞挂。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './protocol.js'

/** 每台设备只留最近几条会话（与中继 MAX_SESSIONS_PER_DEVICE 对齐）。 */
export const MAX_SNAPSHOT_SESSIONS = 8
/** 一条会话最多带多少条消息、每条多长（与中继 MAX_SESSION_MESSAGES / MAX_SESSION_TEXT 对齐）。 */
export const MAX_SNAPSHOT_MESSAGES = 4000
export const MAX_MESSAGE_TEXT = 400000
export const MAX_SESSION_TITLE = 80
/** 「送过去」时注入的正文总预算：太长就只带最近的部分，别把对面撑爆。 */
export const HANDOFF_MAX_CHARS = 200000

/**
 * 已归档（DSH 里叫「回档」）的会话 id 集合。
 *
 * 归档名单不在会话记录里，而在工作区注册表 workspace.json 的 global.archivedSessionIds。
 * 读不到就当没有归档，不影响同步。
 */
export function readArchivedIds(env = process.env) {
  try {
    const file = join(dshHome(env), 'storages', 'workspace.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const ids = parsed && parsed.global && parsed.global.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids.map((value) => String(value)) : [])
  } catch {
    return new Set()
  }
}

/** 这些 user/message 是 DSH 自己塞的上下文，不是人说的话，不进快照。 */
const NOISE_SOURCES = new Set([
  'runtime-context',
  'agent-instructions',
  'compact-checkpoint',
  'system',
  'developer',
])

function clampText(value, limit) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= limit) return text
  return text.slice(0, limit)
}

/** 把 content（字符串或 content 块数组）拍平成纯文本。 */
function contentText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n').trim()
}

/**
 * 把会话事件转成 [{role,text}]。
 *
 * 两种输入都吃：readSurface 给的 surface 事件（{type:'user/message', data:{...}}）
 * 和 deriveMessages 给的派生消息（{role, content}）。
 */
export function toMessages(events, options = {}) {
  const max = Number(options.maxMessages) > 0 ? Number(options.maxMessages) : MAX_SNAPSHOT_MESSAGES
  const out = []
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue
    const type = typeof event.type === 'string' ? event.type : ''
    const data = event.data && typeof event.data === 'object' ? event.data : event
    let role = ''
    if (type === 'user/message' || (type === '' && data.role === 'user')) role = 'user'
    else if (type === 'assistant/message' || (type === '' && data.role === 'assistant')) role = 'assistant'
    else continue
    if (role === 'user') {
      const kind = data.source && typeof data.source.kind === 'string' ? data.source.kind : ''
      if (kind && NOISE_SOURCES.has(kind)) continue
    }
    const text = contentText(data.content)
    if (!text) continue
    out.push({
      role,
      text: clampText(text, MAX_MESSAGE_TEXT),
      at: typeof data.at === 'string' ? data.at : (typeof event.at === 'string' ? event.at : ''),
    })
  }
  return out.slice(-max)
}

function firstUserLine(messages) {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const line = message.text.split('\n').map((s) => s.trim()).filter(Boolean)[0] || ''
    if (line) return line
  }
  return ''
}

/**
 * 「送过去」的会话到了本机：先说明来路，再把之前的对话按人/机交替贴进来。
 * 目标会话是新建的时候，这段话就是它的开场白；已存在时就是接着聊的下一句。
 */
export function frameHandoffMessage(handoff, deviceName = '') {
  const title = clampText(String((handoff && handoff.title) || '未命名会话'), MAX_SESSION_TITLE)
  const from = String((handoff && handoff.fromDevice) || '') || '另一台设备'
  const lines = [
    '**会话已送过来：' + title + '**',
    '',
    '这条会话从「' + from + '」送到「' + (deviceName || '本机') + '」。',
    '下面是它之前的对话记录（最早的在最前面）。接着往下聊就行，不用复述上面这些。',
    '',
  ]
  const messages = Array.isArray(handoff && handoff.messages) ? handoff.messages : []
  if (messages.length === 0) {
    lines.push('（这条会话还没有消息）')
  } else {
    const blocks = []
    for (const message of messages) {
      const who = message && message.role === 'assistant' ? '助手' : '主人'
      const text = clampText(String((message && message.text) || ''), MAX_MESSAGE_TEXT)
      if (!text) continue
      blocks.push('--- ' + who + ' ---\n' + text + '\n')
    }
    // 从最近往前收，超预算就停：接续看的是「刚才聊到哪」，不是开天辟地那几句。
    const kept = []
    let used = lines.join('\n').length
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      if (used + blocks[i].length > HANDOFF_MAX_CHARS && kept.length > 0) break
      kept.unshift(blocks[i])
      used += blocks[i].length
    }
    const dropped = blocks.length - kept.length
    if (dropped > 0) lines.push('（更早的 ' + dropped + ' 条消息太长，省略了）', '')
    for (const block of kept) lines.push(block.trimEnd(), '')
  }
  return lines.join('\n').trim()
}

/**
 * readTitleSnapshots 的 value 形状随版本不同（`{title}` 或 `{title:{title}}`），
 * 这里两种都认，认不出就当没有标题。
 */
function titleOfSnapshot(value) {
  if (!value || typeof value !== 'object') return ''
  const first = value.title
  if (typeof first === 'string') return first.trim()
  if (first && typeof first === 'object' && typeof first.title === 'string') return first.title.trim()
  return ''
}

/**
 * 会话读写门面。服务缺失时所有方法都安全降级（返回空/报错字符串），不抛。
 */
export function createSessionReader(ctx, logger) {
  const log = logger || { warn() {}, info() {} }

  function service(name) {
    try {
      const value = typeof ctx.get === 'function' ? ctx.get(name) : undefined
      return value
    } catch {
      return undefined
    }
  }

  function controller() {
    return service('sessionController')
  }

  function query() {
    return service('sessionQuery')
  }

  function liveSessions() {
    try {
      return ctx.sessions && typeof ctx.sessions.list === 'function' ? ctx.sessions.list() : []
    } catch {
      return []
    }
  }

  /** 本机最近 N 条会话（不含空白会话、不含已归档），新的在前。 */
  async function listRecent(limit = MAX_SNAPSHOT_SESSIONS) {
    const archived = readArchivedIds()
    const alive = (sessionId) => Boolean(sessionId) && !archived.has(String(sessionId))
    const ctrl = controller()
    if (ctrl && typeof ctrl.list === 'function') {
      const result = await ctrl.list({})
      const items = (result && result.items) || []
      return items
        .filter((item) => item && item.sessionId && item.blank !== true && alive(item.sessionId))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, limit)
        .map((item) => ({ sessionId: String(item.sessionId), updatedAt: Number(item.updatedAt) || 0 }))
    }
    const q = query()
    if (q && typeof q.listSessions === 'function') {
      const records = await q.listSessions()
      return (Array.isArray(records) ? records : [])
        .map((record) => ({
          sessionId: String((record && record.header && record.header.id) || ''),
          updatedAt: Date.parse((record && record.header && record.header.createdAt) || '') || 0,
        }))
        .filter((item) => item.sessionId && alive(item.sessionId))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
    }
    return liveSessions()
      .filter((session) => session && alive(session.id))
      .slice(0, limit)
      .map((session) => ({ sessionId: String(session.id), updatedAt: 0 }))
  }

  /** sessionId → 标题（取不到就空，调用方用首句兜底）。 */
  async function readTitles(ids) {
    const titles = new Map()
    const title = service('sessionTitle')
    const live = liveSessions()
    for (const id of ids) {
      const session = live.find((item) => item && item.id === id)
      if (!session || !title || typeof title.get !== 'function') continue
      try {
        const folded = title.get(session)
        if (folded && typeof folded.title === 'string' && folded.title.trim()) titles.set(id, folded.title.trim())
      } catch {
        // 冷会话会抛「not live in this store」，忽略，走批量冷读。
      }
    }
    const q = query()
    if (!q || typeof q.readTitleSnapshots !== 'function' || ids.length === 0) return titles
    try {
      const results = await q.readTitleSnapshots(ids)
      for (let i = 0; i < results.length && i < ids.length; i += 1) {
        const result = results[i]
        if (!result || result.status !== 'fulfilled') continue
        const title = titleOfSnapshot(result.value)
        if (title) titles.set(ids[i], title)
      }
    } catch (error) {
      log.warn('relay-pair: 读会话标题失败: ' + (error && error.message ? error.message : error))
    }
    return titles
  }

  /** 一条会话的最近消息；读不到就返回空数组。 */
  async function readMessages(sessionId) {
    const q = query()
    if (q && typeof q.readSurface === 'function') {
      const surface = await q.readSurface(sessionId)
      return toMessages(surface && surface.events)
    }
    const session = liveSessions().find((item) => item && item.id === sessionId)
    if (session && typeof session.deriveMessages === 'function') {
      return toMessages(session.deriveMessages())
    }
    return []
  }

  /** 组装上报体：最近 8 条会话（标题 + 全部消息），按新→旧排。 */
  async function collect(limit = MAX_SNAPSHOT_SESSIONS) {
    const recent = await listRecent(limit)
    if (recent.length === 0) return []
    const titles = await readTitles(recent.map((item) => item.sessionId))
    const out = []
    for (const item of recent) {
      let messages = []
      try {
        messages = await readMessages(item.sessionId)
      } catch (error) {
        log.warn('relay-pair: 读会话 ' + item.sessionId + ' 失败: ' + (error && error.message ? error.message : error))
      }
      const title = titles.get(item.sessionId) || firstUserLine(messages) || '未命名会话'
      out.push({
        sessionId: item.sessionId,
        title: clampText(title, MAX_SESSION_TITLE),
        updatedAt: new Date(item.updatedAt || Date.now()).toISOString(),
        messages,
      })
    }
    return out
  }

  /** 本机有没有这条会话（含冷会话）。 */
  async function hasSession(sessionId) {
    if (!sessionId) return false
    const ctrl = controller()
    if (ctrl && typeof ctrl.list === 'function') {
      const result = await ctrl.list({})
      const items = (result && result.items) || []
      if (items.some((item) => item && item.sessionId === sessionId)) return true
    }
    if (liveSessions().some((session) => session && session.id === sessionId)) return true
    const q = query()
    if (q && typeof q.listSessions === 'function') {
      const records = await q.listSessions()
      return (Array.isArray(records) ? records : []).some(
        (record) => record && record.header && record.header.id === sessionId,
      )
    }
    return false
  }

  /**
   * 拿住一个会话的 agent（投递要用），顺手给新建的会话补标题。
   *
   * @returns {{ok:true, agent, sessionId, created:boolean} | {ok:false, error:string}}
   */
  async function resolveSession(sessionId, options = {}) {
    const ctrl = controller()
    const resolved = await ctrl.resolveAgent(sessionId)
    if (!resolved || (typeof resolved === 'object' && 'error' in resolved)) {
      const error = resolved && resolved.error
      return { ok: false, error: '接续会话失败：' + (error && error.message ? error.message : String(error)) }
    }
    const deliverable = (value) => value && (typeof value.followup === 'function' || typeof value.send === 'function')
    const agent = deliverable(resolved) ? resolved : resolved.agent
    if (!deliverable(agent)) {
      return { ok: false, error: '接续会话失败：拿到的不是可投递的 agent' }
    }
    // 新建出来的会话还没有标题事件，补一个（已有标题的不要覆盖）。
    const titleText = String((options && options.title) || '').trim()
    const title = service('sessionTitle')
    if (options && options.created && titleText && title && typeof title.rename === 'function' && agent.session) {
      try {
        if (typeof title.get !== 'function' || title.get(agent.session) === undefined) {
          title.rename(agent.session, clampText(titleText, MAX_SESSION_TITLE))
        }
      } catch (error) {
        log.warn('relay-pair: 给新会话设标题失败: ' + (error && error.message ? error.message : error))
      }
    }
    return { ok: true, agent, sessionId, created: Boolean(options && options.created) }
  }

  /**
   * 开一条全新会话 —— 每条中继任务一个会话，互不串味。
   *
   * 不指定 id：让 DSH 自己发一个，避免撞上主人手头正在聊的那条。
   * @returns {{ok:true, agent, sessionId, created:true} | {ok:false, error:string}}
   */
  async function createSession(options = {}) {
    const ctrl = controller()
    if (!ctrl || typeof ctrl.resolveAgent !== 'function') {
      return { ok: false, error: '这个 DSH 没有提供 sessionController，没法新建会话' }
    }
    if (typeof ctrl.create !== 'function') {
      return { ok: false, error: '这个 DSH 的 sessionController 不支持新建会话' }
    }
    const made = await ctrl.create({})
    const sessionId = String((made && made.sessionId) || '').trim()
    if (!sessionId) return { ok: false, error: '新建会话没有返回 sessionId' }
    return resolveSession(sessionId, { created: true, title: options.title })
  }

  /**
   * 接上指定会话：本机有就 resume，没有就用这个 id 新建。
   * 「接着做」必须落到原会话，所以这里**只认给定 id**，绝不换成别的会话。
   *
   * @returns {{ok:true, agent, sessionId, created:boolean} | {ok:false, error:string}}
   */
  async function ensureSession(sessionId, options = {}) {
    const wanted = String(sessionId || '').trim()
    const ctrl = controller()
    if (!ctrl || typeof ctrl.resolveAgent !== 'function') {
      return { ok: false, error: '这个 DSH 没有提供 sessionController，没法新建/接续会话' }
    }
    if (!wanted) return { ok: false, error: '这条会话没有 sessionId，没法接续' }
    let exists = false
    try {
      exists = await hasSession(wanted)
    } catch (error) {
      log.warn('relay-pair: 查会话是否存在失败: ' + (error && error.message ? error.message : error))
    }
    if (!exists) {
      if (typeof ctrl.create !== 'function') {
        return { ok: false, error: '这个 DSH 的 sessionController 不支持新建会话' }
      }
      const made = await ctrl.create({ sessionId: wanted })
      const madeId = String((made && made.sessionId) || wanted)
      return resolveSession(madeId, { created: true, title: options.title })
    }
    return resolveSession(wanted, { created: false, title: options.title })
  }

  /**
   * 接上一条送过来的会话（「送过去」用）。
   *
   * 已有这条 sessionId → 直接 resume 那条会话（接着聊）；
   * 没有 → 用同一个 sessionId 新建一条，这样下次再送过来还是同一条，不会越送越多。
   *
   * @returns {{ok:true, agent, sessionId, created:boolean} | {ok:false, error:string}}
   */
  async function applyHandoff(handoff, options = {}) {
    const wanted = String((handoff && handoff.sessionId) || '').trim()
    return ensureSession(wanted, { title: (options && options.title) || '' })
  }

  return {
    listRecent, readTitles, readMessages, collect, hasSession,
    createSession, ensureSession, applyHandoff,
    available: () => Boolean(controller() || query()),
  }
}
