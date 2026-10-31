// dsh-anim-pack — the 341-style code-animation prompt library as DSH tools.
//
// The library (341 Markdown prompts, 193 reference stills, a catalog and the
// original license notes) ships inside this package under assets/library/.
// The tools let a session search it, read one prompt, look at its still, and
// copy a style into a working directory — without loading 341 files into the
// context.
//
// Like the other workspace plugins this file imports no @deepseek-ai/*
// package: it is loaded from a workspace path (junction-linked into the
// profile), so only node: builtins and relative files resolve. The tool
// registration shim below stands in for @deepseek-ai/dsh-tools' defineTool.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

import {
  exportEntry,
  getEntry,
  loadCatalog,
  randomEntry,
  readPrompt,
  searchEntries,
  stillPath,
  summarize,
} from './catalog.js'

export const name = 'anim-pack'

export const inject = ['tools']

/** Plugin root: this file lives in <root>/lib/index.js. */
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Cap on how much prompt text one tool result prints before pointing at the file. */
const MAX_PROMPT_CHARS = 12000

/** Local stand-in for defineTool: compiles the compact parameter spec into JSON Schema. */
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
    parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    output: { schema: options.output.schema, render: options.output.render },
    execute: options.execute,
  }
}

/** Every tool answers with text; this is the shared renderer. */
const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

function normalizeConfig(config) {
  const input = config !== null && typeof config === 'object' ? config : {}
  return {
    libraryPath: typeof input.libraryPath === 'string' && input.libraryPath.trim() ? input.libraryPath.trim() : '',
    exportDir: typeof input.exportDir === 'string' ? input.exportDir.trim() : '',
  }
}

/** Render one style the way anim_show / anim_random answer. */
function renderStyle(catalog, entry) {
  const still = stillPath(entry)
  const lines = [
    `# ${entry.id} ${entry.name}`,
    '',
    `- 系列：${entry.series}${entry.category ? ` / ${entry.category}` : ''}`,
    `- 适合：${entry.fit || '（未注明）'}`,
    `- 描述：${entry.description || '（未注明）'}`,
    `- 标签：${entry.tags.length > 0 ? entry.tags.join('、') : '（无）'}`,
    `- 提示词文件：${entry.filePath}`,
    `- 参考静帧：${still || '无（文字参考，148/341 条没有静帧）'}`,
    '',
  ]
  let prompt = ''
  try {
    prompt = readPrompt(entry)
  } catch (error) {
    lines.push(`（读取提示词失败：${error?.message ?? error}）`)
    return lines.join('\n')
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    lines.push(prompt.slice(0, MAX_PROMPT_CHARS))
    lines.push('', `…（已截断，完整内容见上面的提示词文件，共 ${prompt.length} 字符）`)
  } else {
    lines.push(prompt)
  }
  return lines.join('\n')
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const libraryRoot = config.libraryPath ? resolve(config.libraryPath) : ROOT
  const logger = ctx.logger
  /** Host logging is optional: a headless profile may not provide ctx.logger. */
  const log = (message) => {
    try {
      ;(logger?.info ?? logger?.debug)?.call(logger, message)
    } catch {
      /* logging must never break a tool call */
    }
  }

  let catalog = null
  /** Load the catalog once, on first use: a broken library must not break plugin start. */
  function getCatalog() {
    if (catalog) return catalog
    catalog = loadCatalog(libraryRoot)
    log(`anim-pack: ${catalog.total} styles (${catalog.withStill} with stills) from ${catalog.catalogPath}`)
    return catalog
  }

  /** Resolve an export directory: explicit arg, config default, else <cwd>/anim-styles. */
  function resolveExportDir(args, exec) {
    const explicit = typeof args?.dir === 'string' ? args.dir.trim() : ''
    if (explicit) return resolve(explicit)
    if (config.exportDir) return resolve(config.exportDir)
    const cwd = exec?.agent?.session?.cwd ?? process.cwd()
    return join(cwd, 'anim-styles')
  }

  ctx.tools.register(defineTool({
    name: 'anim_list_series',
    description: '列出代码动画素材包的 10 个风格系列与条目数（341 条提示词，193 条带参考静帧）。开始挑风格前先看一眼有哪些系列。',
    parameters: {},
    output: textOutput,
    async execute() {
      const data = getCatalog()
      return JSON.stringify({
        total: data.total,
        withStill: data.withStill,
        series: data.series.map((row) => ({ ...row })),
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'anim_search',
    description: '按关键词 / 系列检索代码动画风格（341 条）。多个词用空格分隔表示"同时命中"；不传 query 则按系列列出。返回编号、名称、适用内容、标签与是否有静帧；再用 anim_show 读完整提示词。',
    parameters: {
      query: { type: 'string', description: '关键词，例如「水墨」「粒子」「霓虹 雨夜」；也可以直接填编号（B3）或风格名。' },
      series: { type: 'string', description: '限定系列：AG / M / K / Z / H / L / V / X / R / O。' },
      limit: { type: 'number', description: '最多返回多少条，默认 20，上限 200。' },
    },
    output: textOutput,
    async execute(args) {
      const data = getCatalog()
      const rows = searchEntries(data, args ?? {})
      return JSON.stringify({
        query: args?.query ?? '',
        series: args?.series ?? '',
        count: rows.length,
        results: rows.map(summarize),
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'anim_show',
    description: '读取某个风格的完整提示词（Markdown 原文）、参考静帧路径与元信息。编号不区分大小写。',
    parameters: {
      id: { type: 'string', required: true, description: '风格编号，例如 B3、Z1、R1。' },
    },
    output: textOutput,
    async execute(args) {
      const entry = getEntry(getCatalog(), args?.id)
      if (!entry) return `找不到风格编号「${args?.id ?? ''}」。先用 anim_search 检索，或用 anim_list_series 看系列。`
      return renderStyle(getCatalog(), entry)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'anim_still',
    description: '取某个风格的参考静帧图片路径（可直接交给看图工具）。148 条风格没有静帧，此时会说明是文字参考。',
    parameters: {
      id: { type: 'string', required: true, description: '风格编号，例如 A1、K7。' },
    },
    output: textOutput,
    async execute(args) {
      const entry = getEntry(getCatalog(), args?.id)
      if (!entry) return `找不到风格编号「${args?.id ?? ''}」。`
      const still = stillPath(entry)
      if (!still) return `${entry.id} ${entry.name}：没有参考静帧，属于文字参考条目（341 条中 193 条有图）。`
      return `${entry.id} ${entry.name} 的参考静帧：\n${still}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'anim_export',
    description: '把一个或多个风格的提示词 Markdown（及参考静帧）复制到工作目录，方便在项目里直接用。默认复制到 <当前目录>/anim-styles/<编号>_<名称>/。',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, description: '要导出的风格编号列表，例如 ["B3","Z1"]。' },
      id: { type: 'string', description: '只导出一个时可直接传单个编号。' },
      dir: { type: 'string', description: '导出到指定目录（绝对路径或相对当前目录）；省略则用 <当前目录>/anim-styles/<编号>_<名称>/。' },
    },
    output: textOutput,
    async execute(args, exec) {
      const data = getCatalog()
      const ids = []
      if (Array.isArray(args?.ids)) ids.push(...args.ids)
      if (typeof args?.id === 'string' && args.id.trim()) ids.push(args.id)
      const wanted = [...new Set(ids.map((v) => String(v).trim()).filter(Boolean))]
      if (wanted.length === 0) return '没有给出要导出的编号。用 anim_search 挑一个，再传 id 或 ids。'
      const base = resolveExportDir(args, exec)
      const results = wanted.map((id) => {
        const entry = getEntry(data, id)
        if (!entry) return { id, ok: false, error: '未知的风格编号' }
        const target = args?.dir ? base : join(base, `${entry.id}_${entry.name}`)
        return exportEntry(data, entry, target)
      })
      return JSON.stringify({ exportDir: base, results }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'anim_random',
    description: '随机抽一个风格（可限定系列），并直接返回它的完整提示词，适合"随便来一个"或给灵感。',
    parameters: {
      series: { type: 'string', description: '限定系列：AG / M / K / Z / H / L / V / X / R / O。' },
    },
    output: textOutput,
    async execute(args) {
      const data = getCatalog()
      const entry = randomEntry(data, args ?? {})
      if (!entry) return `系列「${args?.series ?? ''}」里没有条目。用 anim_list_series 看可选系列。`
      return renderStyle(data, entry)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'anim_guide',
    description: '返回「怎么用这 341 条提示词做出代码动画」的完整指南：选型方法、占位符填充、时间接口、渲染成 MP4 与验收清单。动手做动画前读一次。',
    parameters: {},
    output: textOutput,
    async execute() {
      const guidePath = join(ROOT, 'docs', 'SKILL.md')
      try {
        return readFileSync(guidePath, 'utf8')
      } catch (error) {
        return `读取指南失败：${error?.message ?? error}\n路径：${guidePath}`
      }
    },
  }))

  log('anim-pack: ready, library at ' + libraryRoot)
}
