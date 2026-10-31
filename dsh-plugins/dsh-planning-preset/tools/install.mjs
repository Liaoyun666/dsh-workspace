#!/usr/bin/env node
/**
 * dsh-planning-preset 安装器 / 卸载器。
 *
 * 它把「规划」+「执行」两个 agent preset 装进某个 dsh profile：
 *
 *  · patch（默认）：把本包的 cordis.patch.yml 原样追加进 profile 的
 *      cordis.patch.yml（profile 是配置热重载的，运行中的 dsh 会立即应用），
 *      并在 profile/node_modules 里为本包建一个 junction（供 !!js 表达式或
 *      后续 skills 目录解析本包目录）；
 *  · bundle（--bundle）：等价于官方 `dsh plugin --profile <name> add link:<本包目录>`，
 *      写入 profile 的 dependencies 与 dsh.profile.bundles，本包成为一层
 *      bundle patch。bundle 列表在启动时结算，需要重启 dsh；
 *  · --status / --uninstall：查看现状 / 两种登记都撤掉。
 *
 * 用法：
 *   node tools/install.mjs                 # 装进 desktop profile（patch，热生效）
 *   node tools/install.mjs web             # 装进 web profile
 *   node tools/install.mjs desktop --bundle
 *   node tools/install.mjs --status
 *   node tools/install.mjs --uninstall
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).name
if (typeof packageName !== 'string' || packageName === '') throw new Error('本包 package.json 缺少 name')

/** 本包声明的装配补丁（也是 patch 模式下写进 profile 补丁层的内容）。 */
const bundlePatch = readFileSync(join(pluginDir, 'cordis.patch.yml'), 'utf8').trimEnd()
/** 托管块首尾标记；卸载时按标记精确摘除。 */
const BLOCK_BEGIN = `# ── ${packageName} (managed block; 由 tools/install.mjs 维护) ──`
const BLOCK_END = `# ── /${packageName} ──`
const BLOCK = `${BLOCK_BEGIN}\n${bundlePatch}\n${BLOCK_END}\n`

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((value) => value.startsWith('--')))
const rest = argv.filter((value) => !value.startsWith('--'))
const profile = rest[0] ?? 'desktop'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', profile)
const profileManifestPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const link = join(profileDir, 'node_modules', packageName)

if (!existsSync(profileManifestPath)) {
  console.error(`找不到 profile ${JSON.stringify(profile)} 的清单：${profileManifestPath}`)
  console.error(`先用 ${profile === 'desktop' ? 'DeepSeek Harness 桌面端' : `dsh --profile ${profile}`} 把 profile 建出来再安装。`)
  process.exit(1)
}

const readProfileManifest = () => JSON.parse(readFileSync(profileManifestPath, 'utf8'))
const writeAtomic = (path, text) => {
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, text)
  renameSync(temp, path)
}
const writeProfileManifest = (manifest) => writeAtomic(profileManifestPath, `${JSON.stringify(manifest, void 0, 2)}\n`)
/** 读补丁层；profile 里还没有这个文件时给一份带表头的空列表。 */
const readPatchFile = () =>
  existsSync(patchPath)
    ? readFileSync(patchPath, 'utf8')
    : `# ${profile} profile 的用户补丁层：顶层 YAML 数组的 loader 补丁条目。\n[]\n`

/** junction 现状：undefined=不存在，false=同名实体目录，字符串=指向。 */
function linkTarget() {
  try {
    const stat = lstatSync(link)
    return stat.isSymbolicLink() ? readlinkSync(link) : false
  } catch {
    return undefined
  }
}
const linkType = process.platform === 'win32' ? 'junction' : 'dir'

/** 删除 junction / 符号链接（Windows 上 rmSync 对 junction 会报 "Path is a directory"，改用 unlink）。 */
function removeLink() {
  try {
    unlinkSync(link)
  } catch {
    rmSync(link, { recursive: true, force: true })
  }
}

/** 摘掉托管块。 */
function stripBlock(text) {
  const start = text.indexOf(BLOCK_BEGIN)
  if (start === -1) return text
  const end = text.indexOf(BLOCK_END, start)
  if (end === -1) return text
  return text.slice(0, start) + text.slice(end + BLOCK_END.length)
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
  if (base.split('\n').some((line) => /^\s*-\s/.test(line))) return base
  return base.replace(/\s*$/, '\n\n[]\n')
}

const hasPatchBlock = existsSync(patchPath) && readFileSync(patchPath, 'utf8').includes(BLOCK_BEGIN)
const manifestNow = readProfileManifest()
const hasBundle = (manifestNow.dsh?.profile?.bundles ?? []).includes(packageName)
const target = linkTarget()

if (flags.has('--status')) {
  console.log(`profile      : ${profile} (${profileDir})`)
  console.log(`node_modules : ${target === undefined ? '（无 junction）' : target === false ? '（同名实体目录，未接管）' : target}`)
  console.log(`patch 登记    : ${hasPatchBlock ? `已写入 ${patchPath}` : '未登记'}`)
  console.log(`bundle 登记   : ${hasBundle ? '已写入 package.json (dependencies + dsh.profile.bundles)' : '未登记'}`)
  console.log(`补丁模式      : ${hasPatchBlock ? '是（运行中的 dsh 会热应用；刷新页面即可看到 preset）' : '否'}`)
  process.exit(0)
}

if (flags.has('--uninstall')) {
  if (typeof target === 'string') removeLink()
  if (hasPatchBlock) writeAtomic(patchPath, withoutBlock(readPatchFile()))
  const manifest = readProfileManifest()
  if (manifest.dependencies?.[packageName] !== undefined) delete manifest.dependencies[packageName]
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes(packageName)) manifest.dsh.profile.bundles = bundles.filter((value) => value !== packageName)
  writeProfileManifest(manifest)
  console.log(`已卸载 ${packageName}（profile ${profile}）；刷新页面后「规划」与「执行」preset 消失。`)
  process.exit(0)
}

/** 动手之前留一份 .bak（同一份只留最近一次）。 */
function backup(pathToBackup) {
  if (existsSync(pathToBackup)) writeFileSync(`${pathToBackup}.bak-${packageName}`, readFileSync(pathToBackup))
}

// 1. profile/node_modules junction（幂等；绝不覆盖同名实体目录）
mkdirSync(dirname(link), { recursive: true })
if (target === false) {
  console.error(`拒绝覆盖实体目录：${link}（请先确认它是什么）`)
  process.exit(1)
}
if (target !== undefined) removeLink()
symlinkSync(pluginDir, link, linkType)

if (flags.has('--bundle')) {
  const manifest = readProfileManifest()
  manifest.dependencies = { ...manifest.dependencies, [packageName]: `link:${pluginDir}` }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(packageName)) bundles.push(packageName)
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
  backup(profileManifestPath)
  writeProfileManifest(manifest)
  if (hasPatchBlock) writeAtomic(patchPath, withoutBlock(readPatchFile()))
  console.log(`已安装 ${packageName}（bundle 方式，profile ${profile}）`)
  console.log(`  junction : ${link} -> ${pluginDir}`)
  console.log(`  依赖     : dependencies.${packageName} = link:${pluginDir}`)
  console.log(`  装配层   : dsh.profile.bundles = [${bundles.join(', ')}]`)
  console.log('  bundle 列表在启动时结算：重启 DeepSeek Harness（或下次启动 dsh）后生效。')
} else {
  backup(patchPath)
  writeAtomic(patchPath, withBlock(readPatchFile()))
  if (hasBundle) {
    const manifest = readProfileManifest()
    delete manifest.dependencies?.[packageName]
    const bundles = (manifest.dsh?.profile?.bundles ?? []).filter((value) => value !== packageName)
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    writeProfileManifest(manifest)
    console.log('（原先的 bundle 登记已撤销，避免同一 preset 被声明两次）')
  }
  console.log(`已安装 ${packageName}（patch 方式，profile ${profile}）`)
  console.log(`  junction : ${link} -> ${pluginDir}`)
  console.log(`  补丁层   : ${patchPath}`)
  console.log('  profile 配置热重载：运行中的 dsh 会立刻应用，刷新页面即可在「设置 → Agent 预设」看到「规划」与「执行」。')
  console.log('  插件代码本身不需要重启；preset 的声明层与技能目录都是即时读取的。')
}
