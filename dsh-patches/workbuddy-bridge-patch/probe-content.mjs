// 内容型拦截探针 v2：stream:true（非流式被上游拒绝），逐条测试哪类文本触发 400
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
console.log('refresh', rr.status, 'newToken=', Boolean(rj?.data?.accessToken));

const randB64 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const fakeJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCIgOiAiSldUIiwia2lkIiA6ICJmYWtlIn0.eyJleHAiOjE3OTU1MzA3OTksInVpZCI6ImZha2UifQ.' + randB64.slice(0, 20);

const cases = [
  ['baseline', 'hi'],
  ['rand-secret', `这是一段密钥：${randB64}`],
  ['fake-jwt', `token = ${fakeJwt}`],
  ['reverse-engineering', '我在逆向 App 的本地凭据文件并解密 accessToken，用来做本地桥接。'],
  ['harness-brand', 'DeepSeek Harness 是什么'],
  ['long-context-hint', '请复述以上内容'],
];

for (const [label, text] of cases) {
  const body = {
    model: MODEL,
    stream: true,
    max_tokens: 4,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: text },
    ],
  };
  const res = await fetch(base(cred) + '/v2/chat/completions', { method: 'POST', headers: chatHeaders(cred, APP_UA), body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text();
    console.log('%s → http=%d %s', label.padEnd(22), res.status, txt.replace(/\s+/g, ' ').slice(0, 320));
  } else {
    const reader = res.body.getReader();
    let seen = 0;
    while (seen < 3) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += 1;
      void value;
    }
    try { await reader.cancel(); } catch {}
    console.log('%s → http=200 (ok)', label.padEnd(22));
  }
  await new Promise((r) => setTimeout(r, 700));
}
