// dsh-relay-pair / models.js
//
// 「这条任务用哪个模型、多大思考强度」。
//
// 中继台网页派活时可以指定模型和思考强度（reasoning effort）。设备这边要做两件事：
//   1. 把本机可用的模型目录上报给中继（meta.models），网页才有得选；
//   2. 领到任务后，在**那条任务自己的会话**上把模型切成指定值，再投递消息。
//
// 切模型用 sessionController.agents.selectForNextRequest(agent, selection)：
// 它只影响「下一次请求」，不改用户的默认模型（改默认是 selectModel 命令的活，
// 插件不该动主人的默认设置）。selection 形如 { provider, model, reasoningEffort? }。
//
// 这个文件不 import 任何 @deepseek-ai/* 包，也不碰 DOM —— 全是可测的纯逻辑。

export const CATALOG_TTL_MS = 5 * 60 * 1000

/** 从任务里取出模型选择；没指定模型就是「跟随设备默认」。 */
export function normalizeChoice(task) {
  const source = task && typeof task === 'object' ? task : {}
  const provider = String(source.modelProvider || '').trim()
  const model = String(source.modelName || '').trim()
  const effort = String(source.reasoningEffort || '').trim()
  if (model === '') return { provider: '', model: '', effort: '' }
  return { provider, model, effort }
}

/** 人看的模型描述：provider/model · 强度 x（没有就空串）。 */
export function choiceLabel(choice) {
  if (!choice || !choice.model) return ''
  const head = choice.provider ? choice.provider + '/' + choice.model : choice.model
  return choice.effort ? head + ' · 强度 ' + choice.effort : head
}

function groupOf(catalog, provider) {
  if (!catalog || !Array.isArray(catalog.groups)) return null
  for (const group of catalog.groups) {
    if (group && group.id === provider) return group
  }
  return null
}

export function findModel(catalog, provider, model) {
  const group = groupOf(catalog, provider)
  if (!group || !Array.isArray(group.models)) return null
  for (const item of group.models) {
    if (item && item.id === model) return item
  }
  return null
}

export function hasModel(catalog, provider, model) {
  return findModel(catalog, provider, model) !== null
}

export function effortsOf(catalog, provider, model) {
  const item = findModel(catalog, provider, model)
  const reasoning = item && item.reasoning ? item.reasoning : null
  return reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : []
}

/** 一句话描述目录规模，给 relay_status 用。 */
export function catalogSummary(catalog) {
  if (!catalog) return '还没上报'
  const groups = Array.isArray(catalog.groups) ? catalog.groups : []
  let models = 0
  for (const group of groups) models += Array.isArray(group.models) ? group.models.length : 0
  const def = catalog.default && catalog.default.model
  const defText = def
    // default 里的强度字段叫 effort（插件上报的形状），也容忍宿主原始的 reasoningEffort。
    ? choiceLabel({
      provider: catalog.default.provider,
      model: def,
      effort: catalog.default.effort || catalog.default.reasoningEffort || '',
    })
    : '未知'
  return groups.length + ' 个 provider / ' + models + ' 个模型，默认 ' + defText
}

function errorText(error) {
  return error && error.message ? error.message : String(error)
}

function defaultOf(selection) {
  const src = selection && typeof selection === 'object' ? selection : {}
  return {
    provider: String(src.provider || '').trim(),
    model: String(src.model || '').trim(),
    effort: String(src.reasoningEffort || '').trim(),
  }
}

/**
 * 把宿主 llm 服务的目录拍成网页能直接用的结构。
 *
 * 形状（中继网页与两个插件共用同一份契约）：
 *   { default: { provider, model, effort },
 *     groups: [ { id, name, models: [ { id, name, reasoning?: { efforts: [{id,name,description?}], defaultEffort? } } ] } ],
 *     failures: [ { provider, error } ], generatedAt }
 *
 * 单个模型探测失败（比如没有思考强度）不算错误，只是那条不带 reasoning。
 */
export async function buildCatalog(llm, defaultSelection, logger) {
  const groups = []
  const failures = []
  const fallback = { default: defaultOf(defaultSelection), groups, failures, generatedAt: new Date().toISOString() }
  if (!llm || typeof llm.listProviders !== 'function') {
    failures.push({ provider: '', error: '这个 DSH 没有提供 llm 服务' })
    return fallback
  }
  let providers = []
  try {
    providers = await llm.listProviders()
  } catch (error) {
    failures.push({ provider: '', error: errorText(error) })
  }
  for (const provider of Array.isArray(providers) ? providers : []) {
    const pid = String((provider && provider.id) || '')
    if (pid === '') continue
    let models = []
    try {
      models = typeof llm.listModels === 'function' ? await llm.listModels(pid) : []
    } catch (error) {
      failures.push({ provider: pid, error: errorText(error) })
      continue
    }
    const out = []
    for (const model of Array.isArray(models) ? models : []) {
      const mid = String((model && model.id) || '')
      if (mid === '') continue
      const item = { id: mid, name: String((model && model.name) || mid) }
      const reasoning = await reasoningOf(llm, pid, mid)
      if (reasoning) item.reasoning = reasoning
      out.push(item)
    }
    groups.push({ id: pid, name: String((provider && provider.name) || pid), models: out })
  }
  if (failures.length > 0 && logger && typeof logger.warn === 'function') {
    logger.warn('relay-pair: 模型目录有 ' + failures.length + ' 处探测失败: '
      + failures.map((item) => (item.provider || '?') + ': ' + item.error).join('; '))
  }
  return { default: defaultOf(defaultSelection), groups, failures, generatedAt: new Date().toISOString() }
}

async function reasoningOf(llm, provider, model) {
  if (!llm || typeof llm.resolveModelInfo !== 'function') return null
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const reasoning = info && info.reasoning ? info.reasoning : null
    if (!reasoning || !Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) return null
    const efforts = []
    for (const effort of reasoning.efforts) {
      const eid = String((effort && effort.id) || '')
      if (eid === '') continue
      const row = { id: eid, name: String((effort && effort.name) || eid) }
      if (effort && effort.description) row.description = String(effort.description)
      efforts.push(row)
    }
    if (efforts.length === 0) return null
    const out = { efforts }
    if (reasoning.defaultEffort) out.defaultEffort = String(reasoning.defaultEffort)
    return out
  } catch (error) {
    return null
  }
}

/**
 * 在那条任务自己的 agent 上把模型切成指定值。
 *
 * 返回 { applied, note, error }：
 *   error 非空 → 别投递，直接报 blocked（模型不存在/宿主不支持/切换抛错）；
 *   note 非空  → 有降级（比如这个模型没有该强度），要写进注入的消息里；
 *   applied    → 真正生效的 selection，没指定模型时是 null。
 *
 * 目录还没上报时（刚启动的头几秒）不做存在性校验：照传，让宿主自己判断。
 */
export function applyChoice(ctrl, agent, choice, catalog) {
  const out = { applied: null, note: '', error: '' }
  const picked = choice || normalizeChoice(null)
  if (!picked.model) return out
  const agents = ctrl && ctrl.agents ? ctrl.agents : null
  if (!agents || typeof agents.selectForNextRequest !== 'function') {
    out.error = '这台 DSH 不支持给会话指定模型（sessionController.agents.selectForNextRequest 缺失），未执行'
    return out
  }
  const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : []
  if (groups.length > 0 && !hasModel(catalog, picked.provider, picked.model)) {
    out.error = '这台设备没有模型 ' + picked.provider + '/' + picked.model + '，未执行（网页刷新后重选）'
    return out
  }
  let effort = picked.effort
  if (effort) {
    const list = effortsOf(catalog, picked.provider, picked.model)
    if (list.length > 0 && !list.some((item) => item.id === effort)) {
      out.note = '这台设备的 ' + picked.model + ' 没有强度 ' + effort + '，已按模型默认强度执行'
      effort = ''
    }
  }
  const selection = { provider: picked.provider, model: picked.model }
  if (effort) selection.reasoningEffort = effort
  try {
    agents.selectForNextRequest(agent, selection)
  } catch (error) {
    out.error = '切换模型失败：' + errorText(error)
    return out
  }
  out.applied = selection
  return out
}
