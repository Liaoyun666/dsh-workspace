// dsh-relay-pair / tests/client.test.mjs
//
// 不启浏览器：伪造 window.__ModuleLoader__ 与最小 ctx，验证客户端插件能加载、
// 注册字典/样式/设置页槽位，并且设置页注册信息完整（桌面端与手机端共用这一份）。
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

ok('客户端插件调用了 ModuleLoader.load', captured !== null && captured.id === 'dsh-relay-pair', captured && captured.id)

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
const ctx = {
  effect(fn, label) {
    const dispose = fn()
    if (typeof dispose === 'function') cleanups.push({ label, dispose })
  },
  locale: {
    register(ns, dicts) { dictionaries.push({ ns, dicts }); return () => {} },
    bind() { return (key) => key },
  },
  slots: {
    inject(name, fn) { registeredSlots.push('inject:' + name); fn() },
    register(decl, component) { registrations.push({ decl, component }); return () => {} },
  },
}

mod.apply(ctx)

ok('注册了字典', dictionaries.length === 1 && dictionaries[0].ns === 'relay-pair' &&
  Boolean(dictionaries[0].dicts.zh && dictionaries[0].dicts.en), dictionaries.map((d) => d.ns))
ok('中英文字典键一致', (() => {
  const zh = Object.keys(dictionaries[0].dicts.zh).sort()
  const en = Object.keys(dictionaries[0].dicts.en).sort()
  return zh.join(',') === en.join(',')
})(), [Object.keys(dictionaries[0].dicts.zh).length, Object.keys(dictionaries[0].dicts.en).length])
ok('注入了样式', styleTags.length === 1 && styleTags[0].textContent.includes('.relay-pair'))
ok('注册到 settings.section 槽位', registeredSlots.includes('inject:settings.section'), registeredSlots)
const reg = registrations[0]
ok('设置页声明完整', reg && reg.decl.name === 'settings.section' && reg.decl.id === 'relay-pair' &&
  typeof reg.decl.order === 'number' && typeof reg.decl.label === 'function' && typeof reg.decl.inject === 'function', reg && reg.decl)
ok('标签是「中继配对」', reg && reg.decl.label() === 'nav', reg && reg.decl.label())
ok('inject() 给出 t', (() => {
  const props = reg.decl.inject()
  return props && typeof props.t === 'function'
})())
ok('组件是函数', typeof reg.component === 'function')

// --- 拆掉时不残留 ---------------------------------------------------------
for (const item of cleanups.reverse()) item.dispose()
ok('dispose 后样式被移除', styleTags.length === 0, styleTags.length)

// --- package.json 契约 ----------------------------------------------------
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
ok('package.json 导出 client', pkg.exports['./client'] === './lib/client.js', pkg.exports)
ok('package.json 声明 web 客户端', pkg.dsh.client && pkg.dsh.client.platform === 'web', pkg.dsh)

console.log(fails.length === 0 ? '\n全部通过' : '\n失败: ' + fails.join(', '))
process.exit(fails.length === 0 ? 0 : 1)
