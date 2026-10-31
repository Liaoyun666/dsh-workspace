// 用「真实的系统提示词」验证补丁里的两个正则是否会把所有品牌词改写掉
import fs from 'node:fs';
import zlib from 'node:zlib';

const SESSION = 'C:/Users/user/.dsh/sessions/--E-~5DE5~4F5C~533A--/session-8be6bd49-e4f4-4efd-928a-f2cbbfaf05f1/session.v4.jsonl.zstd';

function readLog(file) {
  const raw = fs.readFileSync(file);
  const M = [0x28, 0xb5, 0x2f, 0xfd];
  const off = [];
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw[i] === M[0] && raw[i + 1] === M[1] && raw[i + 2] === M[2] && raw[i + 3] === M[3]) off.push(i);
  }
  const parts = [];
  for (let k = 0; k < off.length; k++) {
    const s = off[k];
    const e = k + 1 < off.length ? off[k + 1] : raw.length;
    try { parts.push(zlib.zstdDecompressSync(raw.subarray(s, e)).toString('utf8')); } catch {}
  }
  return parts.join('').split('\n').filter((l) => l.trim());
}

const ZW = '\u200b';
const CHANNEL_OPENER = /^([\s\uFEFF]*)You\s+are\s+an\s+AI\s+agent\s+powered\s+by\s+DeepSeek[\s\u00A0]+Harness\s*\./i;
const CHANNEL_SIGNATURE_PHRASE = /(?<![\\/])DeepSeek([\s\u00A0]+)Harness(?![\\/])/gi;
const neutralize = (text) => text.replace(CHANNEL_OPENER, '$1You are an AI agent.').replace(CHANNEL_SIGNATURE_PHRASE, `DeepSeek${ZW}$1Harness`);

const lines = readLog(SESSION);
const systems = [];
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (o.type !== 'system/message') continue;
  const content = o.data?.message?.content;
  const parts = Array.isArray(content) ? content.filter((p) => p?.type === 'text').map((p) => p.text) : [String(content)];
  systems.push(parts.join('\n'));
}
console.log('system messages:', systems.length);

const last = systems[systems.length - 1] ?? '';
console.log('last system length:', last.length, 'starts with:', JSON.stringify(last.slice(0, 80)));

const before = (last.match(/DeepSeek[\s\u00A0]+Harness/gi) ?? []).length;
const after1 = neutralize(last);
const after = (after1.replace(new RegExp(ZW, 'g'), '').match(/DeepSeek[\s\u00A0]+Harness/gi) ?? []).length;
console.log('occurrences before=%d, after neutralize=%d', before, after);

const re = /DeepSeek[\s\u00A0]+Harness/gi;
let m;
let n = 0;
while ((m = re.exec(after1)) !== null && n < 10) {
  n += 1;
  const s = Math.max(0, m.index - 60);
  const seg = after1.slice(s, m.index + 40).replace(/\n/g, '⏎');
  console.log('LEFT[%d] …%s…', n, seg);
}
if (after === 0) console.log('OK: 系统提示词全部被改写');
