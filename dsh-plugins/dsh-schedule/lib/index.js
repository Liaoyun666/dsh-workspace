// dsh-schedule: one scheduler for DeepSeek Harness.
//
// Two kinds of timed work share one plugin, one store, one HTTP prefix and one
// drawer:
//
//   remind - fire a prompt into a conversation at a moment or on a rhythm
//            (at / every / daily / cron). Delivery injects a plugin-sourced
//            user message through agent.followup(), which queues an ordinary
//            turn and wakes the driver.
//   goal   - at one absolute moment pin the session's permission preset and
//            arm a /goal whose objective is the stored prompt; the
//            deployment's goal-round-driver runs it automatically.
//
// Remind-task sources: config.tasks in cordis.yml (static, origin "config"),
// and schedule_add tool calls / POST /schedule/api/add (dynamic, persisted).
// Run stamps (lastRunAt / firedAt), enabled overrides, timed goals and the
// execution history are persisted, so a restart never refires a consumed slot
// and the UI can show what ran.
//
// The plugin deliberately imports no @deepseek-ai/* package: it is loaded from
// a workspace path, so only node: builtins and relative files are resolved.
// Tool registration and user-message construction use the local shims below
// instead of defineTool / createUserMessage.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { createGoalEngine, formatGoal, isValidGoal } from './goals.js'

export const name = 'schedule'

export const inject = ['agents', 'tools']

// Minimum fixed-interval seconds. Deliberately small-but-nonzero: every fire
// is a full agent turn (a real model call), so sub-10s loops burn tokens and
// can starve the session; 10s leaves room for testing and near-realtime use.
const MIN_EVERY_SECONDS = 10
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const DAILY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const STORAGE_VERSION = 2
const MAX_HISTORY = 500
const EXCERPT_LENGTH = 300
/** Rows the conversation picker lists; each title costs one session-log read. */
const SESSION_DIRECTORY_LIMIT = 60
/** How long the first directory call waits for titles before answering with ids. */
const TITLE_WAIT_MS = 2000
/** Titles kept in the cache file (the picker only ever shows the newest rows). */
const TITLE_CACHE_LIMIT = 300
/** Cap for a task's goal text; long enough for a paragraph, short enough not to flood the prompt. */
const MAX_GOAL_LENGTH = 4000

/**
 * How a task picks its delivery conversation:
 *   bound - the conversation stored on the task (resumed when it was closed),
 *           which is the conversation it was created in unless one was picked;
 *   new   - a dedicated conversation of its own, opened on the first firing.
 */
const SESSION_MODES = new Set(['bound', 'new'])

/**
 * Local stand-in for @deepseek-ai/dsh-tools' defineTool: compiles the
 * author-facing compact parameter spec ({ type, required?, description }) into
 * the raw JSON Schema that ctx.tools.register() validates arguments against.
 * The host registry still enforces the schema and the output contract.
 */
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
 * Local stand-in for @deepseek-ai/dsh-llm's createUserMessage: a frozen user
 * message with a fresh id and the plugin as its source.
 */
function createUserMessage(input) {
  return Object.freeze({ ...input, id: randomUUID(), role: 'user' })
}

/** Fill the config defaults so every config field below is safe. */
function normalizeConfig(config) {
  const input = config !== null && typeof config === 'object' ? config : {}
  return {
    storagePath: typeof input.storagePath === 'string' ? input.storagePath : '',
    historyPath: typeof input.historyPath === 'string' ? input.historyPath : '',
    tickSeconds: Number.isFinite(input.tickSeconds) ? input.tickSeconds : 15,
    goalTickSeconds: Number.isFinite(input.goalTickSeconds) ? input.goalTickSeconds : 1,
    systemNotify: input.systemNotify !== false,
    systemNotifySound: input.systemNotifySound !== false,
    // A one-shot task that already ran has nothing left to do; drop it so the
    // task tab does not pile up spent rows. Set false to keep them.
    autoRemoveFinished: input.autoRemoveFinished !== false,
    tasks: Array.isArray(input.tasks) ? input.tasks : [],
  }
}

// --- scheduling ------------------------------------------------------------

/** Count how many schedule rules one task carries. */
function ruleCount(task) {
  return (task.at ? 1 : 0) + (task.every != null ? 1 : 0) + (task.daily ? 1 : 0) + (task.cron ? 1 : 0)
}

// --- cron expressions (standard 5 fields, local time) ------------------------

const CRON_RANGES = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 are Sunday)
]

/** Parse one cron field into a set of allowed values, or null when invalid. */
function parseCronField(field, [min, max]) {
  const values = new Set()
  for (const part of field.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part)
    if (!m) return null
    const step = m[3] != null ? Number(m[3]) : 1
    if (step < 1) return null
    let lo
    let hi
    if (m[1] === '*') {
      lo = min
      hi = max
    } else if (m[2] != null) {
      lo = Number(m[1])
      hi = Number(m[2])
    } else if (m[3] != null) {
      // "a/n" means a..max with step n (Vixie cron behavior).
      lo = Number(m[1])
      hi = max
    } else {
      lo = Number(m[1])
      hi = lo
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return values.size > 0 ? values : null
}

/**
 * Parse a standard 5-field cron expression ("分 时 日 月 周"), or return null.
 * Supports *, lists (a,b), ranges (a-b), and steps (*\/n, a-b/n, a/n).
 */
function parseCron(expr) {
  if (typeof expr !== 'string') return null
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const parsed = []
  for (let i = 0; i < 5; i++) {
    const set = parseCronField(fields[i], CRON_RANGES[i])
    if (!set) return null
    parsed.push(set)
  }
  // Normalize Sunday: 7 is an alias of 0.
  if (parsed[4].has(7)) {
    parsed[4].delete(7)
    parsed[4].add(0)
  }
  return {
    minute: parsed[0],
    hour: parsed[1],
    dom: parsed[2],
    month: parsed[3],
    dow: parsed[4],
    domStar: fields[2] === '*',
    dowStar: fields[4] === '*',
  }
}

function cronMatches(cron, date) {
  if (!cron.minute.has(date.getMinutes())) return false
  if (!cron.hour.has(date.getHours())) return false
  if (!cron.month.has(date.getMonth() + 1)) return false
  const domMatch = cron.dom.has(date.getDate())
  const dowMatch = cron.dow.has(date.getDay())
  // Standard schedule: when BOTH dom and dow are restricted, either may match.
  if (!cron.domStar && !cron.dowStar) return domMatch || dowMatch
  return domMatch && dowMatch
}

/** First matching local minute strictly after `afterMs`, or null within 4 years. */
function nextCronSlot(cron, afterMs) {
  let t = Math.floor(afterMs / 60_000) * 60_000 + 60_000
  const limit = t + 4 * 366 * 24 * 60 * 60_000
  while (t < limit) {
    if (cronMatches(cron, new Date(t))) return t
    t += 60_000
  }
  return null
}

/** Trim a goal string; an empty string means "this task has no goal". */
function normalizeGoal(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/** Validate a raw task record; returns an error string or null. */
function validateTask(task) {
  if (!task || typeof task !== 'object') return 'task must be an object'
  if (typeof task.id !== 'string' || !TASK_ID.test(task.id)) return `invalid task id: ${JSON.stringify(task.id)}`
  if (typeof task.prompt !== 'string' || task.prompt.trim() === '') return `task "${task.id}" needs a non-empty prompt`
  if (ruleCount(task) !== 1) return `task "${task.id}" must set exactly one of at / every / daily`
  if (task.at && !Number.isFinite(Date.parse(task.at))) return `task "${task.id}" has an unparseable at value`
  if (task.every != null && (!Number.isFinite(task.every) || task.every < MIN_EVERY_SECONDS)) {
    return `task "${task.id}" every must be a number >= ${MIN_EVERY_SECONDS}`
  }
  if (task.daily && !DAILY_RE.test(task.daily)) return `task "${task.id}" daily must be "HH:MM" (24h)`
  if (task.cron && !parseCron(task.cron)) return `task "${task.id}" has an invalid cron expression (want 5 fields: minute hour day month weekday)`
  if (task.goal != null && typeof task.goal !== 'string') return `task "${task.id}" goal must be a string`
  if (typeof task.goal === 'string' && task.goal.length > MAX_GOAL_LENGTH) {
    return `task "${task.id}" goal is longer than ${MAX_GOAL_LENGTH} characters`
  }
  if (task.sessionMode != null && !SESSION_MODES.has(task.sessionMode)) {
    return `task "${task.id}" sessionMode must be "bound" or "new"`
  }
  if (task.sessionId != null && (typeof task.sessionId !== 'string' || task.sessionId.trim() === '')) {
    return `task "${task.id}" sessionId must be a non-empty string`
  }
  if (task.cwd != null && typeof task.cwd !== 'string') return `task "${task.id}" cwd must be a string`
  return null
}

/** Generate a unique task id: time-ordered base36 plus a random suffix. */
function generateTaskId(tasks) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    if (!tasks.has(id)) return id
  }
  throw new Error('could not allocate a task id')
}

/** Today's local occurrence of a "HH:MM" rule at or before `now`, as epoch ms. */
function dailySlotToday(daily, now) {
  const m = DAILY_RE.exec(daily)
  if (!m) return null
  const d = new Date(now)
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  return d.getTime()
}

/** Effective enabled state: a runtime override wins over the declared flag. */
function isEnabled(task) {
  return task.enabledOverride ?? task.enabled !== false
}

/**
 * Cached next cron slot for one task. Recomputed only after a successful
 * fire (which sets lastRunAt) or an edit, so ticks stay cheap.
 */
function cronNext(task, startedAt) {
  if (task.cronNext == null) {
    task.cronNext = nextCronSlot(task.cronParsed, task.lastRunAt ?? startedAt - 60_000)
  }
  return task.cronNext
}

/**
 * The scheduled slot a task is due for right now, or null when not due.
 * `startedAt` anchors `every`/`cron` tasks that have never run.
 */
function dueSlot(task, now, startedAt) {
  if (!isEnabled(task)) return null
  if (task.at) {
    if (task.firedAt) return null
    const t = Date.parse(task.at)
    return Number.isFinite(t) && now >= t ? t : null
  }
  if (task.every != null) {
    const slot = (task.lastRunAt ?? startedAt) + task.every * 1000
    return now >= slot ? slot : null
  }
  if (task.daily) {
    const slot = dailySlotToday(task.daily, now)
    if (slot == null || slot > now) return null
    // Already consumed today's slot (covers catch-up runs too).
    if ((task.lastRunAt ?? 0) >= slot) return null
    return slot
  }
  if (task.cron) {
    const slot = cronNext(task, startedAt)
    return slot != null && now >= slot ? slot : null
  }
  return null
}

/** Next scheduled fire time for display, or null when nothing is pending. */
function nextRunAt(task, now, startedAt) {
  if (!isEnabled(task)) return null
  if (task.at) return task.firedAt ? null : Date.parse(task.at)
  if (task.every != null) return (task.lastRunAt ?? startedAt) + task.every * 1000
  if (task.daily) {
    const slot = dailySlotToday(task.daily, now)
    if (slot == null) return null
    // Today's slot still ahead, or missed and not yet caught up -> today.
    if (slot > now || (task.lastRunAt ?? 0) < slot) return slot
    return slot + 86_400_000
  }
  if (task.cron) return cronNext(task, startedAt)
  return null
}

/** Public view of one task for tools, the HTTP API, and logs. */
function taskView(task, now, startedAt) {
  const next = nextRunAt(task, now, startedAt)
  return {
    id: task.id,
    prompt: task.prompt,
    goal: task.goal ?? null,
    schedule: task.at ? { at: task.at } : task.every != null ? { everySeconds: task.every } : task.daily ? { daily: task.daily } : task.cron ? { cron: task.cron } : {},
    enabled: isEnabled(task),
    origin: task.origin,
    // Where the next firing lands: a stored conversation (resumed when closed)
    // or a dedicated conversation opened on the first firing.
    sessionMode: task.sessionMode ?? 'bound',
    sessionId: task.sessionId ?? null,
    cwd: task.cwd ?? null,
    lastRunAt: task.lastRunAt ? new Date(task.lastRunAt).toISOString() : null,
    firedAt: task.firedAt ? new Date(task.firedAt).toISOString() : null,
    nextRunAt: next ? new Date(next).toISOString() : null,
  }
}

/**
 * Injection-resistant framing: the model must see this is automation, not the
 * user. A task with a goal also carries the goal and the excerpts of its last
 * few runs, so each firing continues the objective instead of starting over.
 */
function renderTaskMessage(task, slot, progress) {
  const lines = [
    `[cron] Scheduled task "${task.id}" fired.`,
    `Scheduled for: ${new Date(slot).toISOString()}`,
    `Fired at: ${new Date().toISOString()}`,
    '',
    'This is an automated task submitted by the cron plugin, not a message from the user.',
    'Execute the task inside <task> now, then report the result concisely.',
    '',
    '<task>',
    task.prompt,
    '</task>',
  ]
  if (task.goal) {
    const round = progress?.round ?? 1
    const previous = progress?.previous ?? []
    lines.push('', `<goal round="${round}">`, task.goal)
    if (previous.length > 0) {
      lines.push('', 'Progress from earlier rounds (oldest first):')
      for (const item of previous) lines.push(`- ${item.at}: ${item.excerpt}`)
    } else {
      lines.push('', 'This is the first round of this goal.')
    }
    lines.push(
      '',
      'Continue this goal from the progress above: do not redo what is already done, take the next concrete step,',
      'and end your reply with one short line saying what you advanced this round.',
      '</goal>',
    )
  }
  return lines.join('\n')
}

/** Concatenated text blocks of one assistant message, for history excerpts. */
function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

// --- trust fence -----------------------------------------------------------
//
// Behaviorally identical to the /api gateway's fence in
// @deepseek-ai/dsh-client-connection (BSD-3-Clause), copied here the same way
// dsh-better-sidebar copies it: the package does not export these helpers and
// a plugin must not depend on its internals. Host-header loopback or a
// configured trusted authority passes; cross-site browser markers refuse.
// This is a DNS-rebinding / cross-site defense, not authentication.

function headerValue(headers, name) {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
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

function isTrustedApiRequest(req, trustedHosts) {
  const host = headerValue(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts ?? [])) return false
  // Browser cross-site markers never appear on same-origin page fetches.
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
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/**
 * Best-effort native OS notification, fired from the host process: it appears
 * even when no browser is open at all. macOS uses osascript (Glass sound),
 * Linux uses notify-send when installed; anything else is a quiet no-op.
 * Never throws, never blocks the scheduler.
 */
function sendSystemNotification(title, body, { sound = true } = {}) {
  try {
    const text = String(body ?? '').replace(/\s+/g, ' ').slice(0, 200)
    if (process.platform === 'darwin') {
      const script = `display notification ${JSON.stringify(text)} with title ${JSON.stringify(String(title))}${sound ? ' sound name "Glass"' : ''}`
      execFile('osascript', ['-e', script], { timeout: 5000 }, () => {})
    } else if (process.platform === 'linux') {
      execFile('notify-send', [String(title), text], { timeout: 5000 }, () => {})
    }
  } catch { /* best effort only */ }
}

// --- plugin ------------------------------------------------------------------

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger
  const startedAt = Date.now()
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const storagePath = config.storagePath || join(dshHome, 'schedule-tasks.json')
  const historyPath = config.historyPath || join(dshHome, 'schedule-history.jsonl')
  const titleCachePath = config.titleCachePath || join(dshHome, 'schedule-session-titles.json')

  /**
   * Session titles, kept across restarts: the host reads one session log per id
   * to fold a title, which takes ~40ms each, so the directory would otherwise
   * answer slowly and change underneath the picker every time it opened.
   * @type {Map<string, string>}
   */
  const titleCache = new Map()

  function loadTitleCache() {
    if (!existsSync(titleCachePath)) return
    try {
      const data = JSON.parse(readFileSync(titleCachePath, 'utf8'))
      const titles = data?.titles
      if (!titles || typeof titles !== 'object') return
      for (const [id, title] of Object.entries(titles)) {
        if (typeof id === 'string' && typeof title === 'string' && title !== '') titleCache.set(id, title)
      }
    } catch (error) {
      logger.warn(`schedule: ignoring unreadable title cache ${titleCachePath}: ${error?.message ?? error}`)
    }
  }

  function saveTitleCache() {
    // Old conversations scroll out of the picker; keep the file bounded too.
    while (titleCache.size > TITLE_CACHE_LIMIT) {
      const oldest = titleCache.keys().next()
      if (oldest.done) break
      titleCache.delete(oldest.value)
    }
    const payload = JSON.stringify({ version: 1, titles: Object.fromEntries(titleCache) }, null, 2)
    try {
      mkdirSync(dirname(titleCachePath), { recursive: true })
      const tmp = `${titleCachePath}.tmp`
      writeFileSync(tmp, payload)
      renameSync(tmp, titleCachePath)
    } catch (error) {
      logger.warn(`schedule: failed to write ${titleCachePath}: ${error?.message ?? error}`)
    }
  }


  /** @type {Map<string, object>} live task records keyed by id */
  const tasks = new Map()

  /** Timed-goal records; persisted in the same file as the remind tasks. */
  const goalState = { jobs: [] }

  // --- task storage --------------------------------------------------------

  function save() {
    // Explicit field list: internal caches (cronParsed Sets, cronNext) never
    // reach the file and are rebuilt on load.
    const dynamic = [...tasks.values()]
      .filter((t) => t.origin === 'dynamic')
      .map((t) => ({ id: t.id, prompt: t.prompt, goal: t.goal ?? null, at: t.at, every: t.every, daily: t.daily, cron: t.cron ?? null, sessionMode: t.sessionMode ?? 'bound', sessionId: t.sessionId, cwd: t.cwd ?? null, enabled: t.enabled }))
    const runs = {}
    const overrides = {}
    for (const t of tasks.values()) {
      if (t.lastRunAt || t.firedAt) runs[t.id] = { lastRunAt: t.lastRunAt ?? null, firedAt: t.firedAt ?? null }
      if (t.enabledOverride != null) overrides[t.id] = t.enabledOverride
    }
    const payload = JSON.stringify({ version: STORAGE_VERSION, tasks: dynamic, runs, overrides, goals: goalState.jobs }, null, 2)
    try {
      mkdirSync(dirname(storagePath), { recursive: true })
      const tmp = `${storagePath}.tmp`
      writeFileSync(tmp, payload)
      renameSync(tmp, storagePath)
    } catch (error) {
      logger.warn(`schedule: failed to write ${storagePath}: ${error?.message ?? error}`)
    }
  }

  function load() {
    if (!existsSync(storagePath)) return { dynamic: [], runs: {}, overrides: {}, goals: [] }
    try {
      const data = JSON.parse(readFileSync(storagePath, 'utf8'))
      return {
        dynamic: Array.isArray(data.tasks) ? data.tasks : [],
        runs: data.runs && typeof data.runs === 'object' ? data.runs : {},
        overrides: data.overrides && typeof data.overrides === 'object' ? data.overrides : {},
        goals: Array.isArray(data.goals) ? data.goals : [],
      }
    } catch (error) {
      logger.warn(`schedule: ignoring unreadable storage ${storagePath}: ${error?.message ?? error}`)
      return { dynamic: [], runs: {}, overrides: {}, goals: [] }
    }
  }

  function addTask(raw, origin) {
    const invalid = validateTask(raw)
    if (invalid) return invalid
    if (tasks.has(raw.id)) return `task "${raw.id}" already exists`
    tasks.set(raw.id, {
      id: raw.id,
      prompt: raw.prompt,
      // Optional long-running objective: each firing continues it.
      goal: normalizeGoal(raw.goal),
      at: raw.at,
      every: raw.every,
      daily: raw.daily,
      cron: raw.cron ?? raw.schedule ?? null,
      cronParsed: (raw.cron ?? raw.schedule) ? parseCron(raw.cron ?? raw.schedule) : null,
      cronNext: null,
      // Where the next firing lands. "bound" delivers into sessionId (the
      // creating conversation unless one was picked) and resumes it when it is
      // closed; "new" opens a dedicated conversation and keeps it in sessionId.
      sessionMode: raw.sessionMode === 'new' ? 'new' : 'bound',
      sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null,
      cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : null,
      enabled: raw.enabled !== false,
      enabledOverride: null,
      origin,
      lastRunAt: null,
      firedAt: null,
    })
    return null
  }

  // Boot: persisted dynamic tasks + run stamps, then config tasks on top.
  const stored = load()
  loadTitleCache()
  for (const raw of stored.dynamic) {
    const invalid = addTask(raw, 'dynamic')
    if (invalid) logger.warn(`schedule: skipping stored task: ${invalid}`)
  }
  for (const raw of config.tasks ?? []) {
    const invalid = addTask(raw, 'config')
    if (invalid) logger.warn(`schedule: skipping config task: ${invalid}`)
  }
  for (const [id, run] of Object.entries(stored.runs)) {
    const task = tasks.get(id)
    if (!task) continue
    if (Number.isFinite(run?.lastRunAt)) task.lastRunAt = run.lastRunAt
    if (Number.isFinite(run?.firedAt)) task.firedAt = run.firedAt
  }
  // A one-shot that already fired is spent — its turn may have ended before the
  // last reload, or the row would just sit in the task tab forever.
  for (const task of [...tasks.values()]) {
    if (task.origin !== 'dynamic' || !isOneShot(task)) continue
    if (!task.firedAt && !task.lastRunAt) continue
    retireFinishedTask(task.id)
  }
  for (const [id, enabled] of Object.entries(stored.overrides)) {
    const task = tasks.get(id)
    if (task && typeof enabled === 'boolean') task.enabledOverride = enabled
  }
  for (const job of stored.goals) {
    if (isValidGoal(job)) goalState.jobs.push(job)
    else logger.warn('schedule: skipping an invalid timed goal record')
  }

  // The timed-goal engine shares this file: it mutates goalState.jobs and
  // calls save(), so one writer owns the whole schedule.
  const goals = createGoalEngine({
    ctx,
    logger,
    getJobs: () => goalState.jobs,
    save,
  })

  // --- execution history -----------------------------------------------------

  /** Newest-last in-memory history, persisted as JSONL. */
  let history = []
  let historyLoaded = false
  let historySeq = 0

  function loadHistory() {
    if (historyLoaded) return
    historyLoaded = true
    if (!existsSync(historyPath)) return
    try {
      const lines = readFileSync(historyPath, 'utf8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line)
          if (record && typeof record.id === 'string') {
            history.push(record)
            const seq = Number(record.seq)
            if (Number.isFinite(seq) && seq >= historySeq) historySeq = seq + 1
          }
        } catch { /* skip a torn line */ }
      }
      if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY)
    } catch (error) {
      logger.warn(`schedule: ignoring unreadable history ${historyPath}: ${error?.message ?? error}`)
      history = []
    }
  }

  function persistHistory() {
    try {
      mkdirSync(dirname(historyPath), { recursive: true })
      const tmp = `${historyPath}.tmp`
      writeFileSync(tmp, history.map((record) => JSON.stringify(record)).join('\n') + (history.length > 0 ? '\n' : ''))
      renameSync(tmp, historyPath)
    } catch (error) {
      logger.warn(`schedule: failed to write ${historyPath}: ${error?.message ?? error}`)
    }
  }

  function appendHistory(record) {
    loadHistory()
    history.push(record)
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY)
    persistHistory()
    return record
  }

  function updateHistory(id, patch) {
    const record = history.find((r) => r.id === id)
    if (!record) return
    Object.assign(record, patch)
    persistHistory()
  }

  /**
   * Runs awaiting their execution outcome, keyed by injected message id.
   * A run closes when a turn ends on the same session after its message
   * entered the surface.
   * @type {Map<string, { recordId: string, session: object, seen: boolean }>}
   */
  const pendingRuns = new Map()

  /**
   * Every callback entry point (timers, event listeners, HTTP handlers) is
   * wrapped so a plugin bug can NEVER escape as an uncaughtException /
   * unhandledRejection and take the host process down. The plugin does not
   * install process-level handlers — those belong to the host.
   */
  function guarded(label, fn) {
    return (...args) => {
      try {
        const result = fn(...args)
        // Async entry points (a firing may reopen a conversation) reject
        // instead of throwing; catch that here so no rejection goes unhandled.
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          return result.catch((error) => {
            logger.warn(`schedule: ${label} failed: ${error?.message ?? error}`)
            return undefined
          })
        }
        return result
      } catch (error) {
        logger.warn(`schedule: ${label} failed: ${error?.message ?? error}`)
        return undefined
      }
    }
  }

  /**
   * Newest history record of one session that has not closed yet. Used as a
   * fallback when the in-memory run map is gone (plugin reload / HMR) — the
   * persisted history is the durable source of truth for excerpts and status.
   */
  function openRunFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    loadHistory()
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const record = history[i]
      if (record.sessionId !== sessionId) continue
      if (record.status === 'delivered' || record.status === 'running') return record
    }
    return null
  }

  ctx.on('session/event', guarded('session/event listener', (session, event) => {
    // SessionEvent is an envelope: { type, seq, time, data } — the payload
    // (the message, the turn reason, …) lives under `data`.
    const data = event?.data ?? {}
    if (event.type === 'user/message') {
      const run = pendingRuns.get(data.id)
      if (run && !run.seen) {
        run.seen = true
        updateHistory(run.recordId, { status: 'running', startedAt: Date.now() })
      }
      return
    }
    if (event.type === 'assistant/message') {
      const text = messageText(data.message)
      if (!text) return
      let matched = false
      for (const run of pendingRuns.values()) {
        if (run.seen && run.session === session) {
          updateHistory(run.recordId, { excerpt: text.slice(0, EXCERPT_LENGTH) })
          matched = true
        }
      }
      if (!matched) {
        const open = openRunFor(session?.id)
        if (open) updateHistory(open.id, { excerpt: text.slice(0, EXCERPT_LENGTH) })
      }
      return
    }
    if (event.type === 'turn/end') {
      const reason = data.reason
      const kind = typeof reason?.kind === 'string' ? reason.kind : 'unknown'
      let closed = 0
      for (const [messageId, run] of pendingRuns) {
        if (!run.seen || run.session !== session) continue
        pendingRuns.delete(messageId)
        closed += 1
        updateHistory(run.recordId, {
          status: kind === 'completed' ? 'completed' : 'failed',
          endReason: kind,
          completedAt: Date.now(),
        })
        retireFinishedTask(history.find((r) => r.id === run.recordId)?.taskId)
        if (config.systemNotify) {
          const record = history.find((r) => r.id === run.recordId)
          if (record) {
            const title = kind === 'completed' ? `定时任务完成：${record.taskId}` : `定时任务失败：${record.taskId}`
            sendSystemNotification(title, record.excerpt || record.prompt, { sound: config.systemNotifySound })
          }
        }
      }
      if (closed === 0) {
        const open = openRunFor(session?.id)
        if (open) {
          updateHistory(open.id, {
            status: kind === 'completed' ? 'completed' : 'failed',
            endReason: kind,
            completedAt: Date.now(),
          })
          retireFinishedTask(open.taskId)
        }
      }
    }
  }))

  // --- delivery --------------------------------------------------------------

  // The web UI may host several root agents (one per open session); deliver
  // to the one that most recently showed life.
  let lastActiveRoot = null
  ctx.on('agent/created', guarded('agent/created listener', ({ agent }) => {
    if (ctx.agents.roots().includes(agent)) lastActiveRoot = agent
  }))
  ctx.on('agent/status', guarded('agent/status listener', ({ agent }) => {
    if (agent && ctx.agents.roots().includes(agent)) lastActiveRoot = agent
  }))

  /**
   * The host's session controller. It is the only entry point that resumes a
   * closed conversation and opens a new one with the deployment's own preset,
   * cwd rules and concurrent-resume dedupe, so the scheduler never has to
   * rebuild an agent by hand. Read through ctx.get(): the name cannot be listed
   * in inject (a host without it would leave this entry pending forever), and
   * ctx.get() is the documented read-without-inject entry point.
   */
  function sessionController() {
    const controller = ctx.get('sessionController')
    return controller === undefined || controller === null ? null : controller
  }

  /** The live agent that owns one conversation right now, or null. */
  function liveAgentFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    try {
      const agent = ctx.agents.get(sessionId)
      return agent === undefined ? null : agent
    } catch (error) {
      logger.warn(`schedule: could not read agent for session "${sessionId}": ${error?.message ?? error}`)
      return null
    }
  }

  /**
   * Resume one closed conversation and return its agent. This is what makes a
   * task stay attached to its conversation: the firing reopens that session
   * instead of landing in whatever window happens to be open.
   */
  async function resumeSession(sessionId) {
    const controller = sessionController()
    if (!controller || typeof controller.resolveAgent !== 'function') return null
    try {
      const found = await controller.resolveAgent(sessionId)
      if (found && found.agent) return found.agent
      const reason = found?.error?.message ?? 'session could not be resolved'
      logger.warn(`schedule: session "${sessionId}" was not resumed: ${reason}`)
      return null
    } catch (error) {
      logger.warn(`schedule: session "${sessionId}" was not resumed: ${error?.message ?? error}`)
      return null
    }
  }

  /**
   * Open the dedicated conversation of a "new conversation" task and remember
   * it, so later firings continue in the same place.
   */
  async function createTaskSession(task) {
    const controller = sessionController()
    if (!controller || typeof controller.create !== 'function') {
      logger.warn(`schedule: task "${task.id}" wants its own conversation but the session controller is unavailable`)
      return null
    }
    try {
      const created = await controller.create(task.cwd ? { cwd: task.cwd } : {})
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        logger.warn(`schedule: task "${task.id}" could not open a new conversation`)
        return null
      }
      task.sessionId = sessionId
      save()
      logger.info(`schedule: task "${task.id}" opened conversation "${sessionId}"`)
      return liveAgentFor(sessionId) ?? (await resumeSession(sessionId))
    } catch (error) {
      logger.warn(`schedule: task "${task.id}" could not open a new conversation: ${error?.message ?? error}`)
      return null
    }
  }

  /**
   * Resolve where one firing goes. A bound task delivers into its own
   * conversation, resuming it when it was closed; a "new" task opens its
   * dedicated conversation the first time it fires. Only when neither can be
   * resolved does the firing fall back to the most recently active window —
   * a due task is never silently dropped.
   */
  async function resolveDeliveryAgent(task) {
    if (task.sessionMode === 'new' && !task.sessionId) {
      const created = await createTaskSession(task)
      if (created) return created
    }
    if (task.sessionId) {
      const live = liveAgentFor(task.sessionId)
      if (live) return live
      const resumed = await resumeSession(task.sessionId)
      if (resumed) return resumed
      logger.warn(`schedule: task "${task.id}" is bound to session "${task.sessionId}" which cannot be resumed; using the active conversation`)
    }
    const roots = ctx.agents.roots()
    if (lastActiveRoot && roots.includes(lastActiveRoot)) return lastActiveRoot
    return roots.length > 0 ? roots[roots.length - 1] : null
  }

  /**
   * Goal context for the next firing: which round this is plus the excerpts of
   * the last few runs, so a goal task picks up where the previous run stopped.
   */
  /**
   * One line of a previous reply for the next round's progress block: the last
   * non-empty line, which is where the task asks the model to state what it
   * advanced this round. Long replies would otherwise flood the next prompt.
   */
  function lastLine(text) {
    const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
    const line = lines.length > 0 ? lines[lines.length - 1] : ''
    return line.length > 180 ? line.slice(0, 180) + '…' : line
  }

  function goalProgress(task) {
    loadHistory()
    const mine = history.filter((r) => r.taskId === task.id)
    const previous = mine
      .filter((r) => typeof r.excerpt === 'string' && r.excerpt.trim() !== '')
      .slice(-3)
      .map((r) => ({ at: r.firedAt ?? '', excerpt: lastLine(r.excerpt) }))
    // Every earlier firing is one earlier round, whether or not the turn that
    // answered it has ended yet — counting only 'completed' records would
    // repeat the same round number while the previous turn is still running.
    return { round: mine.length + 1, previous }
  }

  /**
   * Task ids whose delivery is being prepared right now. Opening or resuming a
   * conversation takes seconds, so the tick timer can come around again before
   * the previous attempt finished; this guard keeps one slot to one delivery.
   */
  const firing = new Set()

  /**
   * Deliver one task. Returns the history record when the message was
   * accepted, null when no conversation could take it (retry next tick).
   */
  async function fire(task, slot) {
    if (firing.has(task.id)) {
      logger.info(`schedule: task "${task.id}" is still being delivered; skipping this tick`)
      return null
    }
    firing.add(task.id)
    try {
      const agent = await resolveDeliveryAgent(task)
      if (!agent) {
        logger.warn(`schedule: task "${task.id}" is due but no conversation is available yet; will retry next tick`)
        return null
      }
      let message
      try {
        message = createUserMessage({
          content: [{ type: 'text', text: renderTaskMessage(task, slot, task.goal ? goalProgress(task) : undefined) }],
          source: { kind: 'plugin:dsh-schedule' },
        })
        // Queues an ordinary turn and wakes the driver; when the agent is
        // busy the turn waits behind the current one, so tasks never overlap.
        agent.followup(message)
      } catch (error) {
        logger.warn(`schedule: followup failed for task "${task.id}": ${error?.message ?? error}`)
        return null
      }
      const now = Date.now()
      task.lastRunAt = now
      if (task.at) task.firedAt = now
      task.cronNext = null // recompute the cron slot from this run
      save()
      const record = appendHistory({
        id: `run-${historySeq}-${now.toString(36)}`,
        seq: historySeq++,
        taskId: task.id,
        prompt: task.prompt,
        sessionId: agent.session?.id ?? null,
        scheduledFor: new Date(slot).toISOString(),
        firedAt: new Date(now).toISOString(),
        status: 'delivered',
      })
      pendingRuns.set(message.id, { recordId: record.id, session: agent.session, seen: false })
      logger.info(`schedule: fired task "${task.id}" into session "${agent.session?.id ?? '?'}" (scheduled ${new Date(slot).toISOString()})`)
      return record
    } finally {
      firing.delete(task.id)
    }
  }


  /**
   * Catch-all for spend one-shots whose turn/end was missed (the conversation
   * was closed, or the run closed through another path): a fired one-shot with
   * no queued run left has nothing to wait for, so drop it instead of leaving
   * the row in the task tab. Tasks with a run still in `pendingRuns` keep their
   * row — the turn/end handler retires those.
   */
  function sweepSpentOneShots() {
    for (const task of [...tasks.values()]) {
      if (task.origin !== 'dynamic' || !isOneShot(task) || !task.firedAt) continue
      let waiting = false
      for (const run of pendingRuns.values()) {
        if (history.find((r) => r.id === run.recordId)?.taskId === task.id) {
          waiting = true
          break
        }
      }
      if (waiting) continue
      retireFinishedTask(task.id)
    }
  }

  async function tick() {
    const now = Date.now()
    const due = []
    for (const task of tasks.values()) {
      // Per-task isolation: one malformed task must not block the others,
      // and nothing here may ever escape the timer callback.
      try {
        const slot = dueSlot(task, now, startedAt)
        if (slot != null) due.push([task, slot])
      } catch (error) {
        logger.warn(`schedule: tick failed for task "${task?.id}": ${error?.message ?? error}`)
      }
    }
    // Deliver concurrently: a task that has to reopen its conversation must
    // not hold up the others, and each failure stays its own problem.
    await Promise.allSettled(due.map(([task, slot]) => fire(task, slot)))
    try {
      sweepSpentOneShots()
    } catch (error) {
      logger.warn(`schedule: cleanup sweep failed: ${error?.message ?? error}`)
    }
  }

  // One interval owns the whole schedule; cleared automatically on unload.
  ctx.effect(() => {
    const safeTick = guarded('tick', tick)
    // A short first delay lets the surrounding composition finish booting
    // so due tasks find a live root agent on the first tick.
    const first = setTimeout(safeTick, 3000)
    const timer = setInterval(safeTick, Math.max(1, config.tickSeconds) * 1000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  })

  // Timed goals need second precision: they fire once at an absolute moment
  // (or once a day), unlike the reminder grid.
  ctx.effect(() => {
    let stopped = false
    const safeGoalTick = () => {
      if (stopped) return
      goals.tick().catch((error) => {
        logger.warn("schedule: goal tick rejected: " + String(error?.message ?? error))
      })
    }
    // A short first delay lets the composition finish booting.
    const first = setTimeout(safeGoalTick, 2000)
    const timer = setInterval(safeGoalTick, Math.max(1, config.goalTickSeconds) * 1000)
    return () => {
      stopped = true
      clearTimeout(first)
      clearInterval(timer)
    }
  })

  // --- shared operations (tools + HTTP API) -----------------------------------

  /**
   * Recent conversations for the "which conversation" picker: id, folded
   * title, working directory and whether the session is attached right now.
  /**
   * Title text out of whatever `readTitleSnapshots` settled with: recent hosts
   * settle `{ session, title: { title, messageSeqs, ... } }` (a title snapshot),
   * older ones settle a bare string. Anything else means "no title yet".
   */
  function titleTextOf(value) {
    const raw = value?.title
    const text = typeof raw === 'string' ? raw : typeof raw?.title === 'string' ? raw.title : null
    if (text === null) return null
    const trimmed = text.trim()
    return trimmed === '' ? null : trimmed
  }

  /**
   * Read from the host's session query service, whose list is newest-first and
   * already merges live sessions the persistence layer has not flushed yet.
   */
  async function listSessionDirectory() {
    const query = ctx.get('sessionQuery')
    if (!query || typeof query.listSessions !== 'function') return []
    let rows
    try {
      rows = await query.listSessions()
    } catch (error) {
      logger.warn(`schedule: could not list conversations: ${error?.message ?? error}`)
      return []
    }
    if (!Array.isArray(rows)) return []
    // Titles need one log read each, so only the newest rows get one (the rest
    // would make this request take tens of seconds on a long history).
    const recent = rows.slice(0, SESSION_DIRECTORY_LIMIT)
    const ids = recent.map((row) => row?.header?.id).filter((id) => typeof id === 'string')
    const missing = ids.filter((id) => !titleCache.has(id))
    if (missing.length > 0 && typeof query.readTitleSnapshots === 'function') {
      const pending = Promise.resolve()
        .then(() => query.readTitleSnapshots(missing))
        .then((snaps) => {
          if (!Array.isArray(snaps)) return
          missing.forEach((id, index) => {
            const snap = snaps[index]
            if (!snap || snap.status !== 'fulfilled') return
            const text = titleTextOf(snap.value)
            if (text !== null) titleCache.set(id, text)
          })
          saveTitleCache()
        })
        .catch((error) => {
          logger.warn(`schedule: could not read conversation titles: ${error?.message ?? error}`)
        })
      // A cold cache would otherwise make this request take seconds; answer with
      // whatever the read managed in the meantime and let it fill in behind us.
      if (missing.length === ids.length) {
        let timer = null
        try {
          await Promise.race([
            pending,
            new Promise((resolve) => {
              timer = setTimeout(resolve, TITLE_WAIT_MS)
            }),
          ])
        } finally {
          if (timer !== null) clearTimeout(timer)
        }
      }
    }
    return recent
      .map((row) => ({
        id: row?.header?.id,
        title: titleCache.get(row?.header?.id) ?? null,
        cwd: row?.header?.cwd ?? null,
        live: row?.live === true,
      }))
      .filter((row) => typeof row.id === 'string')
  }

  function listTasks() {
    const now = Date.now()
    return [...tasks.values()].map((t) => taskView(t, now, startedAt))
  }

  async function addDynamicTask(raw, sessionId) {
    const input = { ...raw }
    delete input.newSession
    // "schedule" is the tool/form name for a cron expression; the record keeps it
    // as "cron" (what dueSlot/nextRunAt/save/taskView read).
    if (input.cron == null && typeof input.schedule === 'string' && input.schedule.trim() !== '') input.cron = input.schedule.trim()
    delete input.schedule
    // The id is optional for callers: the web form never asks for one and
    // the model may omit it — allocate a unique id instead.
    if (input.id == null || input.id === '') input.id = generateTaskId(tasks)
    if (raw.newSession === true || input.sessionMode === 'new') {
      // A dedicated-conversation task must not inherit the creator's session,
      // or its first firing would land back in the conversation it came from.
      input.sessionMode = 'new'
      input.sessionId = null
    } else {
      // Bound: deliver into the creator's conversation unless one was picked.
      input.sessionMode = 'bound'
      const explicit = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
      input.sessionId = explicit !== '' ? explicit : (typeof sessionId === 'string' && sessionId !== '' ? sessionId : null)
    }
    const invalid = validateTask(input)
    if (invalid) throw new Error(invalid)
    const added = addTask(input, 'dynamic')
    if (added) throw new Error(added)
    save()
    const task = tasks.get(input.id)
    // Open the dedicated conversation right away so it shows up in the sidebar
    // together with the task, instead of materializing on the first firing.
    if (task.sessionMode === 'new' && !task.sessionId) await createTaskSession(task)
    return taskView(task, Date.now(), startedAt)
  }

  /** A one-shot rule: `at` alone, no repeating rule to fall back on. */
  function isOneShot(task) {
    return task.at != null && task.every == null && task.daily == null && task.cron == null
  }

  /**
   * Drop a dynamic one-shot task once its run ended: it has nothing left to do,
   * and keeping it would pile spent rows up in the task tab forever. Recurring
   * rules stay, and so do tasks that come from cordis.yml (the plugin must not
   * edit the user's config).
   */
  function retireFinishedTask(taskId) {
    if (config.autoRemoveFinished === false) return false
    const task = tasks.get(taskId)
    if (!task || task.origin !== 'dynamic' || !isOneShot(task)) return false
    tasks.delete(taskId)
    save()
    logger.info(`schedule: removed finished one-shot task "${taskId}"`)
    return true
  }

  function removeDynamicTask(id) {
    const task = tasks.get(id)
    if (!task) throw new Error(`no task with id "${id}"`)
    if (task.origin !== 'dynamic') throw new Error(`task "${id}" comes from cordis.yml config; remove it there`)
    tasks.delete(id)
    save()
    return { removed: id }
  }

  const RULE_KEYS = ['at', 'every', 'daily', 'cron']

  /**
   * Edit a dynamic task. Prompt updates in place; when any schedule rule key
   * is present in the patch the whole schedule is replaced (the other rules
   * are cleared) and the run stamps reset so the new rule takes effect now.
   */
  async function updateDynamicTask(id, patch) {
    const task = tasks.get(id)
    if (!task) throw new Error(`no task with id "${id}"`)
    if (task.origin !== 'dynamic') throw new Error(`task "${id}" comes from cordis.yml config; edit it there`)
    // "schedule" (tool parameter) is the record's "cron".
    if (patch.cron == null && typeof patch.schedule === 'string' && patch.schedule.trim() !== '') patch = { ...patch, cron: patch.schedule.trim() }
    if (patch.sessionMode !== undefined && !SESSION_MODES.has(patch.sessionMode)) {
      throw new Error('sessionMode must be "bound" or "new"')
    }
    const merged = { id, prompt: task.prompt }
    for (const k of RULE_KEYS) if (task[k] != null) merged[k] = task[k]
    if (typeof patch.prompt === 'string' && patch.prompt.trim() !== '') merged.prompt = patch.prompt.trim()
    if (patch.goal !== undefined) merged.goal = normalizeGoal(patch.goal)
    const scheduleTouched = RULE_KEYS.some((k) => patch[k] !== undefined && patch[k] !== null)
    if (scheduleTouched) {
      for (const k of RULE_KEYS) delete merged[k]
      for (const k of RULE_KEYS) if (patch[k] !== undefined && patch[k] !== null) merged[k] = patch[k]
    }
    const invalid = validateTask(merged)
    if (invalid) throw new Error(invalid)
    task.prompt = merged.prompt
    if (patch.goal !== undefined) task.goal = merged.goal ?? null
    for (const k of RULE_KEYS) task[k] = merged[k]
    if (scheduleTouched) {
      task.lastRunAt = null
      task.firedAt = null
      task.cronNext = null
      task.cronParsed = task.cron ? parseCron(task.cron) : null
    }
    // Delivery target. "new" opens a dedicated conversation; switching to it
    // drops the old binding so a fresh conversation is opened rather than the
    // previous one being reused.
    const wantsNew = patch.newSession === true || patch.sessionMode === 'new'
    if (patch.newSession !== undefined) task.sessionMode = patch.newSession === true ? 'new' : 'bound'
    if (patch.sessionMode !== undefined) task.sessionMode = patch.sessionMode
    if (patch.sessionId !== undefined) {
      const next = typeof patch.sessionId === 'string' ? patch.sessionId.trim() : ''
      task.sessionId = next === '' ? null : next
    } else if (wantsNew) {
      task.sessionId = null
    }
    if (patch.cwd !== undefined) task.cwd = typeof patch.cwd === 'string' && patch.cwd.trim() !== '' ? patch.cwd.trim() : null
    if (task.sessionMode === 'new' && !task.sessionId) await createTaskSession(task)
    save()
    return taskView(task, Date.now(), startedAt)
  }

  function setTaskEnabled(id, enabled) {
    const task = tasks.get(id)
    if (!task) throw new Error(`no task with id "${id}"`)
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
    // null clears the override when it matches the declared flag again.
    task.enabledOverride = enabled === (task.enabled !== false) ? null : enabled
    save()
    return taskView(task, Date.now(), startedAt)
  }

  async function runTaskNow(id) {
    const task = tasks.get(id)
    if (!task) throw new Error(`no task with id "${id}"`)
    const record = await fire(task, Date.now())
    if (!record) throw new Error('no conversation is available to receive the task')
    return { fired: id, run: record }
  }

  function listHistory(limit) {
    loadHistory()
    const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_HISTORY) : 100
    return history.slice(-cap).reverse()
  }

  // --- management tools --------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'sched_sessions',
    description: 'List recent conversations (id, title, working directory, whether attached) so a task can be pinned to one of them.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return JSON.stringify(await listSessionDirectory(), null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_list',
    description: 'List all scheduled tasks (from config and added at runtime) with their state and next run time.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return JSON.stringify(listTasks(), null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_add',
    description: 'Add a scheduled task. Set exactly one rule: at (ISO instant, one-shot), every (interval seconds, min 10), daily ("HH:MM" local time), or cron (standard 5-field expression "minute hour day month weekday", local time — e.g. "0 9 * * *" = daily 09:00, "*/30 * * * *" = every 30 min, "0 9 * * 1" = Mondays 09:00). Convert the user\'s natural-language schedule into one of these rules. The task prompt is delivered to the agent automatically when due and the result is replied in the conversation. Dynamic tasks persist across restarts.',
    parameters: {
      id: { type: 'string', description: 'Optional unique task id (letters, digits, -, _). One is generated when omitted.' },
      prompt: { type: 'string', required: true, description: 'What the agent should do when the task fires.' },
      goal: { type: 'string', description: 'Optional long-running objective this task advances. When set, every firing carries the goal plus the excerpts of the last three runs and asks the agent to take the NEXT step on it instead of starting over — use this for multi-round work ("keep improving X every hour").' },
      at: { type: 'string', description: 'ISO 8601 instant for a one-shot task.' },
      every: { type: 'number', description: `Fixed interval in seconds (min ${MIN_EVERY_SECONDS}).` },
      daily: { type: 'string', description: 'Local wall-clock "HH:MM" for a daily task.' },
      schedule: { type: 'string', description: 'Standard 5-field cron expression (minute hour day month weekday), local time.' },
      sessionId: { type: 'string', description: 'Conversation to deliver the runs into. Defaults to this conversation, so the task stays pinned here.' },
      newSession: { type: 'boolean', description: 'Open a dedicated new conversation for this task instead of using the current one.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      // Bind to the calling session: the task's runs reply in this window.
      const view = await addDynamicTask(args, exec?.agent?.session?.id)
      const target = view.sessionMode === 'new'
        ? `dedicated conversation "${view.sessionId ?? 'opening'}"`
        : (view.sessionId == null ? 'the most recent conversation' : `conversation "${view.sessionId}"`)
      return `Task "${view.id}" added for ${target}. Next run: ${view.nextRunAt}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_update',
    description: 'Edit a dynamically added scheduled task: change its prompt and/or replace its schedule rule. Pass exactly one rule (at / every / daily / cron) to change the schedule; omitted fields stay unchanged. Tasks declared in cordis.yml config cannot be edited at runtime.',
    parameters: {
      id: { type: 'string', required: true, description: 'Id of the task to edit.' },
      prompt: { type: 'string', description: 'New task prompt.' },
      goal: { type: 'string', description: 'Replace the task goal. Pass an empty string to remove the goal.' },
      at: { type: 'string', description: 'Replace the schedule with a one-shot ISO 8601 instant.' },
      every: { type: 'number', description: `Replace the schedule with a fixed interval in seconds (min ${MIN_EVERY_SECONDS}).` },
      daily: { type: 'string', description: 'Replace the schedule with a daily local "HH:MM".' },
      schedule: { type: 'string', description: 'Replace the schedule with a standard 5-field cron expression.' },
      sessionId: { type: 'string', description: 'Deliver into this conversation. Pass an empty string to stop pinning to any conversation.' },
      newSession: { type: 'boolean', description: 'true: move the task into a dedicated new conversation. false: deliver into a named conversation (sessionId or the current one).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const view = await updateDynamicTask(args.id, args)
      return `Task "${view.id}" updated. Next run: ${view.nextRunAt}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_remove',
    description: 'Remove a dynamically added scheduled task by id. Tasks declared in cordis.yml config cannot be removed at runtime.',
    parameters: {
      id: { type: 'string', required: true, description: 'Id of the task to remove.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      removeDynamicTask(args.id)
      return `Task "${args.id}" removed.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_history',
    description: 'Show recent scheduled-task execution records: when each task fired, whether it completed, and a short result excerpt.',
    parameters: {
      limit: { type: 'number', description: 'Max records to return (default 20, newest first).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return JSON.stringify(listHistory(args.limit ?? 20), null, 2)
    },
  }))

  // --- timed-goal tools ---------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'sched_goal_add',
    description: 'Schedule an automatic goal: at the given moment the session is pinned to the chosen permission and a goal with this objective is created and run by the goal driver. The session must still be reachable (an open or persisted session). Use sched_add instead when the user only wants a reminder message.',
    parameters: {
      when: { type: 'string', required: true, description: 'Absolute local time "YYYY-MM-DD HH:mm[:ss]"; append Z for UTC. Must be in the future.' },
      prompt: { type: 'string', required: true, description: 'The goal objective, i.e. what the agent should do when the goal fires.' },
      rounds: { type: 'number', description: 'Positive round cap for the goal (maxGoalRounds). Omit for the deployment default.' },
      daily: { type: 'boolean', description: 'Repeat every day at the same clock time (+24h after each run).' },
      permission: { type: 'string', description: 'Access level pinned at fire time: full-access (default) or workspace-write.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const job = goals.add(args, exec?.agent?.session?.id)
      return 'Timed goal "' + job.id + '" scheduled for ' + formatGoal(job)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_goal_list',
    description: 'List the scheduled timed goals (pending / fired / failed) with their time, rounds, access level and bound session.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return JSON.stringify(goals.list(), null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_goal_update',
    description: 'Edit a scheduled timed goal: change its time, prompt, round cap, daily repeat or access level. An edited goal becomes pending again.',
    parameters: {
      id: { type: 'string', required: true, description: 'Id of the timed goal to edit (tg-...).' },
      when: { type: 'string', required: true, description: 'New absolute local time "YYYY-MM-DD HH:mm[:ss]"; append Z for UTC.' },
      prompt: { type: 'string', required: true, description: 'New goal objective.' },
      rounds: { type: 'number', description: 'New round cap.' },
      daily: { type: 'boolean', description: 'Set true to repeat daily.' },
      permission: { type: 'string', description: 'full-access or workspace-write.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const job = goals.update(args.id, args)
      return 'Timed goal "' + job.id + '" updated: ' + formatGoal(job)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sched_goal_remove',
    description: 'Remove a scheduled timed goal by id.',
    parameters: {
      id: { type: 'string', required: true, description: 'Id of the timed goal to remove (tg-...).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      goals.remove(args.id)
      return 'Timed goal "' + args.id + '" removed.'
    },
  }))

  // --- HTTP API for the web client half -----------------------------------------
  //
  // Optional injection: profiles without the web stack (headless) never
  // activate this block and keep full scheduling.

  ctx.inject(['webServer'], (webCtx) => {
    // trustedHosts lives on webRuntime in DSH <= 0.2.0 and on webStartup in DSH >= 0.2.1.
    // Both are read through ctx.get(), never ctx.webRuntime / ctx.webStartup: neither name
    // can be listed in inject (a service the host lacks leaves the entry permanently
    // pending), and ctx.get() is the documented read-without-inject entry point.
    //
    // The connection service is the authority that actually fences the /api gateway, and
    // its list also carries the authorities configured on that plugin itself (the desktop
    // profile's cordis.patch.yml), not only the CLI --trusted-host values the two services
    // above report. Merging it is what keeps this panel working when the UI is reached
    // through a reverse proxy or a tunnel: with the CLI list alone every call here answers
    // 403 while the rest of the UI works fine.
    const trustedHosts = () => {
      const hosts = []
      const startup = ctx.get('webStartup')
      if (startup !== undefined && startup !== null) hosts.push(...(startup.trustedHosts ?? []))
      const runtime = ctx.get('webRuntime')
      if (runtime !== undefined && runtime !== null) hosts.push(...(runtime.trustedHosts ?? []))
      const connection = ctx.get('connection')
      if (connection !== undefined && connection !== null && Array.isArray(connection.trustedHosts)) {
        hosts.push(...connection.trustedHosts)
      }
      return [...new Set(hosts)]
    }
    const fence = (req) => isTrustedApiRequest(req, trustedHosts())

    const api = {
      list: () => ({ tasks: listTasks(), goals: goals.list() }),
      detail: (payload) => {
        const task = tasks.get(payload?.id)
        if (!task) throw new Error(`no task with id "${payload?.id}"`)
        return { task: taskView(task, Date.now(), startedAt), progress: goalProgress(task) }
      },
      sessions: async () => ({ sessions: await listSessionDirectory() }),
      add: async (payload) => ({ task: await addDynamicTask(payload) }),
      update: async (payload) => ({ task: await updateDynamicTask(payload?.id, payload ?? {}) }),
      remove: (payload) => removeDynamicTask(payload?.id),
      toggle: (payload) => ({ task: setTaskEnabled(payload?.id, payload?.enabled) }),
      run: (payload) => runTaskNow(payload?.id),
      history: (payload) => ({ records: listHistory(payload?.limit) }),
      goal_list: () => ({ goals: goals.list() }),
      goal_add: (payload) => ({ goal: goals.add(payload) }),
      goal_update: (payload) => ({ goal: goals.update(payload?.id, payload ?? {}) }),
      goal_remove: (payload) => goals.remove(payload?.id),
      goal_clear: () => goals.clear(),
    }

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/schedule/api',
      handler: async (req, res) => {
        try {
          if (!fence(req)) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith('/schedule/api/') ? pathname.slice('/schedule/api/'.length) : undefined
          if (method === undefined || method.includes('/')) {
            writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown cron API method' } })
            return
          }
          const payload = await readJsonBody(req)
          const handler = api[method]
          if (handler === undefined) {
            writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown cron API method "${method}"` } })
            return
          }
          // Handlers may be async (resuming or opening a conversation); a
          // rejected promise must reach the catch below, not the client socket.
          writeJson(res, 200, { ok: true, result: await handler(payload) })
        } catch (error) {
          // Last line of defense: a rejected handler promise must never
          // escape into the webserver as an unhandledRejection.
          try {
            if (!res.headersSent) writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: error?.message ?? String(error) } })
            else res.end()
          } catch { /* socket already gone */ }
        }
      },
    }), 'dsh-schedule: /schedule/api routes')

    logger.info('schedule: HTTP API mounted at /schedule/api')
  })

  logger.info(`schedule: loaded ${tasks.size} task(s), storage at ${storagePath}`)
}
