// 验证「把 system 内容搬到 user 里」能否绕过 11128（用真实失败会话的系统提示词，原文不改写）
import fs from 'node:fs';
import zlib from 'node:zlib';
import { readDesktopCredential } from './desktop-credential.mjs';

const M = [0x28, 0xb5, 0x2f, 0xfd];
const SID = process.argv[2] ?? 'session-4663a9de-794';
const ROOT = 'C:/Users/user/.dsh/sessions';

function readLog(file) {
  const raw = fs.readFileSync(file);
  const off = [];
  for (let i = 0; i + 4 <= raw.length; i++) if (raw[i] === M[0] && raw[i + 1] === M[1] && raw[i + 2] === M[2] && raw[i + 3] === M[3]) off.push(i);
  const out = [];
  for (let k = 0; k < off.length; k++) { const s = off[k]; const e = k + 1 < off.length ? off[k + 1] : raw.length; try { out.push(zlib.zstdDecompressSync(raw.subarray(s, e)).toString('utf8')); } catch {} }
  return out.join('').split('\n').filter((l) => l.trim());
}
let target = null;
for (const ws of fs.readdirSync(ROOT)) {
  const wsp = `${ROOT}/${ws}`;
  if (!fs.statSync(wsp).isDirectory()) continue;
  for (const sd of fs.readdirSync(wsp)) if (sd.startsWith(SID)) { const f = `${wsp}/${sd}/session.v4.jsonl.zstd`; if (fs.existsSync(f)) target = f; }
}
const recs = readLog(target).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
let sysText = recs.filter((r) => r.type === 'system/message').pop().data.message.content;
if (typeof sysText !== 'string') sysText = sysText.map((p) => p?.text ?? '').join('');

const cred = await readDesktopCredential();
async function post(model, messages, label) {
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
    body: JSON.stringify({ model, stream: true, messages }),
  });
  const t = await r.text();
  const gate = /11128/.test(t);
  console.log(`  ${gate ? '✗ 400/11128' : r.status === 200 ? '✓ 200' : '? ' + r.status}  [${label}]`);
  return !gate && r.status === 200;
}

const ask = { role: 'user', content: '只回一个字：好' };
for (const model of ['kimi-k3.1-pro', 'deepseek-v4.1-flash']) {
  console.log(`\n=== ${model}`);
  await post(model, [{ role: 'system', content: sysText }, ask], 'A 原样 system（预期 400）');
  await post(model, [{ role: 'user', content: sysText }, ask], 'B system 文本搬进 user，无 system');
  await post(model, [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: sysText }, ask], 'C 小 system + 搬进 user');
}
