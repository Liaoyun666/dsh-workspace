import assert from 'node:assert/strict';
import test from 'node:test';


// ── 浏览器环境桩：只验证模块能装载、插件体能注册，不渲染 React 组件 ──────────

const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded.push(entry);
    },
  },
};

function fakeElement() {
  return { id: '', textContent: '', appendChild() {}, contains() { return false; } };
}
globalThis.document = {
  head: { appendChild() {} },
  getElementById() { return null; },
  createElement() { return fakeElement(); },
};
globalThis.fetch = async () => { throw new Error('fetch not expected in this test'); };

const registered = [];
const injectedDeps = [];
const localeDictionaries = new Map();

function makeT(ns) {
  return (key, values) => {
    const dict = localeDictionaries.get(ns) ?? {};
    let text = dict[key] ?? key;
    if (values !== undefined && typeof values === 'object') {
      for (const [name, value] of Object.entries(values)) text = text.replaceAll('{' + name + '}', String(value));
    }
    return text;
  };
}

function fakeContext() {
  const ctx = {
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    locale: {
      register(ns, dicts) {
        localeDictionaries.set(ns, { ...(dicts.zh ?? {}), ...(dicts.en ?? {}) });
        return () => {};
      },
      bind(ns) {
        return makeT(ns);
      },
    },
    logger: { warn() {}, info() {} },
  };
  ctx.slots = {
    inject(name, callback) {
      injectedDeps.push('slot:' + name);
      const disposer = callback();
      return () => { if (typeof disposer === 'function') disposer(); };
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    },
  };
  ctx.inject = (deps, callback) => {
    injectedDeps.push(...deps);
    const scope = {
      effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
      slots: ctx.slots,
      configForms: { get: () => ({ subscribe: () => () => {} }) },
      modelDirectories: {
        directoryFor: () => ({
          store: { subscribe: () => () => {}, getSnapshot: () => ({ current: null, groups: [], status: 'ready' }) },
          load: async () => {},
          select: async () => ({ ok: true }),
        }),
      },
      sessions: { subagentAddress: () => undefined },
    };
    callback(scope);
  };
  return ctx;
}

await import(new URL('../lib/client.js', import.meta.url).href);

test('client bundle registers exactly one module under the package id', () => {
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'dsh-relay-think');
  assert.equal(typeof loaded[0].factory, 'function');
});

test('factory materializes exports and registers both UI surfaces', () => {
  const fakeReact = {
    createElement: (...args) => ({ args }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const fakeRequire = (name) => {
    if (name === 'react') return fakeReact;
    if (name === 'react-dom') return { createPortal: (...args) => ({ args }) };
    throw new Error('unexpected require: ' + name);
  };
  const exports = loaded[0].factory(fakeRequire);
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(exports.inject, ['slots', 'locale', 'sessions', 'remote', 'remote.session']);
  assert.equal(exports.SETTINGS_NS, 'llm-pi-ai');

  const ctx = fakeContext();
  exports.apply(ctx);

  const card = registered.find((entry) => entry.options.name === 'settings.models.provider-card');
  assert.ok(card, 'provider-card slot registered');
  assert.equal(card.options.key, 'llm-pi-ai');
  assert.equal(card.options.locale, 'relay-think');
  assert.equal(typeof card.component, 'function');

  const chip = registered.find((entry) => entry.options.name === 'conversation.input.right');
  assert.ok(chip, 'composer effort chip registered');
  assert.equal(chip.options.id, 'relay-think');
  assert.equal(typeof chip.component, 'function');

  assert.ok(injectedDeps.includes('slot:settings.models.provider-card'));
  assert.ok(injectedDeps.includes('slot:conversation.input.right'));
  assert.ok(injectedDeps.includes('modelDirectories'));

  const dict = localeDictionaries.get('relay-think');
  assert.ok(dict['card.title']);
  assert.ok(dict['chip.label']);
  assert.ok(dict['preset.standard']);
});