// 扫描所有会话日志，找出今天所有「请求被拦截」失败记录，并列出该会话最近的 request/header
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'C:/Users/user/.dsh/sessions';
const M = [0x28, 0xb5, 0x2f, 0xfd];

function readLog(file) {
  const raw = fs.readFileSync(file);
  const off = [];
  for (let i = 0; i + 4 <= raw.length; i++) if (raw[i] === M[0] && raw[i + 1] === M[1] && raw[i + 2] === M[2] && raw[i + 3] === M[3]) off.push(i);
  const out = [];
  for (let k = 0; k < off.length; k++) {
    const s = off[k];
    const e = k + 1 < off.length ? off[k + 1] : raw.length;
    try { out.push(zlib.zstdDecompressSync(raw.subarray(s, e)).toString('utf8')); } catch {}
  }
  return out.join('').split('\n').filter((l) => l.trim());
}

const files = [];
for (const dir of fs.readdirSync(ROOT)) {
  const p = path.join(ROOT, dir);
  if (!fs.statSync(p).isDirectory()) continue;
  for (const sub of fs.readdirSync(p)) {
    const f = path.join(p, sub, 'session.v4.jsonl.zstd');
    if (fs.existsSync(f)) files.push(f);
  }
}
files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

for (const f of files.slice(0, 12)) {
  const lines = readLog(f);
  const hits = [];
  let lastHdr = null;
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (l.includes('请求被拦截') && (o.type === 'assistant/attempt' || o.type === 'assistant/message')) hits.push([o.type, new Date(o.time).toLocaleString(), o.data?.turn]);
    if (o.type === 'request/header') lastHdr = { t: o.time, p: o.data?.header?.config?.provider, m: o.data?.header?.config?.model, tools: o.data?.header?.tools?.length };
  }
  const mt = new Date(fs.statSync(f).mtimeMs).toLocaleString();
  console.log(`${path.basename(path.dirname(f)).slice(0, 20)} mtime=${mt} lines=${lines.length} 失败=${hits.length} ${hits.slice(-3).map((h) => h.join('/')).join(' ')}`);
  if (lastHdr) console.log('   最近 header:', new Date(lastHdr.t).toLocaleString(), lastHdr.p + '/' + lastHdr.m, 'tools=' + lastHdr.tools);
}
