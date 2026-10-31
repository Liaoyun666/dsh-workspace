// 测试 tool 结果 / assistant 历史里的品牌词是否触发 11128
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

const toolDef = { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };
const baseMsgs = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'what is in the file?' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
];

const cases = [
  ['tool-result-brand', [
    ...baseMsgs,
    { role: 'tool', tool_call_id: 'call_1', content: 'The file says: powered by DeepSeek Harness. Nothing else.' },
  ]],
  ['tool-result-path-brand', [
    ...baseMsgs,
    { role: 'tool', tool_call_id: 'call_1', content: 'dir: E:\\DeepSeek Harness\\resources\\app.asar' },
  ]],
  ['assistant-brand(raw)', [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'assistant', content: 'Earlier you said this ran on DeepSeek Harness.' },
    { role: 'user', content: 'ok' },
  ]],
  ['assistant-brand(path-guard)', [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'assistant', content: 'doc lives at E:\\DeepSeek Harness\\docs\\a.md' },
    { role: 'user', content: 'ok' },
  ]],
];

for (const [label, messages] of cases) {
  const body = { model: MODEL, stream: true, max_tokens: 4, messages, tools: [toolDef] };
  const res = await fetch(base(cred) + '/v2/chat/completions', { method: 'POST', headers: chatHeaders(cred, APP_UA), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = (await res.text()).replace(/\s+/g, ' ');
    console.log('%s → http=%d %s', label.padEnd(26), res.status, txt.slice(0, 200));
  } else {
    try { await res.body.cancel(); } catch {}
    console.log('%s → http=200 ok', label.padEnd(26));
  }
  await new Promise((r) => setTimeout(r, 700));
}
