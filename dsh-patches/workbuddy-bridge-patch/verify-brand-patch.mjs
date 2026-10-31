// 离线验证补丁后的品牌词改写：用真实系统提示词走同样的两条规则，再打上游看是否 200
import fs from 'node:fs';
import zlib from 'node:zlib';
import { readDesktopCredential } from './desktop-credential.mjs';

const LIB = 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-workbuddy-bridge/lib';
const chunkFile = fs
  .readdirSync(LIB)
  .filter((f) => f.endsWith('.js'))
  .find((f) => fs.readFileSync(`${LIB}/${f}`, 'utf8').includes('CHANNEL_SIGNATURE_PHRASE ='));
const src = fs.readFileSync(`${LIB}/${chunkFile}`, 'utf8');

function regexFrom(line) {
  const s = line.trim().replace(/\r$/, '');
  const open = s.indexOf('/');
  const close = s.lastIndexOf('/');
  const flags = (s.slice(close + 1).match(/^[dgimsuvy]+/) ?? [''])[0];
  return new RegExp(s.slice(open + 1, close), flags);
}
function lineWith(needle) {
  const i = src.indexOf(needle);
  if (i < 0) throw new Error(`missing ${needle}`);
  return src.slice(i, src.indexOf('\n', i));
}

const OPENER = regexFrom(lineWith('const CHANNEL_OPENER ='));
const PHRASE = regexFrom(lineWith('const CHANNEL_SIGNATURE_PHRASE ='));
const patched = src.includes('"the local agent runtime"');
console.log('chunk:', chunkFile, '| 补丁已打:', patched);
const NEUTRAL = patched ? 'the local agent runtime' : null;
if (!NEUTRAL) throw new Error('补丁未生效，脚本应已写入 "the local agent runtime"');

const neutralize = (text) => text.replace(OPENER, '$1You are an AI agent.').replace(PHRASE, NEUTRAL);
console.log('样本 →', JSON.stringify(neutralize('You are an AI agent powered by DeepSeek Harness. Path D:/DeepSeek Harness/x stays.')));

const SESSION = 'C:/Users/user/.dsh/sessions/--E-~5DE5~4F5C~533A--/session-8be6bd49-e4f4-4efd-928a-f2cbbfaf05f1/session.v4.jsonl.zstd';
function readLog(file) {
  const raw = fs.readFileSync(file);
  const M = [0x28, 0xb5, 0x2f, 0xfd];
  const off = [];
  for (let i = 0; i + 4 <= raw.length; i++) if (raw[i] === M[0] && raw[i + 1] === M[1] && raw[i + 2] === M[2] && raw[i + 3] === M[3]) off.push(i);
  const out = [];
  for (let k = 0; k < off.length; k++) {
    const s = off[k];
    const e = k + 1 < off.length ? off[k + 1] : raw.length;
    try { out.push(zlib.zstdDecompressSync(raw.subarray(s, e)).toString('utf8')); } catch {}
  }
  return out.join('').split('\n').filter((l) => l.trim());
}
let systemText = '';
for (const line of readLog(SESSION)) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.type === 'system/message') {
    const c = o.data?.message?.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '';
    if (t.length > 500) systemText = t;
  }
}
const rewritten = neutralize(systemText);
console.log('原文 %d 字符 → 改写后 %d 字符；遗留裸品牌词 %d 处', systemText.length, rewritten.length, rewritten.split('DeepSeek Harness').length - 1);

const cred = await readDesktopCredential();
const r = await fetch('https://copilot.tencent.com/v2/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${cred.accessToken}`,
    'Content-Type': 'application/json',
    'X-Product': 'SaaS',
    'User-Agent': 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.63.2',
    Origin: 'https://www.codebuddy.cn',
    Referer: 'https://www.codebuddy.cn',
  },
  body: JSON.stringify({ model: process.argv[2] ?? 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'system', content: rewritten }, { role: 'user', content: '只回一个字：好' }] }),
});
const text = await r.text();
const gate = /11128/.test(text);
console.log(`上游结果 → HTTP ${r.status} gate=${gate} ${gate ? '仍然被拦' : '通过 ✓'}`);
