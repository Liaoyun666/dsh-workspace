// Calibrate: credit-per-message vs (input, output, cacheRead) token buckets.
// Joins the DSH session log (multi-frame zstd JSONL) with the bridge credit route,
// then fits  credit / multiplier = a*output + b*input (+ c*cacheRead).
import fs from 'node:fs';
import zlib from 'node:zlib';

const SESSION = process.argv[2] ?? 'session-8be6bd49-e4f4-4efd-928a-f2cbbfaf05f1';
const LOG = process.argv[3] ?? `C:/Users/user/.dsh/sessions/--E-~5DE5~4F5C~533A--/${SESSION}/session.v4.jsonl.zstd`;
const ORIGIN = 'http://127.0.0.1:64905';

function decompressAll(buf) {
  const parts = [];
  let start = 0;
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    const magic = buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd;
    if (magic && i > start) {
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(start, i)));
        start = i;
      } catch {
        /* keep scanning */
      }
    }
  }
  try {
    parts.push(zlib.zstdDecompressSync(buf.subarray(start)));
  } catch {
    /* trailing garbage */
  }
  return Buffer.concat(parts).toString('utf8');
}

const text = decompressAll(fs.readFileSync(LOG));
const events = [];
for (const line of text.split('\n')) {
  if (line.trim() === '') continue;
  try {
    events.push(JSON.parse(line));
  } catch {
    /* ignore */
  }
}

// model multiplier table from the live status route
const status = await (await fetch(`${ORIGIN}/plugins/dsh-workbuddy-bridge/status`, {
  headers: { accept: 'application/json', origin: ORIGIN }
})).json();
const rates = new Map();
for (const m of status.models ?? []) {
  const raw = m.credits;
  const value = typeof raw === 'string' ? Number.parseFloat(raw.replace(/^x/u, '')) : undefined;
  rates.set(m.id, Number.isFinite(value) ? value : undefined);
}
const creditMap = await (await fetch(`${ORIGIN}/plugins/dsh-workbuddy-bridge/credit?sessionId=${encodeURIComponent(SESSION)}`, {
  headers: { accept: 'application/json', origin: ORIGIN }
})).json();
const credits = creditMap.credits ?? {};

const rows = [];
for (const e of events) {
  const data = e?.data;
  if (e?.type !== 'assistant/message' || data === undefined) continue;
  const message = data.message;
  const usage = data.usage;
  if (message?.source?.provider !== 'workbuddy' || usage === undefined) continue;
  rows.push({
    messageId: message.id,
    model: message.source.model,
    in: usage.inputTokens ?? 0,
    out: usage.outputTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
    credit: credits[message.id],
    rate: rates.get(message.source.model)
  });
}

const joined = rows.filter((r) => typeof r.credit === 'number' && r.credit > 0 && typeof r.rate === 'number');
console.log(`messages=${rows.length} joined=${joined.length} creditMapSize=${Object.keys(credits).length}`);
console.log('model                        rate   n     in      out    cacheRead  credit  credit/rate  scaled-tokens');
for (const [model, group] of Map.groupBy(joined, (r) => r.model)) {
  const sum = (k) => group.reduce((acc, r) => acc + r[k], 0);
  const rate = group[0].rate;
  const scaled = sum('credit') / (rate === 0 ? 1 : rate);
  console.log(
    `${model.padEnd(28)} ${String(rate).padEnd(6)} ${String(group.length).padEnd(5)} ` +
      `${String(sum('in')).padEnd(7)} ${String(sum('out')).padEnd(7)} ${String(sum('cacheRead')).padEnd(10)} ` +
      `${sum('credit').toFixed(2).padEnd(7)} ${scaled.toFixed(3).padEnd(12)} ${(sum('in') + sum('out')).toFixed(0)}`
  );
}

// Least squares for credit/rate = a*out + b*in, then optional + c*cacheRead.
function solve(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col];
    if (Math.abs(d) < 1e-12) return undefined;
    for (let k = col; k <= n; k += 1) a[col][k] /= d;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const f = a[row][col];
      for (let k = col; k <= n; k += 1) a[row][k] -= f * a[col][k];
    }
  }
  return a.map((row) => row[n]);
}

function fit(features) {
  const k = features.length;
  const ata = Array.from({ length: k }, () => new Array(k).fill(0));
  const aty = new Array(k).fill(0);
  for (const r of joined) {
    const x = features.map((f) => f(r));
    const y = r.credit / r.rate;
    for (let i = 0; i < k; i += 1) {
      aty[i] += x[i] * y;
      for (let j = 0; j < k; j += 1) ata[i][j] += x[i] * x[j];
    }
  }
  const coef = solve(ata, aty);
  if (coef === undefined) return undefined;
  let ss = 0;
  let sst = 0;
  const mean = joined.reduce((acc, r) => acc + r.credit / r.rate, 0) / joined.length;
  for (const r of joined) {
    const predicted = features.reduce((acc, f, i) => acc + coef[i] * f(r), 0);
    const y = r.credit / r.rate;
    ss += (y - predicted) ** 2;
    sst += (y - mean) ** 2;
  }
  return { coef, r2: sst === 0 ? 0 : 1 - ss / sst };
}

if (joined.length >= 3) {
  const two = fit([(r) => r.out, (r) => r.in]);
  const three = fit([(r) => r.out, (r) => r.in, (r) => r.cacheRead]);
  console.log('\nfit credit/rate = a*out + b*in          ->', two && { a: two.coef[0], b: two.coef[1], r2: two.r2 });
  console.log('fit credit/rate = a*out + b*in + c*cache ->', three && { a: three.coef[0], b: three.coef[1], c: three.coef[2], r2: three.r2 });
  const plain = fit([(r) => r.in + r.out]);
  console.log('fit credit/rate = k*(in+out)            ->', plain && { k: plain.coef[0], r2: plain.r2 });
  console.log('\nper-sample (credit, rate, in, out):');
  for (const r of joined) console.log(`  ${r.model.padEnd(24)} credit=${String(r.credit).padEnd(6)} rate=${String(r.rate).padEnd(5)} in=${String(r.in).padEnd(6)} out=${String(r.out).padEnd(6)} cache=${r.cacheRead}`);
}
