/**
 * dsh-relay-think 安装器 / 卸载器。
 *
 * 两种登记方式（脚本保证不会同时上两处，避免同一 id 被插入两次）：
 *
 *  · patch（默认）：把一行 insert 追加进 profile 自己的 cordis.patch.yml。
 *      运行中的 dsh 会按自己的 patchReload 策略处理，通常刷新浏览器即可看到界面。
 *
 *  · bundle（--bundle）：等价于官方 `dsh plugin --profile <p> add link:<本包>`，
 *      写 profile package.json 的 dependencies 与 dsh.profile.bundles，启动时结算，需要重启 dsh。
 *
 * 两种方式都会先在 profile/node_modules 里建一个指向本包的软链（Loader 靠它解析包名）。
 *
 * 用法：
 *   node tools/install.mjs                    # patch 方式，自动选 desktop/web profile
 *   node tools/install.mjs desktop            # 指定 profile
 *   node tools/install.mjs desktop --bundle   # bundle 方式
 *   node tools/install.mjs --status           # 看现状
 *   node tools/install.mjs --uninstall        # 撤掉两种登记
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginManifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const packageName = pluginManifest.name
if (typeof packageName !== 'string' || packageName === '') throw new Error('本包 package.json 缺少 name')

/** 装配行 id：cordis.patch.yml 里的 loader 行。 */
const ROW_ID = 'relay-think'
/** 托管块首尾标记（纯注释，只用于阅读；卸载按行 id 精确定位，不依赖标记位置）。 */
const BLOCK_BEGIN = `# ── ${packageName} (managed block; 由 tools/install.mjs 维护) ──`
const BLOCK_END = `# ── /${packageName} ──`
const BLOCK = `${BLOCK_BEGIN}\n- insert:\n    - id: ${ROW_ID}\n      name: ${packageName}\n${BLOCK_END}\n`

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((value) => value.startsWith('--')))
const rest = argv.filter((value) => !value.startsWith('--'))

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profilesDir = join(home, 'profiles')

/** 默认 profile：环境变量优先；否则 desktop 存在就用 desktop，再退回 web。 */
function defaultProfile() {
  if (typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== '') return process.env.DSH_PROFILE
  if (existsSync(join(profilesDir, 'desktop'))) return 'desktop'
  return 'web'
}

const profile = rest[0] ?? defaultProfile()
const profileDir = join(profilesDir, profile)
const profileManifestPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const link = join(profileDir, 'node_modules', packageName)

if (!existsSync(profileManifestPath)) {
  console.error(`找不到 profile ${JSON.stringify(profile)} 的清单：${profileManifestPath}`)
  console.error(`先跑一次 dsh --profile ${profile} 让 dsh 把 profile 建出来。`)
  process.exit(1)
}

/** 补丁文件可能正被运行中的 dsh 监听：先写临时文件再原子改名，避免读到半截 YAML。 */
function writeFileAtomic(path, text) {
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, text)
  renameSync(temp, path)
}

const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
const readProfileManifest = () => JSON.parse(stripBom(readFileSync(profileManifestPath, 'utf8')))
const writeProfileManifest = (manifest) => writeFileAtomic(profileManifestPath, `${JSON.stringify(manifest, void 0, 2)}\n`)

/** 读补丁层；profile 里还没这个文件时给一份带表头的空列表。 */
const readPatchFile = () =>
  existsSync(patchPath)
    ? stripBom(readFileSync(patchPath, 'utf8'))
    : `# ${profile} profile 的用户补丁层：顶层 YAML 数组的 loader 补丁条目。\n[]\n`

/** 软链现状：undefined=不存在，false=同名实体目录，字符串=指向。 */
function linkTarget() {
  try {
    const stat = lstatSync(link)
    return stat.isSymbolicLink() ? readlinkSync(link) : false
  } catch {
    return undefined
  }
}

/** 某行是否本插件的行 id。 */
function isOursId(line) {
  return new RegExp('^\\s*-\\s*id:\\s*' + ROW_ID + '\\s*$').test(line)
}

/**
 * 判断一个顶层条目（从 start 行的 `- ` 开始）是否本插件的装配行：
 * insert 形式看块内是否有 `- id: relay-think`；单行形式看本行。
 */
function blockIsOurs(lines, start) {
  if (isOursId(lines[start])) return true
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^- /.test(lines[index])) return false
    if (isOursId(lines[index])) return true
  }
  return false
}

/**
 * 摘掉本插件的托管块。
 *
 * 不只按首尾注释裁剪：config-editor 重新排版 patch 时，别的设置行可能被追加进
 * 标记之间。这里按「顶层条目 + 行 id」精确定位，命中则整块删除，其它行原样保留。
 */
function stripBlock(text) {
  const lines = text.split('\n').filter((line) => !line.includes(`── ${packageName} (managed block`) && !line.includes(`── /${packageName} ──`))
  const out = []
  for (let index = 0; index < lines.length;) {
    if (/^- /.test(lines[index]) && blockIsOurs(lines, index)) {
      index += 1
      while (index < lines.length && !/^- /.test(lines[index])) index += 1
      continue
    }
    out.push(lines[index])
    index += 1
  }
  return out.join('\n')
}

/** 追加托管块（先把 `[]` 空列表占位去掉，避免解析出两个顶层值）。 */
function withBlock(text) {
  let base = stripBlock(text)
  base = base.replace(/^[ \t]*\[[ \t]*\][ \t]*\r?\n?/m, '')
  if (base !== '' && !base.endsWith('\n')) base += '\n'
  return `${base}${BLOCK}`
}

/** 摘干净后如果一行补丁都不剩，补回 `[]`（补丁文件必须是顶层数组）。 */
function withoutBlock(text) {
  const base = stripBlock(text)
  if (base.split('\n').some((line) => /^-\s/.test(line))) return base
  return base.replace(/\s*$/, '\n\n[]\n')
}

const hasPatchBlock = existsSync(patchPath) && readPatchFile().split('\n').some(isOursId)
const manifestNow = readProfileManifest()
const hasBundle = (manifestNow.dsh?.profile?.bundles ?? []).includes(packageName)
const target = linkTarget()

if (flags.has('--status')) {
  console.log(`profile      : ${profile} (${profileDir})`)
  console.log(`node_modules : ${target === undefined ? '（无软链）' : target === false ? '（同名实体目录，未接管）' : target}`)
  console.log(`patch 登记    : ${hasPatchBlock ? `已写入 ${patchPath}` : '未登记'}`)
  console.log(`bundle 登记   : ${hasBundle ? '已写入 package.json (dependencies + dsh.profile.bundles)' : '未登记'}`)
  process.exit(0)
}

if (flags.has('--uninstall')) {
  if (typeof target === 'string') rmSync(link, { force: true })
  if (hasPatchBlock) writeFileAtomic(patchPath, withoutBlock(readPatchFile()))
  const manifest = readProfileManifest()
  if (manifest.dependencies?.[packageName] !== undefined) delete manifest.dependencies[packageName]
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes(packageName)) {
    manifest.dsh.profile.bundles = bundles.filter((value) => value !== packageName)
  }
  writeProfileManifest(manifest)
  console.log(`已卸载 ${packageName}（profile ${profile}）；刷新浏览器后界面消失`)
  process.exit(0)
}

// ── 安装 ────────────────────────────────────────────────────────────────────

/** 动手之前留一份 .bak（同一份只留最近一次，避免堆文件）。 */
function backup(pathToBackup) {
  if (!existsSync(pathToBackup)) return
  writeFileSync(`${pathToBackup}.bak-${packageName}`, readFileSync(pathToBackup))
}

// 1. node_modules 软链（幂等；绝不覆盖同名实体目录）
mkdirSync(dirname(link), { recursive: true })
if (target === false) {
  console.error(`拒绝覆盖实体目录：${link}（请先确认它是什么）`)
  process.exit(1)
}
if (target !== undefined) rmSync(link, { force: true })
symlinkSync(pluginDir, link, 'junction')

if (flags.has('--bundle')) {
  const manifest = readProfileManifest()
  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dependencies[packageName] = `link:${pluginDir}`
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = new Set(manifest.dsh.profile.bundles ?? [])
  bundles.add(packageName)
  manifest.dsh.profile.bundles = [...bundles]
  backup(profileManifestPath)
  writeProfileManifest(manifest)
  // bundle 与 patch 互斥：切到 bundle 时摘掉 patch 块。
  if (hasPatchBlock) writeFileAtomic(patchPath, withoutBlock(readPatchFile()))
  console.log(`已安装 ${packageName}（bundle 方式，profile ${profile}）。`)
  console.log('bundle 列表在启动时结算：请重启 dsh（或刷新桌面端）后生效。')
  process.exit(0)
}

// 2. profile patch 托管块
backup(patchPath)
writeFileAtomic(patchPath, withBlock(readPatchFile()))
// patch 与 bundle 互斥：切到 patch 时摘掉 bundle 登记。
{
  const manifest = readProfileManifest()
  let changed = false
  if (manifest.dependencies?.[packageName] !== undefined) {
    delete manifest.dependencies[packageName]
    changed = true
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes(packageName)) {
    manifest.dsh.profile.bundles = bundles.filter((value) => value !== packageName)
    changed = true
  }
  if (changed) writeProfileManifest(manifest)
}
console.log(`已安装 ${packageName}（patch 方式，profile ${profile}）。`)
console.log(`  软链：${link}`)
console.log(`  补丁：${patchPath}`)
console.log('运行中的 dsh 若支持 profile 热重载，界面会自动出现；否则重启一次 dsh / 刷新页面。')