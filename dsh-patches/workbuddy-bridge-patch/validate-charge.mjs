// Validate the measured per-model coefficients against data the fit never saw:
//  1) the datapoint the bridge author documented in source (glm-5.3, 900 output -> credit 0.51)
//  2) every real credit sample harvested from this session's log (deepseek-v4.1-flash)
//  3) today's whole-day ledger bucket for workbuddy:deepseek-v4.1-flash
//
// Charge law: credit = rate * (a * output + b * freshInput + c * cacheRead), c = CACHE_FACTOR * b
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const here = import.meta.dirname;
const fitted = JSON.parse(fs.readFileSync(path.join(here, 'fitted.json'), 'utf8'));
const table = new Map();
for (const entry of fitted) if (!entry.error && !entry.free) table.set(entry.model, entry);

const CACHE_FACTOR = 0.02;
const creditFor = (model, rate, output, input, cacheRead) => {
  const entry = table.get(model);
  if (entry === undefined) return undefined;
  return rate * (entry.a * output + entry.b * input + CACHE_FACTOR * entry.b * (cacheRead ?? 0));
};

console.log('# 1) bridge source datapoint: glm-5.3, 900 output tokens, documented credit 0.51');
const glm = creditFor('glm-5.3', 0.69, 900, 0, 0);
console.log(`   predicted ${glm.toFixed(4)} credit  (documented 0.51, delta ${((glm / 0.51 - 1) * 100).toFixed(1)}%)`);

// --- multi-frame zstd session log ---
const SESSION = 'C:/Users/user/.dsh/sessions/--E-~5DE5~4F5C~533A--/session-8be6bd49-e4f4-4efd-928a-f2cbbfaf05f1/session.v4.jsonl.zstd';
function decodeSessionLog(file) {
  const buffer = fs.readFileSync(file);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  for (let index = 0; index < buffer.length - 4; index += 1) {
    if (buffer[index] === MAGIC[0] && buffer[index + 1] === MAGIC[1]
      && buffer[index + 2] === MAGIC[2] && buffer[index + 3] === MAGIC[3]) starts.push(index);
  }
  const chunks = [];
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buffer.length;
    try { chunks.push(zlib.zstdDecompressSync(buffer.subarray(starts[k], end))); } catch { /* skip bad frame */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

const CREDIT_URL = 'http://127.0.0.1:64905/plugins/dsh-workbuddy-bridge/credit?sessionId=session-8be6bd49-e4f4-4efd-928a-f2cbbfaf05f1';
const creditResponse = await fetch(CREDIT_URL, {
  headers: { accept: 'application/json', Origin: 'http://127.0.0.1:64905' },
});
const creditMap = (await creditResponse.json()).credits ?? {};

const lines = decodeSessionLog(SESSION).split('\n');
const samples = [];
for (const line of lines) {
  if (!line.includes('"assistant/message"')) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event.type !== 'assistant/message') continue;
  const message = event.data?.message;
  if (message?.source?.provider !== 'workbuddy') continue;
  const usage = event.data?.usage;
  if (usage === undefined) continue;
  const model = message.source.model;
  const credit = creditMap[message.id];
  if (typeof credit !== 'number') continue;
  samples.push({
    model,
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
    credit,
  });
}

console.log(`\n# 2) ${samples.length} real credit samples from this session`);
let totalPredicted = 0;
let totalActual = 0;
for (const sample of samples) {
  const predicted = creditFor(sample.model, 0.11, sample.output, sample.input, sample.cacheRead);
  totalPredicted += predicted ?? 0;
  totalActual += sample.credit;
  const delta = predicted === undefined ? 'n/a' : `${((predicted / sample.credit - 1) * 100).toFixed(0)}%`;
  console.log(`   in=${String(sample.input).padEnd(6)} out=${String(sample.output).padEnd(6)} cache=${String(sample.cacheRead).padEnd(7)} actual=${String(sample.credit).padEnd(6)} predicted=${predicted?.toFixed(3) ?? 'n/a'} (${delta})`);
}
console.log(`   TOTAL actual=${totalActual.toFixed(2)} predicted=${totalPredicted.toFixed(2)} delta=${((totalPredicted / totalActual - 1) * 100).toFixed(0)}%`);

console.log('\n# 3) whole-day ledger bucket 2026-10-24 for workbuddy:deepseek-v4.1-flash');
const ledger = JSON.parse(fs.readFileSync('C:/Users/user/.dsh/storages/cost-meter/ledger.json', 'utf8'));
// `days` is a date-keyed object, not an array.
const day = Array.isArray(ledger.days)
  ? ledger.days.find((entry) => entry.date === '2026-10-24')
  : ledger.days['2026-10-24'];
const bucket = day.byProviderModel['workbuddy:deepseek-v4.1-flash'];
console.log(`   in=${bucket.input} out=${bucket.output} cache=${bucket.cacheRead}`);
console.log(`   predicted ${creditFor('deepseek-v4.1-flash', 0.11, bucket.output, bucket.input, bucket.cacheRead).toFixed(1)} credit for the day`);

console.log('\n# 4) tokens per credit under the observed usage mix (out 41.63% / in 58.37%, cache 23.28x)');
const OUT_SHARE = 0.4163;
const IN_SHARE = 1 - OUT_SHARE;
const CACHE_PER_NONCACHED = 23.28;
const perCredit = (entry) => 1 / (entry.rate * (
  entry.a * OUT_SHARE + entry.b * IN_SHARE + CACHE_FACTOR * entry.b * CACHE_PER_NONCACHED
));
for (const entry of fitted) {
  if (entry.free) { console.log(`   ${entry.model.padEnd(20)} free`); continue; }
  if (entry.error) { console.log(`   ${entry.model.padEnd(20)} (no coefficients: ${entry.error})`); continue; }
  console.log(`   ${entry.model.padEnd(20)} rate=${String(entry.rate).padEnd(5)} ${perCredit(entry).toFixed(0).padStart(7)} tokens/credit`);
}
