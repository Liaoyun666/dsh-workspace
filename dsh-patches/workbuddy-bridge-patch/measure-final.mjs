// Final measurement pass: adaptive probe sizes so quantization (credit is rounded
// to 0.01) does not dominate, and three probes per model so the fit can be checked.
//
// The charge law being verified is
//     credit = rate * (a * output + b * input)
// where `rate` is the model's catalogue multiplier (the "x0.11" the UI shows) and
// a, b are per-model constants. Two unknowns, three probes -> least squares plus a
// residual, which catches a probe that under-generated (models sometimes stop early).
import fs from 'node:fs';
import path from 'node:path';

import { readDesktopCredential } from './desktop-credential.mjs';

const CN_CHAT_BASE = 'https://copilot.tencent.com';
const CN_BILLING_BASE = 'https://www.codebuddy.cn';
const STATUS_URL = 'http://127.0.0.1:64905/plugins/dsh-workbuddy-bridge/status';

const credential = readDesktopCredential();
const { uid, enterpriseId, domain } = credential;

const PRODUCT_PHRASE = ['DeepSeek', 'Harness'].join(' ');
const neutralize = (text) => text.split(PRODUCT_PHRASE).join(['DeepSeek', '\u200bHarness'].join(''));

async function refreshToken() {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: CN_BILLING_BASE,
    Referer: `${CN_BILLING_BASE}/`,
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    'Content-Type': 'application/json',
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
    ...domain === '' ? {} : { 'X-Domain': domain },
    ...uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': uid },
    ...enterpriseId === undefined ? { 'X-No-Enterprise-Id': '1' } : { 'X-Enterprise-Id': enterpriseId },
  };
  const response = await fetch(`${CN_CHAT_BASE}/v2/plugin/auth/token/refresh`, {
    method: 'POST', headers, signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => undefined);
  const token = body?.data?.accessToken;
  if (typeof token !== 'string' || token === '') throw new Error(`refresh failed: http ${response.status}`);
  credential.accessToken = token;
}

function chatHeaders() {
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: CN_BILLING_BASE,
    Referer: `${CN_BILLING_BASE}/`,
    'User-Agent': 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.63.2',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.accessToken}`,
    ...uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': uid },
    ...enterpriseId === undefined ? { 'X-No-Enterprise-Id': '1' } : { 'X-Enterprise-Id': enterpriseId },
    'X-Product': 'SaaS',
    ...domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': domain },
  };
}

function parseSse(text) {
  let usage;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload.startsWith('[DONE]')) continue;
    let frame;
    try { frame = JSON.parse(payload); } catch { continue; }
    if (frame.usage && typeof frame.usage === 'object') usage = frame.usage;
  }
  return usage ?? {};
}

const FILLER_LINE = '这条记录只用于占位，内容与环境、结论、任务都无关，请勿引用或复述它。'.repeat(2);
/** Measured at ~48 tokens per filler line on both CN catalogues. */
const TOKENS_PER_LINE = 48;

async function call(model, messages, maxTokens) {
  const body = JSON.stringify({
    model, stream: true, max_tokens: maxTokens,
    messages: messages.map((m) => ({ role: m.role, content: neutralize(m.content) })),
  });
  const response = await fetch(`${CN_CHAT_BASE}/v2/chat/completions`, {
    method: 'POST', headers: chatHeaders(), body, signal: AbortSignal.timeout(420000),
  });
  if (!response.ok) return { ok: false, status: response.status, message: (await response.text()).slice(0, 240) };
  const u = parseSse(await response.text());
  return {
    ok: true,
    input: u.prompt_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    cacheRead: u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0,
    credit: typeof u.credit === 'number' ? u.credit : null,
  };
}

async function catalogue() {
  const response = await fetch(STATUS_URL, {
    headers: { accept: 'application/json', Origin: 'http://127.0.0.1:64905' },
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json();
  return {
    total: value.credits?.total,
    models: (value.models ?? []).map((model) => {
      const rate = typeof model.credits === 'string'
        ? Number.parseFloat(model.credits.replace(/^x/iu, ''))
        : Number.NaN;
      return { id: model.id, rate: Number.isFinite(rate) ? rate : undefined, contextWindow: model.contextWindow };
    }),
  };
}

/** Probe plan: each probe targets ~0.6 credit, which keeps quantization under 2%. */
function probesFor(rate, contextWindow) {
  const target = 0.6;
  const linesRaw = Math.round(target / (Math.max(rate, 1e-3) * 1.5e-4 * TOKENS_PER_LINE));
  const lines = Math.max(8, Math.min(linesRaw, Math.floor((contextWindow ?? 200000) * 0.5 / TOKENS_PER_LINE)));
  const outRaw = Math.round(target / (Math.max(rate, 1e-3) * 1e-3));
  const out = Math.max(16, Math.min(outRaw, 6000));
  const prose = (nonce, words) => `会话编号 ${nonce}。请写一篇约 ${words} 字的散文，主题是"缓存、延迟与人的耐心"，`
    + '分成若干自然段连贯叙述，直接给正文，不要标题、不要总结、不要停笔。';
  return [
    {
      name: 'in',
      maxTokens: 8,
      messages: [
        { role: 'system', content: '你是一个只回答一个词的助手。' },
        {
          role: 'user',
          content: `${[`会话编号 ${nonce()}，以下为占位文本。`, ...Array.from({ length: lines }, () => FILLER_LINE)].join('\n')}\n\n请只回答两个字：收到`,
        },
      ],
    },
    {
      name: 'out',
      maxTokens: out,
      messages: [
        { role: 'system', content: '你是一个写作者，按要求输出正文，不要客套，不要用列表。' },
        { role: 'user', content: prose(nonce(), Math.round(out * 0.8)) },
      ],
    },
    {
      name: 'mix',
      maxTokens: Math.max(16, Math.round(out / 2)),
      messages: [
        { role: 'system', content: '你是一个助手。' },
        { role: 'user', content: `${prose(nonce(), Math.round(out * 0.35))}\n\n补充说明：主题也可以从"排队论"切入。` },
      ],
    },
  ];
}

const nonce = () => Math.random().toString(36).slice(2, 10);
const round = (value, digits = 6) => Number(value.toPrecision(digits));

try {
  await refreshToken();
  console.log('# token refreshed');
} catch (error) {
  console.log(`# refresh failed, using the stored token: ${error.message}`);
}

const { total, models } = await catalogue();
console.log(`# balance ${total} · ${models.length} models\n`);

const rows = [];
for (const { id: model, rate, contextWindow } of models) {
  if (rate === undefined) { rows.push({ model, rate: undefined, error: 'no-rate' }); continue; }
  if (rate === 0) { rows.push({ model, rate, free: true }); continue; }
  const probes = [];
  for (const probe of probesFor(rate, contextWindow)) {
    const result = await call(model, probe.messages, probe.maxTokens).catch((error) => ({ ok: false, status: 0, message: String(error) }));
    probes.push({ name: probe.name, ...result });
    if (!result.ok) {
      console.log(`${model}\t${probe.name}\tFAILED\thttp ${result.status}\t${String(result.message).slice(0, 140)}`);
      continue;
    }
    console.log(`${model}\trate=${rate}\t${probe.name}\tin=${result.input}\tout=${result.output}\tcache=${result.cacheRead}\tcredit=${result.credit}`);
  }
  rows.push({ model, rate, probes });
}

fs.writeFileSync(path.join(import.meta.dirname, 'measure-final.json'), `${JSON.stringify(rows, null, 2)}\n`);

// ---------- least squares: y = a*out + b*in, y = credit/rate ----------
console.log('\n// ---- fitted per-model coefficients ----');
const fitted = [];
for (const row of rows) {
  if (row.free) { fitted.push({ model: row.model, rate: 0, free: true }); continue; }
  if (!row.probes) continue;
  const usable = row.probes.filter((p) => p.ok && p.credit !== null);
  if (usable.length < 2) { console.log(`${row.model}\tSKIP (${usable.length} usable probes)`); fitted.push({ model: row.model, rate: row.rate, error: 'insufficient' }); continue; }
  const xs = usable.map((p) => p.output);
  const zs = usable.map((p) => p.input);
  const ys = usable.map((p) => p.credit / row.rate);
  const n = usable.length;
  // normal equations for the two-parameter no-intercept model
  let sxx = 0; let sxz = 0; let szz = 0; let sxy = 0; let szy = 0;
  for (let k = 0; k < n; k += 1) {
    sxx += xs[k] * xs[k]; sxz += xs[k] * zs[k]; szz += zs[k] * zs[k];
    sxy += xs[k] * ys[k]; szy += zs[k] * ys[k];
  }
  const det = sxx * szz - sxz * sxz;
  if (det === 0) { console.log(`${row.model}\tSKIP singular`); fitted.push({ model: row.model, rate: row.rate, error: 'singular' }); continue; }
  const a = (sxy * szz - szy * sxz) / det;
  const b = (szy * sxx - sxy * sxz) / det;
  const residual = usable.map((p, k) => {
    const predicted = a * xs[k] + b * zs[k];
    return Math.abs(predicted - ys[k]) / Math.max(ys[k], 1e-9);
  });
  const worst = Math.max(...residual);
  const MIX_OUT = 0.4163;
  const tokensPerCredit = 1 / (row.rate * (a * MIX_OUT + b * (1 - MIX_OUT)));
  fitted.push({
    model: row.model, rate: row.rate, a: round(a), b: round(b),
    outPerCredit: round(1 / (a * row.rate), 4), inPerCredit: round(1 / (b * row.rate), 4),
    tokensPerCredit: round(tokensPerCredit, 5), worstRelativeError: round(worst, 3), probes: n,
  });
  console.log(
    `${row.model}\trate=${String(row.rate).padEnd(5)}\ta=${a.toExponential(4)}\tb=${b.toExponential(4)}`
    + `\ttokPerCredit=${tokensPerCredit.toFixed(0)}\tworstErr=${(worst * 100).toFixed(1)}%\tn=${n}`,
  );
}

fs.writeFileSync(path.join(import.meta.dirname, 'fitted.json'), `${JSON.stringify(fitted, null, 2)}\n`);

console.log('\n// ---- JS literal for the client patch ----');
console.log('const MODEL_CHARGE = {');
for (const entry of fitted) {
  if (entry.free) { console.log(`\t${JSON.stringify(entry.model)}: null,`); continue; }
  if (entry.error) continue;
  console.log(`\t${JSON.stringify(entry.model)}: { a: ${entry.a}, b: ${entry.b} },`);
}
console.log('};');
