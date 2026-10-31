// 扫描会话日志，找出最近的错误事件（400 / 请求被拦截）
import fs from 'node:fs';
import zlib from 'node:zlib';

const FILE = process.argv[2];
const NEEDLE = process.argv[3] ?? '请求被拦截';

const raw = fs.readFileSync(FILE);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
let offsets = [];
for (let i = 0; i + 4 <= raw.length; i++) {
  if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) offsets.push(i);
}
const parts = [];
for (let k = 0; k < offsets.length; k++) {
  const start = offsets[k];
  const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length;
  try { parts.push(zlib.zstdDecompressSync(raw.subarray(start, end)).toString('utf8')); } catch {}
}
const text = parts.join('');
const lines = text.split('\n').filter((l) => l.trim() !== '');
console.log('bytes=', raw.length, 'frames=', offsets.length, 'lines=', lines.length);

const hits = [];
for (const line of lines) {
  if (line.includes(NEEDLE)) hits.push(line);
}
console.log('hits=', hits.length);
for (const h of hits.slice(-6)) {
  try {
    const o = JSON.parse(h);
    console.log('---', o.type, new Date(o.time ?? 0).toISOString());
    console.log(JSON.stringify(o.data ?? o, null, 1).slice(0, 2500));
  } catch {
    console.log(h.slice(0, 1200));
  }
}

// 顺便列出最后 20 条事件的类型
console.log('\n=== last events ===');
for (const line of lines.slice(-20)) {
  try {
    const o = JSON.parse(line);
    console.log(o.type, '|', new Date(o.time ?? 0).toISOString().slice(11, 19));
  } catch {}
}
