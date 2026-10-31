// Renders the patched WorkBuddyCreditBalance out of the live bundle with stub React
// primitives, so the dock row (credit / multiplier / token estimate) can be asserted
// without a browser. Usage: node test_render2.mjs [path-to-client.js]
import fs from 'node:fs';

const file = process.argv[2] ?? 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-workbuddy-bridge/lib/client.js';
const src = fs.readFileSync(file, 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`markers missing: ${from} .. ${to}`);
  return src.slice(a, b);
};
const helpers = cut('\t\tconst SHARED_STATUS_TTL_MS', '\t\tconst POLL_INTERVAL_MS = 12e4;');
const component = cut('\t\tfunction WorkBuddyCreditBalance(', '\t\t//#endregion');

const models = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', credits: 'x0.11' },
  { id: 'hy3', name: 'Hy3', credits: 'x0.00' },
  { id: 'kimi-k3-1', name: 'Kimi K3.1', credits: 'x1.62' },
  { id: 'DeepSeek-V4.1-Flash', name: 'Case variant', credits: 'x0.11' },
];

const mod = new Function(
  'react', 'react_jsx_runtime', 'window', 'fetch', 'isWorkBuddyWebStatus', 'document',
  'CoinGlyph', 'cardVariantFor', 'formatCredit', 'credit_balance_module_css_default',
  helpers + component + '\nreturn { WorkBuddyCreditBalance, parseCreditRate, estimateTokensFromCredits, formatTokenEstimate };',
);

const CLASSES = { amount: 'A', dock: 'D', estimate: 'E', rate: 'RT', readout: 'R' };

function api(selection) {
  const react = {
    useSyncExternalStore: () => ({ current: selection }),
    useState: (init) => [init, () => {}],
    useRef: (init) => ({ current: init }),
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  const jsx = (type, props, key) => ({ type, props, key });
  return mod(react, { jsx, jsxs: jsx },
    { setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {} },
    async () => { throw new Error('no network in this test'); }, (v) => v !== undefined, {},
    () => 'CoinGlyph',
    (p) => (p === 'workbuddy' ? { id: 'workbuddy', appName: 'WorkBuddy' } : undefined),
    (c) => (Number.isInteger(c) ? String(c) : c.toFixed(2).replace(/\.?0+$/u, '')),
    CLASSES);
}

// the balance state is read out of useState, so seed it through a per-call module
function render(selection, balance) {
  const react = {
    useSyncExternalStore: () => ({ current: selection }),
    useState: () => [balance, () => {}],
    useRef: (init) => ({ current: init }),
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const bundle = mod(react, { jsx, jsxs: jsx },
    { setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {} },
    async () => { throw new Error('no network in this test'); }, (v) => v !== undefined, {},
    () => 'CoinGlyph',
    (p) => (p === 'workbuddy' ? { id: 'workbuddy', appName: 'WorkBuddy' } : undefined),
    (c) => (Number.isInteger(c) ? String(c) : c.toFixed(2).replace(/\.?0+$/u, '')),
    CLASSES);
  return bundle.WorkBuddyCreditBalance({ directory: { subscribe() {}, getSnapshot() {} }, t: (k, v) => (v ? `${k}${JSON.stringify(v)}` : k) });
}

const flatten = (node) => {
  if (node === 'CoinGlyph') return 'CoinGlyph';
  if (node === void 0 || node === null) return '';
  if (!node.props) return String(node);
  const kids = node.props.children;
  if (kids === void 0) return `${node.props.className ?? node.type}(empty)`;
  const list = Array.isArray(kids) ? kids : [kids];
  return `${node.props.className ?? node.type}[${list.map(flatten).join(' , ')}]`;
};
const parts = (tree) => (tree.props.children ?? []).map(flatten);

let failed = 0;
const check = (label, got, want) => {
  const ok = typeof got === 'boolean' || typeof want === 'boolean'
    ? got === want
    : String(got).includes(String(want));
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${got}`);
};

// 1. the row lives in the dock container and shows credit, multiplier, estimate
let tree = render({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }, { kind: 'total', total: 2251, models });
check('dock container class', tree.props.className, CLASSES.dock);
check('flash credit', parts(tree)[1], 'A[2251]');
check('flash multiplier', parts(tree)[2], 'RT[tokenEstimateRate{"rate":"0.11"}]');
check('flash estimate', parts(tree)[3], 'E[tokenEstimate{"tokens":');
check('dock title mentions model', tree.props.title, 'DeepSeek V4.1 Flash');

// 2. a free model reports free instead of a number
tree = render({ provider: 'workbuddy', model: 'hy3' }, { kind: 'total', total: 2251, models });
check('free model', parts(tree)[3], 'E[tokenEstimateFree]');

// 3. the expensive model buys fewer tokens than the cheap one
const numOf = (t) => Number((parts(t)[3].match(/tokens":("?)([\d.]+)/) ?? [])[2]);
const flashTokens = numOf(render({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }, { kind: 'total', total: 2251, models }));
const kimiTokens = numOf(render({ provider: 'workbuddy', model: 'kimi-k3-1' }, { kind: 'total', total: 2251, models }));
check('kimi shows multiplier', parts(render({ provider: 'workbuddy', model: 'kimi-k3-1' }, { kind: 'total', total: 2251, models }))[2], 'RT[tokenEstimateRate{"rate":"1.62"}]');
check('kimi is smaller than flash', kimiTokens < flashTokens, true);

// 4. unlimited / unknown model: no estimate, no multiplier, no crash
tree = render({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }, { kind: 'unlimited' });
check('unlimited credit', parts(tree)[1], 'A[creditRemainingUnlimited]');
check('unlimited has no estimate', parts(tree).length === 2, true);
tree = render({ provider: 'workbuddy', model: 'unknown-model' }, { kind: 'total', total: 2251, models });
check('unknown model has no estimate', parts(tree).length === 2, true);

// 5. non-workbuddy providers render nothing
check('other provider renders null', render({ provider: 'deepseek-official', model: 'x' }, { kind: 'total', total: 1, models }) === null, true);

// 6. the multiplier lookup survives a drifted catalog id and the maths holds up
const bundle = api({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' });
check('exact id', bundle.parseCreditRate(models, 'deepseek-v4.1-flash'), '0.11');
check('case-insensitive id', bundle.parseCreditRate(models, 'DeepSeek-V4.1-Flash'), '0.11');
check('unknown id', bundle.parseCreditRate(models, 'nope'), 'undefined');
check('non-array safe', bundle.parseCreditRate(void 0, 'x'), 'undefined');
check('rate 0 is infinity', bundle.estimateTokensFromCredits(2251, 0), 'Infinity');
check('missing total', bundle.estimateTokensFromCredits(void 0, 0.11), 'undefined');
check('infinity prints as the symbol', bundle.formatTokenEstimate(Number.POSITIVE_INFINITY), '\u221E');

console.log(failed === 0 ? '\nALL PASS' : `\nFAILED ${failed}`);
process.exit(failed === 0 ? 0 : 1);
