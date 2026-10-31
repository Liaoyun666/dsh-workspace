// Unit tests for the patched helpers, sliced out of the real bundle so the tests
// run against exactly what ships.
import fs from 'node:fs';

const file = process.argv[2] ?? 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-workbuddy-bridge/lib/client.js';
const code = fs.readFileSync(file, 'utf8');

function slice(startMarker, endMarker) {
  const i = code.indexOf(startMarker);
  if (i < 0) throw new Error(`missing start marker: ${startMarker}`);
  const j = code.indexOf(endMarker, i);
  if (j < 0) throw new Error(`missing end marker: ${endMarker}`);
  return code.slice(i, j + endMarker.length);
}

const helpers = slice('const SHARED_STATUS_TTL_MS', '\n\t\t}\n\t\tconst POLL_INTERVAL_MS = 12e4;');
const isProbe = slice('function isProbeSection(', '\n\t\t}');
const isEffort = slice('function isEffortRow(', '\n\t\t}');
const isVisibility = slice('function isVisibilitySection(', '\n\t\t}');
const isStatus = slice('function isWorkBuddyWebStatus(', '\n\t\t}');
const isCredits = slice('function isWorkBuddySessionCredits(', '\n\t\t}');
const pollMs = 'const POLL_INTERVAL_MS$1 = 3e4;';

// --- fake browser (timers are real so debounce actually fires) --------------
const timers = [];
const focusHandlers = new Set();
const track = (kind) => (fn, ms) => {
  const t = { ms, kind, live: true };
  const fire = () => { if (!t.live) return; if (kind === 'timeout') t.live = false; fn(); };
  t.handle = kind === 'timeout' ? setTimeout(fire, ms) : setInterval(fire, ms);
  timers.push(t);
  return t;
};
const untrack = (t) => { if (t) { t.live = false; if (t.handle) { clearTimeout(t.handle); clearInterval(t.handle); } } };
globalThis.window = {
  setTimeout: track('timeout'),
  clearTimeout: untrack,
  setInterval: track('interval'),
  clearInterval: untrack,
  addEventListener: (name, fn) => { if (name === 'focus') focusHandlers.add(fn); },
  removeEventListener: (name, fn) => { if (name === 'focus') focusHandlers.delete(fn); },
};

let fetchCalls = [];
let nextCredits = { msg1: 0.04 };
globalThis.fetch = async (url) => {
  fetchCalls.push(url);
  await new Promise((r) => setImmediate(r));
  return { ok: true, status: 200, json: async () => ({ sessionId: 's1', credits: nextCredits }) };
};

const sandbox = { window: globalThis.window, fetch: globalThis.fetch, Date, Set, Map, Array, Number, String, Promise, Intl, Math, AbortController, isWorkBuddyWebStatus: null };
const src = `
${isEffort}
${isProbe}
${isVisibility}
${isStatus}
${isCredits}
${pollMs}
${helpers}
return { readStatusShared, subscribeFocusRefresh, openSessionCreditStore, sessionCreditStores, parseCreditRate, estimateTokensFromCredits, formatTokenEstimate, modelNameFor, creditsPerToken, chargeFor, MODEL_CHARGE, DEFAULT_CHARGE };
`;
const api = new Function('window', 'fetch', 'Date', 'Set', 'Map', 'AbortController', 'Intl', src)(
  globalThis.window, globalThis.fetch, Date, Set, Map, AbortController, Intl,
);

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else { failures += 1; console.log(`FAIL ${name} ${extra}`); }
};

const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r)); };

// --- 1. per-session store dedupes the poll across many subscribers ----------
{
  fetchCalls = [];
  const subs = [];
  for (let i = 0; i < 40; i += 1) {
    const store = api.openSessionCreditStore('/plugins/x/credit', 's1');
    store.listeners.add(() => {});
    store.refs += 1;
    store.start();
    subs.push(store);
  }
  await flush();
  check('40 message rows share one store', api.sessionCreditStores.size === 1, `size=${api.sessionCreditStores.size}`);
  check('40 message rows cause one request', fetchCalls.length === 1, `calls=${fetchCalls.length}`);
  check('one interval for the session', timers.filter((t) => t.kind === 'interval' && t.live).length === 1);
  check('one focus listener for the session', focusHandlers.size === 1, `n=${focusHandlers.size}`);
  check('store got the credits', subs[0].credits?.msg1 === 0.04);

  // focus storm collapses into a single read
  fetchCalls = [];
  for (const fn of [...focusHandlers]) fn();
  await new Promise((r) => setTimeout(r, 260));
  await flush();
  check('focus storm collapses to one read', fetchCalls.length === 1, `calls=${fetchCalls.length}`);

  // second focus inside the 5s gap is dropped
  fetchCalls = [];
  for (const fn of [...focusHandlers]) fn();
  await new Promise((r) => setTimeout(r, 260));
  await flush();
  check('repeat focus inside gap dropped', fetchCalls.length === 0, `calls=${fetchCalls.length}`);

  // subscribers unmount -> polling stops, store is forgotten
  for (const store of subs) { store.refs -= 1; if (store.refs <= 0) { store.stop(); api.sessionCreditStores.delete(store.key); } }
  check('store forgotten after last unmount', api.sessionCreditStores.size === 0);
  check('intervals cleared', timers.filter((t) => t.kind === 'interval' && t.live).length === 0);
  check('focus listeners removed', focusHandlers.size === 0);
}

// --- 2. status cache: TTL reuse, single-flight, force bypass -----------------
{
  let calls = 0;
  const fetchStatus = async () => { calls += 1; await new Promise((r) => setImmediate(r)); return { ok: true, json: async () => ({ status: 'signed-in', probe: { models: [] }, visibility: { hidden: [] } }) }; };
  globalThis.fetch = fetchStatus;
  // re-create the reader against the new fetch by re-evaluating the slice
  const api2 = new Function('window', 'fetch', 'Date', 'Set', 'Map', 'AbortController', 'Intl', src)(
    globalThis.window, fetchStatus, Date, Set, Map, AbortController, Intl,
  );
  const p = [api2.readStatusShared('/p', {}), api2.readStatusShared('/p', {}), api2.readStatusShared('/p', {})];
  await Promise.all(p);
  check('concurrent status reads collapse to one', calls === 1, `calls=${calls}`);
  await api2.readStatusShared('/p', {});
  check('status read inside TTL is free', calls === 1, `calls=${calls}`);
  await api2.readStatusShared('/p', { force: true });
  check('force read bypasses TTL', calls === 2, `calls=${calls}`);
}

// --- 3. token estimate ------------------------------------------------------
{
  const models = [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', credits: 'x0.11' },
    { id: 'hy3', name: 'Hy3', credits: 'x0.00' },
    { id: 'kimi-k3-1', name: 'Kimi K3.1', credits: 'x1.62' },
    { id: 'weird', name: 'Weird' },
  ];
  check('rate parsed', api.parseCreditRate(models, 'deepseek-v4.1-flash') === 0.11);
  check('missing rate -> undefined', api.parseCreditRate(models, 'weird') === undefined);
  check('unknown model -> undefined', api.parseCreditRate(models, 'nope') === undefined);
  check('non-array safe', api.parseCreditRate(undefined, 'x') === undefined);
  const t1 = api.estimateTokensFromCredits(2251, 0.11, 'deepseek-v4.1-flash');
  // 1 token costs rate * (mixed coefficients) credits, so credits / that is the count.
  check('flash estimate uses its own coefficients',
    Math.abs(t1 - 2251 / api.creditsPerToken(0.11, 'deepseek-v4.1-flash')) < 1e-6, `got ${t1}`);
  // The whole point of the per-model table: two models at DIFFERENT multipliers can still
  // land at very different token counts, and the same multiplier on a dearer model buys less.
  const tKimi = api.estimateTokensFromCredits(2251, 1.62, 'kimi-k3-1');
  const tGlm = api.estimateTokensFromCredits(2251, 0.69, 'glm-5.3');
  check('kimi buys far fewer tokens than flash', tKimi < t1 / 30, `kimi=${tKimi} flash=${t1}`);
  check('glm-5.3 uses glm coefficients, not a global constant',
    Math.abs(tGlm - 2251 / api.creditsPerToken(0.69, 'glm-5.3')) < 1e-6, `got ${tGlm}`);
  check('per-model rates differ beyond the multiplier',
    Math.abs(api.creditsPerToken(0.08, 'glm-5.3-flash') / 0.08
      - api.creditsPerToken(0.08, 'minimax-m3.1-flash') / 0.08) > 1e-6,
    'coefficients must not be a single global constant');
  check('unknown model falls back to the median', api.chargeFor('brand-new-model') === api.DEFAULT_CHARGE);
  check('prefix match finds a drifted id', api.chargeFor('kimi-k3-1-preview').a === api.MODEL_CHARGE['kimi-k3-1'].a);
  check('free model -> Infinity', api.estimateTokensFromCredits(2251, 0, 'hy3') === Number.POSITIVE_INFINITY);
  check('no rate -> undefined', api.estimateTokensFromCredits(2251, undefined, 'deepseek-v4.1-flash') === undefined);
  check('bad total -> undefined', api.estimateTokensFromCredits(undefined, 0.11, 'deepseek-v4.1-flash') === undefined);
  check('format millions', api.formatTokenEstimate(28_200_000) === new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(28_200_000));
  check('format infinity', api.formatTokenEstimate(Number.POSITIVE_INFINITY) === '\u221E');
  check('model name', api.modelNameFor(models, 'kimi-k3-1') === 'Kimi K3.1');
  check('model name fallback', api.modelNameFor(models, 'zzz') === 'zzz');
  check('model name no models', api.modelNameFor(undefined, 'zzz') === 'WorkBuddy');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
