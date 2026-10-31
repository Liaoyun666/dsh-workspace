
// Unity 2019.4.15f1 downloader: 4 parallel HTTP ranges with resume + fallback mirrors.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DEST = 'E:\\Unity\\downloads\\UnitySetup64-2019.4.15f1.exe';
const TOTAL = 1986732664;
const MIRRORS = [
  'https://download.unitychina.cn/download_unity/fbf367ac14e9/Windows64EditorInstaller/UnitySetup64-2019.4.15f1.exe',
  'https://download.unity3d.com/download_unity/fbf367ac14e9/Windows64EditorInstaller/UnitySetup64-2019.4.15f1.exe'
];
const THREADS = 4;
const STATE = DEST + '.parts.json';
const LOG = DEST + '.log';

function log(...a) {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

async function head(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 20000);
  try {
    const r = await fetch(url, { method: 'HEAD', signal: c.signal, redirect: 'follow' });
    return { ok: r.ok, len: Number(r.headers.get('content-length') || 0), status: r.status };
  } finally { clearTimeout(t); }
}

async function pickMirror() {
  for (const u of MIRRORS) {
    try {
      const h = await head(u); log('HEAD', u, JSON.stringify(h));
      if (h.ok && (!h.len || h.len === TOTAL)) return u;
      if (h.ok && h.len && h.len !== TOTAL) log('WARN size mismatch', h.len, '!=', TOTAL);
    } catch (e) { log('HEAD fail', u, e.message); }
  }
  return MIRRORS[0];
}

async function downloadRange(url, fh, start, end, state, idx) {
  let pos = start + (state.done[idx] || 0);
  let attempt = 0;
  while (pos <= end) {
    attempt++;
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), 60000);
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=' + pos + '-' + end }, signal: c.signal, redirect: 'follow' });
      if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
      let got = 0;
      for await (const chunk of r.body) {
        await fh.write(chunk, 0, chunk.length, pos);
        pos += chunk.length; got += chunk.length;
        state.done[idx] = pos - start;
      }
      clearTimeout(timer);
      if (pos > end + 1) throw new Error('overrun');
      log('chunk', idx, 'finished', got, 'bytes');
      return;
    } catch (e) {
      clearTimeout(timer);
      log('chunk', idx, 'error at', pos, e.message, 'retry', attempt);
      if (attempt > 12) throw e;
      await new Promise(r => setTimeout(r, Math.min(15000, 1000 * attempt)));
    }
  }
}

(async () => {
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  if (fs.existsSync(DEST) && fs.statSync(DEST).size === TOTAL) { log('already complete'); return; }
  const url = await pickMirror();
  log('using mirror', url, 'threads', THREADS);
  let state = { done: Array(THREADS).fill(0) };
  try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); if (Array.isArray(s.done) && s.done.length === THREADS) state = s; } catch {}
  const fh = await fsp.open(DEST, 'a+');
  const size = (await fh.stat()).size;
  if (size > TOTAL) { await fh.truncate(TOTAL); }
  const span = Math.ceil(TOTAL / THREADS);
  const jobs = [];
  for (let i = 0; i < THREADS; i++) {
    const start = i * span, end = Math.min(TOTAL - 1, start + span - 1);
    jobs.push(downloadRange(url, fh, start, end, state, i));
  }
  let last = -1;
  const tick = setInterval(() => {
    const sum = state.done.reduce((a, b) => a + b, 0);
    if (sum !== last) {
      last = sum;
      const pct = (sum / TOTAL * 100).toFixed(2);
      fs.writeFileSync(STATE, JSON.stringify(state));
      log('progress', pct + '%', (sum / 1048576).toFixed(1) + 'MB / ' + (TOTAL / 1048576).toFixed(1) + 'MB');
    }
  }, 3000);
  try { await Promise.all(jobs); } finally { clearInterval(tick); await fh.close(); }
  const finalSize = fs.statSync(DEST).size;
  log('DONE size=' + finalSize, finalSize === TOTAL ? 'OK' : 'MISMATCH');
  if (finalSize !== TOTAL) process.exitCode = 2;
})().catch(e => { log('FATAL', e && e.stack || e); process.exitCode = 1; });
