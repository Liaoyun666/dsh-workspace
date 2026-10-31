// tests/models.test.mjs
//
// 模型选择层的纯逻辑测试：任务里的模型字段怎么归一化、目录怎么拍平、
// 投递前怎么在 agent 上切模型、以及注入消息里的模型说明。
// 不碰 DSH、不起服务器。
//
// 跑法：ELECTRON_RUN_AS_NODE=1 '/e/Deepseek/DeepSeek Harness.exe' tests/models.test.mjs

const M = await import('../lib/models.js')
const P = await import('../lib/protocol.js')

const fails = []
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + JSON.stringify(extra)))
  if (!cond) fails.push(name)
}

// ---------- normalizeChoice ----------
ok('TTL 是 5 分钟', M.CATALOG_TTL_MS === 300000, M.CATALOG_TTL_MS)
const empty = M.normalizeChoice(null)
ok('没任务时是「跟随默认」', empty.provider === '' && empty.model === '' && empty.effort === '', empty)
const bare = M.normalizeChoice({ modelProvider: 'deepseek', modelName: 'deepseek-chat', reasoningEffort: 'high' })
ok('三个字段原样取出', bare.provider === 'deepseek' && bare.model === 'deepseek-chat' && bare.effort === 'high', bare)
const spaced = M.normalizeChoice({ modelProvider: '  p  ', modelName: '  m  ', reasoningEffort: '  ' })
ok('首尾空白被去掉', spaced.provider === 'p' && spaced.model === 'm' && spaced.effort === '', spaced)
const noModel = M.normalizeChoice({ modelProvider: 'p', reasoningEffort: 'high' })
ok('只有 provider 没 model 等于没指定', noModel.provider === '' && noModel.model === '' && noModel.effort === '', noModel)
ok('非对象不炸', M.normalizeChoice('x').model === '' && M.normalizeChoice(42).model === '')

// ---------- choiceLabel ----------
ok('没模型时标签是空串', M.choiceLabel(null) === '' && M.choiceLabel({ model: '' }) === '')
ok('标签带 provider 与强度', M.choiceLabel({ provider: 'deepseek', model: 'v4', effort: 'high' }) === 'deepseek/v4 · 强度 high')
ok('没 provider 就只写模型', M.choiceLabel({ provider: '', model: 'v4', effort: '' }) === 'v4')

// ---------- 目录查找 ----------
const catalog = {
  default: { provider: 'deepseek', model: 'v4', effort: 'medium' },
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'v4', name: 'V4', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } },
        { id: 'chat', name: 'Chat' },
      ],
    },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt', name: 'GPT' }] },
  ],
  failures: [],
  generatedAt: 'now',
}
ok('findModel 找到模型', M.findModel(catalog, 'deepseek', 'v4').name === 'V4')
ok('findModel 找不到返回 null', M.findModel(catalog, 'deepseek', 'nope') === null && M.findModel(catalog, 'nope', 'v4') === null)
ok('findModel 对空目录不炸', M.findModel(null, 'a', 'b') === null)
ok('hasModel 判断存在', M.hasModel(catalog, 'openai', 'gpt') === true && M.hasModel(catalog, 'openai', 'v4') === false)
ok('effortsOf 取出强度列表', M.effortsOf(catalog, 'deepseek', 'v4').length === 2)
ok('没有 reasoning 的模型强度为空', M.effortsOf(catalog, 'deepseek', 'chat').length === 0)

// ---------- catalogSummary ----------
ok('没目录时提示还没上报', M.catalogSummary(null) === '还没上报', M.catalogSummary(null))
const summary = M.catalogSummary(catalog)
ok('摘要带 provider/模型数', summary.indexOf('2 个 provider') === 0 && summary.indexOf('3 个模型') > 0, summary)
ok('摘要带默认模型与强度', summary.indexOf('deepseek/v4 · 强度 medium') > 0, summary)
ok('没默认模型时写未知', M.catalogSummary({ groups: [] }).indexOf('未知') > 0, M.catalogSummary({ groups: [] }))

// ---------- buildCatalog ----------
const fakeLlm = {
  async listProviders() {
    return [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'broken', name: '坏掉的' }, { id: '', name: '没 id' }]
  },
  async listModels(pid) {
    if (pid === 'broken') throw new Error('adapter down')
    return [{ id: 'v4', name: 'V4' }, { id: 'chat', name: 'Chat' }, { id: '', name: 'x' }]
  },
  async resolveModelInfo(pid, mid) {
    if (mid === 'chat') throw new Error('no reasoning info')
    return { reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高', description: '想久一点' }], defaultEffort: 'low' } }
  },
}
const built = await M.buildCatalog(fakeLlm, { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' }, null)
ok('目录按 provider 分组（探测失败的 provider 不进目录）', built.groups.length === 1 && built.groups[0].id === 'deepseek', built.groups.map((g) => g.id))
ok('没有 id 的 provider 被跳过', built.groups.every((g) => g.id !== ''), built.groups)
ok('没有 id 的模型被跳过', built.groups[0].models.length === 2, built.groups[0].models)
ok('带 reasoning 的模型有强度', built.groups[0].models[0].reasoning.efforts.length === 2)
ok('强度的 description 保留', built.groups[0].models[0].reasoning.efforts[1].description === '想久一点')
ok('resolveModelInfo 抛错只是没强度', !built.groups[0].models[1].reasoning, built.groups[0].models[1])
ok('listModels 抛错记进 failures', built.failures.length === 1 && built.failures[0].provider === 'broken' && built.failures[0].error === 'adapter down', built.failures)
ok('默认选择被保留', built.default.provider === 'deepseek' && built.default.model === 'v4' && built.default.effort === 'high', built.default)
ok('generatedAt 是字符串', typeof built.generatedAt === 'string' && built.generatedAt.length > 0)

const noLlm = await M.buildCatalog(null, null, null)
ok('没有 llm 服务时 failures 有话说', noLlm.failures.length === 1 && noLlm.failures[0].error.indexOf('llm') > 0, noLlm.failures)
ok('没有 llm 时默认值也是空的', noLlm.default.provider === '' && noLlm.groups.length === 0)

const listBoom = await M.buildCatalog({ async listProviders() { throw new Error('boom') } }, null, null)
ok('listProviders 抛错也不炸', listBoom.failures.length === 1 && listBoom.failures[0].error === 'boom' && listBoom.groups.length === 0, listBoom)

// ---------- applyChoice ----------
const calls = []
const ctrl = { agents: { selectForNextRequest(agent, selection) { calls.push({ agent, selection }) } } }
const agent = { session: { id: 's1' } }

const none = M.applyChoice(ctrl, agent, M.normalizeChoice({}), catalog)
ok('没指定模型就不切、不报错', none.applied === null && none.error === '' && calls.length === 0, none)

const good = M.applyChoice(ctrl, agent, M.normalizeChoice({ modelProvider: 'deepseek', modelName: 'v4', reasoningEffort: 'high' }), catalog)
ok('指定模型会切下一次请求', good.error === '' && calls.length === 1 && calls[0].agent === agent, good)
ok('切的 selection 带强度', calls[0].selection.provider === 'deepseek' && calls[0].selection.model === 'v4' && calls[0].selection.reasoningEffort === 'high', calls[0].selection)
ok('applied 回传真实选择', good.applied && good.applied.model === 'v4', good.applied)

calls.length = 0
const noEffort = M.applyChoice(ctrl, agent, M.normalizeChoice({ modelProvider: 'deepseek', modelName: 'v4', reasoningEffort: 'ultra' }), catalog)
ok('强度不存在时降级并给提示', noEffort.error === '' && noEffort.note.indexOf('没有强度 ultra') > 0, noEffort)
ok('降级后 selection 不带 reasoningEffort', calls[0].selection.reasoningEffort === undefined, calls[0].selection)

calls.length = 0
const missing = M.applyChoice(ctrl, agent, M.normalizeChoice({ modelProvider: 'deepseek', modelName: 'nope' }), catalog)
ok('模型不存在就不投递', missing.error.indexOf('没有模型') > 0 && calls.length === 0, missing)

const noCtrl = M.applyChoice(null, agent, M.normalizeChoice({ modelProvider: 'deepseek', modelName: 'v4' }), catalog)
ok('宿主不支持时给明确原因', noCtrl.error.indexOf('selectForNextRequest') > 0, noCtrl)

calls.length = 0
const beforeCatalog = M.applyChoice(ctrl, agent, M.normalizeChoice({ modelProvider: 'deepseek', modelName: 'v4' }), null)
ok('目录还没上报时不校验存在性', beforeCatalog.error === '' && calls.length === 1, beforeCatalog)

const boomCtrl = { agents: { selectForNextRequest() { throw new Error('locked') } } }
const boom = M.applyChoice(boomCtrl, agent, M.normalizeChoice({ modelProvider: 'deepseek', modelName: 'v4' }), catalog)
ok('切换抛错变成 error', boom.error.startsWith('切换模型失败') && boom.error.indexOf('locked') > 0, boom)

// ---------- 注入消息里的模型说明 ----------
const NL = String.fromCharCode(10)
const framed = P.frameTaskMessage({ id: 't-1', prompt: '做事', modelProvider: 'deepseek', modelName: 'v4', reasoningEffort: 'high' }, 'dev', '')
ok('消息里写明指定了模型', framed.indexOf('指定了模型：deepseek/v4（思考强度 high）') > 0, framed)
ok('消息里仍然有任务正文', framed.indexOf('<task>' + NL + '做事' + NL + '</task>') > 0, framed)
const framedNoModel = P.frameTaskMessage({ id: 't-2', prompt: '做事' }, 'dev', '')
ok('没指定模型时不写模型行', framedNoModel.indexOf('指定了模型') < 0, framedNoModel)
const framedNote = P.frameTaskMessage({ id: 't-3', prompt: '做事', modelProvider: 'deepseek', modelName: 'v4' }, 'dev', '这台设备的 v4 没有强度 ultra，已按模型默认强度执行')
ok('降级提示写进消息', framedNote.indexOf('注意：这台设备的 v4 没有强度 ultra') > 0, framedNote)
ok('modelNote 空串不产生空提示', P.frameTaskMessage({ id: 't-4', prompt: 'x' }, 'dev', '   ').indexOf('注意：') < 0)
ok('frameTaskMessage 对 null 任务不炸', typeof P.frameTaskMessage(null, 'dev') === 'string')

console.log(fails.length === 0 ? NL + '全部通过' : NL + '失败: ' + fails.join(', '))
process.exit(fails.length === 0 ? 0 : 1)
