// 把 src/client.template.js 里的 __CSS__ 换成 src/mobile.css 的内容，产出 lib/client.js。
// 生成而不是手写：CSS 里带引号和反斜杠，直接拼进 JS 字符串很容易出错（踩过）。
// 用法：ELECTRON_RUN_AS_NODE=1 "<node 或 DSH 的 exe>" tools/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const css = readFileSync(join(root, 'src', 'mobile.css'), 'utf8');
const tpl = readFileSync(join(root, 'src', 'client.template.js'), 'utf8');
if (!tpl.includes('__CSS__')) throw new Error('src/client.template.js is missing the __CSS__ placeholder');
const out = tpl.replace('__CSS__', JSON.stringify(css));
writeFileSync(join(root, 'lib', 'client.js'), out, 'utf8');
console.log('wrote lib/client.js', out.length, 'chars; css', css.length, 'chars');
