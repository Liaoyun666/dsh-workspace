// dsh-mobile-ui 客户端自测：用最小的假 DOM 把 lib/client.js 跑一遍，
// 确认它注册了模块、注入了样式、按屏宽打上 data-mui、挂上汉堡键与遮罩、卸载干净。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const clientSrc = readFileSync(join(pkgRoot, 'lib', 'client.js'), 'utf8');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const patch = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8');

function makeEl(tag) {
  const attrs = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    style: {
      props: {},
      setProperty(k, v) { this.props[k] = v; },
      removeProperty(k) { delete this.props[k]; },
      getPropertyValue(k) { return this.props[k] ?? ''; },
    },
    className: '',
    innerHTML: '',
    textContent: '',
    listeners: new Map(),
    parentNode: null,
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    hasAttribute(k) { return attrs.has(k); },
    removeAttribute(k) { attrs.delete(k); },
    append(...kids) {
      for (const k of kids) { k.parentNode = el; k.parentElement = el; el.children.push(k); }
    },
    appendChild(k) { el.append(k); return k; },
    remove() {
      const p = el.parentNode;
      if (p === null) return;
      const i = p.children.indexOf(el);
      if (i >= 0) p.children.splice(i, 1);
      el.parentNode = null;
    },
    addEventListener(type, fn) { el.listeners.set(type, fn); },
    removeEventListener(type) { el.listeners.delete(type); },
    click() { const fn = el.listeners.get('click'); if (fn) fn({ target: el }); },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
  };
  return el;
}

function makeEnv({ width = 390, height = 844, visualViewport = null, storage = null, withSidebar = false, withPage = false } = {}) {
  const html = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body');
  const created = [];
  // withSidebar：造一份「侧栏还挂在 AppFrame 里」的最小 DOM，用来验浮窗打开与位置记忆
  let sidebar = null;
  if (withSidebar) {
    const frame = makeEl('div');
    const col = makeEl('div');
    col.className = 'mP3x-q_sidebarCol';
    frame.append(col);
    sidebar = { frame, col };
  }
  // withPage：模拟从浮窗点开「插件」后宿主换上来的整页面板
  const page = withPage ? makeEl('section') : null;
  if (page !== null) page.className = 'V7pFBG_page';
  const doc = {
    documentElement: html,
    head,
    body,
    createElement(tag) { const el = makeEl(tag); created.push(el); return el; },
    querySelector(sel) {
      const s = String(sel);
      if (s.includes('section[class*="_page"]')) return page;
      if (sidebar !== null && s.includes('_sidebarCol')) return sidebar.col;
      return null;
    },
    querySelectorAll() { return []; },
    listeners: new Map(),
    addEventListener(type, fn) { doc.listeners.set(type, fn); },
    removeEventListener(type) { doc.listeners.delete(type); },
  };
  const modules = [];
  const win = {
    innerWidth: width,
    innerHeight: height,
    listeners: new Map(),
    addEventListener(type, fn) { win.listeners.set(type, fn); },
    removeEventListener(type) { win.listeners.delete(type); },
    __ModuleLoader__: { load(mod) { modules.push(mod); } },
  };
  win.visualViewport = visualViewport;
  win.localStorage = storage;
  win.window = win;
  win.document = doc;
  return { win, doc, html, head, body, modules, created };
}

function run(env) {
  const sandboxWindow = env.win;
  const fn = new Function('window', 'document', 'MutationObserver', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', clientSrc);
  const timers = [];
  const intervals = [];
  const fakeSetTimeout = (cb) => { timers.push(cb); return timers.length; };
  const fakeSetInterval = (cb) => { intervals.push(cb); return intervals.length; };
  class FakeObserver {
    constructor() { this.cb = null; }
    observe() {}
    disconnect() {}
  }
  fn(sandboxWindow, env.doc, FakeObserver, fakeSetTimeout, () => {}, fakeSetInterval, () => {});
  return { timers, intervals };
}

async function boot(env, opts) {
  const ctl = run(env);
  const mod = env.modules[0];
  assert.ok(mod, 'should call window.__ModuleLoader__.load');
  const disposers = [];
  const ctx = {
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
  };
  const api = mod.factory(() => ({}));
  api.apply(ctx);
  // 第一次 setTimeout(boot, 0)：让它真正把样式和浮键挂上
  while (ctl.timers.length > 0) { const cb = ctl.timers.shift(); cb(); }
  return { mod, api, disposers, ctl };
}

test('模块 id 与注册方式', async () => {
  const env = makeEnv();
  const { mod, api } = await boot(env);
  assert.equal(mod.id, 'dsh-mobile-ui');
  assert.equal(typeof mod.factory, 'function');
  assert.deepEqual(api.inject, []);
  assert.equal(typeof api.apply, 'function');
});

test('package.json 是浏览器侧插件包', () => {
  assert.equal(pkg.name, 'dsh-mobile-ui');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.dsh.client.immediately, true);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.ok(pkg.peerDependencies.cordis);
});

test('cordis.patch.yml 插入 mobile-ui', () => {
  assert.match(patch, /insert:/);
  assert.match(patch, /id: mobile-ui/);
  assert.match(patch, /name: dsh-mobile-ui/);
});

test('样式挂到 head 且带 data-plugin 标记', async () => {
  const env = makeEnv();
  await boot(env);
  const styles = env.head.children.filter((c) => c.tagName === 'STYLE');
  assert.equal(styles.length, 1);
  assert.equal(styles[0].dataset.plugin, 'dsh-mobile-ui');
  assert.ok(styles[0].textContent.includes('data-mui=phone'));
});

test('390x844 打上 data-mui=phone 并算出 --mui-vh', async () => {
  const env = makeEnv({ width: 390, height: 844 });
  await boot(env);
  assert.equal(env.html.getAttribute('data-mui'), 'phone');
  assert.equal(env.html.style.getPropertyValue('--mui-vh'), '844px');
});

test('有 visualViewport 时 --mui-vh 跟它走（键盘弹出不被挡）', async () => {
  const env = makeEnv({ width: 390, height: 844, visualViewport: { height: 512, addEventListener() {}, removeEventListener() {} } });
  await boot(env);
  assert.equal(env.html.style.getPropertyValue('--mui-vh'), '512px');
});

test('820x1180 打上 data-mui=tablet', async () => {
  const env = makeEnv({ width: 820, height: 1180 });
  await boot(env);
  assert.equal(env.html.getAttribute('data-mui'), 'tablet');
});

test('844x390 横屏手机也走 phone 档', async () => {
  const env = makeEnv({ width: 844, height: 390 });
  await boot(env);
  assert.equal(env.html.getAttribute('data-mui'), 'phone');
});

test('宽屏不打 data-mui（桌面不受影响）', async () => {
  const env = makeEnv({ width: 1440, height: 900 });
  await boot(env);
  assert.equal(env.html.getAttribute('data-mui'), null);
});

test('汉堡键与遮罩挂在 body 上', async () => {
  const env = makeEnv();
  await boot(env);
  const fab = env.body.children.find((c) => c.dataset.muiFab !== undefined);
  const backdrop = env.body.children.find((c) => c.dataset.muiBackdrop !== undefined);
  assert.ok(fab, 'should append a fab');
  assert.ok(backdrop, 'should append a backdrop');
  assert.equal(fab.getAttribute('aria-label'), '打开侧栏');
  assert.equal(backdrop.getAttribute('aria-label'), '关闭侧栏');
});

test('卸载时把样式、浮键和 html 属性都清掉', async () => {
  const env = makeEnv();
  const { disposers } = await boot(env);
  assert.equal(disposers.length, 1);
  disposers[0]();
  assert.equal(env.head.children.filter((c) => c.tagName === 'STYLE').length, 0);
  assert.equal(env.body.children.length, 0);
  assert.equal(env.html.getAttribute('data-mui'), null);
  assert.equal(env.html.style.getPropertyValue('--mui-vh'), '');
});

test('CSS 不用裸的 [class*="_frame"] 认 AppFrame', () => {
  // 消息列表 V4vHZW_frame / 占位 SNx2jG_frame 也以 _frame 结尾，裸选择器会把它们
  // 的高度锁成视口高，输入框会被挤出屏幕（真踩过）。
  const css = clientSrc;
  assert.ok(!css.includes('html[data-mui=phone] [class*="_frame"]'));
  assert.ok(css.includes('[data-mui-frame]'));
});

test('CSS 只在 data-mui 下生效，且带安全区', () => {
  assert.ok(clientSrc.includes('env(safe-area-inset-bottom'));
  assert.ok(clientSrc.includes('[data-mui-backdrop]'));
  assert.ok(clientSrc.includes('[data-mui-fab]'));
});

test('侧栏是悬浮卡片、汉堡键是浮键，顶栏让位', () => {
  // 样式在 client.js 里是 JSON 字符串，双引号前面带反斜杠；剥掉再比对选择器
  const BS = String.fromCharCode(92);
  const flat = clientSrc.split(BS).join('');
  // 侧栏是浮窗的窗身：标题栏（34px）在下、窗身占剩下的高度，只有下面两个角是圆的
  assert.ok(flat.includes('border-radius: 0 0 18px 18px'));
  // 收起要挪到屏幕外：用 100vw 而不是 100%，浮窗被拖到右边时百分比会漏出来
  assert.ok(flat.includes('translateX(calc(-100vw - 80px))'));
  assert.ok(!flat.includes('translateX(calc(-100% - 16px))'));
  // 汉堡键不能压住顶栏的标题与「对话/轨迹」标签：两处都右移 52px
  assert.ok(flat.includes('[class*="_header"] [class*="_titleRow"]'));
  assert.ok(flat.includes('[class*="_header"] [class*="_tabs"]'));
  assert.ok(flat.includes('padding-left: 52px'));
  // 直接子元素组合选择器在真实 DOM 里匹配不到 titleRow（父级不是 header），别再写回去
  assert.ok(!flat.includes('> [class*="_titleRow"]'));
});

// ---- 浮窗（0.2.0）----

function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

test('浮窗标题栏、二级页收起键、页遮罩都挂在 body 上', async () => {
  const env = makeEnv();
  await boot(env);
  const winbar = env.body.children.find((c) => c.dataset.muiWinbar !== undefined);
  const pageClose = env.body.children.find((c) => c.dataset.muiPageclose !== undefined);
  const pageBackdrop = env.body.children.find((c) => c.dataset.muiPagebackdrop !== undefined);
  assert.ok(winbar, 'should append a window title bar');
  assert.ok(pageClose, 'should append a page close button');
  assert.ok(pageBackdrop, 'should append a page backdrop');
  assert.equal(winbar.getAttribute('role'), 'presentation');
  const barClose = winbar.children.find((c) => c.dataset.muiWinbarClose !== undefined);
  assert.equal(barClose.getAttribute('aria-label'), '关闭菜单');
  assert.equal(pageClose.getAttribute('aria-label'), '收起面板');
  assert.equal(pageBackdrop.getAttribute('aria-label'), '关闭面板');
  // 把手 + 标题
  assert.ok(winbar.children.some((c) => c.dataset.muiWinbarGrip !== undefined));
  const title = winbar.children.find((c) => c.dataset.muiWinbarTitle !== undefined);
  assert.equal(title.textContent, '菜单');
});

test('抽屉打开时按视口算好浮窗尺寸与位置', async () => {
  const env = makeEnv({ withSidebar: true });
  await boot(env);
  assert.equal(env.html.getAttribute('data-mui-drawer'), 'open');
  // 390 宽：宽 = min(84vw=328, 312) = 312；高 = min(844-16, 620) = 620
  assert.equal(env.html.style.getPropertyValue('--mui-win-w'), '312px');
  assert.equal(env.html.style.getPropertyValue('--mui-win-h'), '620px');
  assert.equal(env.html.style.getPropertyValue('--mui-win-x'), '8px');
  assert.equal(env.html.style.getPropertyValue('--mui-win-y'), '8px');
});

test('位置记忆：存过就按存的来，越界夹回视口里', async () => {
  const storage = makeStorage({ 'dsh-mobile-ui:win:drawer': '{"x":9999,"y":200}' });
  const env = makeEnv({ withSidebar: true, storage });
  await boot(env);
  // 右边界 = 390 - 312 - 8 = 70
  assert.equal(env.html.style.getPropertyValue('--mui-win-x'), '70px');
  assert.equal(env.html.style.getPropertyValue('--mui-win-y'), '200px');
});

test('拖标题栏挪窗口，松手才把位置存进 localStorage', async () => {
  const storage = makeStorage();
  const env = makeEnv({ withSidebar: true, storage });
  await boot(env);
  const winbar = env.body.children.find((c) => c.dataset.muiWinbar !== undefined);
  const down = winbar.listeners.get('pointerdown');
  assert.equal(typeof down, 'function');
  down({ button: 0, clientX: 20, clientY: 20, target: null, cancelable: true, preventDefault() {} });
  // 拖动过程中还没存
  assert.equal(storage.getItem('dsh-mobile-ui:win:drawer'), null);
  const move = env.doc.listeners.get('pointermove');
  assert.equal(typeof move, 'function');
  move({ clientX: 60, clientY: 50, pointerId: undefined, cancelable: true, preventDefault() {} });
  assert.equal(env.html.style.getPropertyValue('--mui-win-x'), '48px');
  assert.equal(env.html.style.getPropertyValue('--mui-win-y'), '38px');
  const up = env.doc.listeners.get('pointerup');
  up({});
  assert.equal(storage.getItem('dsh-mobile-ui:win:drawer'), '{"x":48,"y":38}');
});

test('二级整页面板当浮窗：写尺寸、打 data-mui-page、收起键贴右上角', async () => {
  const env = makeEnv({ withPage: true });
  await boot(env);
  assert.equal(env.html.getAttribute('data-mui-page'), 'open');
  // 390 宽：宽 = min(390-16, 430) = 374；高 = min(844-16, 640) = 640
  assert.equal(env.html.style.getPropertyValue('--mui-page-w'), '374px');
  assert.equal(env.html.style.getPropertyValue('--mui-page-h'), '640px');
  assert.equal(env.html.style.getPropertyValue('--mui-page-x'), '8px');
  assert.equal(env.html.style.getPropertyValue('--mui-page-y'), '56px');
  // 收起键贴在窗口右上角：x + w - 38，y + 7
  assert.equal(env.html.style.getPropertyValue('--mui-page-close-x'), '344px');
  assert.equal(env.html.style.getPropertyValue('--mui-page-close-y'), '63px');
});

test('没有二级页时不打 data-mui-page', async () => {
  const env = makeEnv({ withSidebar: true });
  await boot(env);
  assert.equal(env.html.getAttribute('data-mui-page'), null);
});

test('CSS：浮窗位置全走变量，页头当把手，别写死 100%', () => {
  const BS = String.fromCharCode(92);
  const flat = clientSrc.split(BS).join('');
  assert.ok(flat.includes('var(--mui-win-x'));
  assert.ok(flat.includes('var(--mui-win-y'));
  assert.ok(flat.includes('var(--mui-win-w'));
  assert.ok(flat.includes('var(--mui-win-h'));
  assert.ok(flat.includes('var(--mui-page-x'));
  assert.ok(flat.includes('var(--mui-page-w'));
  // 手机上手一滑就滚页面了，把手必须 touch-action:none
  assert.ok(flat.includes('touch-action: none'));
  // 二级页的页头当把手
  assert.ok(flat.includes('section[class*="_page"] > header[class*="_pageHead"]'));
  assert.ok(flat.includes('[data-mui-pageclose]'));
  assert.ok(flat.includes('[data-mui-pagebackdrop]'));
  assert.ok(flat.includes('[data-mui-winbar]'));
  // 二级页浮窗开着时，汉堡键让位（横屏矮屏上它会被夹到页左上角，压住标题）
  assert.ok(flat.includes('[data-mui-page=open] [data-mui-fab]'));
});

test('卸载时把浮窗标题栏、二级页按钮一起清掉', async () => {
  const env = makeEnv({ withSidebar: true, withPage: true });
  const { disposers } = await boot(env);
  disposers[0]();
  assert.equal(env.body.children.length, 0);
  assert.equal(env.html.getAttribute('data-mui-drawer'), null);
  assert.equal(env.html.getAttribute('data-mui-page'), null);
  assert.equal(env.html.style.getPropertyValue('--mui-win-x'), '');
  assert.equal(env.html.style.getPropertyValue('--mui-page-x'), '');
});
