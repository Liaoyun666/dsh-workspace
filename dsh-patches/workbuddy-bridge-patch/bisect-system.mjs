// 对一个会触发 11128 的 system 文本做行级 delta-debugging，找出最小触发片段
import fs from 'node:fs';
import zlib from 'node:zlib';
import { readDesktopCredential } from './desktop-credential.mjs';

const M = [0x28, 0xb5, 0x2f, 0xfd];
const SID = process.argv[2] ?? 'session-4663a9de-794';
const MODEL = process.argv[3] ?? 'kimi-k3.1-pro';
const ROOT = 'C:/Users/user/.dsh/sessions';

function readLog(file) {
  const raw = fs.readFileSync(file);
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

let target = null;
for (const ws of fs.readdirSync(ROOT)) {
  const wsp = `${ROOT}/${ws}`;
  if (!fs.statSync(wsp).isDirectory()) continue;
  for (const sd of fs.readdirSync(wsp)) if (sd.startsWith(SID)) { const f = `${wsp}/${sd}/session.v4.jsonl.zstd`; if (fs.existsSync(f)) target = f; }
}
if (!target) throw new Error('session not found');
const recs = readLog(target).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const sysRec = recs.filter((r) => r.type === 'system/message').pop();
let sysText = sysRec.data.message.content;
if (typeof sysText !== 'string') sysText = sysText.map((p) => p?.text ?? '').join('');

const LIB = 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-workbuddy-bridge/lib';
const chunkFile = fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).find((f) => fs.readFileSync(`${LIB}/${f}`, 'utf8').includes('CHANNEL_SIGNATURE_PHRASE ='));
const src = fs.readFileSync(`${LIB}/${chunkFile}`, 'utf8');
const regexFrom = (line) => { const s = line.trim().replace(/\r$/, ''); const open = s.indexOf('/'); const close = s.lastIndexOf('/'); const flags = (s.slice(close + 1).match(/^[dgimsuvy]+/) ?? [''])[0]; return new RegExp(s.slice(open + 1, close), flags); };
const lineWith = (n) => { const i = src.indexOf(n); return src.slice(i, src.indexOf('\n', i)); };
const OPENER = regexFrom(lineWith('const CHANNEL_OPENER ='));
const PHRASE = regexFrom(lineWith('const CHANNEL_SIGNATURE_PHRASE ='));
const neutralize = (t) => t.replace(OPENER, '$1You are an AI agent.').replace(PHRASE, 'the local agent runtime');

const cred = await readDesktopCredential();
let calls = 0;
async function triggers(text) {
  calls++;
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
    body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'system', content: text }, { role: 'user', content: '只回一个字：好' }] }),
  });
  const t = await r.text();
  return { gate: /11128/.test(t), status: r.status };
}

const neutral = neutralize(sysText);
console.log('原始 %d 字符 → 中性化 %d；裸品牌词剩余 %d', sysText.length, neutral.length, neutral.split('DeepSeek Harness').length - 1);
const base = await triggers(neutral);
console.log('baseline:', JSON.stringify(base));
if (!base.gate) { console.log('基线没触发，说明触发物在其他位置（tools/history）'); process.exit(0); }

// 行级 ddmin：从行集合里尽量删除，保留仍能触发的子集
let lines = neutral.split('\n');
let n = 2;
while (lines.length >= 2) {
  const chunkSize = Math.ceil(lines.length / n);
  let reduced = false;
  for (let i = 0; i < lines.length; i += chunkSize) {
    const candidate = [...lines.slice(0, i), ...lines.slice(i + chunkSize)];
    if (candidate.length === 0) continue;
    const r = await triggers(candidate.join('\n'));
    if (r.gate) { lines = candidate; n = Math.max(n - 1, 2); reduced = true; break; }
  }
  if (!reduced) { if (n >= lines.length) break; n = Math.min(n * 2, lines.length); }
}
console.log('\n最小触发集（%d 行，调用 %d 次）:', lines.length, calls);
lines.forEach((l) => console.log('  |', JSON.stringify(l)));
