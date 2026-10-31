// Build the cost-meter-based model for WorkBuddy credits:
//   1) per-model API list prices (USD / 1M tokens) from dsh-cost-meter's price table
//   2) the observed usage structure (cache / input / output mix) from cost-meter's ledger
//   3) K = credits per USD-of-list-price at multiplier x1, fitted on the real bridge samples
// Prints JS literals ready to paste into the client patch.
import fs from 'node:fs';

const ORIGIN = 'http://127.0.0.1:64905';
const SESSION = 'session-8be6bd49-e4f4-4efd-928a-f2cbbfaf05f1';
const HOME = 'C:/Users/user/.dsh';
const CM = `${HOME}/profiles/desktop/node_modules/dsh-cost-meter`;
const PRICING = `${CM}/docs/provider-pricing.json`;
const LEDGER = `${HOME}/storages/cost-meter/ledger.json`;

// ---------- 1. price table ----------
const pricing = JSON.parse(fs.readFileSync(PRICING, 'utf8'));
const byId = new Map();
for (const [provider, body] of Object.entries(pricing.providers ?? {})) {
  for (const [id, e] of Object.entries(body.models ?? {})) {
    if (typeof e?.input !== 'number' || typeof e?.output !== 'number') continue;
    const row = { provider, input: e.input, cachedInput: typeof e.cachedInput === 'number' ? e.cachedInput : e.input, output: e.output };
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(row);
  }
}
// provider preference: the direct vendor first, then opencode/zen mirrors
const pref = ['moonshot', 'z-ai', 'minimax', 'xiaomi', 'tencent', 'stepfun', 'opencode-go', 'opencode-zen', 'opendesign', 'openrouter'];
const pick = (id) => {
  const list = byId.get(id);
  if (!list) return undefined;
  for (const p of pref) { const hit = list.find((r) => r.provider === p); if (hit) return hit; }
  return list[0];
};

// WorkBuddy catalog id -> price lookup (direct id, then family fallback)
const WORKBUDDY_MODELS = [
  'hy4-preview', 'hy3', 'hy3-x', 'step-5-preview', 'space-bunny', 'deepseek-v4.1-flash',
  'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3.1-flash',
  'minimax-m3', 'minimax-m2.7', 'kimi-k3.1-pro', 'kimi-k3-1', 'kimi-k2.8-preview',
  'deepseek-v4-pro', 'mimo-v2.6-pro',
];
const FALLBACK = {
  'hy3-x': 'hy3',
  'glm-5v-turbo': 'glm-5.3',
  'minimax-m3.1-flash': 'minimax-m3',
  'kimi-k3.1-pro': 'kimi-k3',
  'kimi-k3-1': 'kimi-k3',
  'kimi-k2.8-preview': 'kimi-k3',
};

const prices = {};
const missing = [];
for (const id of WORKBUDDY_MODELS) {
  let row = pick(id);
  let source = id;
  if (!row && FALLBACK[id]) { row = pick(FALLBACK[id]); source = FALLBACK[id]; }
  if (!row) { missing.push(id); continue; }
  prices[id] = { input: row.input, cachedInput: row.cachedInput, output: row.output, source, provider: row.provider };
}
console.log('// ---- prices (USD per 1M tokens) ----');
for (const [id, p] of Object.entries(prices)) {
  console.log(`'${id}': { input: ${p.input}, cachedInput: ${p.cachedInput}, output: ${p.output} }, // ${p.provider}${p.source === id ? '' : ` via ${p.source}`}`);
}
if (missing.length) console.log('// MISSING:', missing.join(', '));

// ---------- 2. usage structure from the ledger ----------
const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const total = { input: 0, output: 0, cacheRead: 0 };
for (const day of Object.values(ledger.days ?? {})) {
  for (const [key, row] of Object.entries(day.byProviderModel ?? {})) {
    if (!key.startsWith('workbuddy:')) continue;
    for (const f of ['input', 'output', 'cacheRead']) total[f] += Number.isFinite(row[f]) ? row[f] : 0;
  }
}
const nonCached = total.input + total.output;
const inShare = total.input / nonCached;
const outShare = total.output / nonCached;
const cachePerNonCached = total.cacheRead / nonCached;
console.log('\n// ---- observed WorkBuddy usage structure (cost-meter ledger, all days) ----');
console.log(`// input=${total.input} output=${total.output} cacheRead=${total.cacheRead}`);
console.log(`const INPUT_SHARE = ${inShare.toFixed(6)};      // ${(inShare * 100).toFixed(1)}% of non-cached tokens`);
console.log(`const OUTPUT_SHARE = ${outShare.toFixed(6)};     // ${(outShare * 100).toFixed(1)}%`);
console.log(`const CACHE_PER_NONCACHED = ${cachePerNonCached.toFixed(6)}; // cached reads per non-cached token`);

// ---------- 3. K: credits per USD of list-price usage at multiplier x1 ----------
const status = await (await fetch(`${ORIGIN}/plugins/dsh-workbuddy-bridge/status`, { headers: { accept: 'application/json', origin: ORIGIN } })).json();
const rates = new Map();
for (const m of status.models ?? []) {
  const v = typeof m.credits === 'string' ? Number.parseFloat(m.credits.replace(/^x/u, '')) : undefined;
  rates.set(m.id, Number.isFinite(v) ? v : undefined);
}
const creditMap = await (await fetch(`${ORIGIN}/plugins/dsh-workbuddy-bridge/credit?sessionId=${encodeURIComponent(SESSION)}`, { headers: { accept: 'application/json', origin: ORIGIN } })).json();
const credits = creditMap.credits ?? {};
const zlib = await import('node:zlib');
const logPath = `${HOME}/sessions/--E-~5DE5~4F5C~533A--/${SESSION}/session.v4.jsonl.zstd`;
function decompressAll(buf) {
  const parts = [];
  let start = 0;
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd && i > start) {
      try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, i))); start = i; } catch { /* scan */ }
    }
  }
  try { parts.push(zlib.zstdDecompressSync(buf.subarray(start))); } catch { /* trailing */ }
  return Buffer.concat(parts).toString('utf8');
}
const rows = [];
for (const line of decompressAll(fs.readFileSync(logPath)).split('\n')) {
  if (line.trim() === '') continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  const d = e?.data;
  if (e?.type !== 'assistant/message' || d === undefined) continue;
  const m = d.message, u = d.usage;
  if (m?.source?.provider !== 'workbuddy' || u === undefined) continue;
  if (typeof credits[m.id] !== 'number' || credits[m.id] <= 0) continue;
  const price = prices[m.source.model];
  if (price === undefined) continue;
  rows.push({ model: m.source.model, in: u.inputTokens ?? 0, out: u.outputTokens ?? 0, cache: u.cacheReadTokens ?? 0, credit: credits[m.id], rate: rates.get(m.source.model), price });
}
let num = 0, den = 0;
for (const r of rows) {
  const usd = (r.in * r.price.input + r.out * r.price.output + r.cache * r.price.cachedInput) / 1e6;
  const y = r.credit / r.rate;
  num += usd * y; den += usd * usd;
}
const K = num / den;
let ss = 0, sst = 0;
const mean = rows.reduce((a, r) => a + r.credit / r.rate, 0) / rows.length;
for (const r of rows) {
  const usd = (r.in * r.price.input + r.out * r.price.output + r.cache * r.price.cachedInput) / 1e6;
  const y = r.credit / r.rate;
  ss += (y - K * usd) ** 2; sst += (y - mean) ** 2;
}
console.log(`\n// ---- K fit: n=${rows.length} credit/rate = K * USD ----`);
console.log(`const CREDITS_PER_USD = ${K.toFixed(4)};  // R2=${(1 - ss / sst).toFixed(6)}`);
console.log('\n// per-sample check');
for (const r of rows) {
  const usd = (r.in * r.price.input + r.out * r.price.output + r.cache * r.price.cachedInput) / 1e6;
  console.log(`//   in=${String(r.in).padEnd(6)} out=${String(r.out).padEnd(6)} cache=${String(r.cache).padEnd(8)} credit=${String(r.credit).padEnd(5)} y=${(r.credit / r.rate).toFixed(4)} K*usd=${(K * usd).toFixed(4)}`);
}

// ---------- 4. resulting token table ----------
const balance = status.credits?.total ?? 0;
console.log(`
// ---- estimates at balance=${balance} (non-cached input+output tokens) ----`);
const usdPerNonCached = (price) => (price.input * inShare + price.output * outShare + price.cachedInput * cachePerNonCached) / 1e6;
const tokensFor = (credits, rate, price) => (credits / (rate * K)) / usdPerNonCached(price);
for (const m of status.models ?? []) {
  const rate = typeof m.credits === 'string' ? Number.parseFloat(m.credits.replace(/^x/u, '')) : undefined;
  const price = prices[m.id];
  if (price === undefined || rate === undefined) { console.log(`// ${String(m.id).padEnd(20)} NO PRICE`); continue; }
  if (rate === 0) { console.log(`// ${String(m.id).padEnd(20)} free`); continue; }
  const t = tokensFor(balance, rate, price);
  console.log(`// ${String(m.id).padEnd(20)} x${String(rate).padEnd(5)} ${(t / 1e4).toFixed(1)}万  usd/1M-noncached=${(usdPerNonCached(price) * 1e6).toFixed(4)}`);
}
