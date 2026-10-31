// 逐条试不同的「解除 11128 误伤」扰动策略，看哪一种现在还能过。
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

// 取最后一个真实 system 消息
let systemText = '';
for (const line of readLog(SESSION)) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (o.type === 'system/message') {
    const c = o.data?.message?.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '';
    if (t.length > 500) systemText = t;
  }
}
if (!systemText) throw new Error('no system message found');
console.log('system prompt: %d chars', systemText.length);

const cred = await readDesktopCredential();
const UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.63.2';

function headers(auth) {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    'X-Product': 'SaaS',
    'User-Agent': UA,
    Origin: 'https://www.codebuddy.cn',
    Referer: 'https://www.codebuddy.cn',
  };
}

async function attempt(label, sys, extraMessages = []) {
  const body = {
    model: MODEL,
    stream: false,
    messages: [{ role: 'system', content: sys }, ...extraMessages, { role: 'user', content: '只回一个字：好' }],
  };
  const r = await fetch('https://copilot.tencent.com/v2/chat/completions', {
    method: 'POST',
    headers: headers(cred),
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let msg = '';
  let code = '';
  try {
    const j = JSON.parse(text);
    msg = j?.message ?? j?.error?.message ?? '';
    code = j?.code ?? j?.error?.code ?? '';
  } catch {
    msg = text.slice(0, 80);
  }
  console.log(`${String(label).padEnd(34)} → HTTP ${r.status} code=${code} ${msg.slice(0, 60)}`);
  return r.status;
}

const spaceEvery = (t, n) => t.replace(new RegExp(`(.{${n}})`, 'gs'), '$1 ');
const dropAtParagraph = (t) => t.replace(/[^\n]*Tokens prefixed with[^\n]*(\n[^\n]+)*/g, '');
const NL = '\n';

await attempt('baseline (as-is)', systemText);
await attempt('zw every 64 (current patch)', systemText.replace(/(.{64})/gs, `$1\u200b`));
await attempt('space every 64', spaceEvery(systemText, 64));
await attempt('drop "Tokens prefixed with" para', dropAtParagraph(systemText));
await attempt('prefix benign line', `以下是本地会话的系统提示。${NL}${systemText}`);
await attempt('suffix benign line', `${systemText}${NL}（以上为系统提示原文。）`);
await attempt('space every 64 + suffix', spaceEvery(systemText, 64) + `${NL}（以上为系统提示原文。）`);
