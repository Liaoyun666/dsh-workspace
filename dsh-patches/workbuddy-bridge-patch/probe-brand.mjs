// 验证「改写品牌词」能否解除 11128：对真实系统提示词做几种最小改写
import fs from 'node:fs';
import zlib from 'node:zlib';
import { readDesktopCredential } from './desktop-credential.mjs';

const SESSION = process.argv[2] ?? 'C:/Users/user/.dsh/sessions/--E-~5DE5~4F5C~533A--/session-8be6bd49-e4f4-4efd-928a-f2cbbfaf05f1/session.v4.jsonl.zstd';
const MODEL = process.argv[3] ?? 'deepseek-v4.1-flash';

function readLog(file) {
  const raw = fs.readFileSync(file);
  const M = [0x28, 0xb5, 0x2f, 0xfd];
  const off = [];
  for (let i = 0; i + 4 <= raw.length; i++) if (raw[i] === M[0] && raw[i + 1] === M[1] && raw[i + 2] === M[2] && raw[i + 3] === M[3]) off.push(i);
  const parts = [];
  for (let k = 0; k < off.length; k++) {
    const s = off[k];
    const e = k + 1 < off.length ? off[k + 1] : raw.length;
    try { parts.push(zlib.zstdDecompressSync(raw.subarray(s, e)).toString('utf8')); } catch {}
  }
  return parts.join('').split('\n').filter((l) => l.trim());
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
const cred = await readDesktopCredential();

console.log('occurrences of "DeepSeek Harness": %d', systemText.split('DeepSeek Harness').length - 1);
console.log('occurrences of "DeepSeek": %d', systemText.split('DeepSeek').length - 1);

async function attempt(label, sys) {
  const body = { model: MODEL, stream: true, messages: [{ role: 'system', content: sys }, { role: 'user', content: '好' }] };
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
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log(`${label.padEnd(46)} → HTTP ${r.status} gate=${/11128/.test(text)}`);
}

const A = systemText.replaceAll('DeepSeek Harness', 'the local agent runtime');
const B = systemText.replaceAll('DeepSeek Harness', 'DSH');
const C = systemText.replaceAll('DeepSeek Harness', 'DeepSeek');
const D = systemText.split('\n').filter((l) => !l.includes('DeepSeek Harness')).join('\n');

await attempt('baseline', systemText);
await attempt('→ the local agent runtime (all)', A);
await attempt('→ DSH (all)', B);
await attempt('→ DeepSeek (all)', C);
await attempt('删掉含该词的行', D);
