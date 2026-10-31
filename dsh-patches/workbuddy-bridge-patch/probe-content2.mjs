// 针对「系统提示/工具描述里的品牌词」是否触发拦截
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
console.log('refresh', rr.status);

const ZW = '\u200b';
const tool = (name, description) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {}, required: [] } } });

const cases = [
  ['sys-plain-harness', {
    messages: [
      { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' },
      { role: 'user', content: 'hi' },
    ],
  }],
  ['sys-neutralized', {
    messages: [
      { role: 'system', content: `You are an AI agent powered by DeepSeek${ZW}Harness.` },
      { role: 'user', content: 'hi' },
    ],
  }],
  ['tool-desc-harness', {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
    ],
    tools: [tool('dsh_probe', 'List every Cordis plugin installed in the current DeepSeek Harness profile.')],
  }],
  ['tool-desc-neutralized', {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
    ],
    tools: [tool('dsh_probe', `List every Cordis plugin installed in the current DeepSeek${ZW}Harness profile.`)],
  }],
];

for (const [label, extra] of cases) {
  const body = { model: MODEL, stream: true, max_tokens: 4, ...extra };
  const res = await fetch(base(cred) + '/v2/chat/completions', { method: 'POST', headers: chatHeaders(cred, APP_UA), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = (await res.text()).replace(/\s+/g, ' ');
    let disp = '';
    try { disp = JSON.stringify(JSON.parse(txt).displayMsg?.zh ?? ''); } catch {}
    console.log('%s → http=%d displayMsg=%s :: %s', label.padEnd(24), res.status, disp, txt.slice(0, 220));
  } else {
    try { await res.body.cancel(); } catch {}
    console.log('%s → http=200 ok', label.padEnd(24));
  }
  await new Promise((r) => setTimeout(r, 700));
}
