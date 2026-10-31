// 单元测试：验证 dsh-persona-dafeiyu 补丁的「一键启停全部」逻辑。
// 用临时 DSH_HOME，绝不碰真实人设库。
import { pathToFileURL } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'persona-patch-test-'))
const plugin = pathToFileURL('C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-persona-dafeiyu/lib/index.js').href
const mod = await import(plugin)

const IDS = ['dafeiyu', 'acha', 'tinglan']
const base = () => ({ version: 1, mode: 'global', current: 'dafeiyu', disabled: ['acha', 'tinglan'], personas: [], workspaces: [{ cwd: 'E:/工作区', personaId: 'tinglan' }] })
const cfg = { enabled: true }
const ok = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)

// 1) 一键停用全部
{
  const store = base()
  const r = mod.mutatePersona({ action: 'set-all-enabled', enabled: false }, cfg, undefined, store)
  const persisted = mod.readStore()
  ok('set-all-enabled(false) 返回 ok', r.ok === true, JSON.stringify(r))
  ok('内存 store.disabled 覆盖全部',
    IDS.every((id) => store.disabled.includes(id)) && store.disabled.length === IDS.length,
    JSON.stringify(store.disabled))
  ok('已落盘且回读一致', IDS.every((id) => persisted.disabled.includes(id)), JSON.stringify(persisted.disabled))
  ok('catalog 全员 enabled=false', mod.buildCatalog(undefined, persisted).every((p) => p.enabled === false))
  ok('全局兜底同时关闭', store.current === null && persisted.current === null, String(store.current))
  ok('工作区选择保留', store.workspaces[0]?.personaId === 'tinglan', JSON.stringify(store.workspaces))
}

// 2) 一键启用全部
{
  const store = mod.readStore() // 承接上一步（全部停用）
  const r = mod.mutatePersona({ action: 'set-all-enabled', enabled: true }, cfg, undefined, store)
  ok('set-all-enabled(true) 返回 ok', r.ok === true, JSON.stringify(r))
  ok('disabled 清空', Array.isArray(store.disabled) && store.disabled.length === 0, JSON.stringify(store.disabled))
  ok('current 恢复内置默认 dafeiyu', store.current === 'dafeiyu', store.current)
  ok('catalog 全员 enabled=true', mod.buildCatalog(undefined, mod.readStore()).every((p) => p.enabled === true))
}

// 3) 兼容写法 set-enabled id=all / *
{
  const store = base()
  mod.mutatePersona({ action: 'set-enabled', id: 'all', enabled: false }, cfg, undefined, store)
  ok("set-enabled id='all' 停用全部", IDS.every((id) => store.disabled.includes(id)), JSON.stringify(store.disabled))
  mod.mutatePersona({ action: 'set-enabled', id: '*', enabled: true }, cfg, undefined, store)
  ok("set-enabled id='*' 启用全部", store.disabled.length === 0 && store.current === 'dafeiyu', JSON.stringify(store.disabled))
}

// 4) 回归：全部停用后点「设为当前」只恢复那一条
{
  const store = base()
  mod.mutatePersona({ action: 'set-all-enabled', enabled: false }, cfg, undefined, store)
  const r = mod.mutatePersona({ action: 'set-current', id: 'tinglan' }, cfg, undefined, store)
  ok('停用全部后 set-current 仍可用', r.ok === true, JSON.stringify(r))
  ok('只恢复 tinglan', store.disabled.length === 2 && !store.disabled.includes('tinglan'), JSON.stringify(store.disabled))
}

// 5) 回归：未知动作仍报错
{
  const store = base()
  const r = mod.mutatePersona({ action: 'nope' }, cfg, undefined, store)
  ok('未知动作返回错误', r.ok === false && /未知操作/.test(r.error), JSON.stringify(r))
}

console.log('\nDSH_HOME =', process.env.DSH_HOME)
