// 触发条件矩阵：哪一角色的消息「以开篇句开头」会被拦截
import { readDesktopCredential } from './desktop-credential.mjs';

const CN_CHAT_BASE = 'https://copilot.tencent.com';
const CN_BILLING_BASE = 'https://www.codebuddy.cn';
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const APP_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.63.2';
const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash';
const OPENER = 'You are an AI agent powered by DeepSeek Harness.';

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

const toolDef = { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {}, required: [] } } };

const cases = [
  ['user-starts-opener', [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: OPENER + '\n\nhi there' },
  ]],
  ['user-only-no-system', [
    { role: 'user', content: OPENER + '\n\nhi there' },
  ]],
  ['assistant-starts-opener', [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'assistant', content: OPENER + '\n\nearlier reply' },
    { role: 'user', content: 'ok' },
  ]],
  ['tool-starts-opener', [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: OPENER + '\nfile content' },
  ]],
  ['sys-opener-leading-newlines', [
    { role: 'system', content: '\n\n  ' + OPENER + '\n\n# role\nbe nice' },
    { role: 'user', content: 'hi' },
  ]],
];

for (const [label, messages] of cases) {
  const body = { model: MODEL, stream: true, max_tokens: 4, messages, tools: [toolDef] };
  const res = await fetch(base(cred) + '/v2/chat/completions', { method: 'POST', headers: chatHeaders(cred, APP_UA), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = (await res.text()).replace(/\s+/g, ' ');
    let code = '';
    try { code = String(JSON.parse(txt).code); } catch {}
    console.log('%s → http=%d code=%s', label.padEnd(28), res.status, code);
  } else {
    try { await res.body.cancel(); } catch {}
    console.log('%s → http=200 ok', label.padEnd(28));
  }
  await new Promise((r) => setTimeout(r, 700));
}
