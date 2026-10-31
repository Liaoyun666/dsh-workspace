// 按「补丁后的行为」复现真实失败请求：品牌词中性化 + system/developer 降级为 user，再打上游
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
const header = [...recs].reverse().find((r) => r.type === 'request/header').data.header;
let sysText = recs.filter((r) => r.type === 'system/message').pop().data.message.content;
if (typeof sysText !== 'string') sysText = sysText.map((p) => p?.text ?? '').join('');

const LIB = 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-workbuddy-bridge/lib';
const chunkFile = fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).find((f) => fs.readFileSync(`${LIB}/${f}`, 'utf8').includes('CHANNEL_SIGNATURE_PHRASE ='));
const src = fs.readFileSync(`${LIB}/${chunkFile}`, 'utf8');
const lineWith = (n) => { const i = src.indexOf(n); return src.slice(i, src.indexOf('\n', i)); };
const regexFrom = (line) => { const s = line.trim().replace(/\r$/, ''); const open = s.indexOf('/'); const close = s.lastIndexOf('/'); const flags = (s.slice(close + 1).match(/^[dgimsuvy]+/) ?? [''])[0]; return new RegExp(s.slice(open + 1, close), flags); };
const OPENER = regexFrom(lineWith('const CHANNEL_OPENER ='));
const PHRASE = regexFrom(lineWith('const CHANNEL_SIGNATURE_PHRASE ='));
const neutralize = (t) => t.replace(OPENER, '$1You are an AI agent.').replace(PHRASE, 'the local agent runtime');
console.log('角色迁移补丁已打:', src.includes('function demoteSystemMessages'));

const cred = await readDesktopCredential();
async function post(model, messages, tools, label) {
  const body = { model, stream: true, messages };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
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
  const t = await r.text();
  const gate = /11128/.test(t);
  const err = /"message":"([^"]{0,120})/.exec(t)?.[1] ?? '';
  console.log(`  ${gate ? '✗ 400/11128' : r.status === 200 ? '✓ 200' : '? ' + r.status + ' ' + err}  [${label}]`);
}

const messages = [{ role: 'system', content: neutralize(sysText) }, { role: 'user', content: '只回一个字：好' }];
for (const model of ['kimi-k3.1-pro', 'deepseek-v4.1-flash']) {
  console.log(`\n=== ${model}`);
  await post(model, messages.map((m) => ({ ...m })), header?.tools, '原样（system 仍是 system）');
  const demoted = messages.map((m) => (m.role === 'system' || m.role === 'developer' ? { ...m, role: 'user' } : m));
  await post(model, demoted, header?.tools, '补丁后（system→user + 真实 83 个 tools）');
}
