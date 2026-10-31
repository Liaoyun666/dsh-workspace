// 端到端验证 patch_channel_gate_retry.py 的扰动重试逻辑（用真实上游 + 真实系统提示词）
import fs from 'node:fs';
import zlib from 'node:zlib';
import { readDesktopCredential } from './desktop-credential.mjs';

const HOST = 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-workbuddy-bridge/lib/index.js';
const SESSION = 'C:/Users/user/.dsh/sessions/--E-~5DE5~4F5C~533A--/session-8be6bd49-e4f4-4efd-928a-f2cbbfaf05f1/session.v4.jsonl.zstd';
const CN_CHAT_BASE = 'https://copilot.tencent.com';
const CN_BILLING_BASE = 'https://www.codebuddy.cn';
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const APP_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.63.2';
const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash';

// 从已打补丁的 host 里切出真实的 helper 源码，保证测的就是补丁本身
const hostSrc = fs.readFileSync(HOST, 'utf8');
const start = hostSrc.indexOf('let channelGateGuard');
const end = hostSrc.indexOf('/**\n* Start the loopback endpoint.');
if (start < 0 || end < 0 || end <= start) throw new Error('helpers not found in patched bundle');
const helperSrc = hostSrc.slice(start, end);
const api = new Function(helperSrc + '\nreturn { perturbChannelGateBody, channelGateRejected, perturbGateText };')();
console.log('helpers extracted: %d chars', helperSrc.length);

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
const systems = [];
for (const line of readLog(SESSION)) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (o.type !== 'system/message') continue;
  const c = o.data?.message?.content;
  systems.push(Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : String(c));
}
const RAW_SYSTEM = systems[systems.length - 1];

const regionOf = (d) => {
  const s = String(d ?? '').trim().toLowerCase();
  return s === 'workbuddy.ai' || s.endsWith('.workbuddy.ai') ? 'global' : 'cn';
};
const base = (c) => (regionOf(c.domain) === 'global' ? 'https://www.workbuddy.ai' : CN_CHAT_BASE);
const origin = (c) => (regionOf(c.domain) === 'global' ? 'https://www.workbuddy.ai' : CN_BILLING_BASE);
const common = (c) => {
  const o = origin(c);
  return { Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest', Origin: o, Referer: o + '/', 'User-Agent': CLIENT_UA };
};
const chatHeaders = (c, ua) => {
  const h = { ...common(c), 'User-Agent': ua, 'Content-Type': 'application/json', 'X-Product': 'SaaS', Authorization: 'Bearer ' + c.accessToken };
  h[c.uid ? 'X-User-Id' : 'X-No-User-Id'] = c.uid || '1';
  h[c.enterpriseId ? 'X-Enterprise-Id' : 'X-No-Enterprise-Id'] = c.enterpriseId || '1';
  h[c.domain ? 'X-Domain' : 'X-No-Department-Info'] = c.domain || '1';
  return h;
};
const cred = await readDesktopCredential();
const rr = await fetch(base(cred) + '/v2/plugin/auth/token/refresh', {
  method: 'POST',
  headers: { ...common(cred), 'X-Refresh-Token': cred.refreshToken, 'X-Auth-Refresh-Source': 'workbuddy', 'X-User-Id': cred.uid, 'X-No-Enterprise-Id': '1', 'X-Domain': cred.domain },
});
const rj = JSON.parse(await rr.text());
cred.accessToken = rj?.data?.accessToken ?? cred.accessToken;

// 模拟 DSH 发来的请求体（未做任何中性化的最坏情况）
const prepared = JSON.stringify({ model: MODEL, stream: true, max_tokens: 4, messages: [{ role: 'system', content: RAW_SYSTEM }, { role: 'user', content: '你好' }] });

async function send(label, bodyText) {
  const res = await fetch(base(cred) + '/v2/chat/completions', { method: 'POST', headers: chatHeaders(cred, APP_UA), body: bodyText });
  let out;
  if (res.ok) { try { await res.body.cancel(); } catch {} out = 'OK 200'; }
  else {
    const txt = await res.text();
    let code = '';
    try { code = String(JSON.parse(txt).code); } catch {}
    out = 'BLOCKED code=' + code;
  }
  console.log('%s → %s', label.padEnd(30), out);
  await new Promise((x) => setTimeout(x, 400));
  return out.includes('OK');
}

const first = await send('attempt 1 (as DSH sends)', prepared);
const result = { ok: first, status: first ? 200 : 400, kind: first ? '' : 'client', message: first ? '' : '请求被拦截，请重新发送' };
console.log('channelGateRejected(result) =', api.channelGateRejected(result));
if (!first) {
  const nudged = api.perturbChannelGateBody(prepared);
  console.log('nudged body len %d -> %d, has ZW=%s', prepared.length, nudged.length, nudged.includes('\u200b'));
  const second = await send('attempt 2 (nudged retry)', nudged);
  console.log(second ? 'RESULT: retry recovered the request' : 'RESULT: retry did NOT help');
}
