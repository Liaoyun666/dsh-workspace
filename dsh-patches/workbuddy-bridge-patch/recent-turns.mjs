// 列出会话里最近的 assistant/message（provider/model/时间）与 turn/end，确认 WorkBuddy 轮次是否成功
import fs from 'node:fs';
import zlib from 'node:zlib';

const SESSION = process.argv[2] ?? 'C:/Users/user/.dsh/sessions/--E-~5DE5~4F5C~533A--/session-8be6bd49-e4f4-4efd-928a-f2cbbfaf05f1/session.v4.jsonl.zstd';

const raw = fs.readFileSync(SESSION);
const M = [0x28, 0xb5, 0x2f, 0xfd];
const off = [];
for (let i = 0; i + 4 <= raw.length; i++) if (raw[i] === M[0] && raw[i + 1] === M[1] && raw[i + 2] === M[2] && raw[i + 3] === M[3]) off.push(i);
const parts = [];
for (let k = 0; k < off.length; k++) {
  const s = off[k];
  const e = k + 1 < off.length ? off[k + 1] : raw.length;
  try { parts.push(zlib.zstdDecompressSync(raw.subarray(s, e)).toString('utf8')); } catch {}
}
const lines = parts.join('').split('\n').filter((l) => l.trim());
const rows = [];
let n = 0;
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (o.type === 'assistant/message') {
    const m = o.data?.message;
    const u = o.data?.usage ?? {};
    rows.push({ at: o.time ?? '', kind: 'assistant', provider: m?.source?.provider ?? '?', model: m?.source?.model ?? '?', in: u.inputTokens ?? 0, out: u.outputTokens ?? 0, turn: o.data?.turn, step: o.data?.step });
  } else if (o.type === 'turn/end' || o.type === 'turn/start') {
    rows.push({ at: o.time ?? '', kind: o.type, reason: o.data?.reason ?? '', turn: o.data?.turn });
  } else if (o.type === 'user/message') {
    rows.push({ at: o.time ?? '', kind: 'user', turn: o.data?.turn, text: String(o.data?.message?.content ?? '').slice(0, 40).replace(/\s+/g, ' ') });
  }
}
console.log('lines', lines.length, 'rows', rows.length);
for (const r of rows.slice(-40)) {
  if (r.kind === 'assistant') console.log(`${r.at} assistant turn=${r.turn} step=${r.step} ${r.provider}/${r.model} in=${r.in} out=${r.out}`);
  else if (r.kind === 'user') console.log(`${r.at} user turn=${r.turn} :: ${r.text}`);
  else console.log(`${r.at} ${r.kind} turn=${r.turn} ${r.reason}`);
}
const wb = rows.filter((r) => r.kind === 'assistant' && String(r.provider).startsWith('workbuddy'));
console.log('--- workbuddy assistant messages:', wb.length, 'last at', wb.length ? wb[wb.length - 1].at : 'n/a');