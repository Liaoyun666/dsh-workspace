#!/usr/bin/env node
/**
 * dsh-anim-pack 冒烟测试：不启动 DSH，直接用 node 验证 lib/catalog.js 的行为。
 *
 *   node tools/verify.mjs
 *
 * 检查项：素材库完整性（341 条索引 / 341 个提示词文件 / 193 张静帧真的在磁盘上）、
 * 编号查找、关键词与系列检索、读提示词、导出到临时目录、拒绝写进库内部。
 * 全部通过打印 PASS，有任何一条不过就以退出码 1 结束。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clampLimit,
  exportEntry,
  getEntry,
  loadCatalog,
  randomEntry,
  readPrompt,
  searchEntries,
  stillPath,
  summarize,
} from '../lib/catalog.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_TOTAL = 341
const EXPECTED_WITH_STILL = 193
const EXPECTED_SERIES = 10

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    return
  }
  failures.push(detail ? `${label} —— ${detail}` : label)
}

const catalog = loadCatalog(ROOT)

// ── 索引本身 ────────────────────────────────────────────────────────────────
check('总条目数 = 341', catalog.total === EXPECTED_TOTAL, `实际 ${catalog.total}`)
check('索引条目数 = total', catalog.entries.length === EXPECTED_TOTAL, `实际 ${catalog.entries.length}`)
check('带静帧 = 193', catalog.withStill === EXPECTED_WITH_STILL, `实际 ${catalog.withStill}`)
check('系列数 = 10', catalog.series.length === EXPECTED_SERIES, `实际 ${catalog.series.length}`)
check(
  '系列条目数之和 = 341',
  catalog.series.reduce((sum, row) => sum + Number(row.count ?? 0), 0) === EXPECTED_TOTAL,
  catalog.series.map((row) => `${row.id}:${row.count}`).join(' '),
)

// ── 每个条目引用的文件都得真的存在 ─────────────────────────────────────────
const missingPrompts = catalog.entries.filter((entry) => !entry.filePath || !existsSync(entry.filePath))
check('341 个提示词文件都在磁盘上', missingPrompts.length === 0, `缺 ${missingPrompts.length} 个：${missingPrompts.slice(0, 5).map((e) => e.id).join(', ')}`)

const withImage = catalog.entries.filter((entry) => entry.imagePath)
check('193 条索引带静帧路径', withImage.length === EXPECTED_WITH_STILL, `实际 ${withImage.length}`)
const missingStills = withImage.filter((entry) => !existsSync(entry.imagePath))
check('193 张静帧都在磁盘上', missingStills.length === 0, `缺 ${missingStills.length} 张：${missingStills.slice(0, 5).map((e) => e.id).join(', ')}`)

const promptDirs = readdirSync(join(ROOT, 'assets', 'library', '风格提示词'))
check('素材库按系列分 10 个目录', promptDirs.length === EXPECTED_SERIES, `实际 ${promptDirs.length}：${promptDirs.join(', ')}`)
check('提示词目录里没有空目录', promptDirs.every((dir) => readdirSync(join(ROOT, 'assets', 'library', '风格提示词', dir)).length > 0))

// ── 单条读取 ───────────────────────────────────────────────────────────────
const first = catalog.entries[0]
check('getEntry 命中首条', getEntry(catalog, first.id)?.id === first.id)
check('getEntry 大小写不敏感', getEntry(catalog, first.id.toLowerCase())?.id === first.id)
check('getEntry 容忍首尾空格', getEntry(catalog, ` ${first.id} `)?.id === first.id)
check('getEntry 未知编号返回 null', getEntry(catalog, 'ZZ99') === null)

const prompt = readPrompt(first)
check('readPrompt 有内容', prompt.length > 200, `只有 ${prompt.length} 字符`)
check('readPrompt 是 Markdown', prompt.includes('#') || prompt.includes('：'), prompt.slice(0, 60).replace(/\n/g, ' '))

const summary = summarize(first)
check('summarize 字段齐全', ['id', 'name', 'series', 'description', 'fit', 'tags', 'hasStill'].every((key) => key in summary))
check('hasStill 与 imagePath 一致', summary.hasStill === Boolean(first.imagePath))

const withStillEntry = withImage[0]
check('stillPath 返回存在的图片', withStillEntry ? existsSync(stillPath(withStillEntry)) : false)
const textOnly = catalog.entries.find((entry) => !entry.imagePath)
check('文字参考条目 stillPath 为空串', textOnly ? stillPath(textOnly) === '' : false)

// ── 检索 ───────────────────────────────────────────────────────────────────
const byId = searchEntries(catalog, { query: first.id, limit: 5 })
check('按编号检索把该条排第一', byId[0]?.id === first.id, `实际 ${byId[0]?.id}`)

const seriesId = catalog.series[0].id
const inSeries = searchEntries(catalog, { series: seriesId, limit: 200 })
check('系列筛选只返回该系列', inSeries.length > 0 && inSeries.every((entry) => entry.series === seriesId))
check('系列筛选条数与索引一致', inSeries.length === catalog.series[0].count, `实际 ${inSeries.length} / 索引 ${catalog.series[0].count}`)

const word = first.name.slice(0, 2)
const byWord = searchEntries(catalog, { query: word, limit: 50 })
check('关键词检索有结果', byWord.length > 0, `关键词「${word}」没有结果`)
check('关键词结果确实包含该词', byWord.every((entry) => JSON.stringify(summarize(entry)).toLowerCase().includes(word.toLowerCase())))

const multi = searchEntries(catalog, { query: `${word} ${first.series}`, limit: 50 })
check('多词是 AND 关系', multi.length > 0 && multi.length <= byWord.length, `${multi.length} / ${byWord.length}`)

check('未知系列返回空数组', searchEntries(catalog, { series: 'ZZ' }).length === 0)
check('未知关键词返回空数组', searchEntries(catalog, { query: '这个词库里绝对没有出现过吧' }).length === 0)
check('limit 生效', searchEntries(catalog, { limit: 3 }).length === 3)
check('clampLimit 兜住非法值', clampLimit('abc') === 20 && clampLimit(-5) === 20 && clampLimit(9999) === 200 && clampLimit(0, 7) === 7)

// ── 随机 ───────────────────────────────────────────────────────────────────
const picked = new Set()
for (let i = 0; i < 30; i += 1) picked.add(randomEntry(catalog).id)
check('randomEntry 有随机性', picked.size > 1, `30 次只抽到 ${picked.size} 个`)
check('randomEntry 系列筛选正确', catalog.entries.length > 0 && randomEntry(catalog, { series: seriesId })?.series === seriesId)
check('randomEntry 未知系列返回 null', randomEntry(catalog, { series: 'ZZ' }) === null)

// ── 导出 ───────────────────────────────────────────────────────────────────
const workDir = mkdtempSync(join(tmpdir(), 'anim-pack-verify-'))
try {
  const ok = exportEntry(catalog, withStillEntry ?? first, join(workDir, 'one'))
  check('导出成功', ok.ok === true, ok.error)
  check('导出后提示词落地', ok.ok === true && existsSync(ok.files[0]) && statSync(ok.files[0]).size > 200)
  if (withStillEntry) {
    check('导出带上静帧', ok.ok === true && ok.files.length === 2 && existsSync(ok.files[1]))
  }

  const inside = exportEntry(catalog, first, join(catalog.root, 'assets', 'library', '风格提示词'))
  check('拒绝写进库内部', inside.ok === false && /refusing/.test(inside.error ?? ''), JSON.stringify(inside))

  const same = exportEntry(catalog, first, catalog.root)
  check('拒绝写进库根目录', same.ok === false, JSON.stringify(same))
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

// ── 插件注册：用假 ctx 跑一遍 apply()，7 个工具都得能真的执行 ─────────────
const registered = []
const fakeCtx = { tools: { register: (tool) => registered.push(tool) }, logger: { info: () => {} } }
const { apply } = await import('../lib/index.js')
apply(fakeCtx, {})

const TOOL_NAMES = ['anim_list_series', 'anim_search', 'anim_show', 'anim_still', 'anim_export', 'anim_random', 'anim_guide']
const toolsByName = new Map(registered.map((tool) => [tool.name, tool]))
check('注册了 7 个工具', registered.length === TOOL_NAMES.length, `实际 ${registered.length}：${registered.map((t) => t.name).join(', ')}`)
check('工具名齐全', TOOL_NAMES.every((name) => toolsByName.has(name)), TOOL_NAMES.filter((n) => !toolsByName.has(n)).join(', '))
check(
  '每个工具都有描述与 JSON Schema',
  registered.every((tool) => typeof tool.description === 'string' && tool.description.length > 5 && tool.parameters?.type === 'object'),
)
check('输出 renderer 返回 text 块', registered.every((tool) => {
  const blocks = tool.output.render({}, 'hello')
  return Array.isArray(blocks) && blocks[0]?.type === 'text' && blocks[0]?.text === 'hello'
}))

const callTool = (name, args = {}, exec = {}) => toolsByName.get(name).execute(args, exec)

const listOut = JSON.parse(await callTool('anim_list_series'))
check('anim_list_series 给出 10 个系列 / 341 条', listOut.series.length === 10 && listOut.total === 341, JSON.stringify(listOut).slice(0, 120))

const searchOut = JSON.parse(await callTool('anim_search', { query: first.id, limit: 5 }))
check('anim_search 命中该条', searchOut.results[0]?.id === first.id, JSON.stringify(searchOut.results[0] ?? null))

const showOut = await callTool('anim_show', { id: first.id.toLowerCase() })
check('anim_show 输出元信息 + 提示词正文', showOut.includes(`# ${first.id} ${first.name}`) && showOut.length > 500, `${showOut.length} 字符`)
check('anim_show 未知编号给提示而不是抛错', (await callTool('anim_show', { id: 'ZZ99' })).includes('找不到'))

const stillOut = await callTool('anim_still', { id: withStillEntry.id })
check('anim_still 给出存在的图片路径', existsSync(stillOut.trim().split('\n').pop() ?? ''), stillOut.slice(0, 120))
check('anim_still 文字参考条目说明没有图', (await callTool('anim_still', { id: textOnly.id })).includes('没有参考静帧'))

const guideOut = await callTool('anim_guide')
check('anim_guide 读到制作指南', guideOut.length > 1000, `${guideOut.length} 字符`)

const toolWorkDir = mkdtempSync(join(tmpdir(), 'anim-pack-tools-'))
try {
  const exportOut = JSON.parse(await callTool('anim_export', { ids: [first.id, withStillEntry.id], dir: join(toolWorkDir, 'out') }))
  check('anim_export 两条都导出成功', exportOut.results.every((row) => row.ok === true), JSON.stringify(exportOut.results))
  check('anim_export 落地的文件真的存在', exportOut.results.every((row) => row.files.every((file) => existsSync(file))))
  const emptyOut = await callTool('anim_export', {})
  check('anim_export 没给编号时给提示', emptyOut.includes('没有给出'))
} finally {
  rmSync(toolWorkDir, { recursive: true, force: true })
}

const randomOut = await callTool('anim_random', { series: seriesId })
check('anim_random 限定系列', randomOut.includes(`系列：${seriesId}`), randomOut.slice(0, 80))

// ── 结果 ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nFAIL — ${passed} 项通过，${failures.length} 项失败：`)
  for (const failure of failures) console.error(`  · ${failure}`)
  process.exit(1)
}
console.log(`PASS — ${passed} 项检查全部通过（341 条风格 / 193 张静帧 / 10 个系列）`)
