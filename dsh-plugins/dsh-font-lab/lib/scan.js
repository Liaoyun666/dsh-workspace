/**
 * 本机字体扫描 — 只依赖 node: 内置模块。
 *
 * 为什么自己解析二进制而不是调 fontconfig / PowerShell：
 *   - Windows 上没有任何可靠的「列出已安装字体目录」的现成命令行（.NET 的
 *     System.Drawing.FontFamilies 要起一个 .NET 进程，慢且中文名会乱码）；
 *   - 宿主的字体目录里 .fon 是位图字体、.ttc 是多字体集合，只有自己读 sfnt
 *     的 name 表才能拿到正确的「家族名 + 字重」。
 *
 * 解析范围：ttf / otf / ttc（sfnt 容器）的
 *   name  → 家族名、子族名
 *   OS/2  → usWeightClass（100..900）、panose（分类）
 *   post  → isFixedPitch（等宽）
 *   cmap  → 是否含 CJK 汉字（U+4E00）、是否含拉丁（U+0041）
 * 解析失败的文件只计数，不影响整体。
 *
 * @module dsh-font-lab/scan
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CJK_PROBE = 0x4e00
const LATIN_PROBE = 0x0041

/** 读 sfnt 里某张表的目录位置。 */
function tableIndex(buf, base) {
  const numTables = buf.readUInt16BE(base + 4)
  const tables = new Map()
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16
    if (rec + 16 > buf.length) break
    const tag = buf.toString('latin1', rec, rec + 4)
    tables.set(tag, { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) })
  }
  return tables
}

/** name 表 → { 家族名, 子族名, 全名 }。优先 Windows 平台（UTF-16BE）。 */
function readNames(buf, table) {
  const base = table.offset
  if (base + 6 > buf.length) return null
  const count = buf.readUInt16BE(base + 2)
  const storage = base + buf.readUInt16BE(base + 4)
  const picked = new Map()
  for (let i = 0; i < count; i++) {
    const rec = base + 6 + i * 12
    if (rec + 12 > buf.length) break
    const platform = buf.readUInt16BE(rec)
    const language = buf.readUInt16BE(rec + 4)
    const nameId = buf.readUInt16BE(rec + 6)
    const length = buf.readUInt16BE(rec + 8)
    const start = storage + buf.readUInt16BE(rec + 10)
    if (start + length > buf.length) continue
    if (platform !== 3 && platform !== 0) continue
    let text = ''
    if (platform === 3) {
      for (let j = 0; j + 1 < length; j += 2) text += String.fromCharCode(buf.readUInt16BE(start + j))
    } else {
      text = buf.toString('latin1', start, start + length)
    }
    text = text.replace(/\u0000/g, '').trim()
    if (text === '') continue
    // 英文（0x409）优先，其余语言只做兜底。
    const rank = language === 0x409 ? 2 : 1
    const prev = picked.get(nameId)
    if (!prev || rank > prev.rank) picked.set(nameId, { rank, text })
  }
  const get = (id) => (picked.get(id) ? picked.get(id).text : '')
  return { family: get(16) || get(1), subfamily: get(17) || get(2), fullName: get(4) }
}

/** cmap 里是否映射了某个码位（只看 format 4 / format 12）。 */
function hasCodepoint(buf, cmap, codepoint) {
  if (!cmap || cmap.offset + 4 > buf.length) return false
  const base = cmap.offset
  const count = buf.readUInt16BE(base + 2)
  const candidates = []
  for (let i = 0; i < count; i++) {
    const rec = base + 4 + i * 8
    if (rec + 8 > buf.length) break
    const platform = buf.readUInt16BE(rec)
    const encoding = buf.readUInt16BE(rec + 2)
    const sub = base + buf.readUInt32BE(rec + 4)
    if (sub + 2 > buf.length) continue
    const format = buf.readUInt16BE(sub)
    // （3,10) / (0,4+) 的 format 12 覆盖全码位，优先。
    const rank = format === 12 ? 3 : format === 4 ? 2 : 0
    if (rank === 0) continue
    if (platform !== 3 && platform !== 0) continue
    candidates.push({ sub, format, rank: rank + (encoding === 10 ? 1 : 0) })
  }
  candidates.sort((a, b) => b.rank - a.rank)
  for (const c of candidates) {
    if (c.format === 12) {
      const groups = buf.readUInt32BE(c.sub + 12)
      for (let i = 0; i < groups; i++) {
        const g = c.sub + 16 + i * 12
        if (g + 12 > buf.length) break
        const start = buf.readUInt32BE(g)
        const end = buf.readUInt32BE(g + 4)
        if (codepoint >= start && codepoint <= end) return true
      }
      continue
    }
    const segCount = buf.readUInt16BE(c.sub + 6) / 2
    const endBase = c.sub + 14
    const startBase = endBase + segCount * 2 + 2
    for (let i = 0; i < segCount; i++) {
      const s = startBase + i * 2
      if (s + 2 > buf.length) break
      const start = buf.readUInt16BE(s)
      const end = buf.readUInt16BE(endBase + i * 2)
      if (codepoint >= start && codepoint <= end) return true
    }
  }
  return false
}

const PANOSE_KIND = { 2: 'text', 3: 'handwritten', 4: 'decorative', 5: 'symbol' }

/** 一个 sfnt 字体 → 一条家族记录（拿不到 name 表就返回 null）。 */
function readFace(buf, base) {
  const tables = tableIndex(buf, base)
  const nameTable = tables.get('name')
  if (!nameTable) return null
  const names = readNames(buf, nameTable)
  if (!names || names.family === '') return null
  let weight = 400
  let panoseKind = ''
  let serif = null
  const os2 = tables.get('OS/2')
  if (os2 && os2.offset + 34 <= buf.length) {
    const w = buf.readUInt16BE(os2.offset + 4)
    if (w >= 1 && w <= 1000) weight = w
    const panose = os2.offset + 32
    panoseKind = PANOSE_KIND[buf.readUInt8(panose)] || ''
    // panose[1] = 衬线样式：2..10 是衬线，11..15 是无衬线。
    const style = buf.readUInt8(panose + 1)
    if (style >= 2 && style <= 10) serif = true
    else if (style >= 11 && style <= 15) serif = false
  }
  let mono = false
  const post = tables.get('post')
  if (post && post.offset + 16 <= buf.length) mono = buf.readUInt32BE(post.offset + 12) !== 0
  const cmap = tables.get('cmap')
  const cjk = hasCodepoint(buf, cmap, CJK_PROBE)
  const latin = hasCodepoint(buf, cmap, LATIN_PROBE)
  return {
    family: names.family,
    subfamily: names.subfamily,
    weight,
    panose: panoseKind,
    serif,
    mono,
    cjk,
    latin,
  }
}

/**
 * 扫描一个字体文件，返回其中所有 face（.ttc 里可能有好几个）。
 * @param {string} file - 绝对路径。
 */
export function readFontFile(file) {
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return { faces: [], error: 'unreadable' }
  }
  if (buf.length < 12) return { faces: [], error: 'too-small' }
  const tag = buf.toString('latin1', 0, 4)
  try {
    if (tag === 'ttcf') {
      const count = buf.readUInt32BE(8)
      const faces = []
      for (let i = 0; i < count && i < 64; i++) {
        const off = buf.readUInt32BE(12 + i * 4)
        const face = readFace(buf, off)
        if (face) faces.push(face)
      }
      return { faces, error: faces.length === 0 ? 'no-name-table' : undefined }
    }
    const face = readFace(buf, 0)
    return { faces: face ? [face] : [], error: face ? undefined : 'no-name-table' }
  } catch (error) {
    return { faces: [], error: String(error && error.message ? error.message : error) }
  }
}

/** 字体目录：系统 Fonts + 当前用户 Fonts（后者放用户自己装的字体）。 */
export function fontDirs() {
  const dirs = []
  const win = process.env.WINDIR || 'C:\\Windows'
  dirs.push(join(win, 'Fonts'))
  const local = process.env.LOCALAPPDATA
  if (local) dirs.push(join(local, 'Microsoft', 'Windows', 'Fonts'))
  return dirs
}

/** 权重 → 中文档位名，给卡片上的字重标签用。 */
export function weightName(weight) {
  if (weight < 150) return 'Thin'
  if (weight < 250) return 'ExtraLight'
  if (weight < 350) return 'Light'
  if (weight < 450) return 'Regular'
  if (weight < 550) return 'Medium'
  if (weight < 650) return 'SemiBold'
  if (weight < 750) return 'Bold'
  if (weight < 850) return 'ExtraBold'
  return 'Black'
}

/** 一条 face → 粗分类（衬线 / 无衬线 / 手写 / 装饰 / 符号 / 等宽）。 */
function categoryOf(face) {
  if (face.mono) return '等宽'
  if (face.panose === 'handwritten') return '手写'
  if (face.panose === 'decorative') return '装饰'
  if (face.panose === 'symbol') return '符号'
  if (face.serif === true) return '衬线'
  if (face.serif === false) return '无衬线'
  return '其他'
}

/**
 * 扫描全部字体目录，按家族聚合。
 * @returns {{ scannedAt: number, dirs: string[], files: number, parsed: number, failed: number,
 *   families: Array<{ family: string, category: string, weights: number[], subs: string[],
 *   mono: boolean, cjk: boolean, latin: boolean, fileNames: string[] }> }}
 */
export function scanFonts() {
  const dirs = fontDirs()
  const families = new Map()
  let files = 0
  let parsed = 0
  let failed = 0
  for (const dir of dirs) {
    let list
    try {
      list = readdirSync(dir)
    } catch {
      continue
    }
    for (const fileName of list) {
      if (!/\.(ttf|otf|ttc)$/i.test(fileName)) continue
      const full = join(dir, fileName)
      try {
        if (!statSync(full).isFile()) continue
      } catch {
        continue
      }
      files++
      const { faces } = readFontFile(full)
      if (faces.length === 0) {
        failed++
        continue
      }
      for (const face of faces) {
        parsed++
        const key = face.family
        let entry = families.get(key)
        if (!entry) {
          entry = { family: key, category: '', weights: new Set(), subs: new Set(), mono: face.mono, cjk: face.cjk, latin: face.latin, fileNames: new Set() }
          families.set(key, entry)
        }
        entry.weights.add(face.weight)
        if (face.subfamily) entry.subs.add(face.subfamily)
        entry.fileNames.add(fileName)
        entry.mono = entry.mono || face.mono
        entry.cjk = entry.cjk || face.cjk
        entry.latin = entry.latin || face.latin
        // 分类取第一条有意义的判据：等宽/手写/装饰/符号优先于衬线与否。
        const cat = categoryOf(face)
        if (entry.category === '' || (entry.category === '其他' && cat !== '其他')) entry.category = cat
      }
    }
  }
  const list = [...families.values()].map((entry) => ({
    family: entry.family,
    category: entry.category === '' ? '其他' : entry.category,
    weights: [...entry.weights].sort((a, b) => a - b),
    subs: [...entry.subs],
    mono: entry.mono,
    cjk: entry.cjk,
    latin: entry.latin,
    fileNames: [...entry.fileNames],
  }))
  list.sort((a, b) => a.family.localeCompare(b.family))
  return { scannedAt: Date.now(), dirs, files, parsed, failed, families: list }
}
