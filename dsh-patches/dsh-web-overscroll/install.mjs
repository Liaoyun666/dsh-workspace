/**
 * dsh-web-overscroll 重打器（幂等）—— profile 重建 / 插件升级 / 手工清理后跑一遍即可。
 *
 * 现场由三处组成，脚本逐一检查、缺哪补哪：
 *   1) <profile>/node_modules/dsh-web-overscroll  —— 建 junction 指回源目录 dsh-plugins/dsh-web-overscroll
 *   2) <profile>/cordis.patch.yml                —— 补上 insert 块（先备份，已存在则跳过）
 *   3) dsh-agent-preset-compact(-release)/lib/client.js
 *        —— 在 css 模板串开头补两行视口锁（第二个守卫，随 preset 升级可能丢）
 *
 * 用法：
 *   node install.mjs            # 打上（已打则跳过）
 *   node install.mjs --check     # 只看状态，不写文件；齐了退出码 0，缺了退出码 1
 *   node install.mjs --uninstall # 摘掉（删 insert 块 + 删 junction + 摘掉 preset 里的两行）
 *
 * 环境变量：
 *   DSH_PROFILE_DIR    默认 ~/.dsh/profiles/desktop
 *   DSH_OVERSCROLL_SRC 默认 <本脚本>/../../dsh-plugins/dsh-web-overscroll
 *   DSH_APC_SRC        预设插件源码根（默认 <本脚本>/../../dsh-plugins），加 --no-apc 可跳过第 3 步
 *
 * 说明：样式只在浏览器端注入（lib/client.js），宿主不需要重启；页面刷新（Ctrl+R）即生效。
 * 本脚本不碰 app.asar。
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, realpathSync,
  lstatSync, readlinkSync, symlinkSync, unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_NAME = 'dsh-web-overscroll';
const ID = 'web-overscroll';
const SRC = resolve(process.env.DSH_OVERSCROLL_SRC || join(HERE, '..', '..', 'dsh-plugins', PKG_NAME));
const PROFILE = resolve(process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop'));
const NODE_MODULES = join(PROFILE, 'node_modules');
const DEST = join(NODE_MODULES, PKG_NAME);
const YML = join(PROFILE, 'cordis.patch.yml');
const BACKUP = join(HERE, 'backup');

const MODE = process.argv.includes('--check') ? 'check'
  : process.argv.includes('--uninstall') ? 'uninstall'
  : 'install';
const WITH_APC = !process.argv.includes('--no-apc');

const APC_PKGS = ['dsh-agent-preset-compact-release', 'dsh-agent-preset-compact'];
const APC_ROOT = resolve(process.env.DSH_APC_SRC || join(HERE, '..', '..', 'dsh-plugins'));
const APC_COMMENT = '/* shell: 页面外壳固定，滚轮/触控到边界不再拖动整个页面；消息列表/侧栏/弹窗等内部容器仍各自滚动 */';
const APC_LINE = 'html,body,#root{height:100%;overflow:hidden;overscroll-behavior:none}';
const APC_BACKUP = join(HERE, 'backup');

const BEGIN = `# ── dsh-web-overscroll (本地插件：关掉视口级 overscroll，滚轮过度下拉不再把整页拖出视口) ──`;
const END = `# ── /dsh-web-overscroll ──`;
const BLOCK = [
  BEGIN,
  `# 只关 html/body 的 overscroll + 让根节点不再可滚；消息列表/侧栏等内部滚动不受影响。`,
  `# 代码：${SRC}`,
  '',
  '- insert:',
  `    - id: ${ID}`,
  `      name: ${PKG_NAME}`,
  '',
  END,
  '',
].join('\n');

const fail = (msg, code = 1) => {
  console.error('PATCH FAILED: ' + msg);
  process.exit(code);
};
const log = (msg) => console.log(msg);
const rel = (p) => p.replace(PROFILE, '<profile>');

function pkgOk() {
  const pj = join(SRC, 'package.json');
  if (!existsSync(pj)) return `源目录缺少 package.json：${SRC}`;
  let meta;
  try {
    meta = JSON.parse(readFileSync(pj, 'utf8'));
  } catch (e) {
    return `源目录 package.json 解析失败：${e.message}`;
  }
  if (meta.name !== PKG_NAME) return `源包名不符：期望 ${PKG_NAME}，实际 ${meta.name}`;
  if (!existsSync(join(SRC, 'lib', 'client.js'))) return `源目录缺少 lib/client.js：${SRC}`;
  return null;
}

function junctionState() {
  if (!existsSync(DEST) && !isDanglingLink(DEST)) return 'missing';
  try {
    const st = lstatSync(DEST);
    if (!st.isSymbolicLink()) return 'realdir';
    const target = resolve(NODE_MODULES, readlinkSync(DEST));
    return target.toLowerCase() === SRC.toLowerCase() ? 'ok' : 'wrong:' + target;
  } catch {
    return 'unknown';
  }
}

function isDanglingLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function ymlState() {
  if (!existsSync(YML)) return 'noyml';
  const text = readFileSync(YML, 'utf8');
  if (text.includes(`name: ${PKG_NAME}`)) return 'ok';
  if (text.includes(BEGIN)) return 'marker-only';
  return 'missing';
}

// ---------------------------------------------------------------- actions
function ensureJunction() {
  const state = junctionState();
  if (state === 'ok') {
    log(`  junction 已在：${rel(DEST)} -> ${SRC}`);
    return;
  }
  if (state === 'realdir') fail(`目标已存在且是真实目录（不是 junction），不敢动：${rel(DEST)}`);
  if (state === 'wrong:' || state.startsWith('wrong:')) {
    log(`  junction 指向别处（${state.replace('wrong:', '')}），先删掉重指`);
    unlinkSync(DEST);
  }
  symlinkSync(SRC, DEST, 'junction');
  log(`  junction 已建：${rel(DEST)} -> ${SRC}`);
}

function backupYml() {
  if (!existsSync(BACKUP)) mkdirSync(BACKUP, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = join(BACKUP, `cordis.patch.yml.${stamp}`);
  copyFileSync(YML, dst);
  log(`  backup -> ${rel(dst)}`);
}

function ensureYmlBlock() {
  if (!existsSync(YML)) fail(`找不到 profile 补丁层：${YML}`);
  const state = ymlState();
  if (state === 'ok') {
    log(`  insert 块已在：${rel(YML)}`);
    return;
  }
  backupYml();
  let text = readFileSync(YML, 'utf8');
  if (state === 'marker-only') {
    // 有开始标记但没包名：把残缺块整段删掉再补
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.trim() === BEGIN.trim());
    const end = lines.findIndex((l) => l.trim() === END.trim());
    if (start >= 0) lines.splice(start, end > start ? end - start + 1 : 1);
    text = lines.join('\n');
    log(`  检测到残缺块，已移除后重写`);
  }
  if (!text.endsWith('\n')) text += '\n';
  text += (text.trim().endsWith('') ? '' : '\n') + BLOCK;
  writeFileSync(YML, text, 'utf8');
  log(`  insert 块已写入：${rel(YML)}（原文件已备份）`);
}

function removeYmlBlock() {
  if (!existsSync(YML)) return;
  const lines = readFileSync(YML, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === BEGIN.trim());
  let end = lines.findIndex((l) => l.trim() === END.trim());
  if (start < 0) {
    log(`  insert 块本来就不在：${rel(YML)}`);
    return;
  }
  backupYml();
  if (end < start) end = start;
  lines.splice(start, end - start + 1);
  writeFileSync(YML, lines.join('\n'), 'utf8');
  log(`  已移除 insert 块：${rel(YML)}（原文件已备份）`);
}

function removeJunction() {
  if (!existsSync(DEST)) {
    log(`  junction 本来就不在：${rel(DEST)}`);
    return;
  }
  if (lstatSync(DEST).isSymbolicLink()) {
    unlinkSync(DEST);
    log(`  已删 junction：${rel(DEST)}（源目录保留）`);
  } else {
    fail(`目标不是 junction，不删：${rel(DEST)}`);
  }
}

// ---------------------------------------------------------------- apc (第二守卫)
function apcTargets() {
  const out = [];
  const push = (p) => {
    const key = p.toLowerCase();
    if (out.some((o) => o.toLowerCase() === key)) return;
    if (existsSync(p)) out.push(p);
  };
  try {
    push(join(realpathSync(join(NODE_MODULES, 'dsh-agent-preset-compact')), 'lib', 'client.js'));
  } catch {}
  for (const name of APC_PKGS) push(join(APC_ROOT, name, 'lib', 'client.js'));
  return out;
}

function apcState(file) {
  const text = readFileSync(file, 'utf8');
  if (text.includes(APC_LINE)) return 'ok';
  return /const\s+css\s*=\s*`/.test(text) ? 'missing' : 'noanchor';
}

function backupFile(file) {
  if (!existsSync(APC_BACKUP)) mkdirSync(APC_BACKUP, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = join(APC_BACKUP, `${basename(file)}.${stamp}.bak`);
  copyFileSync(file, dst);
  return dst;
}

function ensureApc() {
  const files = apcTargets();
  if (!files.length) {
    log(`  预设插件源码未找到（${APC_ROOT}），跳第二步守卫`);
    return;
  }
  for (const file of files) {
    const state = apcState(file);
    if (state === 'ok') {
      log(`  视口锁已在：${file}`);
      continue;
    }
    if (state === 'noanchor') fail(`找不到 css 模板串锚点（const css=\`）：${file}`);
    const lines = readFileSync(file, 'utf8').split('\n');
    const at = lines.findIndex((l) => /const\s+css\s*=\s*`/.test(l));
    if (at < 0) fail(`锚点行定位失败：${file}`);
    lines.splice(at + 1, 0, APC_COMMENT, APC_LINE);
    const bak = backupFile(file);
    writeFileSync(file, lines.join('\n'), 'utf8');
    log(`  视口锁已写入：${file}（备份 ${bak}）`);
  }
}

function removeApc() {
  for (const file of apcTargets()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const at = lines.findIndex((l) => l.trim() === APC_LINE);
    if (at < 0) {
      log(`  视口锁本来就不在：${file}`);
      continue;
    }
    backupFile(file);
    const count = lines[at - 1]?.trim() === APC_COMMENT ? 2 : 1;
    lines.splice(at - count + 1, count);
    writeFileSync(file, lines.join('\n'), 'utf8');
    log(`  已摘掉视口锁：${file}`);
  }
}

// ---------------------------------------------------------------- main
log(`profile : ${PROFILE}`);
log(`源目录  : ${SRC}`);

const srcProblem = pkgOk();
if (srcProblem && (MODE === 'install' || MODE === 'check')) fail(srcProblem, 1);

if (MODE === 'check') {
  const j = junctionState();
  const y = ymlState();
  const apc = WITH_APC ? apcTargets().map((f) => `${apcState(f)} ${f}`) : ['skipped (--no-apc)'];
  log(`junction: ${j}`);
  log(`yml     : ${y}`);
  for (const line of apc) log(`preset  : ${line}`);
  const ok = j === 'ok' && y === 'ok' && (!WITH_APC || apc.every((s) => s.startsWith('ok ')));
  log(ok ? '状态：已打上（无需操作）' : '状态：缺东西，跑 node install.mjs 补上');
  process.exit(ok ? 0 : 1);
}

if (MODE === 'uninstall') {
  removeYmlBlock();
  removeJunction();
  if (WITH_APC) removeApc();
  log('已卸载（插件源码 dsh-plugins/dsh-web-overscroll 保留）。刷新页面即恢复原状。');
  process.exit(0);
}

ensureJunction();
ensureYmlBlock();
if (WITH_APC) ensureApc();
log('完成。刷新 DSH 窗口（Ctrl+R）即生效；无需重启 Harness。');
