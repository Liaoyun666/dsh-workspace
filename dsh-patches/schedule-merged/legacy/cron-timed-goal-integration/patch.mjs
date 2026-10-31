/**
 * dsh-cron + dsh-timed-goal 联动补丁（幂等）。
 *
 * 背景：
 *   dsh-timed-goal 的「⏱定时」面板会把任务存进自己的 jobs.json（GET/DELETE
 *   /timed-goal/jobs），而 dsh-cron 的右上角抽屉只读自己的 /cron/api/list。
 *   两边各管一套，所以用户在 [⏱ 定时] 里安排的目标在「定时任务」抽屉里看不见。
 *
 * 补丁做的事（只改 dsh-cron 的 Web 客户端 bundle lib/client.js，宿主不动）：
 *   1. CronPanel 的 refresh() 并行多拉一次 GET /timed-goal/jobs（插件缺失时
 *      静默降级为空列表，不报错、不影响原功能）；
 *   2. 任务 tab 顶部多一段「自动目标（定时 /goal）」列表：状态点、job id、
 *      待触发/已触发/失败、计划时间、轮数、权限、提示词，带「删除」按钮
 *      （DELETE /timed-goal/jobs/<id>，与设置页里那个卡片等价）；
 *   3. 触发按钮上的数字徽标把「cron 已启用任务 + pending 目标」一起数；
 *   4. 空态文案补一句「也可以用输入行的 [⏱ 定时] 安排自动目标」。
 *
 * 用法（插件被 pnpm 更新覆盖后重跑即可）：
 *   node patch.mjs
 * 可选环境变量：
 *   DSH_CRON_DIR       dsh-cron 根目录（默认 ~/.dsh/profiles/desktop/node_modules/dsh-cron）
 *   DSH_CRON_BACKUP    备份目录（默认 ~/.dsh/dsh-cron-patches/backup，按文件名分开存）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PKG = process.env.DSH_CRON_DIR || join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-cron');
const BACKUP = process.env.DSH_CRON_BACKUP || join(homedir(), '.dsh', 'dsh-cron-patches', 'backup');
const FILE = join(PKG, 'lib', 'client.js');
const MARK = 'dsh-timed-goal: goals in drawer';

const fail = (msg) => {
	console.error('PATCH FAILED: ' + msg);
	process.exit(1);
};
if (!existsSync(FILE)) fail('文件不存在：' + FILE);
let text = readFileSync(FILE, 'utf8');
if (text.includes(MARK)) {
	console.log('已打过补丁，跳过：' + FILE);
	process.exit(0);
}

function replaceOnce(needle, replacement, label) {
	const first = text.indexOf(needle);
	if (first < 0) fail('锚点「' + label + '」没找到');
	if (text.indexOf(needle, first + needle.length) >= 0) fail('锚点「' + label + '」命中多次（期望 1 次）');
	text = text.slice(0, first) + replacement + text.slice(first + needle.length);
}

// ── 1. 字典：zh ────────────────────────────────────────────────────────────
replaceOnce(
	'"history.scheduled": "计划: {time}",',
	'"history.scheduled": "计划: {time}",\n\t"goal.section": "自动目标（定时 /goal）",\n\t"task.section": "对话定时任务",\n\t"goal.badge": "目标",\n\t"goal.status.pending": "待触发",\n\t"goal.status.fired": "已触发",\n\t"goal.status.failed": "失败",\n\t"goal.rounds": "{count} 轮",',
	'zh 字典'
);
replaceOnce(
	'"history.scheduled": "scheduled: {time}",',
	'"history.scheduled": "scheduled: {time}",\n\t"goal.section": "Scheduled goals (/goal)",\n\t"task.section": "Chat scheduled tasks",\n\t"goal.badge": "goal",\n\t"goal.status.pending": "pending",\n\t"goal.status.fired": "fired",\n\t"goal.status.failed": "failed",\n\t"goal.rounds": "{count} rounds",',
	'en 字典'
);
replaceOnce(
	'"tasks.empty": "还没有定时任务。在对话中直接说，比如「每周一早上9点提醒我交周报」，Agent 会自动创建。",',
	'"tasks.empty": "还没有定时任务。在对话中直接说，比如「每周一早上9点提醒我交周报」，Agent 会自动创建；也可以用输入行的 [定时] 安排一个到点自动执行的 goal。",',
	'zh 空态文案'
);

// ── 2. styles 表补充两个类名 ───────────────────────────────────────────────
replaceOnce(
	'\tunreadBadge: "dsh-cron-unreadBadge",',
	'\tunreadBadge: "dsh-cron-unreadBadge",\n\tbadgeGoal: "dsh-cron-badge dsh-cron-badgeGoal",\n\tsectionLabel: "dsh-cron-sectionLabel",',
	'styles 表'
);

// ── 3. CSS ────────────────────────────────────────────────────────────────
replaceOnce(
	'@keyframes dsh-cron-toast-in {',
	'/* ' + MARK + ' */\n.dsh-cron-sectionLabel {\n  padding: 8px 8px 2px; font-size: 11px; font-weight: 600; letter-spacing: .02em;\n  color: var(--dsw-alias-label-tertiary, #999);\n}\n.dsh-cron-badgeGoal {\n  color: var(--dsw-alias-label-brand, #6b4cff); border-color: currentColor; opacity: 1;\n}\n@keyframes dsh-cron-toast-in {',
	'CSS'
);

// ── 4. 辅助函数（CronPanel 之前）───────────────────────────────────────────
const helpers = [
	'/** ' + MARK + ' —— 定时目标走 dsh-timed-goal 的 /timed-goal/jobs。 */',
	'async function goalApi(method, id) {',
	'\tconst url = id === undefined ? "/timed-goal/jobs" : "/timed-goal/jobs/" + encodeURIComponent(id);',
	'\tconst res = await fetch(url, { method, headers: { accept: "application/json" } });',
	'\tconst data = await res.json().catch(() => null);',
	'\tif (data === null || data.ok !== true) throw new Error(data && data.error ? data.error : "request failed (" + res.status + ")");',
	'\treturn data;',
	'}',
	'function goalRank(goal) {',
	'\tif (goal.status === "pending") return 0;',
	'\tif (goal.status === "fired") return 1;',
	'\treturn 2;',
	'}',
	'/** pending 在前、已触发/失败在后；同组按计划时间升序。 */',
	'function sortGoals(goals) {',
	'\treturn goals.slice().sort((a, b) => goalRank(a) - goalRank(b) || (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));',
	'}',
	'function goalDotClass(goal) {',
	'\tif (goal.status === "pending") return styles.dotOn;',
	'\tif (goal.status === "failed") return styles.dot_failed;',
	'\treturn styles.dot_completed;',
	'}',
	'function goalScheduleText(goal, t) {',
	'\tconst time = formatTime(new Date(goal.scheduledAt ?? 0).toISOString());',
	'\treturn goal.repeat === "daily" ? t("schedule.daily", { time }) : t("schedule.at", { time });',
	'}',
	'function goalMetaText(goal, t) {',
	'\tconst parts = [goalScheduleText(goal, t)];',
	'\tif (goal.rounds !== undefined && goal.rounds !== null) parts.push(t("goal.rounds", { count: goal.rounds }));',
	'\tif (typeof goal.permission === "string" && goal.permission !== "") parts.push(goal.permission);',
	'\treturn parts.join(" · ");',
	'}',
	'function CronGoalRow({ t, goal, onRemove }) {',
	'\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {',
	'\t\tclassName: styles.row,',
	'\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {',
	'\t\t\tclassName: styles.rowHead,',
	'\t\t\tchildren: [',
	'\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: goalDotClass(goal) }),',
	'\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: styles.taskId, children: goal.id }),',
	'\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: styles.badgeGoal, children: t("goal.badge") }),',
	'\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: styles.badge, children: t("goal.status." + goal.status) }),',
	'\t\t\t\tgoal.sessionId ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: styles.badge, title: goal.sessionId, children: t("task.bound") }) : null',
	'\t\t\t]',
	'\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: styles.prompt, title: goal.prompt, children: goal.prompt }),',
	'\t\tgoal.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: styles.error, children: goal.error }) : null,',
	'\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { className: styles.meta, children: [',
	'\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: goalMetaText(goal, t) }),',
	'\t\t\tgoal.status === "pending" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("task.next", { time: formatTime(new Date(goal.scheduledAt ?? 0).toISOString()) }) }) : null',
	'\t\t] }),',
	'\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: styles.actions, children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {',
	'\t\t\ttype: "button",',
	'\t\t\tclassName: styles.actionDanger,',
	'\t\t\tonClick: () => void onRemove(goal.id),',
	'\t\t\tchildren: t("action.remove")',
	'\t\t}) })]',
	'\t});',
	'}',
	''
].join('\n');
replaceOnce('function CronPanel({ t, tab, setTab }) {', helpers + 'function CronPanel({ t, tab, setTab }) {', 'CronPanel 前插辅助函数');

// ── 5. CronPanel 状态 + refresh 同时拉目标 ─────────────────────────────────
replaceOnce(
	'\tconst [editingId, setEditingId] = (0, react.useState)(null);\n\tconst refresh = (0, react.useCallback)(async () => {\n\t\ttry {\n\t\t\tconst [listResult, historyResult] = await Promise.all([api("list"), api("history", { limit: 50 })]);\n\t\t\tsetTasks(listResult.tasks);\n\t\t\tsetRecords(historyResult.records);\n\t\t\tsetEnabledCount(listResult.tasks.filter((task) => task.enabled).length);',
	'\tconst [editingId, setEditingId] = (0, react.useState)(null);\n\tconst [goals, setGoals] = (0, react.useState)([]);\n\tconst refresh = (0, react.useCallback)(async () => {\n\t\ttry {\n\t\t\tconst [listResult, historyResult, goalsResult] = await Promise.all([api("list"), api("history", { limit: 50 }), goalApi("GET").catch(() => null)]);\n\t\t\tconst nextGoals = goalsResult !== null && Array.isArray(goalsResult.jobs) ? sortGoals(goalsResult.jobs) : [];\n\t\t\tsetTasks(listResult.tasks);\n\t\t\tsetRecords(historyResult.records);\n\t\t\tsetGoals(nextGoals);\n\t\t\tsetEnabledCount(listResult.tasks.filter((task) => task.enabled).length + nextGoals.filter((goal) => goal.status === "pending").length);',
	'CronPanel 状态与 refresh'
);

// ── 6. 删除目标的动作（放在 act 后面）───────────────────────────────────────
replaceOnce(
	'\tconst act = async (method, payload) => {',
	[
		'\t/** 删除一条 dsh-timed-goal 目标（与设置页那个卡片的删除等价）。 */',
		'\tconst removeGoal = async (id) => {',
		'\t\ttry {',
		'\t\t\tawait goalApi("DELETE", id);',
		'\t\t\tawait refresh();',
		'\t\t} catch (err) {',
		'\t\t\tsetError(err instanceof Error ? err.message : String(err));',
		'\t\t}',
		'\t};',
		'\tconst act = async (method, payload) => {'
	].join('\n'),
	'removeGoal'
);

// ── 7. 任务 tab 里插目标列表 ───────────────────────────────────────────────
replaceOnce(
	'children: [tasks.length === 0 ?',
	[
		'children: [...(goals.length === 0 ? [] : [',
		'\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: styles.sectionLabel, children: t("goal.section") }, "goal-section"),',
		'\t\t\t\t\t...goals.map((goal) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CronGoalRow, {',
		'\t\t\t\t\t\tt,',
		'\t\t\t\t\t\tgoal,',
		'\t\t\t\t\t\tonRemove: removeGoal',
		'\t\t\t\t\t}, goal.id)),',
		'\t\t\t\t\ttasks.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: styles.sectionLabel, children: t("task.section") }, "task-section")',
		'\t\t\t\t]), tasks.length === 0 && goals.length === 0 ?'
	].join('\n'),
	'目标列表'
);

mkdirSync(BACKUP, { recursive: true });
if (!existsSync(join(BACKUP, 'client.js'))) copyFileSync(FILE, join(BACKUP, 'client.js'));
writeFileSync(FILE, text);
writeFileSync(join(BACKUP, 'client.goals-integrated.js'), text);
console.log('PATCH OK: ' + FILE);
