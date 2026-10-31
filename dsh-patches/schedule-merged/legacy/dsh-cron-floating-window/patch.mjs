/**
 * dsh-cron 浮窗补丁（幂等）：把右侧抽屉改成真正浮在最上层、可拖动的浮窗。
 *
 * 背景（为什么原来的抽屉会被挡住）：
 *   dsh-cron 把面板 inject 进 `shell.overlay` 槽位，而 shell 的 AppFrame 里
 *   `.overlayLayer { position: absolute; inset: 0; z-index: 20; pointer-events: none }`
 *   —— 这是一个**层叠上下文**。抽屉内部写的 `z-index: 901` 只在层内比较，
 *   整层永远排在 body 里其它浮层（dsh-pet 的 2147483000+、cost-meter 的 9999 …）
 *   之下；外层的 `.frame { overflow: hidden }` 还会把超出窗口的部分裁掉。
 *   结果：面板经常被宠物 / 侧栏 / 其它插件盖住，或被 shell 边框切掉。
 *
 * 补丁做五件事（只改 Web 客户端 bundle lib/client.js，宿主 index.js 不动）：
 *   1. require("react-dom")，把抽屉 createPortal 到 document.body，
 *      脱离 shell.overlay 的层叠上下文与 overflow 裁剪；
 *   2. 抽屉从「右侧贴边抽屉 + 半透明遮罩」改成「圆角浮窗」，
 *      z-index 提到 2147483200（高于本 profile 内其它插件的 2147483000/3002）；
 *   3. 标题栏可拖动，位置存 localStorage（`dsh-cron:float-pos`），
 *      窗口 resize / 拖出屏幕时自动夹回可视区；
 *   4. 去掉遮罩，改成「点窗口外关闭」（继续保留 ESC 关闭），
 *      通知 toast 层抬高到 2147483300，不会被浮窗盖住。
 *   5. 修掉插件 CSS 里 5 个本版 Harness 不存在的主题变量
 *      （--dsw-alias-fill-l1/l2/l3、--dsw-alias-label-brand、--dsw-font-mono）：
 *      它们会让浏览器落回硬编码的浅色兜底（深色主题下就是几块刺眼白块），
 *      换成真实存在、随主题变化的变量；浮窗再补一层 --dsw-menu-backdrop-filter
 *      毛玻璃，和 DSH 原生菜单材质一致。
 *
 * 用法（插件被 npm/pnpm 更新覆盖后重跑即可）：
 *   node patch.mjs
 * 可选环境变量：
 *   DSH_CRON_DIR      插件根目录（默认 ~/.dsh/profiles/desktop/node_modules/dsh-cron）
 *   DSH_CRON_BACKUP   备份目录（默认 ~/.dsh/dsh-cron-patches/backup，按文件名分开存）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PKG = process.env.DSH_CRON_DIR || join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-cron');
const BACKUP = process.env.DSH_CRON_BACKUP || join(homedir(), '.dsh', 'dsh-cron-patches', 'backup');
const FILE = join(PKG, 'lib', 'client.js');

const fail = (msg) => {
	console.error('PATCH FAILED: ' + msg);
	process.exit(1);
};

if (!existsSync(FILE)) fail('文件不存在：' + FILE);
let text = readFileSync(FILE, 'utf8');

// ------------------------------------------------------------ 已打过就跳过
if (text.includes('function portalTo(node)')) {
	console.log('已打过补丁，跳过：' + FILE);
	process.exit(0);
}

/** 在整份文件里替换唯一出现的一段文本 */
function replaceOnce(needle, replacement, label) {
	const first = text.indexOf(needle);
	if (first < 0) fail('锚点「' + label + '」没找到');
	if (text.indexOf(needle, first + needle.length) >= 0) fail('锚点「' + label + '」命中多次（期望 1 次）');
	text = text.slice(0, first) + replacement + text.slice(first + needle.length);
}

/** 用替换文本覆盖 [startNeedle, endNeedle] 之间的整段 */
function replaceRange(startNeedle, endNeedle, replacement, label) {
	const start = text.indexOf(startNeedle);
	if (start < 0) fail('锚点「' + label + '」起点没找到');
	const end = text.indexOf(endNeedle, start + startNeedle.length);
	if (end < 0) fail('锚点「' + label + '」终点没找到');
	text = text.slice(0, start) + replacement + text.slice(end + endNeedle.length);
}

/** 只在 startNeedle..endNeedle 这段函数体里做替换，避免撞上同名写法 */
function inFunction(startNeedle, endNeedle, edit, label) {
	const start = text.indexOf(startNeedle);
	if (start < 0) fail('找不到函数「' + label + '」');
	const end = text.indexOf(endNeedle, start + startNeedle.length);
	if (end < 0) fail('找不到函数「' + label + '」的结束锚点');
	const seg = edit(text.slice(start, end));
	text = text.slice(0, start) + seg + text.slice(end);
}

function rep(seg, needle, replacement, label) {
	const first = seg.indexOf(needle);
	if (first < 0) fail('函数内锚点「' + label + '」没找到');
	if (seg.indexOf(needle, first + needle.length) >= 0) fail('函数内锚点「' + label + '」命中多次');
	return seg.slice(0, first) + replacement + seg.slice(first + needle.length);
}

// ------------------------------------------------------------ 1) require react-dom
replaceOnce(
	'let react_jsx_runtime = require("react/jsx-runtime");\n',
	'let react_jsx_runtime = require("react/jsx-runtime");\n' +
		'// 浮窗要挂到 <body> 上才不受 shell.overlay 层叠上下文和 overflow:hidden 影响，\n' +
		'// 这正是 shell 自己用的办法（AppFrame / 设置面板都是 createPortal 到 document.body）。\n' +
		'let react_dom = null;\n' +
		'try {\n' +
		'\treact_dom = require("react-dom");\n' +
		'} catch (err) {\n' +
		'\tconsole.warn("[dsh-cron] react-dom 不可用，浮窗退化为原位置渲染（可能仍会被遮挡）", err);\n' +
		'}\n',
	'let react_jsx_runtime = require("react/jsx-runtime");',
);

// ------------------------------------------------------------ 2) 浮窗位置工具 + portal 助手
replaceOnce(
	'function CronDrawer({ t }) {\n',
	//#region src/client/floating-window.ts
	'//#region src/client/floating-window.ts\n' +
		'/** 浮窗位置的 localStorage 键（拖动结束后写入）。 */\n' +
		'const FLOAT_POS_KEY = "dsh-cron:float-pos";\n' +
		'const FLOAT_WIDTH = 420;\n' +
		'const FLOAT_HEIGHT = 560;\n' +
		'const FLOAT_MARGIN = 12;\n' +
		'/** 夹进可视区：拖动、resize、还原历史位置都要过这一关，窗口永远完整可见。 */\n' +
		'function clampFloatPos(x, y) {\n' +
		'\tconst vw = window.innerWidth;\n' +
		'\tconst vh = window.innerHeight;\n' +
		'\tconst width = Math.min(FLOAT_WIDTH, vw - FLOAT_MARGIN * 2);\n' +
		'\tconst height = Math.min(FLOAT_HEIGHT, vh - FLOAT_MARGIN * 2);\n' +
		'\tconst maxX = Math.max(FLOAT_MARGIN, vw - width - FLOAT_MARGIN);\n' +
		'\tconst maxY = Math.max(FLOAT_MARGIN, vh - height - FLOAT_MARGIN);\n' +
		'\treturn {\n' +
		'\t\tx: Math.min(Math.max(FLOAT_MARGIN, Math.round(x)), maxX),\n' +
		'\t\ty: Math.min(Math.max(FLOAT_MARGIN, Math.round(y)), maxY)\n' +
		'\t};\n' +
		'}\n' +
		'/** 读回上次位置；没有记录就用「右上角、避开 header」的默认位置。 */\n' +
		'function readFloatPos() {\n' +
		'\ttry {\n' +
		'\t\tconst raw = window.localStorage.getItem(FLOAT_POS_KEY);\n' +
		'\t\tif (raw !== null) {\n' +
		'\t\t\tconst parsed = JSON.parse(raw);\n' +
		'\t\t\tif (parsed !== null && typeof parsed.x === "number" && typeof parsed.y === "number") return clampFloatPos(parsed.x, parsed.y);\n' +
		'\t\t}\n' +
		'\t} catch {}\n' +
		'\treturn clampFloatPos(window.innerWidth - FLOAT_WIDTH - 28, 88);\n' +
		'}\n' +
		'function writeFloatPos(pos) {\n' +
		'\ttry {\n' +
		'\t\twindow.localStorage.setItem(FLOAT_POS_KEY, JSON.stringify(pos));\n' +
		'\t} catch {}\n' +
		'}\n' +
		'/** 挂到 <body>：抽离一切祖先层叠上下文、overflow 裁剪和 transform 定位。 */\n' +
		'function portalTo(node) {\n' +
		'\tif (react_dom !== null && typeof react_dom.createPortal === "function" && typeof document !== "undefined") return react_dom.createPortal(node, document.body);\n' +
		'\treturn node;\n' +
		'}\n' +
		'//#endregion\n' +
		'function CronDrawer({ t }) {\n',
	'function CronDrawer({ t }) {',
);

// ------------------------------------------------------------ 3) 去掉 mask 的 class 映射
text = (() => {
	replaceOnce('\tmask: "dsh-cron-mask",\n\tmaskOpen: "dsh-cron-mask dsh-cron-maskOpen",\n', '', 'mask 映射');
	return text;
})();

// ------------------------------------------------------------ 4) CSS：抽屉 -> 浮窗
replaceRange(
	'/* mask + right drawer (rendered into shell.overlay, so fixed positioning is',
	'.dsh-cron-drawerOpen { transform: translateX(0); }',
	'/* floating window: portaled into <body> (see portalTo), so neither the shell\n' +
		'   overlay stacking context (z-index:20) nor .frame { overflow: hidden } can clip\n' +
		'   or cover it. z-index sits above every other plugin in this profile\n' +
		'   (dsh-pet / dsh-better-sidebar use 2147483000..3002). */\n' +
		'.dsh-cron-drawer {\n' +
		'  position: fixed; z-index: 2147483200;\n' +
		'  width: 420px; height: 560px;\n' +
		'  max-width: calc(100vw - 24px); max-height: calc(100vh - 24px);\n' +
		'  box-sizing: border-box;\n' +
		'  display: flex; flex-direction: column;\n' +
		'  background: var(--dsw-specific-menu, #fff);\n' +
		'  border: 1px solid var(--dsw-alias-border-l2, #ddd);\n' +
		'  border-radius: 14px; overflow: hidden;\n' +
		'  box-shadow: var(--dsw-shadow-lv3, 0 18px 48px rgba(0, 0, 0, .24));\n' +
		'  opacity: 0; visibility: hidden; pointer-events: none;\n' +
		'  transform: translateY(8px) scale(.985); transform-origin: center top;\n' +
		'  transition: opacity .18s ease, transform .18s ease, visibility 0s linear .18s;\n' +
		'}\n' +
		'.dsh-cron-drawerOpen {\n' +
		'  opacity: 1; visibility: visible; pointer-events: auto;\n' +
		'  transform: none;\n' +
		'  transition: opacity .18s ease, transform .18s ease, visibility 0s linear 0s;\n' +
		'}',
	'mask + drawer CSS',
);

// ------------------------------------------------------------ 4b) 修掉插件里写错的主题变量
// dsh-cron 0.3.1 的 CSS 引了 5 个本版 Harness 里**不存在**的变量，浏览器只能吃到
// 硬编码兜底色（#f2f2f2 之类），深色主题下就是几块刺眼的白块（「提示音」「任务」
// 这类 active 态），浮窗的毛玻璃材质也丢了。这里换成真实存在、且随主题变化的变量。
{
	// active 态用主题的 ghost-active 填充 + 主题主色文字，和头部 tab / 侧栏选中项一个调子。
	// 这几个变量在深浅两套主题下取值相反（深色 #43454a / 浅色 #ebeef2），所以能跟着主题走。
	const accent = 'var(--dsw-alias-button-ghost-active-fill, rgba(127, 127, 127, .16))';
	const accentText = 'var(--dsw-alias-button-primary-fill, #6b4cff)';
	const surface = 'var(--dsw-alias-bg-multi-select, rgba(127, 127, 127, .1))';
	const hover = 'var(--dsw-alias-interactive-bg-hover-solid, rgba(127, 127, 127, .14))';
	replaceOnce(
		'.dsh-cron-triggerActive { color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-fill-l2, #f2f2f2); }',
		'.dsh-cron-triggerActive { color: var(--dsw-alias-label-primary, #222); background: ' + accent + '; }',
		'triggerActive 背景',
	);
	replaceOnce(
		'.dsh-cron-headTextOn {\n  color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-fill-l2, #f2f2f2);\n  font-weight: 600;\n}',
		'.dsh-cron-headTextOn {\n  color: ' + accentText + '; background: ' + accent + ';\n  font-weight: 600;\n}',
		'headTextOn 背景',
	);
	replaceOnce(
		'.dsh-cron-tabActive { color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-fill-l2, #f2f2f2); font-weight: 600; }',
		'.dsh-cron-tabActive { color: ' + accentText + '; background: ' + accent + '; font-weight: 600; }',
		'tabActive 背景',
	);
	// 行底 / 徽标用比浮窗略亮一层的表面色（深色 #212123 / 浅色 #f5f6f7）
	replaceOnce(
		'  background: var(--dsw-alias-fill-l1, transparent);\n',
		'  background: ' + surface + ';\n',
		'row 背景',
	);
	replaceOnce(
		'  background: var(--dsw-alias-fill-l2, #eee); color: var(--dsw-alias-label-secondary, #666);\n',
		'  background: ' + surface + '; color: var(--dsw-alias-label-secondary, #666);\n',
		'badge 背景',
	);
	// 主按钮：直接跟主题主色 + 主题给的对前景色（深色主题下是深字，浅色主题下是白字）
	replaceOnce(
		'  background: var(--dsw-alias-fill-l3, #e5e5e5); color: var(--dsw-alias-label-primary, #222);\n',
		'  background: var(--dsw-alias-button-primary-fill, #6b4cff); color: var(--dsw-alias-label-primary-foreground, #fff);\n',
		'primaryButton 背景',
	);
	// 剩下还写 fill-l2 的都是 hover
	const before = text;
	text = text.split('var(--dsw-alias-fill-l2, #f2f2f2)').join(hover);
	text = text.split('var(--dsw-alias-fill-l2, #f5f5f5)').join(hover);
	if (text === before) fail('没有找到要映射的 hover 背景（fill-l2）');
	// 不存在 --dsw-alias-label-brand / --dsw-font-mono
	text = text.split('var(--dsw-alias-label-brand, #6b4cff)').join('var(--dsw-alias-button-primary-fill, #6b4cff)');
	text = text.split('var(--dsw-font-mono, monospace)').join('ui-monospace, SFMono-Regular, Menlo, monospace');
}
// 浮窗自己也要那层毛玻璃：DSH 的菜单/弹层都是 --dsw-specific-menu（92% 不透明）
// + --dsw-menu-backdrop-filter，浮窗跟着用同一套材质，拖动时背后内容不会糊成一片。
replaceOnce(
	'  background: var(--dsw-specific-menu, #fff);\n  border: 1px solid var(--dsw-alias-border-l2, #ddd);\n  border-radius: 14px; overflow: hidden;',
	'  background: var(--dsw-specific-menu, #fff);\n  backdrop-filter: var(--dsw-menu-backdrop-filter, none);\n  border: 1px solid var(--dsw-alias-border-l2, #ddd);\n  border-radius: 14px; overflow: hidden;',
	'浮窗毛玻璃',
);

// ------------------------------------------------------------ 5) 标题栏当拖动条
replaceOnce(
	'.dsh-cron-drawerHead {\n' +
		'  flex: none; display: flex; align-items: center; justify-content: space-between;\n' +
		'  padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2, #eee);\n' +
		'}\n',
	'.dsh-cron-drawerHead {\n' +
		'  flex: none; display: flex; align-items: center; justify-content: space-between;\n' +
		'  gap: 4px; padding: 10px 12px;\n' +
		'  border-bottom: 1px solid var(--dsw-alias-border-l2, #eee);\n' +
		'  cursor: grab; user-select: none; touch-action: none;\n' +
		'}\n' +
		'.dsh-cron-drawerHead:active { cursor: grabbing; }\n',
	'drawerHead CSS',
);

// ------------------------------------------------------------ 6) toast 层抬到浮窗之上
replaceOnce(
	'  position: fixed; top: 56px; right: 16px; z-index: 1200;\n',
	'  position: fixed; top: 56px; right: 16px; z-index: 2147483300;\n',
	'toastStack z-index',
);

// ------------------------------------------------------------ 7) CronDrawer：portal + 拖动 + 点外关闭
inFunction(
	'function CronDrawer({ t }) {\n',
	'function CronAction({ t }) {\n',
	(seg) => {
		seg = rep(
			seg,
			'\tuseCronWatcher();\n',
			'\tuseCronWatcher();\n' +
				'\tconst [floatPos, setFloatPos] = (0, react.useState)(() => readFloatPos());\n' +
				'\tconst floatRef = (0, react.useRef)(null);\n' +
				'\tconst dragRef = (0, react.useRef)(null);\n' +
				'\tconst posRef = (0, react.useRef)(floatPos);\n' +
				'\t// 按住标题栏拖动（按钮 / 输入框上不抢事件，否则点关闭会变成拖动）\n' +
				'\tconst beginDrag = (event) => {\n' +
				'\t\tif (event.button !== 0) return;\n' +
				'\t\tconst target = event.target;\n' +
				'\t\tif (target instanceof Element && target.closest("button, input, textarea, select, a") !== null) return;\n' +
				'\t\tconst rect = floatRef.current === null ? null : floatRef.current.getBoundingClientRect();\n' +
				'\t\tdragRef.current = {\n' +
				'\t\t\tdx: event.clientX - (rect === null ? 0 : rect.left),\n' +
				'\t\t\tdy: event.clientY - (rect === null ? 0 : rect.top)\n' +
				'\t\t};\n' +
				'\t\tevent.preventDefault();\n' +
				'\t};\n' +
				'\t(0, react.useEffect)(() => {\n' +
				'\t\tif (!open) return;\n' +
				'\t\tconst onMove = (event) => {\n' +
				'\t\t\tconst drag = dragRef.current;\n' +
				'\t\t\tif (drag === null) return;\n' +
				'\t\t\tconst next = clampFloatPos(event.clientX - drag.dx, event.clientY - drag.dy);\n' +
				'\t\t\tposRef.current = next;\n' +
				'\t\t\tsetFloatPos(next);\n' +
				'\t\t};\n' +
				'\t\tconst onUp = () => {\n' +
				'\t\t\tif (dragRef.current === null) return;\n' +
				'\t\t\tdragRef.current = null;\n' +
				'\t\t\twriteFloatPos(posRef.current);\n' +
				'\t\t};\n' +
				'\t\tconst onResize = () => {\n' +
				'\t\t\tconst next = clampFloatPos(posRef.current.x, posRef.current.y);\n' +
				'\t\t\tposRef.current = next;\n' +
				'\t\t\tsetFloatPos(next);\n' +
				'\t\t};\n' +
				'\t\twindow.addEventListener("pointermove", onMove);\n' +
				'\t\twindow.addEventListener("pointerup", onUp);\n' +
				'\t\twindow.addEventListener("pointercancel", onUp);\n' +
				'\t\twindow.addEventListener("resize", onResize);\n' +
				'\t\treturn () => {\n' +
				'\t\t\twindow.removeEventListener("pointermove", onMove);\n' +
				'\t\t\twindow.removeEventListener("pointerup", onUp);\n' +
				'\t\t\twindow.removeEventListener("pointercancel", onUp);\n' +
				'\t\t\twindow.removeEventListener("resize", onResize);\n' +
				'\t\t\tdragRef.current = null;\n' +
				'\t\t};\n' +
				'\t}, [open]);\n' +
				'\t// 遮罩没了，所以「点窗口外面」关闭（header 上的触发器除外，它自己会 toggle）\n' +
				'\t(0, react.useEffect)(() => {\n' +
				'\t\tif (!open) return;\n' +
				'\t\tconst onPointerDown = (event) => {\n' +
				'\t\t\tconst target = event.target;\n' +
				'\t\t\tif (!(target instanceof Node)) return;\n' +
				'\t\t\tif (floatRef.current !== null && floatRef.current.contains(target)) return;\n' +
				'\t\t\tif (target instanceof Element && target.closest("[data-dsh-cron=\\"trigger\\"]") !== null) return;\n' +
				'\t\t\tsetDrawerOpen(false);\n' +
				'\t\t};\n' +
				'\t\tconst timer = setTimeout(() => document.addEventListener("pointerdown", onPointerDown, true), 0);\n' +
				'\t\treturn () => {\n' +
				'\t\t\tclearTimeout(timer);\n' +
				'\t\t\tdocument.removeEventListener("pointerdown", onPointerDown, true);\n' +
				'\t\t};\n' +
				'\t}, [open]);\n',
			'useCronWatcher() 之后插入状态与副作用',
		);
		// 遮罩节点整块删掉
		seg = rep(
			seg,
			'\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {\n' +
				'\t\t\tclassName: open ? styles.maskOpen : styles.mask,\n' +
				'\t\t\tonClick: () => setDrawerOpen(false),\n' +
				'\t\t\t"aria-hidden": "true"\n' +
				'\t\t}),\n',
			'',
			'mask 节点',
		);
		// 整个返回树 portal 到 body
		seg = rep(
			seg,
			'\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [\n',
			'\treturn portalTo(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [\n',
			'return 开头',
		);
		seg = rep(seg, '\t] });\n}', '\t] }));\n}', 'return 结尾');
		// 浮窗容器：ref + 位置 + 标记
		seg = rep(
			seg,
			'\t\t\tclassName: open ? styles.drawerOpen : styles.drawer,\n' +
				'\t\t\t"aria-hidden": !open,\n',
			'\t\t\tref: floatRef,\n' +
				'\t\t\tclassName: open ? styles.drawerOpen : styles.drawer,\n' +
				'\t\t\t"aria-hidden": !open,\n' +
				'\t\t\t"data-dsh-cron": "float",\n' +
				'\t\t\tstyle: {\n' +
				'\t\t\t\tleft: floatPos.x + "px",\n' +
				'\t\t\t\ttop: floatPos.y + "px"\n' +
				'\t\t\t},\n',
			'aside 属性',
		);
		// 标题栏接上拖动
		seg = rep(
			seg,
			'\t\t\t\tclassName: styles.drawerHead,\n',
			'\t\t\t\tclassName: styles.drawerHead,\n\t\t\t\tonPointerDown: beginDrag,\n',
			'drawerHead onPointerDown',
		);
		return seg;
	},
	'CronDrawer',
);

// ------------------------------------------------------------ 8) 触发器打标记（点外关闭要放过它）
inFunction(
	'function CronAction({ t }) {\n',
	'/** Client plugin body: dictionaries, styles, header trigger, and the drawer. */\n',
	(seg) =>
		rep(
			seg,
			'\t\t"aria-expanded": open,\n',
			'\t\t"data-dsh-cron": "trigger",\n\t\t"aria-expanded": open,\n',
			'CronAction 触发器标记',
		),
	'CronAction',
);

// ------------------------------------------------------------ 备份 + 写入
const backupFile = join(BACKUP, 'client.js');
if (!existsSync(backupFile)) {
	mkdirSync(BACKUP, { recursive: true });
	copyFileSync(FILE, backupFile);
	console.log('  backup -> ' + backupFile);
}
writeFileSync(FILE, text, 'utf8');

// ------------------------------------------------------------ 自检
const after = readFileSync(FILE, 'utf8');
const checks = [
	['require("react-dom")', 'require react-dom'],
	['function portalTo(node)', 'portalTo 助手'],
	['function clampFloatPos(x, y)', '位置夹取'],
	['dsh-cron:float-pos', '位置持久化键'],
	['z-index: 2147483200', '浮窗 z-index'],
	['z-index: 2147483300', 'toast z-index'],
	['return portalTo(/* @__PURE__ */', '返回树 portal'],
	['ref: floatRef,', '浮窗 ref'],
	['onPointerDown: beginDrag,', '标题栏拖动'],
	['"data-dsh-cron": "trigger",', '触发器标记'],
	['[data-dsh-cron=\\"trigger\\"]', '点外关闭放过触发器'],
	['cursor: grab;', '拖动光标'],
	['--dsw-alias-bg-multi-select', '主题表面色（行/徽标）'],
	['--dsw-alias-button-ghost-active-fill', '主题 active 态填充'],
	['--dsw-alias-label-primary-foreground', '主按钮前景色（随主题反色）'],
	['--dsw-menu-backdrop-filter', '浮窗毛玻璃材质'],
];
let bad = 0;
for (const [needle, label] of checks) {
	if (!after.includes(needle)) {
		console.error('  SELF-CHECK FAILED: ' + label + '（找不到 ' + JSON.stringify(needle) + '）');
		bad += 1;
	}
}
const leftovers = [
	['styles.maskOpen', '残留的 mask class 引用'],
	['.dsh-cron-mask', '残留的 mask CSS'],
	['transform: translateX(103%)', '残留的贴边抽屉 CSS'],
	['--dsw-alias-fill-l1', '残留的不存在变量 fill-l1'],
	['--dsw-alias-fill-l2', '残留的不存在变量 fill-l2'],
	['--dsw-alias-fill-l3', '残留的不存在变量 fill-l3'],
	['--dsw-alias-label-brand', '残留的不存在变量 label-brand'],
	['--dsw-font-mono', '残留的不存在变量 font-mono'],
];
for (const [needle, label] of leftovers) {
	if (after.includes(needle)) {
		console.error('  SELF-CHECK FAILED: ' + label + '（仍有 ' + JSON.stringify(needle) + '）');
		bad += 1;
	}
}
if (bad > 0) fail('补丁写完后自检失败（备份在 ' + BACKUP + '，可整体覆盖还原）');

console.log('OK：' + FILE);
console.log('  portal->body  |  z-index 2147483200  |  标题栏可拖  |  位置 localStorage  |  点外关闭');
console.log('下一步：刷新 Web 页面（Ctrl+Shift+R）后点头部「定时任务」看效果。');
