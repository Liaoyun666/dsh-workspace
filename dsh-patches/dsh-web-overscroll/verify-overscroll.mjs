/**
 * verify-overscroll.mjs —— 复验「整页不能被滚出视口」，自带浏览器 cookie 签发，无第三方依赖。
 *
 *   node verify-overscroll.mjs                          # 默认 http://127.0.0.1:52266
 *   node verify-overscroll.mjs http://127.0.0.1:52266 9334
 *
 * 依赖：本机 DSH 正在运行（cookie 签名密钥在 ~/.dsh/.credentials.yaml，与别处共用
 * browser-session secret）+ Windows 自带的 Microsoft Edge（headless，脚本自己起在独立端口）。
 *
 * 检查项：
 *   A 组（守卫生效）：守卫样式已注入、html/body 计算值、40 次硬滚轮后文档纹丝不动、
 *                     消息列表仍能上下滚动；三种视口 1280×800 / 1000×560 / 390×844。
 *   B 组（A/B 对照）：往 body 塞一个 2000px 高的绝对定位探针，模拟"某个浮层把文档撑高"，
 *                     并把内部列表滚到尽头（滚动链正要往上传的那一刻）：
 *                       · 守卫在  → 滚轮仍不能移动文档；
 *                       · 拆掉全部守卫 → 同样的滚轮把整页滚走（scrollY == docMax）＝用户看到的故障。
 */
import { spawn } from 'node:child_process';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:52266';
const PORT = Number(process.argv[3] || 9334);
const USER_DATA = join(process.env.TEMP || '.', `dsh-overscroll-verify-${PORT}`);
const STYLE_SEL = 'style[data-plugin="dsh-web-overscroll"]';
const TITLE = process.env.DSH_VERIFY_SESSION || '修复 dsh 页面过度下拉';

const b64u = (b) => Buffer.from(b).toString('base64url');

function mintCookie(url) {
  const authority = new URL(url).host;
  const yaml = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
  const m = yaml.match(/client-connection\/browser-session:[\s\S]*?\n\s+secret:\s*(\S+)/);
  if (!m) throw new Error('在 ~/.dsh/.credentials.yaml 里找不到 browser-session secret');
  const secret = Buffer.from(m[1], 'base64url');
  const now = Date.now();
  const body = b64u(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3_600_000 }));
  return {
    name: 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url'),
    value: `v1.${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`,
  };
}

const results = [];
const check = (vp, label, ok, detail) => {
  results.push({ vp, label, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${vp} · ${label} — ${detail}`);
};

async function waitForEndpoint() {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('CDP 端口不可达: ' + PORT);
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws error'));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ws, send };
}

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

const MEASURE = `(() => {
  const de = document.documentElement, b = document.body, root = document.getElementById('root');
  const cs = (el) => el ? getComputedStyle(el) : null;
  return {
    docMax: de.scrollHeight - de.clientHeight,
    scrollY: window.scrollY, htmlTop: de.scrollTop, bodyTop: b.scrollTop,
    htmlOverflowY: cs(de).overflowY, htmlOverscrollY: cs(de).overscrollBehaviorY,
    bodyOverflowY: cs(b).overflowY, bodyOverscrollY: cs(b).overscrollBehaviorY,
    rootOverflowY: root ? cs(root).overflowY : null,
    rootOverscrollY: root ? cs(root).overscrollBehaviorY : null,
    lockStyles: document.querySelectorAll('${STYLE_SEL}').length,
  };
})()`;

const SCROLLER_AT = (x, y) => `(() => {
  let el = document.elementFromPoint(${x}, ${y});
  while (el && el !== document.documentElement && el !== document.body) {
    const cs = getComputedStyle(el);
    const max = el.scrollHeight - el.clientHeight;
    if (/(auto|scroll|overlay)/.test(cs.overflowY) && max > 4) {
      const cls = (el.className || '').toString().trim().split(/\\s+/)[0];
      const r = el.getBoundingClientRect();
      return {
        sel: cls ? '#root .' + cls : '#root ' + el.tagName.toLowerCase(),
        cls, max, top: el.scrollTop,
        x: Math.round(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 2)),
        y: Math.round(Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 2)),
      };
    }
    el = el.parentElement;
  }
  return null;
})()`;

async function wheelAt(send, x, y, count, deltaY) {
  for (let i = 0; i < count; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, pointerType: 'mouse' });
    await sleep(16);
  }
  await sleep(450);
}

async function clickText(send, text) {
  const t = await evaluate(send, `(() => {
    const want = ${JSON.stringify(text)};
    const hit = (el) => (el.textContent || '').includes(want) ||
      ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '').includes(want);
    const c = [...document.querySelectorAll('div,span,a,li,button,[role="button"]')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < innerHeight && hit(el);
    }).sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!t) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: t.x, y: t.y, button: 'left', clickCount: 1 });
  }
  await sleep(1300);
  return true;
}

/** 打开一条有内容的会话；多次尝试，容忍"应用恢复了上次视图 / 侧栏是抽屉"的各种状态。 */
async function ensureConversation(send, vp) {
  const at = () => evaluate(send, SCROLLER_AT(vp.width / 2, vp.height / 2));
  const clickFirstRow = () => evaluate(send, `(() => {
    const row = [...document.querySelectorAll('[class*="sessionRow"],[class*="sessionTitle"],[class*="title"]')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 10 && r.top >= 0 && r.top < innerHeight - 4 && (el.textContent || '').trim().length > 1;
    });
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`).then(async (t) => {
    if (!t) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: t.x, y: t.y, button: 'left', clickCount: 1 });
    }
    await sleep(1500);
    return true;
  });

  if (await at()) return 'already';
  for (const label of ['打开侧边栏', '展开侧边栏', '显示侧边栏']) {
    if (await clickText(send, label)) {
      if (await at()) return 'sidebar+' + label;
      break;
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await clickText(send, TITLE)) {
      if (await at()) return 'opened ' + TITLE;
    }
    if (await clickFirstRow()) {
      if (await at()) return 'opened first row';
    }
    for (const label of ['打开侧边栏', '展开侧边栏', '显示侧边栏']) {
      if (await clickText(send, label)) { await sleep(700); break; }
    }
  }
  return 'not found';
}

/** 消息列表仍能滚：在光标所在的可滚动容器上真滚，断言 scrollTop 会动。 */
async function listScrolls(send, vp) {
  const s = await evaluate(send, SCROLLER_AT(vp.width / 2, vp.height / 2));
  if (!s) return { ok: false, detail: '视口中心光标下没有可滚动容器（列表没打开？）' };
  const read = () => evaluate(send, `(() => { const el = document.querySelector(${JSON.stringify(s.sel)});
    return el ? { top: el.scrollTop, max: el.scrollHeight - el.clientHeight } : null; })()`);
  const up = s.top > 4;
  await wheelAt(send, s.x, s.y, 10, up ? -600 : 600);
  const a = await read();
  if (!a) return { ok: false, detail: `滚轮后容器消失：${s.sel}` };
  const moved = up ? a.top < s.top : a.top > s.top;
  await wheelAt(send, s.x, s.y, 20, up ? 600 : -600);
  const b = await read();
  const back = b ? (up ? b.top > a.top : b.top < a.top) : false;
  return {
    ok: moved && back,
    detail: `${s.cls} (max ${s.max}) ${s.top} → ${up ? 'up' : 'down'} ${a.top} → 反向 ${b ? b.top : 'null'}；` +
      `moved=${moved} back=${back}`,
  };
}

/** 拆掉所有"锁 html/body/#root"的 CSS 规则（不管来自哪个插件），用于 A/B 对照。 */
const TEARDOWN = `(() => {
  const dirty = (sel) => /(^|,)\\s*(html|body|#root)\\b/.test(sel || '');
  let removed = 0;
  for (const sheet of [...document.styleSheets]) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i];
      if (r.type === 1 && dirty(r.selectorText) && /overflow|overscroll/.test(r.cssText)) {
        try { sheet.deleteRule(i); removed++; } catch {}
      }
      if (r.type === 4) { // @media / @supports 里的同名规则
        const media = r;
        for (let j = (media.cssRules || []).length - 1; j >= 0; j--) {
          const inner = media.cssRules[j];
          if (inner.type === 1 && dirty(inner.selectorText) && /overflow|overscroll/.test(inner.cssText)) {
            try { media.deleteRule(j); removed++; } catch {}
          }
        }
      }
    }
  }
  for (const el of [document.documentElement, document.body, document.getElementById('root')]) {
    if (!el) continue;
    el.style.removeProperty('overflow'); el.style.removeProperty('overflow-y');
    el.style.removeProperty('overscroll-behavior'); el.style.removeProperty('overscroll-behavior-y');
  }
  const de = getComputedStyle(document.documentElement);
  return JSON.stringify({ removed, htmlOverflowY: de.overflowY, htmlOverscrollY: de.overscrollBehaviorY,
    bodyOverflowY: getComputedStyle(document.body).overflowY });
})()`;

const PROBE = `(() => {
  if (!document.getElementById('__probe_tall')) {
    const el = document.createElement('div');
    el.id = '__probe_tall';
    el.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:2000px;opacity:0;pointer-events:none';
    document.body.append(el);
  }
  let best = null;
  for (const el of document.querySelectorAll('#root *')) {
    const max = el.scrollHeight - el.clientHeight;
    if (max > 4 && (!best || max > best.max)) best = { el, max };
  }
  if (best) best.el.scrollTop = best.max;   // 滚到尽头：滚动链正要往上传
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  return document.documentElement.scrollHeight - document.documentElement.clientHeight;
})()`;

const VIEWPORTS = [
  { name: 'desktop-1280x800', width: 1280, height: 800, mobile: false },
  { name: 'short-1000x560', width: 1000, height: 560, mobile: false },
  { name: 'mobile-390x844', width: 390, height: 844, mobile: true },
];

async function openPage(send, vp) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: !!vp.mobile,
  });
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(2000);
  for (let i = 0; i < 60; i++) {
    if (await evaluate(send, `!!document.getElementById('root')?.children.length`).catch(() => false)) break;
    await sleep(300);
  }
  // 冷启动时模块图 + 插件树要几秒才挂上；等到守卫样式出现再开始量。
  for (let i = 0; i < 120; i++) {
    const n = await evaluate(send, `document.querySelectorAll('${STYLE_SEL}').length`).catch(() => 0);
    if (n > 0) break;
    await sleep(250);
  }
  await sleep(1200);
}

async function main() {
  const cookie = mintCookie(BASE);
  const child = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,800', 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  await waitForEndpoint();

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const { ws, send } = await connect(page.webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCookie', { name: cookie.name, value: cookie.value, domain: '127.0.0.1', path: '/' });

  for (const vp of VIEWPORTS) {
    await openPage(send, vp);

    let m = await evaluate(send, MEASURE);
    check(vp.name, '守卫样式已注入', m.lockStyles >= 1, `${STYLE_SEL} × ${m.lockStyles}`);
    check(vp.name, 'html/body/根节点已锁', m.htmlOverflowY === 'hidden' && m.htmlOverscrollY === 'none' && m.bodyOverflowY === 'hidden',
      `html ${m.htmlOverflowY}/${m.htmlOverscrollY} body ${m.bodyOverflowY}/${m.bodyOverscrollY} #root ${m.rootOverflowY}/${m.rootOverscrollY}`);

    await wheelAt(send, Math.round(vp.width / 2), Math.round(vp.height / 2), 40, 600);
    m = await evaluate(send, MEASURE);
    check(vp.name, '40 次硬滚轮后整页仍在原位', m.scrollY === 0 && m.htmlTop === 0 && m.bodyTop === 0,
      `scrollY=${m.scrollY} html.scrollTop=${m.htmlTop} body.scrollTop=${m.bodyTop} docMax=${m.docMax}`);

    const how = await ensureConversation(send, vp);
    const ls = await listScrolls(send, vp);
    check(vp.name, '消息列表仍可滚（两个方向）', ls.ok, `${ls.detail}；会话=${how}`);
  }

  // ---------------- A/B 对照 ----------------
  const vp = VIEWPORTS[0];
  await openPage(send, vp);
  await ensureConversation(send, vp);

  const docMax = await evaluate(send, PROBE);
  await wheelAt(send, Math.round(vp.width / 2), Math.round(vp.height / 2), 20, 600);
  const g = await evaluate(send, MEASURE);
  check('A/B 守卫在', '文档被撑高时整页仍不动', g.scrollY === 0 && g.htmlTop === 0,
    `探针把文档撑到 docMax=${docMax}；列表已滚到尽头；scrollY=${g.scrollY} html.scrollTop=${g.htmlTop}`);

  const td = JSON.parse(await evaluate(send, TEARDOWN));
  await evaluate(send, `document.querySelectorAll('${STYLE_SEL}').forEach((s) => s.remove())`);
  await evaluate(send, PROBE);
  await wheelAt(send, Math.round(vp.width / 2), Math.round(vp.height / 2), 20, 600);
  const u = await evaluate(send, MEASURE);
  const teardownOk = td.htmlOverflowY !== 'hidden' && td.bodyOverflowY !== 'hidden';
  check('A/B 拆掉守卫', '同样的滚轮把整页滚出视口（复现故障）', u.scrollY > 0,
    `拆规则 ${td.removed} 条；拆后 html ${td.htmlOverflowY}/${td.htmlOverscrollY} body ${td.bodyOverflowY}` +
      `${teardownOk ? '' : '（仍有规则在锁）'}；滚后 scrollY=${u.scrollY} html.scrollTop=${u.htmlTop} docMax=${u.docMax}`);

  await evaluate(send, `(() => { document.getElementById('__probe_tall')?.remove(); return 1; })()`);
  ws.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n== ${results.length - failed.length}/${results.length} 通过 ==`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(` - ${f.vp} · ${f.label} — ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('VERIFY ERROR:', e && e.stack ? e.stack : e);
  process.exit(3);
});
