// 触发条件矩阵：不同 system 文本 × 不同模型，看 11128 何时出现
import { readDesktopCredential } from './desktop-credential.mjs';

const cred = await readDesktopCredential();
const LINE = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.';

const cases = {
  '官方开篇句（原样）': 'You are an AI agent powered by DeepSeek Harness.',
  '官方开篇句（中性化）': 'You are an AI agent.',
  '那句 @ 路径说明': LINE,
  '两句都是官方（开篇+@）': 'You are an AI agent powered by DeepSeek Harness.\n\n' + LINE,
  '极短中文': '你是助手。',
  '中等日常英文': 'You are a helpful assistant. Answer concisely and accurately.',
};

async function post(model, system, user) {
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
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  const t = await r.text();
  const code = /"code":"?'?(\d+)/.exec(t)?.[1] ?? '';
  return { status: r.status, gate: /11128/.test(t), code };
}

const models = ['kimi-k3.1-pro', 'deepseek-v4.1-flash'];
for (const model of models) {
  console.log(`\n=== ${model}`);
  for (const [label, system] of Object.entries(cases)) {
    const r = await post(model, system, '只回一个字：好');
    console.log(`  ${r.gate ? '✗ 400/11128' : r.status === 200 ? '✓ 200' : '? ' + r.status + ' code=' + r.code}  ${label}`);
  }
  // user 侧变异：正常短句 vs 带引号路径说明
  const r2 = await post(model, '你是助手。', LINE);
  console.log(`  ${r2.gate ? '✗ 400/11128' : r2.status === 200 ? '✓ 200' : '? ' + r2.status}  同一段文字放到 user 里`);
}
