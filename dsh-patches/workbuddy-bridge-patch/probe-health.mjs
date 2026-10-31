// 最小上游健康探针：只用一句话，验证凭据/账号/网关是否还能通。
// 不打印 token。用法：node probe-health.mjs [model]
import { readDesktopCredential } from './desktop-credential.mjs';

const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash';
const CN_CHAT_BASE = 'https://copilot.tencent.com';
const CN_BILLING_BASE = 'https://www.codebuddy.cn';
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const APP_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.63.2';

function regionOf(domain) {
  const d = String(domain ?? '').trim().toLowerCase();
  return d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai') ? 'global' : 'cn';
}
function base(cred) { return regionOf(cred.domain) === 'global' ? 'https://www.workbuddy.ai' : CN_CHAT_BASE; }
function originReferer(cred) { return regionOf(cred.domain) === 'global' ? 'https://www.workbuddy.ai' : CN_BILLING_BASE; }
function commonHeaders(cred) {
  const o = originReferer(cred);
  return { Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest', Origin: o, Referer: o + '/', 'User-Agent': CLIENT_UA };
}
function refreshHeaders(cred) {
  const h = { ...commonHeaders(cred), 'X-Refresh-Token': cred.refreshToken, 'X-Auth-Refresh-Source': 'workbuddy' };
  if (cred.uid) h['X-User-Id'] = cred.uid; else h['X-No-User-Id'] = '1';
  if (cred.enterpriseId) h['X-Enterprise-Id'] = cred.enterpriseId; else h['X-No-Enterprise-Id'] = '1';
  if (cred.domain) h['X-Domain'] = cred.domain; else h['X-No-Department-Info'] = '1';
  return h;
}
function chatHeaders(cred, ua) {
  const h = { ...commonHeaders(cred), 'User-Agent': ua, 'Content-Type': 'application/json', 'X-Product': 'SaaS', Authorization: 'Bearer ' + cred.accessToken };
  if (cred.uid) h['X-User-Id'] = cred.uid; else h['X-No-User-Id'] = '1';
  if (cred.enterpriseId) h['X-Enterprise-Id'] = cred.enterpriseId; else h['X-No-Enterprise-Id'] = '1';
  if (cred.domain) h['X-Domain'] = cred.domain; else h['X-No-Department-Info'] = '1';
  return h;
}

const cred = await readDesktopCredential();
console.log('credential ok: uid=%s domain=%s expiresAt=%s', cred.uid, JSON.stringify(cred.domain), new Date(cred.expiresAtMs).toISOString());

// 1) refresh
let accessToken = cred.accessToken;
const rr = await fetch(base(cred) + '/v2/plugin/auth/token/refresh', { method: 'POST', headers: refreshHeaders(cred) });
const rt = await rr.text();
console.log('refresh http=%d', rr.status, rt.slice(0, 300));
try {
  const j = JSON.parse(rt);
  const d = j.data ?? j;
  if (d && typeof d.accessToken === 'string' && d.accessToken) { accessToken = d.accessToken; console.log('refresh gave new token: yes'); }
} catch {}

// 2) minimal chat
const body = {
  model: MODEL,
  stream: true,
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'hi' },
  ],
};
const res = await fetch(base(cred) + '/v2/chat/completions', {
  method: 'POST',
  headers: chatHeaders({ ...cred, accessToken }, APP_UA),
  body: JSON.stringify(body),
});
console.log('chat http=%d', res.status);
if (!res.ok) {
  const txt = await res.text();
  console.log('body:', txt.slice(0, 900));
} else {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let last = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload && payload !== '[DONE]') { last = payload; }
      }
    }
  }
  console.log('last frame:', last.slice(0, 500));
}
