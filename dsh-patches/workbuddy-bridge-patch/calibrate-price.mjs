// Price-based calibration: is credit ~ proportional to API-priced token cost?
// Uses the dsh-cost-meter price table (USD per 1M tokens) as the basis.
import fs from 'node:fs';
import zlib from 'node:zlib';

const SESSION = process.argv[2] ?? 'session-8be6bd49-e4f4-4efd-928a-f2cbbfaf05f1';
const LOG = process.argv[3] ?? `C:/Users/user/.dsh/sessions/--E-~5DE5~4F5C~533A--/${SESSION}/session.v4.jsonl.zstd`;
const ORIGIN = 'http://127.0.0.1:64905';
const PRICING = 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-cost-meter/docs/provider-pricing.json';

function decompressAll(buf) {
  const parts = [];
  let start = 0;
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd && i > start) {
      try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, i))); start = i; } catch { /* scan on */ }
    }
  }
  try { parts.push(zlib.zstdDecompressSync(buf.subarray(start))); } catch { /* trailing */ }
  return Buffer.concat(parts).toString('utf8');
}

const events = [];
for (const line of decompressAll(fs.readFileSync(LOG)).split('\n')) {
  if (line.trim() === '') continue;
  try { events.push(JSON.parse(line)); } catch { /* ignore */ }
}

const status = await (await fetch(`${ORIGIN}/plugins/dsh-workbuddy-bridge/status`, { headers: { accept: 'application/json', origin: ORIGIN } })).json();
const rates = new Map();
for (const m of status.models ?? []) {
  const v = typeof m.credits === 'string' ? Number.parseFloat(m.credits.replace(/^x/u, '')) : undefined;
  rates.set(m.id, Number.isFinite(v) ? v : undefined);
}
const creditMap = await (await fetch(`${ORIGIN}/plugins/dsh-workbuddy-bridge/credit?sessionId=${encodeURIComponent(SESSION)}`, { headers: { accept: 'application/json', origin: ORIGIN } })).json();
const credits = creditMap.credits ?? {};

// ---- price table from cost-meter (USD per 1M tokens) ----
const pricing = JSON.parse(fs.readFileSync(PRICING, 'utf8'));
const priceIndex = new Map(); // model id -> [{provider, input, cachedInput, output}]
for (const [provider, body] of Object.entries(pricing.providers ?? {})) {
  for (const [id, e] of Object.entries(body.models ?? {})) {
    if (typeof e?.input !== 'number' || typeof e?.output !== 'number') continue;
    if (!priceIndex.has(id)) priceIndex.set(id, []);
    priceIndex.get(id).push({ provider, input: e.input, cachedInput: typeof e.cachedInput === 'number' ? e.cachedInput : e.input, output: e.output });
  }
}

const rows = [];
for (const e of events) {
  const d = e?.data;
  if (e?.type !== 'assistant/message' || d === undefined) continue;
  const m = d.message, u = d.usage;
  if (m?.source?.provider !== 'workbuddy' || u === undefined) continue;
  rows.push({
    model: m.source.model,
    in: u.inputTokens ?? 0,
    out: u.outputTokens ?? 0,
    cache: u.cacheReadTokens ?? 0,
    credit: credits[m.id],
    rate: rates.get(m.source.model),
  });
}
const joined = rows.filter((r) => typeof r.credit === 'number' && r.credit > 0 && typeof r.rate === 'number');

console.log(`messages=${rows.length} joined=${joined.length}`);
console.log('price candidates for the models in play:');
for (const model of new Set(joined.map((r) => r.model))) {
  console.log(' ', model, JSON.stringify(priceIndex.get(model) ?? null));
}

// Fit: credit/rate = K * USDcost, where USDcost = (in*pIn + out*pOut + cache*pCache)/1e6
function fitK(price, list = joined) {
  let num = 0, den = 0;
  for (const r of list) {
    const usd = (r.in * price.input + r.out * price.output + r.cache * price.cachedInput) / 1e6;
    const y = r.credit / r.rate;
    num += usd * y; den += usd * usd;
  }
  const K = den === 0 ? NaN : num / den;
  let ss = 0, sst = 0;
  const mean = list.reduce((a, r) => a + r.credit / r.rate, 0) / list.length;
  for (const r of list) {
    const usd = (r.in * price.input + r.out * price.output + r.cache * price.cachedInput) / 1e6;
    const y = r.credit / r.rate;
    ss += (y - K * usd) ** 2; sst += (y - mean) ** 2;
  }
  return { K, r2: sst === 0 ? 0 : 1 - ss / sst, mape: list.reduce((a, r) => a + Math.abs(r.credit / r.rate - K * ((r.in * price.input + r.out * price.output + r.cache * price.cachedInput) / 1e6)) / (r.credit / r.rate), 0) / list.length };
}

for (const [model, candidates] of priceIndex) {
  if (!joined.some((r) => r.model === model)) continue;
  for (const c of candidates.slice(0, 3)) {
    const f = fitK(c);
    console.log(`\nprice from ${c.provider} (in=${c.input} cache=${c.cachedInput} out=${c.output}):  K=${f.K.toFixed(1)} credits/USD  R2=${f.r2.toFixed(4)}  meanRelErr=${(f.mape * 100).toFixed(1)}%`);
  }
  // variants: ignore cache, price input==output, etc.
  const base = candidates[0];
  const noCache = { ...base, cachedInput: 0 };
  const flatCache = { ...base, cachedInput: base.cachedInput };
  console.log('  no-cache-weighted:', JSON.stringify(fitK(noCache)));
  console.log('  flatCache same:', JSON.stringify(fitK(flatCache)));
}

// residuals with the best (first) candidate
const best = [...priceIndex.values()][0]?.[0];
if (best !== undefined) {
  console.log('\nper-sample (credit/rate vs K*USD):');
  const K = fitK(best).K;
  for (const r of joined) {
    const usd = (r.in * best.input + r.out * best.output + r.cache * best.cachedInput) / 1e6;
    console.log(`  in=${String(r.in).padEnd(6)} out=${String(r.out).padEnd(6)} cache=${String(r.cache).padEnd(8)} credit=${String(r.credit).padEnd(5)} y=${(r.credit / r.rate).toFixed(4)} pred=${(K * usd).toFixed(4)}`);
  }
}
