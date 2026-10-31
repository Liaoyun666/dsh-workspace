// 字符级 ddmin：从一段已知触发 11128 的文本里缩出最小触发子串
import { readDesktopCredential } from './desktop-credential.mjs';

const cred = await readDesktopCredential();
const MODEL = process.argv[3] ?? 'kimi-k3.1-pro';
const START = process.argv[2] ?? 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.';

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
  return /11128/.test(t);
}

if (!(await triggers(START))) { console.log('起始文本不触发，换个输入'); process.exit(0); }

// ddmin：先按词删，再按字符删
function splitUnits(s, mode) {
  return mode === 'word' ? s.split(/(?<=\s)/) : [...s];
}
let mode = 'word';
let units = splitUnits(START, mode);
let n = 2;
while (true) {
  if (units.length < 2) break;
  const chunkSize = Math.max(1, Math.ceil(units.length / n));
  let reduced = false;
  for (let i = 0; i < units.length; i += chunkSize) {
    const cand = [...units.slice(0, i), ...units.slice(i + chunkSize)];
    const text = cand.join('');
    if (!text.trim()) continue;
    if (await triggers(text)) { units = cand; n = Math.max(2, n - 1); reduced = true; break; }
  }
  if (!reduced) {
    if (n >= units.length) {
      if (mode === 'word') { mode = 'char'; units = splitUnits(units.join(''), mode); n = 2; continue; }
      break;
    }
    n = Math.min(n * 2, units.length);
  }
}
console.log('最小触发子串（%d 字符，%d 次请求）:', units.join('').length, calls);
console.log(JSON.stringify(units.join('')));
