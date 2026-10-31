// 复现失败请求：取指定会话里最后一个 workbuddy request/header（含 tools）+ 该轮消息，按桥接的改写规则处理后打真实上游
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
  for (const sd of fs.readdirSync(wsp)) {
    if (!sd.startsWith(SID)) continue;
    const f = `${wsp}/${sd}/session.v4.jsonl.zstd`;
    if (fs.existsSync(f)) target = f;
  }
}
if (!target) throw new Error('session not found: ' + SID);
const recs = readLog(target).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log('records:', recs.length, recs.map((r) => r.type).join(','));

const hdr = [...recs].reverse().find((r) => r.type === 'request/header');
const header = hdr?.data?.header;
console.log('header config:', JSON.stringify(header?.config), 'tools:', header?.tools?.length);

// 收集该轮的消息：system + 用户消息（失败轮没有 assistant 回复）
const sysMsg = recs.filter((r) => r.type === 'system/message').pop();
const sysText = sysMsg?.data?.message?.content;
const users = recs.filter((r) => r.type === 'user/message').map((r) => r.data?.content ?? r.data?.message?.content);
const userText = Array.isArray(users[users.length - 1]) ? users[users.length - 1].map((p) => p?.text ?? '').join('') : String(users[users.length - 1]);
console.log('system 长度:', (typeof sysText === 'string' ? sysText : JSON.stringify(sysText)).length, '| user:', JSON.stringify(userText).slice(0, 80));

const LIB = 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-workbuddy-bridge/lib';
const chunkFile = fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).find((f) => fs.readFileSync(`${LIB}/${f}`, 'utf8').includes('CHANNEL_SIGNATURE_PHRASE ='));
const src = fs.readFileSync(`${LIB}/${chunkFile}`, 'utf8');
const regexFrom = (line) => { const s = line.trim().replace(/\r$/, ''); const open = s.indexOf('/'); const close = s.lastIndexOf('/'); const flags = (s.slice(close + 1).match(/^[dgimsuvy]+/) ?? [''])[0]; return new RegExp(s.slice(open + 1, close), flags); };
const lineWith = (n) => { const i = src.indexOf(n); return src.slice(i, src.indexOf('\n', i)); };
const OPENER = regexFrom(lineWith('const CHANNEL_OPENER ='));
const PHRASE = regexFrom(lineWith('const CHANNEL_SIGNATURE_PHRASE ='));
const NEUTRAL = src.includes('"the local agent runtime"') ? 'the local agent runtime' : null;
const neutralize = (t) => t.replace(OPENER, '$1You are an AI agent.').replace(PHRASE, NEUTRAL ?? 'the local agent runtime');

const cred = await readDesktopCredential();
async function post(body, label) {
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
    body: JSON.stringify({ ...body, stream: true }),
  });
  const text = await r.text();
  const gate = /11128/.test(text);
  const other = /1110[0-9]|111[0-9]{2}/.exec(text)?.[0] ?? '';
  console.log(`[${label}] HTTP ${r.status} gate11128=${gate} ${other ? 'code=' + other : ''} ${gate ? '' : text.slice(0, 120).replace(/\n/g, ' ')}`);
  return { status: r.status, gate, text };
}

const model = header?.config?.model ?? 'kimi-k3.1-pro';
const messages = [
  { role: 'system', content: neutralize(typeof sysText === 'string' ? sysText : JSON.stringify(sysText)) },
  { role: 'user', content: userText },
];
console.log('model:', model);

await post({ model, messages }, '完整system+user, 无tools');
await post({ model, messages, tools: header?.tools, tool_choice: 'auto' }, '叠加真实83个tools');
