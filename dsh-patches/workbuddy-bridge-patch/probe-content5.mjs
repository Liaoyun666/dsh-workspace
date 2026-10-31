// 精确定位触发条件：system 角色内品牌词的位置/形态
import { readDesktopCredential } from './desktop-credential.mjs';

const CN_CHAT_BASE = 'https://copilot.tencent.com';
const CN_BILLING_BASE = 'https://www.codebuddy.cn';
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const APP_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.63.2';
const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash';

const regionOf = (d) => {
  const s = String(d ?? '').trim().toLowerCase();
  return s === 'workbuddy.ai' || s.endsWith('.workbuddy.ai') ? 'global' : 'cn';
};
const base = (c) => (regionOf(c.domain) === 'global' ? 'https://www.workbuddy.ai' : CN_CHAT_BASE);
const origin = (c) => (regionOf(c.domain) === 'global' ? 'https://www.workbuddy.ai' : CN_BILLING_BASE);
function common(c) {
  const o = origin(c);
  return { Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest', Origin: o, Referer: o + '/', 'User-Agent': CLIENT_UA };
}
function chatHeaders(c, ua) {
  const h = { ...common(c), 'User-Agent': ua, 'Content-Type': 'application/json', 'X-Product': 'SaaS', Authorization: 'Bearer ' + c.accessToken };
  h[c.uid ? 'X-User-Id' : 'X-No-User-Id'] = c.uid || '1';
  h[c.enterpriseId ? 'X-Enterprise-Id' : 'X-No-Enterprise-Id'] = c.enterpriseId || '1';
  h[c.domain ? 'X-Domain' : 'X-No-Department-Info'] = c.domain || '1';
  return h;
}

const cred = await readDesktopCredential();
const rr = await fetch(base(cred) + '/v2/plugin/auth/token/refresh', {
  method: 'POST',
  headers: { ...common(cred), 'X-Refresh-Token': cred.refreshToken, 'X-Auth-Refresh-Source': 'workbuddy', 'X-User-Id': cred.uid, 'X-No-Enterprise-Id': '1', 'X-Domain': cred.domain },
});
const rj = JSON.parse(await rr.text());
cred.accessToken = rj?.data?.accessToken ?? cred.accessToken;

const cases = [
  ['sys-bare-mid', 'You are a helpful assistant.\nThis product is DeepSeek Harness.'],
  ['sys-opener-only', 'You are an AI agent powered by DeepSeek Harness.'],
  ['sys-opener-extra', 'You are an AI agent powered by DeepSeek Harness.\n\n# role\nBe nice.'],
  ['sys-opener-array', ['You are an AI agent powered by DeepSeek Harness.', 'More text.']],
  ['sys-path-guard', 'project at E:\\DeepSeek Harness\\docs\\a.md'],
  ['sys-case-lower', 'you are an ai agent powered by deepseek harness.'],
];

for (const [label, content] of cases) {
  const msg = Array.isArray(content)
    ? { role: 'system', content: content.map((t) => ({ type: 'text', text: t })) }
    : { role: 'system', content };
  const body = { model: MODEL, stream: true, max_tokens: 4, messages: [msg, { role: 'user', content: 'hi' }] };
  const res = await fetch(base(cred) + '/v2/chat/completions', { method: 'POST', headers: chatHeaders(cred, APP_UA), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = (await res.text()).replace(/\s+/g, ' ');
    let code = '';
    try { code = String(JSON.parse(txt).code); } catch {}
    console.log('%s → http=%d code=%s', label.padEnd(20), res.status, code);
  } else {
    try { await res.body.cancel(); } catch {}
    console.log('%s → http=200 ok', label.padEnd(20));
  }
  await new Promise((r) => setTimeout(r, 700));
}
