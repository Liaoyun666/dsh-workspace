// dsh-schedule: the "timed goal" half of the plugngin.
//
// A timed goal is a job that, at one absolute moment, does what
// /timed-goal did in the standalone plugin:
//
//   1. resolve the owning session's live agent (resuming a cold session from
//      persistence when needed, so the goal still runs after a restart),
//   2. pin that session's permission preset to the job's configured access
//      level (full-access -> danger-full-access),
//   3. create an armed goal whose objective is the stored prompt through
//      ctx.get('goals').create(); the deployment's goal-round-driver then runs
//      it automatically.
//
// This module imports nothing but node: builtins on purpose: every host
// service is reached through ctx.get() with duck typing, so the file stays
// loadable from any location and the plugin degrades (with warnings) when a
// service is missing. Storage is owned by the caller (one JSON file holding
// remind tasks *and* goals), so this engine never touches the filesystem.
import { randomUUID } from 'node:crypto'

/** The plugin is pointless without an agent registry. */
export const PERMISSION_KEYS = ['workspace-write', 'full-access']
export const DEFAULT_PERMISSION = 'full-access'
/** Preset that bundles sandbox danger-full-access + approval never. */
export const FULL_ACCESS_PRESET = 'danger-full-access'
/** Fire tick cadence (goals are second-precise). */
export const TICK_MS = 1000
export const ATTEMPT_BACKOFF_MS = 5000
export const MAX_ATTEMPTS = 24
export const GRACE_MS = 30 * 60 * 1000
export const DAY_MS = 24 * 60 * 60 * 1000
export const MAX_PROMPT_CHARS = 4000

/** Map a job-level access key to the permission-presets service preset name. */
export function permissionPresetNameFor(permission) {
  return permission === 'workspace-write' ? 'workspace-write' : FULL_ACCESS_PRESET
}

const SCHEDULE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z)?$/

/**
 * Parse a strict absolute date/time into epoch milliseconds.
 * A trailing Z means UTC; without it the value is the host's local time.
 */
export function parseScheduleInput(text) {
  const match = SCHEDULE_RE.exec(String(text ?? '').trim())
  if (match === null) return { ok: false, error: 'expected YYYY-MM-DD HH:mm[:ss], optionally with a trailing Z for UTC' }
  const [, year, month, day, hour, minute, second, zone] = match
  const y = Number(year)
  const mo = Number(month)
  const d = Number(day)
  const h = Number(hour)
  const mi = Number(minute)
  const s = second === undefined ? 0 : Number(second)
  if (mo < 1 || mo > 12) return { ok: false, error: 'month ' + mo + ' is out of range (1-12)' }
  if (d < 1 || d > 31) return { ok: false, error: 'day ' + d + ' is out of range (1-31)' }
  if (h > 23) return { ok: false, error: 'hour ' + h + ' is out of range (0-23)' }
  if (mi > 59) return { ok: false, error: 'minute ' + mi + ' is out of range (0-59)' }
  if (s > 59) return { ok: false, error: 'second ' + s + ' is out of range (0-59)' }
  const isUtc = zone === 'Z'
  const epochMs = isUtc ? Date.UTC(y, mo - 1, d, h, mi, s) : new Date(y, mo - 1, d, h, mi, s).getTime()
  // Reject normalized-away calendar values (e.g. 2026-02-30 -> Mar 2).
  const probe = new Date(epochMs)
  const valid = isUtc
    ? probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d &&
      probe.getUTCHours() === h && probe.getUTCMinutes() === mi && probe.getUTCSeconds() === s
    : probe.getFullYear() === y && probe.getMonth() === mo - 1 && probe.getDate() === d &&
      probe.getHours() === h && probe.getMinutes() === mi && probe.getSeconds() === s
  if (!valid) return { ok: false, error: 'invalid calendar date' }
  return { ok: true, epochMs, zone: isUtc ? 'utc' : 'local' }
}

/** Render one job's scheduled moment in host-local display terms. */
export function renderWhen(job) {
  const dt = new Date(job.scheduledAt)
  const pad = (n) => String(n).padStart(2, '0')
  const local = dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) + ' ' +
    pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + ':' + pad(dt.getSeconds())
  return job.zone === 'utc' ? local + 'Z' : local + ' (local)'
}

/** Render one goal for text output. */
export function formatGoal(job) {
  const state = job.status === 'fired'
    ? 'fired at ' + job.firedAt
    : job.status === 'failed'
      ? 'failed - ' + (job.error ?? 'unknown error')
      : job.attempts !== undefined && job.attempts > 0
        ? 'pending (retry ' + job.attempts + ')'
        : 'pending'
  const rounds = job.rounds !== undefined ? ' · rounds ' + job.rounds : ''
  const repeat = job.repeat === 'daily' ? ' · daily' : ''
  const access = job.permission !== undefined && job.permission !== DEFAULT_PERMISSION ? ' · ' + job.permission : ''
  return job.id + ' · ' + renderWhen(job) + ' · ' + state + repeat + rounds + access +
    ' · "' + job.prompt + '" (session ' + job.sessionId + ')'
}

/** Structural validation of one persisted job record. */
export function isValidGoal(value) {
  return value !== null && typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.prompt === 'string' &&
    Number.isFinite(value.scheduledAt) &&
    ['pending', 'fired', 'failed'].includes(value.status) &&
    (value.repeat === undefined || value.repeat === 'daily') &&
    (value.permission === undefined || PERMISSION_KEYS.includes(value.permission))
}

/** The preset a persisted session actually runs: header value, later event wins. */
export function latestPresetOf(header, events) {
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i]
    if (event !== null && typeof event === 'object' && event.type === 'agent-preset/selected') {
      return event.data !== null && typeof event.data === 'object' ? event.data.agentPreset : undefined
    }
  }
  return header !== null && typeof header === 'object' ? header.agentPreset : undefined
}

/** Default agent options from the deployment's default-model service. */
function defaultAgentOptions(ctx) {
  const defaults = ctx.get('agentDefaultModel')
  if (defaults === undefined || defaults === null) return undefined
  try {
    const selection = defaults.currentSelection()
    if (selection !== null && typeof selection === 'object' &&
      typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch { /* fall through to registry defaults */ }
  return undefined
}

/**
 * Resolve the live agent for one session, resuming a cold persisted session
 * when needed so scheduled goals still run after the web process restarts.
 * @returns {Promise<{status:'ok',agent:object}|{status:'unavailable',reason:string}|{status:'retry',reason:string}>}
 */
export function resolveAgentFor(ctx, logger, sessionId, resumeChains) {
  const agents = ctx.get('agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') {
    return Promise.resolve({ status: 'unavailable', reason: 'agent service is not mounted' })
  }
  const live = agents.get(sessionId)
  if (live !== undefined && live !== null) return Promise.resolve({ status: 'ok', agent: live })

  const persistence = ctx.get('sessionPersistence')
  const presets = ctx.get('agentPresets')
  if (persistence === undefined || persistence === null || presets === undefined || presets === null || typeof agents.resume !== 'function') {
    return Promise.resolve({ status: 'retry', reason: 'session materialization services are not mounted' })
  }

  let chain = resumeChains.get(sessionId)
  if (chain === undefined) {
    chain = (async () => {
      // sessionPersistence has no enumeration: a session exists iff inspect()
      // resolves (it throws "session ... not found" otherwise).
      let inspected
      try {
        inspected = await persistence.inspect(sessionId)
      } catch (error) {
        const message = String(error?.message ?? error)
        return /not found/i.test(message)
          ? { status: 'unavailable', reason: 'session not found in persistence' }
          : { status: 'retry', reason: 'session inspection failed: ' + message }
      }
      if (inspected?.meta?.origin === 'subagent') return { status: 'unavailable', reason: 'session is subagent-owned' }
      const presetId = latestPresetOf(inspected?.meta, inspected?.events)
      const agentOptions = defaultAgentOptions(ctx)
      try {
        const handle = await agents.resume({
          resumeSessionId: sessionId,
          ...agentOptions === undefined ? {} : { agentOptions },
          setup: async (agentCtx) => {
            if (presetId !== undefined) await presets.mount(agentCtx, presetId)
          },
        })
        return { status: 'ok', agent: handle.agent }
      } catch (error) {
        // The browser may have materialized this session concurrently.
        const again = agents.get(sessionId)
        if (again !== undefined && again !== null) return { status: 'ok', agent: again }
        logger?.warn('dsh-schedule: could not resume session ' + sessionId + ': ' + String(error?.message ?? error))
        return { status: 'retry', reason: 'agent resume failed' }
      }
    })().finally(() => { resumeChains.delete(sessionId) })
    resumeChains.set(sessionId, chain)
  }
  return chain
}

/**
 * Validate one create/edit payload and normalize it into job fields.
 * @returns {ok:true, job:object} or {ok:false, error:string}
 */
export function validateGoalRequest(payload, now = Date.now()) {
  if (payload === null || typeof payload !== 'object') return { ok: false, error: 'request body must be a JSON object' }
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
  if (sessionId.length === 0) return { ok: false, error: 'sessionId is required' }
  const utc = payload.utc === true
  const when = typeof payload.when === 'string' ? payload.when.trim() : ''
  if (when.length === 0) return { ok: false, error: 'when is required (YYYY-MM-DD HH:mm[:ss])' }
  const parsed = parseScheduleInput(utc ? when + 'Z' : when)
  if (!parsed.ok) return { ok: false, error: 'invalid date/time: ' + parsed.error }
  if (parsed.epochMs <= now) return { ok: false, error: 'scheduled time must be in the future' }
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
  if (prompt.length === 0) return { ok: false, error: 'prompt is required' }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { ok: false, error: 'prompt is too long (' + prompt.length + ' chars; maximum ' + MAX_PROMPT_CHARS + ')' }
  }
  let rounds
  if (payload.rounds !== undefined && payload.rounds !== null && payload.rounds !== '') {
    rounds = Number(payload.rounds)
    if (!Number.isSafeInteger(rounds) || rounds < 1) return { ok: false, error: 'rounds must be a positive integer' }
  }
  const daily = payload.daily === true || payload.repeat === 'daily'
  let permission = DEFAULT_PERMISSION
  if (payload.permission !== undefined && payload.permission !== null && String(payload.permission).trim() !== '') {
    permission = String(payload.permission).trim()
    if (!PERMISSION_KEYS.includes(permission)) {
      return { ok: false, error: 'permission must be one of: ' + PERMISSION_KEYS.join(', ') }
    }
  }
  return {
    ok: true,
    job: {
      sessionId,
      scheduledAt: parsed.epochMs,
      zone: parsed.zone,
      prompt,
      permission,
      ...rounds === undefined ? {} : { rounds },
      ...daily ? { repeat: 'daily' } : {},
    },
  }
}

/**
 * Build the timed-goal engine over a caller-owned job array.
 * @param options.ctx - the plugin context (services read through ctx.get).
 * @param options.logger - logger with info/warn.
 * @param options.getJobs - returns the live goal array (persisted by the caller).
 * @param options.save - persists the caller's schedule file.
 */
export function createGoalEngine(options) {
  const { ctx, logger, getJobs, save } = options
  const resumeChains = new Map()

  function jobs() {
    const list = getJobs()
    return Array.isArray(list) ? list : []
  }

  function findJob(id) {
    return jobs().find((job) => job.id === id)
  }

  /** Mark one job permanently failed and persist. */
  function failJob(job, reason) {
    job.status = 'failed'
    job.error = reason
    save()
  }

  /**
   * Fire one due job: pin the access preset, then create the armed goal.
   */
  async function attemptFire(job, now = Date.now()) {
    const resolved = await resolveAgentFor(ctx, logger, job.sessionId, resumeChains)
    if (resolved.status !== 'ok') {
      if (resolved.status === 'unavailable') {
        failJob(job, resolved.reason)
        return
      }
      const attempts = (job.attempts ?? 0) + 1
      job.attempts = attempts
      job.lastAttemptAt = now
      if (attempts >= MAX_ATTEMPTS || now - job.scheduledAt > GRACE_MS) {
        failJob(job, 'session could not be materialized (' + resolved.reason + '); gave up after ' + attempts + ' attempts')
        return
      }
      save()
      return
    }
    const agent = resolved.agent

    // 1. Pin the session's permission preset to the job's access level.
    const presets = ctx.get('permissionPresets')
    const presetName = permissionPresetNameFor(job.permission)
    if (presets === undefined || presets === null) {
      logger?.warn('dsh-schedule: permissionPresets service absent - the goal runs under the session current permission, not the job configured access')
    } else if (typeof presets.set === 'function') {
      try {
        presets.set(agent.session, presetName)
        logger?.info('dsh-schedule: pinned session ' + agent.id + ' to ' + presetName)
      } catch (error) {
        logger?.warn('dsh-schedule: could not pin ' + presetName + ' for session ' + agent.id + ': ' + String(error?.message ?? error))
      }
    }

    // 2. Create and arm the goal; the goal-round-driver continues it at idle.
    const goals = ctx.get('goals')
    if (goals === undefined || goals === null || typeof goals.create !== 'function') {
      failJob(job, 'goal service is not mounted')
      return
    }
    const rescheduleDaily = (reason) => {
      job.scheduledAt += DAY_MS
      job.status = 'pending'
      delete job.firedAt
      delete job.error
      delete job.attempts
      delete job.lastAttemptAt
      save()
      const line = reason === 'conflict'
        ? 'dsh-schedule: session ' + agent.id + ' already had a goal at fire time; skipped this daily occurrence, next run ' + renderWhen(job)
        : 'dsh-schedule: fired daily goal for session ' + agent.id + '; next run ' + renderWhen(job)
      if (reason === 'conflict') logger?.warn(line)
      else logger?.info(line)
    }
    try {
      const request = { objective: job.prompt }
      if (job.rounds !== undefined) request.maxGoalRounds = job.rounds
      goals.create(agent, request)
      if (job.repeat === 'daily') {
        rescheduleDaily('fired')
        return
      }
      job.status = 'fired'
      job.firedAt = new Date().toISOString()
      delete job.error
      delete job.attempts
      delete job.lastAttemptAt
      save()
      logger?.info('dsh-schedule: fired goal for session ' + agent.id + ' at ' + job.scheduledAt + ': "' + job.prompt.slice(0, 80) + '"')
    } catch (error) {
      const conflict = error !== null && typeof error === 'object' && error.code === 'GOAL_ALREADY_EXISTS'
      if (conflict && job.repeat === 'daily') {
        // Never pile a second goal onto a session that is already running one.
        rescheduleDaily('conflict')
        return
      }
      failJob(job, conflict
        ? 'a goal already exists for this session (clear or complete it, or use /goal edit); the scheduled goal was not created'
        : 'goal creation failed: ' + String(error?.message ?? error))
    }
  }

  /** One tick: fire every pending job whose moment has arrived. */
  async function tick(now = Date.now()) {
    for (const job of jobs()) {
      if (job.status !== 'pending' || job.scheduledAt > now) continue
      const lastAttempt = job.lastAttemptAt ?? 0
      if (lastAttempt > 0 && now - lastAttempt < ATTEMPT_BACKOFF_MS) continue
      try {
        await attemptFire(job, now)
      } catch (error) {
        logger?.error('dsh-schedule: goal tick failed for job ' + job.id + ': ' + String(error?.message ?? error))
      }
    }
  }

  /** Newest-first type/sort order the drawer uses. */
  function list() {
    const rank = (job) => job.status === 'pending' ? 0 : job.status === 'fired' ? 1 : 2
    return jobs().slice().sort((a, b) => {
      const byRank = rank(a) - rank(b)
      if (byRank !== 0) return byRank
      return (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0)
    })
  }

  /** Create one goal job bound to sessionId (or the payload's own sessionId). */
  function add(payload, sessionId) {
    const input = { ...(payload ?? {}) }
    if ((input.sessionId === undefined || input.sessionId === '') && sessionId) input.sessionId = sessionId
    const validated = validateGoalRequest(input)
    if (!validated.ok) throw new Error(validated.error)
    const job = { id: 'tg-' + randomUUID().slice(0, 8), ...validated.job, createdAt: Date.now(), status: 'pending' }
    jobs().push(job)
    save()
    return job
  }

  /** Edit one job: re-validate, reschedule and reset it to pending. */
  function update(id, payload) {
    const job = findJob(id)
    if (job === undefined) throw new Error('no timed goal with id "' + id + '"')
    const merged = { sessionId: job.sessionId, ...(payload ?? {}) }
    const validated = validateGoalRequest(merged)
    if (!validated.ok) throw new Error(validated.error)
    const fields = validated.job
    job.scheduledAt = fields.scheduledAt
    job.zone = fields.zone
    job.prompt = fields.prompt
    if (fields.rounds !== undefined) job.rounds = fields.rounds
    else delete job.rounds
    if (fields.repeat !== undefined) job.repeat = fields.repeat
    else delete job.repeat
    // Only an explicit permission in the edit payload overrides the job's.
    if (payload !== null && typeof payload === 'object' && payload.permission !== undefined) job.permission = fields.permission
    job.status = 'pending'
    delete job.error
    delete job.attempts
    delete job.lastAttemptAt
    delete job.firedAt
    save()
    return job
  }

  /** Remove one goal job. */
  function remove(id) {
    const list = jobs()
    const index = list.findIndex((job) => job.id === id)
    if (index === -1) throw new Error('no timed goal with id "' + id + '"')
    list.splice(index, 1)
    save()
    return { removed: id }
  }

  /** Remove every goal job (pending, fired and failed). */
  function clear() {
    const list = jobs()
    const count = list.length
    list.length = 0
    save()
    return { removed: count }
  }

  return { add, clear, find: findJob, format: formatGoal, list, remove, tick, update }
}
