// 端到端验证：直接 import 已经打过补丁的 chunk，用它的 prepareChatBody 处理真实失败请求，再打上游
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
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
const header = [...recs].reverse().find((r) => r.type === 'request/header')?.data?.header ?? {};
let sysText = recs.filter((r) => r.type === 'system/message').pop().data.message.content;
if (typeof sysText !== 'string') sysText = sysText.map((p) => p?.text ?? '').join('');
console.log('真实系统提示词长度:', sysText.length, '| header 键:', Object.keys(header).join(','));

const LIB = 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-workbuddy-bridge/lib';
const chunkFile = fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).find((f) => fs.readFileSync(`${LIB}/${f}`, 'utf8').includes('CHANNEL_SIGNATURE_PHRASE ='));
const src = fs.readFileSync(`${LIB}/${chunkFile}`, 'utf8');
console.log('chunk:', chunkFile, '| 有 demote 实现:', src.includes('function demoteSystemMessages'), '| 有 demote 调用:', src.includes('demoteSystemMessages(obj);'));
const mod = await import(pathToFileURL(`${LIB}/${chunkFile}`).href);
const prepareChatBody = mod.j ?? mod.prepareChatBody;
console.log('导入 prepareChatBody:', typeof prepareChatBody);

const cred = await readDesktopCredential();

async function run(model, withTools, label) {
  const rawBody = {
    model,
    stream: true,
    messages: [
      { role: 'system', content: sysText },
      { role: 'user', content: '只回一个字：好' },
    ],
  };
  if (withTools) {
    rawBody.tools = [
      { type: 'function', function: { name: 'read_file', description: 'Read a file from disk.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    ];
    rawBody.tool_choice = 'auto';
  }
  const prepared = prepareChatBody(JSON.stringify(rawBody)); // ← 走真实补丁代码
  const parsed = JSON.parse(prepared);
  const roles = parsed.messages.map((m) => m.role).join(',');
  const brandLeft = /DeepSeek Harness/.test(JSON.stringify(parsed));
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
    body: prepared,
  });
  const t = await r.text();
  const gate = /11128/.test(t);
  const err = /"message":"([^"]{0,100})/.exec(t)?.[1] ?? '';
  console.log(`  ${gate ? '✗ 11128' : r.status === 200 ? '✓ 200' : '? ' + r.status + ' ' + err}  [${label}] roles=${roles} 残留品牌词=${brandLeft}`);
}

for (const model of ['kimi-k3.1-pro', 'deepseek-v4.1-flash']) {
  console.log(`\n=== ${model}`);
  await run(model, false, 'prepareChatBody 后（无 tools）');
  await run(model, true, 'prepareChatBody 后（带 tools）');
}
