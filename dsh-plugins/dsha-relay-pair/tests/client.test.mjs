// dsha-relay-pair / tests/client.test.mjs
//
// 不启浏览器：伪造 window.__ModuleLoader__ 与最小 ctx，验证手机端「设置 → 中继配对」页
// 能加载、注册字典/样式/槽位，并且还带上了手机端独有的两块（发件箱与「派活给本机」）。
//
// 跑法：ELECTRON_RUN_AS_NODE=1 '/e/Deepseek/DeepSeek Harness.exe' tests/client.test.mjs

import { readFileSync } from 'node:fs'

const fails = []
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + JSON.stringify(extra)))
  if (!cond) fails.push(name)
}

// --- 伪造浏览器环境 --------------------------------------------------------
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(config) { captured = config },
  },
}
const styleTags = []
globalThis.document = {
  createElement() {
    return { dataset: {}, textContent: '', remove() { const i = styleTags.indexOf(this); if (i >= 0) styleTags.splice(i, 1) } }
  },
  head: { append(node) { styleTags.push(node) } },
}

// 极简 react 替身：组件函数只被注册，不会被渲染。
const fakeReact = {
  createElement(...args) { return { type: 'vnode', args } },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() {},
  useCallback(fn) { return fn },
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// 客户端插件是 IIFE（window.__ModuleLoader__.load），用 Function 跑，require 走我们的替身。
new Function('window', 'document', 'require', source)(globalThis.window, globalThis.document, (id) => {
  if (id === 'react') return fakeReact
  throw new Error('unexpected require: ' + id)
})

ok('客户端插件调用了 ModuleLoader.load', captured !== null && captured.id === 'dsha-relay-pair', captured && captured.id)

const mod = captured.factory((id) => {
  if (id === 'react') return fakeReact
  throw new Error('unexpected require: ' + id)
})
ok('导出 apply', typeof mod.apply === 'function')
ok('声明 inject 含 slots/locale', Array.isArray(mod.inject) && mod.inject.includes('slots') && mod.inject.includes('locale'), mod.inject)

// --- 最小 ctx -------------------------------------------------------------
const registrations = []
const dictionaries = []
const cleanups = []
const registeredSlots = []
const boundNamespaces = []
const ctx = {
  effect(fn, label) {
    const dispose = fn()
    if (typeof dispose === 'function') cleanups.push({ label, dispose })
  },
  locale: {
    register(ns, dicts) { dictionaries.push({ ns, dicts }); return () => {} },
    bind(ns) { boundNamespaces.push(ns); return (key) => key },
  },
  slots: {
    inject(name, fn) { registeredSlots.push('inject:' + name); fn() },
    register(decl, component) { registrations.push({ decl, component }); return () => {} },
  },
}

mod.apply(ctx)

ok('注册了字典', dictionaries.length === 1 && dictionaries[0].ns === 'dsha-relay-pair' &&
  Boolean(dictionaries[0].dicts.zh && dictionaries[0].dicts.en), dictionaries.map((d) => d.ns))
ok('中英文字典键一致', (() => {
  const zh = Object.keys(dictionaries[0].dicts.zh).sort()
  const en = Object.keys(dictionaries[0].dicts.en).sort()
  return zh.join(',') === en.join(',')
})(), [Object.keys(dictionaries[0].dicts.zh).length, Object.keys(dictionaries[0].dicts.en).length])

const zhDict = dictionaries[0].dicts.zh
const enDict = dictionaries[0].dicts.en
for (const key of ['nav', 'title', 'intro', 'status.paired', 'status.unpaired', 'field.relayUrl',
  'field.code', 'action.pair', 'action.unpair', 'pair.hint', 'err.fence', 'err.unsupported',
  'empty.tasks', 'section.tasks', 'section.pairing', 'cloud.hint']) {
  ok('字典含 ' + key, typeof zhDict[key] === 'string' && typeof enDict[key] === 'string', [zhDict[key], enDict[key]])
}
// 手机端独有的几项：少了它们说明装错了包（这是桌面端那份，不是手机端）。
for (const key of ['section.mobile', 'section.submit', 'label.outbox', 'label.delivered',
  'label.notify', 'label.vibrate', 'label.idle', 'submit.hint', 'submit.placeholder',
  'submit.ok', 'outbox.warn', 'action.submit']) {
  ok('手机端字段 ' + key, typeof zhDict[key] === 'string', zhDict[key])
}

ok('注入了样式', styleTags.length === 1, styleTags.length)
ok('样式挂在 data-plugin 上', styleTags[0].dataset.plugin === 'dsha-relay-pair', styleTags[0].dataset)
ok('样式包含根 class .dsha-relay-pair', styleTags[0].textContent.includes('.dsha-relay-pair'))
ok('样式不用桌面端的 .relay-pair 根名', !/\.relay-pair\s*\{/.test(styleTags[0].textContent))

ok('注册到 settings.section 槽位', registeredSlots.includes('inject:settings.section'), registeredSlots)
const reg = registrations[0]
ok('设置页声明完整', reg && reg.decl.name === 'settings.section' && reg.decl.id === 'dsha-relay-pair' &&
  typeof reg.decl.order === 'number' && typeof reg.decl.label === 'function' && typeof reg.decl.inject === 'function', reg && reg.decl)
ok('槽位顺序是数字', reg && Number.isFinite(reg.decl.order), reg && reg.decl.order)
ok('标签是「中继配对」', reg && reg.decl.label() === 'nav', reg && reg.decl.label())
ok('inject() 给出 t', (() => {
  const props = reg.decl.inject()
  return props && typeof props.t === 'function'
})())
ok('locale 绑定的是本插件命名空间', boundNamespaces.length === 1 && boundNamespaces[0] === 'dsha-relay-pair', boundNamespaces)
ok('组件是函数', typeof reg.component === 'function')
ok('组件名可读（RelayPairSection）', reg && reg.component.name === 'RelayPairSection', reg && reg.component.name)

// --- 拆掉时不残留 ---------------------------------------------------------
for (const item of cleanups.reverse()) item.dispose()
ok('dispose 后样式被移除', styleTags.length === 0, styleTags.length)

// --- package.json 契约 ----------------------------------------------------
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
ok('package.json 导出 client', pkg.exports['./client'] === './lib/client.js', pkg.exports)
ok('package.json 声明 web 客户端', pkg.dsh.client && pkg.dsh.client.platform === 'web', pkg.dsh.client)
ok('package.json 声明 bundle 补丁', pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', pkg.dsh.bundle)
ok('package.json 名字是手机端', pkg.name === 'dsha-relay-pair', pkg.name)
ok('dshhub 声明六个工具', (() => {
  const provides = pkg.dsh.dshhub && pkg.dsh.dshhub.capabilities && pkg.dsh.dshhub.capabilities.provides
  return Array.isArray(provides) && provides.length === 6 && provides.includes('relay_pair') && provides.includes('relay_unpair')
})(), pkg.dsh.dshhub && pkg.dsh.dshhub.capabilities)
ok('dshhub 声明发件箱文件的读取', (() => {
  const reads = pkg.dsh.dshhub.capabilities.reads || []
  return reads.some((p) => p.includes('relay-outbox.jsonl')) && reads.some((p) => p.includes('relay-device.json'))
})(), pkg.dsh.dshhub.capabilities.reads)

// --- cordis 补丁里的默认值 ------------------------------------------------
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
ok('补丁里插件 id 是 dsha-relay-pair', patch.includes('id: dsha-relay-pair'), null)
ok('补丁默认 deviceKind 是 mobile', /deviceKind:\s*mobile/.test(patch), null)
ok('补丁默认开着通知', /notifyOnTask:\s*true/.test(patch) && /notifyOnResult:\s*true/.test(patch), null)
ok('补丁默认关着震动', /vibrateOnTask:\s*false/.test(patch), null)

console.log(fails.length === 0 ? '\n全部通过' : '\n失败: ' + fails.join(', '))
process.exit(fails.length === 0 ? 0 : 1)
