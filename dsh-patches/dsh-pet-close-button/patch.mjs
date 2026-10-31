/**
 * dsh-pet 「关闭」按钮补丁（幂等）。
 *
 * 作用：
 *  1. runtime/electron-helper/sprite.js —— 桌面桌宠右键菜单加「关闭」项 + POST /quit；
 *  2. lib/index.js                       —— 宿主新增 POST /dsh-pet-7340/quit：
 *     停桌面 Helper + 卸载插件作用域（路由/命令/定时器随 ctx.effect 回收），
 *     不写任何配置、不落任何标记 —— DSH 下次启动照常加载插件。
 *
 * 用法（在插件目录被 npm 更新覆盖后重跑即可）：
 *   node patch.mjs
 * 可选环境变量：
 *   DSH_PET_DIR  插件根目录（默认 ~/.dsh/profiles/desktop/node_modules/dsh-pet）
 *
 * 说明：内置文件是构建产物（lib/index.js 为 ESM、sprite.js 为经典脚本），
 * 这里直接按内容锚点插入，不依赖行号；锚点找不到会报错退出，不会写坏文件。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PKG = process.env.DSH_PET_DIR || join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-pet');
const BACKUP = join(process.env.DSH_PET_PATCH_BACKUP || join(homedir(), '.dsh', 'dsh-pet-patches'), 'backup');

const fail = (msg) => {
  console.error('PATCH FAILED: ' + msg);
  process.exit(1);
};

function readLines(file) {
  if (!existsSync(file)) fail('文件不存在：' + file);
  return readFileSync(file, 'utf8').split('\n');
}

/** 在 lines 中找到唯一一行满足 pred，返回 0-based 下标；找不到/不唯一都报错 */
function findUnique(lines, pred, label, file) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (pred(lines[i])) hits.push(i);
  if (hits.length !== 1) fail(`${file}: 锚点「${label}」命中 ${hits.length} 次（期望 1 次）`);
  return hits[0];
}

/** 从 start 起（含）向后找第一行 trim 等于 text 的行 */
function findNextTrim(lines, start, text, label, file) {
  for (let i = start; i < lines.length; i++) if (lines[i].trim() === text) return i;
  fail(`${file}: 从第 ${start + 1} 行起找不到「${label}」（trim === ${JSON.stringify(text)}）`);
  return -1;
}

function backupOnce(file, rel) {
  const target = join(BACKUP, rel);
  if (!existsSync(target)) {
    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(file, target);
    console.log('  backup -> ' + target);
  }
}

function save(file, lines) {
  writeFileSync(file, lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------- sprite.js
function patchSprite() {
  const file = join(PKG, 'runtime', 'electron-helper', 'sprite.js');
  let lines = readLines(file);
  if (lines.some((l) => l.includes("action: 'quit'"))) {
    console.log('[sprite.js] 已打过补丁，跳过');
    return;
  }
  backupOnce(file, 'sprite.js');

  // 1) 菜单项：跟在「重载配置」之后
  const reloadItem = findUnique(
    lines,
    (l) => l.trim() === "{ label: '重载配置', action: 'reload' },",
    '重载配置菜单项',
    file,
  );
  lines.splice(
    reloadItem + 1,
    0,
    '      // 本次会话退出插件：关闭桌宠并卸载插件，DSH 下次启动自动重新加载（不写任何配置）。',
    "      { label: '关闭', action: 'quit' },",
  );

  // 2) 动作分支：跟在 reload 的 if 块之后
  const reloadIf = findUnique(
    lines,
    (l) => l.trim() === "if (leaf.action === 'reload') {",
    'reload 动作分支',
    file,
  );
  const reloadEnd = findNextTrim(lines, reloadIf + 1, '}', 'reload 分支结束', file);
  lines.splice(
    reloadEnd + 1,
    0,
    "    if (leaf.action === 'quit') {",
    '      this.quitPlugin(); // 本次会话退出插件：请宿主停掉桌宠并卸载插件（下次启动自动加载）',
    '      return;',
    '    }',
  );

  // 3) quitPlugin 方法：跟在 reloadDesktop() 之后
  const reloadMethod = findUnique(lines, (l) => l.trim() === 'reloadDesktop() {', 'reloadDesktop 方法', file);
  const reloadMethodEnd = findNextTrim(lines, reloadMethod + 1, '}', 'reloadDesktop 方法结束', file);
  lines.splice(
    reloadMethodEnd + 1,
    0,
    '',
    '  // 「关闭」菜单：本次会话退出插件 —— 请宿主停掉桌面宠物并卸载插件进程；',
    '  // 不写任何配置，DSH 下次启动照常加载（宿主先回包再杀进程，故不 await）。',
    '  quitPlugin() {',
    "    fetch(BASE + '/quit', { method: 'POST' }).catch((e) => {",
    "      console.warn('[dsh-pet] 关闭插件请求失败（宿主不可达？）', e);",
    '    });',
    '  }',
  );

  save(file, lines);
  console.log('[sprite.js] OK：菜单「关闭」+ quitPlugin()');
}

// ---------------------------------------------------------------- index.js
function patchIndex() {
  const file = join(PKG, 'lib', 'index.js');
  let lines = readLines(file);
  if (lines.some((l) => l.includes('quitForSession'))) {
    console.log('[index.js] 已打过补丁，跳过');
    return;
  }
  backupOnce(file, 'index.js');

  // 1) quitForSession 帮助函数：插在 stopHelperAndWait 之后
  const stopAndWait = findUnique(
    lines,
    (l) => l.trim() === 'await old?.stopAndWait(reason);',
    'stopHelperAndWait 主体',
    file,
  );
  const stopAndWaitEnd = findNextTrim(lines, stopAndWait + 1, '};', 'stopHelperAndWait 结束', file);
  lines.splice(
    stopAndWaitEnd + 1,
    0,
    '',
    '\t/** 本次会话关闭插件（右键菜单「关闭」）：停掉桌面 Helper，并尽量卸掉插件作用域，',
    '\t*  路由 / 命令 / 定时器随 ctx.effect 清理一起回收；不写任何配置、不落任何标记，',
    '\t*  DSH 下次启动会照常重新加载插件。 */',
    '\tlet quitRequested = false;',
    '\tconst quitForSession = (why = "menu") => {',
    '\t\tif (quitRequested) return;',
    '\t\tquitRequested = true;',
    '\t\tdisposed = true;',
    '\t\ttry {',
    '\t\t\tstopHelper("session-quit");',
    '\t\t} catch (e) {',
    '\t\t\tctx.logger?.warn?.(`[dsh-pet] 关闭插件失败（停桌面 Helper）：${e instanceof Error ? e.message : String(e)}`);',
    '\t\t}',
    '\t\tctx.logger?.info?.(`[dsh-pet] 已在本次会话关闭插件（来源：${why}）；DSH 下次启动会重新加载`);',
    '\t\tsetTimeout(() => {',
    '\t\t\tconst fiber = ctx.fiber;',
    '\t\t\tif (!fiber || typeof fiber.dispose !== "function") {',
    '\t\t\t\tctx.logger?.warn?.("[dsh-pet] 当前 Cordis 不支持自卸载，已降级为停止运行（路由保留）");',
    '\t\t\t\treturn;',
    '\t\t\t}',
    '\t\t\t// 会话级退出 ≠ 持久禁用：loader 的自卸载会把 entry 标成 disabled，并把组合后的临时树',
    '\t\t\t// 写回 profile 根配置（cordis.yml），下次启动会重复插入。这里临时屏蔽这一次写回，',
    '\t\t\t// 卸载完成后恢复；配置文件一字不动，下次启动照常加载。',
    '\t\t\tlet restoreWrite;',
    '\t\t\ttry {',
    '\t\t\t\tconst tree = fiber.entry?.parent?.tree;',
    '\t\t\t\tif (tree && typeof tree.write === "function") {',
    '\t\t\t\t\tconst origWrite = tree.write;',
    '\t\t\t\t\ttree.write = () => void 0;',
    '\t\t\t\t\trestoreWrite = () => {',
    '\t\t\t\t\t\ttree.write = origWrite;',
    '\t\t\t\t\t};',
    '\t\t\t\t}',
    '\t\t\t} catch (e) {',
    '\t\t\t\tctx.logger?.warn?.(`[dsh-pet] 屏蔽配置写回失败：${e instanceof Error ? e.message : String(e)}`);',
    '\t\t\t}',
    '\t\t\tfiber.dispose().then(() => {',
    '\t\t\t\tctx.logger?.info?.("[dsh-pet] 插件已在本次会话卸载");',
    '\t\t\t}).catch((e) => {',
    '\t\t\t\tctx.logger?.warn?.(`[dsh-pet] 插件卸载失败（已降级为停止运行）：${e instanceof Error ? e.message : String(e)}`);',
    '\t\t\t}).finally(() => {',
    '\t\t\t\ttry {',
    '\t\t\t\t\trestoreWrite?.();',
    '\t\t\t\t} catch {}',
    '\t\t\t});',
    '\t\t}, 120);',
    '\t};',
  );

  // 2) /quit 路由：插在 /reload 分支之后
  const reloading = findUnique(
    lines,
    (l) => l.trim() === 'obj: { reloading: true }',
    'reload 响应体',
    file,
  );
  // reloading -> }; -> }   （return {...} 的收口 + if 块收口）
  const closeBrace = findNextTrim(lines, reloading + 1, '};', 'reload return 收口', file);
  const ifEnd = findNextTrim(lines, closeBrace + 1, '}', 'reload if 块收口', file);
  lines.splice(
    ifEnd + 1,
    0,
    '\t\tif (rest === "quit") {',
    '\t\t\tif (method !== "POST") return {',
    '\t\t\t\tkind: "json",',
    '\t\t\t\tstatus: 405,',
    '\t\t\t\tobj: { error: "method not allowed" }',
    '\t\t\t};',
    '\t\t\tquitForSession("menu");',
    '\t\t\treturn {',
    '\t\t\t\tkind: "json",',
    '\t\t\t\tstatus: 200,',
    '\t\t\t\tobj: { quitting: true }',
    '\t\t\t};',
    '\t\t}',
  );

  // 3) 关闭后停止活动：work-status 事件、通知帧、余额轮询、碎碎念轮询
  const sessionEvent = findUnique(
    lines,
    (l) => l.trim() === 'const dispose = ctx.on("session/event", (session, event) => {',
    'work-status 事件监听',
    file,
  );
  lines.splice(sessionEvent + 1, 0, '\t\t\tif (disposed) return;');

  const notifyOn = findUnique(lines, (l) => l.trim() === 'const sessionDispose = ctx.on(', '通知 session 监听', file);
  const notifyArrow = findNextTrim(lines, notifyOn + 1, '(session, event) => {', '通知 session 回调', file);
  lines.splice(notifyArrow + 1, 0, '\t\t\t\tif (disposed) return;');

  const errOn = findUnique(lines, (l) => l.trim() === 'const errorDispose = ctx.on(', 'agent/error 监听', file);
  const errArrow = findNextTrim(lines, errOn + 1, '(payload) => {', 'agent/error 回调', file);
  lines.splice(errArrow + 1, 0, '\t\t\t\tif (disposed) return;');

  const balanceTick = findUnique(lines, (l) => l.trim() === 'async function tick() {', '余额轮询 tick', file);
  lines.splice(balanceTick + 1, 0, '\t\t\tif (disposed) return;');

  const whisperTick = findUnique(lines, (l) => l.trim() === 'function tick() {', '碎碎念轮询 tick', file);
  lines.splice(whisperTick + 1, 0, '\t\t\tif (disposed) return;');

  save(file, lines);
  console.log('[index.js] OK：POST /quit + quitForSession() + 轮询/事件停止守卫');
}

console.log('插件目录：' + PKG);
patchSprite();
patchIndex();
console.log('完成。重启 DSH 后：右键桌面宠物 → 「关闭」→ 本次会话退出，下次启动自动加载。');
