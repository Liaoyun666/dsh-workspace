// 验证：命中风控的品牌词出现在 user 角色消息里时是否也会 400（决定要不要放开角色限制）
import { readDesktopCredential } from './desktop-credential.mjs';

const cred = await readDesktopCredential();
const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash';

async function attempt(label, messages) {
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
    body: JSON.stringify({ model: MODEL, stream: true, messages }),
  });
  const text = await r.text();
  console.log(`${label.padEnd(44)} → HTTP ${r.status} gate=${/11128/.test(text)}`);
}

const sys = 'You are an AI agent.';
const sysClean = 'You are an AI agent.';
const sysDirty = 'You are an AI agent powered by DeepSeek Harness.';

await attempt('干净 system + 干净 user', [
  { role: 'system', content: sysClean },
  { role: 'user', content: '你好' },
]);
await attempt('脏 system（未改写）', [
  { role: 'system', content: sysDirty },
  { role: 'user', content: '你好' },
]);
await attempt('干净 system + 脏 user（含品牌词）', [
  { role: 'system', content: sysClean },
  { role: 'user', content: 'Current DeepSeek Harness implementation checkout: E:/ds/dsh/' },
]);
await attempt('干净 system + user 里品牌词已改写', [
  { role: 'system', content: sysClean },
  { role: 'user', content: 'Current the local agent runtime implementation checkout: E:/ds/dsh/' },
]);
await attempt('干净 system + 脏 tool 结果', [
  { role: 'system', content: sysClean },
  { role: 'user', content: '你好' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'path: DeepSeek Harness/dsh' },
]);
