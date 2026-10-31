// 打印上游 baseline 请求的完整响应体，看清 11101 到底是什么
import fs from 'node:fs';
import zlib from 'node:zlib';
import { readDesktopCredential } from './desktop-credential.mjs';

const SESSION = 'C:/Users/user/.dsh/sessions/--E-~5DE5~4F5C~533A--/session-8be6bd49-e4f4-4efd-928a-f2cbbfaf05f1/session.v4.jsonl.zstd';
const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash';

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

async function show(label, body, extraHeaders = {}) {
  const r = await fetch('https://copilot.tencent.com/v2/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cred.accessToken}`,
      'Content-Type': 'application/json',
      'X-Product': 'SaaS',
      'User-Agent': 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.63.2',
      Origin: 'https://www.codebuddy.cn',
      Referer: 'https://www.codebuddy.cn',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log(`\n### ${label} → HTTP ${r.status}`);
  console.log(text.slice(0, 600));
}

const user = [{ role: 'user', content: '只回一个字：好' }];
await show('短提示词 + 长 system', { model: MODEL, stream: false, messages: [{ role: 'system', content: systemText }, ...user] });
await show('只有 user', { model: MODEL, stream: false, messages: user });
await show('短 system', { model: MODEL, stream: false, messages: [{ role: 'system', content: '你是助手。' }, ...user] });
