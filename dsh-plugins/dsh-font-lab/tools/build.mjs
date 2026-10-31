/**
 * src/fontlab.css  +  src/client.template.js  →  lib/client.js
 *
 * 为什么不直接在 client.js 里写模板字符串：CSS 里有反引号和 ${ }，
 * 手写拼接踩过坑（少转义一个反斜杠整个插件就加载不了）。
 * 这里用 JSON.stringify 生成一个合法的 JS 字符串字面量，替进 __CSS__ 占位符。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const css = readFileSync(join(root, 'src', 'fontlab.css'), 'utf8')
const tpl = readFileSync(join(root, 'src', 'client.template.js'), 'utf8')

if (!tpl.includes('__CSS__')) {
  console.error('src/client.template.js 里找不到 __CSS__ 占位符')
  process.exit(1)
}

const out = tpl.replace('__CSS__', JSON.stringify(css))
mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), out)

console.log('lib/client.js  ' + out.length + ' chars  (css ' + css.length + ')')
