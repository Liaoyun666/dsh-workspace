// 二分定位系统提示词里到底哪一段触发了 11128 风控（stream:true，真实上游）
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
let calls = 0;

async function blocked(sys) {
  calls += 1;
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
  return /11128/.test(text);
}

const lines = systemText.split('\n');
console.log('lines: %d , full blocked = %s', lines.length, await blocked(systemText));

// 行区间二分：寻找最小的、单独也会触发的连续行区间
let lo = 0;
let hi = lines.length;
let best = null;
while (hi - lo > 2) {
  const mid = Math.floor((lo + hi) / 2);
  const head = lines.slice(lo, mid).join('\n');
  if (head.trim() && (await blocked(head))) {
    hi = mid;
    best = { lo, hi };
    console.log(`  head[${lo}:${mid}] (${head.length} chars) → BLOCKED`);
    continue;
  }
  const tail = lines.slice(mid, hi).join('\n');
  if (tail.trim() && (await blocked(tail))) {
    lo = mid;
    best = { lo, hi };
    console.log(`  tail[${mid}:${hi}] (${tail.length} chars) → BLOCKED`);
    continue;
  }
  // 两半都不触发：需要组合，保守地缩到「去掉后半」那半（保持整段）
  break;
}
console.log('\nbisect window: lines[%d:%d]  calls=%d', lo, hi, calls);
const seg = lines.slice(lo, hi).join('\n');
console.log('--- 段内容 (%d chars) ---\n%s\n---', seg.length, seg.slice(0, 2000));
