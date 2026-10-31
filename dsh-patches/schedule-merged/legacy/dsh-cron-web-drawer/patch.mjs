/**
 * dsh-cron 右侧抽屉补丁（幂等）。
 *
 * 背景：上游 dsh-cron 0.3.1 的宿主半边这样挂 HTTP API：
 *
 *     ctx.inject(['webServer', 'webRuntime'], (webCtx) => {
 *       const fence = (req) => isTrustedApiRequest(req, webCtx.webRuntime.trustedHosts)
 *
 * 而 DSH 0.2.1 起把 trustedHosts 从 webRuntime 服务搬到了 webStartup 服务，
 * 并且 webRuntime 这个名字在 0.2.x 里根本不存在。Cordis 的规则是：inject 里列了
 * 宿主没有的服务，该 entry 会永久 pending（上游 issue #109）。结果整块 inject 从不
 * 激活 —— /cron/api 前缀路由一次都没注册，Web 抽屉点开只能拿到 405。
 *
 * 补丁做两件事（都只改宿主半边 index.js，客户端 bundle 不动）：
 *   1. inject 只保留 webServer（0.2.x 里真实存在的服务）；
 *   2. fence 用的 trustedHosts 改用 ctx.get() 现取：先 webStartup（0.2.1+），
 *      再退回 webRuntime（<= 0.2.0）。ctx.get() 是文档化的「无需 inject 读取」入口，
 *      服务缺失返回 undefined，不会让 entry 挂住。
 *
 * 安全面不变：isTrustedApiRequest 仍然要求 Host 头是回环地址或命中 trustedHosts，
 * 再拒绝 sec-fetch-site: cross-site。trustedHosts 只是可选的额外放行。
 *
 * 用法（插件被 npm/pnpm 更新覆盖后重跑即可）：
 *   node patch.mjs
 * 可选环境变量：
 *   DSH_CRON_DIR      插件根目录（默认 ~/.dsh/profiles/desktop/node_modules/dsh-cron）
 *   DSH_CRON_BACKUP   备份目录（默认 ~/.dsh/dsh-cron-patches/backup）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PKG = process.env.DSH_CRON_DIR || join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-cron');
const BACKUP = process.env.DSH_CRON_BACKUP || join(homedir(), '.dsh', 'dsh-cron-patches', 'backup');
const FILE = join(PKG, 'index.js');

const fail = (msg) => {
  console.error('PATCH FAILED: ' + msg);
  process.exit(1);
};

if (!existsSync(FILE)) fail('文件不存在：' + FILE);
const raw = readFileSync(FILE, 'utf8');
const lines = raw.split('\n');

/** 找到唯一一行满足 pred，返回 0-based 下标；0 次或多次都报错 */
function findUnique(pred, label) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (pred(lines[i])) hits.push(i);
  if (hits.length !== 1) fail(FILE + ': 锚点「' + label + '」命中 ' + hits.length + ' 次（期望 1 次）');
  return hits[0];
}

function backupOnce() {
  const target = join(BACKUP, 'index.js');
  if (!existsSync(target)) {
    mkdirSync(BACKUP, { recursive: true });
    copyFileSync(FILE, target);
    console.log('  backup -> ' + target);
  }
}

function save() {
  writeFileSync(FILE, lines.join('\n'), 'utf8');
}

// ------------------------------------------------------------ 已打过就跳过
if (lines.some((l) => l.includes('isTrustedApiRequest(req, trustedHosts())'))) {
  console.log('已打过补丁，跳过：' + FILE);
  process.exit(0);
}

// ------------------------------------------------------------ 1) inject 只留 webServer
const injectIdx = findUnique(
  (l) => l.trim() === "ctx.inject(['webServer', 'webRuntime'], (webCtx) => {",
  "ctx.inject(['webServer', 'webRuntime'], (webCtx) => {",
);
lines[injectIdx] = lines[injectIdx].replace("['webServer', 'webRuntime']", "['webServer']");

// ------------------------------------------------------------ 2) fence 用 ctx.get 现取 trustedHosts
const fenceIdx = findUnique(
  (l) => l.trim() === 'const fence = (req) => isTrustedApiRequest(req, webCtx.webRuntime.trustedHosts)',
  'const fence = (req) => isTrustedApiRequest(req, webCtx.webRuntime.trustedHosts)',
);
const INSERTED = 12;
const indent = lines[fenceIdx].match(/^\s*/)[0];
// 保留原文件的换行风格：插件文件是 CRLF，插入行也必须带 CR，否则文件变成混排。
const EOL = raw.length > 0 && (raw.match(/\r\n/g) ?? []).length > (raw.match(/\n/g) ?? []).length / 2 ? '\r' : '';
lines.splice(
  fenceIdx,
  1,
  indent + '// trustedHosts lives on webRuntime in DSH <= 0.2.0 and on webStartup in DSH >= 0.2.1.',
  indent + '// Both are read through ctx.get(), never ctx.webRuntime / ctx.webStartup: neither name',
  indent + '// can be listed in inject (a service the host lacks leaves the entry permanently',
  indent + '// pending), and ctx.get() is the documented read-without-inject entry point.',
  indent + 'const trustedHosts = () => {',
  indent + "  const startup = ctx.get('webStartup')",
  indent + '  if (startup !== undefined && startup !== null) return startup.trustedHosts ?? []',
  indent + "  const runtime = ctx.get('webRuntime')",
  indent + '  if (runtime !== undefined && runtime !== null) return runtime.trustedHosts ?? []',
  indent + '  return []',
  indent + '}',
  indent + 'const fence = (req) => isTrustedApiRequest(req, trustedHosts())',
);
// 给刚插入的这批行补回文件本来的行尾（CRLF 文件里 CR 被 split('\n') 留在了上一行末尾）
if (EOL !== '') for (let i = 0; i < INSERTED; i++) lines[fenceIdx + i] = lines[fenceIdx + i].replace(/\r$/, '') + EOL;

backupOnce();
save();

// ------------------------------------------------------------ 自检
const after = readFileSync(FILE, 'utf8');
const checks = [
  ["ctx.inject(['webServer'], (webCtx) => {", 'inject 只剩 webServer'],
  ['isTrustedApiRequest(req, trustedHosts())', 'fence 用 trustedHosts()'],
  ["ctx.get('webStartup')", '读 webStartup'],
  ["ctx.get('webRuntime')", '读 webRuntime'],
];
let bad = 0;
for (const [needle, label] of checks) {
  if (!after.includes(needle)) {
    console.error('  SELF-CHECK FAILED: ' + label + '（找不到 ' + JSON.stringify(needle) + '）');
    bad += 1;
  }
}
if (after.includes('webCtx.webRuntime.trustedHosts')) {
  console.error('  SELF-CHECK FAILED: 旧写法 webCtx.webRuntime.trustedHosts 仍然存在');
  bad += 1;
}
const bareLf = after.split('\n').slice(0, -1).filter((l) => !l.endsWith('\r')).length;
if (EOL === '' ? bareLf !== after.split('\n').length - 1 : bareLf !== 0) {
  console.error('  SELF-CHECK FAILED: 文件出现混排行尾（bare LF ' + bareLf + ' 行）');
  bad += 1;
}
if (bad > 0) fail('补丁写完后自检失败（备份在 ' + BACKUP + '）');

console.log('OK：' + FILE);
console.log('  inject [webServer]  |  fence -> trustedHosts() via ctx.get');
console.log('下一步：让运行中的 DSH 重新组合 profile（HMR）后访问 POST /cron/api/list 验证。');
