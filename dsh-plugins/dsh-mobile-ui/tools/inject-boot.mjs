// 生成一份 boot-plugin.js：在页面加载前把 lib/client.js 跑一遍（模拟「插件已装好」）。
// 宿主还没重启、插件没进页面 bundle 列表时，用它验证 CSS / 控制器的效果。
// 用法：ELECTRON_RUN_AS_NODE=1 "<node>" tools/inject-boot.mjs [输出路径]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outPath = process.argv[2] || join(root, 'tools', 'boot-plugin.js');
const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
const NL = String.fromCharCode(10);

const parts = [
  '(function(){',
  'const SRC = ' + JSON.stringify(src) + ';',
  'if (!window.__ModuleLoader__) {',
  '  window.__PLUGIN_MODS__ = [];',
  '  window.__ModuleLoader__ = { load: function (mod) { (window.__PLUGIN_MODS__ || (window.__PLUGIN_MODS__ = [])).push(mod); } };',
  '}',
  'try { (new Function(SRC))(); } catch (e) { window.__MUI_BOOT_ERR__ = String((e && e.stack) || e); }',
  'const mods = window.__PLUGIN_MODS__ || [];',
  'for (const mod of mods) {',
  '  try {',
  '    const m = mod.factory(function () { return {}; });',
  '    m.apply({ effect: function (fn) { const d = fn(); if (typeof d === ' + JSON.stringify('function') + ') d(); } });',
  '  } catch (e) { window.__MUI_BOOT_ERR__ = String((e && e.stack) || e); }',
  '}',
  '})();',
];

const text = parts.join(NL);
writeFileSync(outPath, text, 'utf8');
console.log('wrote', outPath, text.length, 'chars');
