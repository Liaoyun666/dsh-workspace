window.__ModuleLoader__.load({
	id: "dsh-schedule",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
// 浮窗要挂到 <body> 上才不受 shell.overlay 层叠上下文和 overflow:hidden 影响，
// 这正是 shell 自己用的办法（AppFrame / 设置面板都是 createPortal 到 document.body）。
let react_dom = null;
try {
	react_dom = require("react-dom");
} catch (err) {
	console.warn("[dsh-schedule] react-dom 不可用，浮窗退化为原位置渲染（可能仍会被遮挡）", err);
}

//#region src/client/locale.ts
const zh = {
	"trigger.aria": "定时任务",
	"drawer.close": "关闭",
	"drawer.test": "测试通知",
	"drawer.testShort": "测试",
	"prefs.system": "系统通知（页面在后台也能收到）",
	"prefs.systemShort": "系统通知",
	"prefs.sound": "提示音（点击切换静音）",
	"prefs.soundShort": "提示音",
	"toast.testBody": "这是一条测试通知：任务完成后会像这样提醒你。",
	"toast.completed": "任务 {id} 已完成",
	"toast.failed": "任务 {id} 执行失败",
	"tab.tasks": "任务",
	"tab.history": "执行记录",
	"tasks.empty": "还没有定时任务。在对话中直接说，比如「每周一早上9点提醒我交周报」，Agent 会自动创建；也可以用输入行的 [定时] 安排一个到点自动执行的 goal。",
	"history.empty": "还没有执行记录。",
	"origin.config": "配置",
	"origin.dynamic": "动态",
	"schedule.at": "一次性 · {time}",
	"schedule.every.seconds": "每 {count} 秒",
	"schedule.every.minutes": "每 {count} 分钟",
	"schedule.every.hours": "每 {count} 小时",
	"schedule.daily": "每天 {time}",
	"schedule.cron": "cron: {expr}",
	"task.next": "下次: {time}",
	"task.bound": "绑定会话",
	"task.boundTo": "触发时在创建它的会话中执行（会话 {id}）",
	"task.newSession": "专属对话",
	"task.newSessionTitle": "触发时在这个任务专属的新对话里执行（会话 {id}）",
	"form.target": "对话目标",
	"form.target.current": "本对话",
	"form.target.pick": "指定对话",
	"form.target.new": "新开对话",
	"form.target.none": "（还没有可选的对话）",
	"form.target.loading": "正在读取对话列表…",
	"form.target.failed": "读取对话列表失败：{message}",
	"form.target.untitled": "对话 {id}",
	"form.target.newNote": "保存后会自动开一个新对话，之后每次触发都回到那个对话里继续。",
	"action.run": "立即执行",
	"action.pause": "暂停",
	"action.resume": "恢复",
	"action.remove": "删除",
	"action.edit": "编辑",
	"action.save": "保存",
	"action.cancel": "取消",
	"form.prompt": "任务内容：到点后 Agent 要做什么",
	"form.goal": "目标（可选）：每次触发都会带上目标和最近 3 次进展，让 Agent 接着往下推进",
	"task.add": "＋ 新任务",
	"task.goalBadge": "目标",
	"task.goalTitle": "持续目标：{text}",
	"task.goalNote": "目标：{text}",
	"form.rule.daily": "每天",
	"form.rule.every": "每隔",
	"form.rule.cron": "cron 表达式",
	"form.rule.at": "一次性",
	"form.value.daily": "HH:MM（如 09:00）",
	"form.value.every": "秒数（如 1800）",
	"form.value.cron": "分 时 日 月 周（如 0 9 * * 1）",
	"form.value.at": "ISO 时间（如 2026-08-24T09:00:00+08:00）",
	"history.status.delivered": "已投递",
	"history.status.running": "执行中",
	"history.status.completed": "已完成",
	"history.status.failed": "失败",
	"history.scheduled": "计划: {time}",
	"goal.section": "自动目标（定时 /goal）",
	"task.section": "对话定时任务",
	"goal.badge": "目标",
	"goal.status.pending": "待触发",
	"goal.status.fired": "已触发",
	"goal.status.failed": "失败",
	"goal.rounds": "{count} 轮",
	"goal.add": "＋ 新目标",
	"goal.addPrompt": "到点要做什么（goal 目标）",
	"goal.addWhen": "时间：2026-10-27 09:00",
	"goal.addRounds": "轮数（可空）",
	"duration.seconds": "{count}s",
	"duration.minutes": "{count}m{seconds}s",
	"error.forbidden": "当前访问域名（{host}）不在 DSH 的信任名单里，/schedule/api 被 403 拦下：给桌面 profile 的 connection 插件 trustedHosts 加上这个域名，重启 DSH 后生效。"
};
const en = {
	"trigger.aria": "Scheduled tasks",
	"drawer.close": "Close",
	"drawer.test": "Test notification",
	"drawer.testShort": "Test",
	"prefs.system": "System notifications (work in background)",
	"prefs.systemShort": "System",
	"prefs.sound": "Sound (click to mute)",
	"prefs.soundShort": "Sound",
	"toast.testBody": "This is a test notification: finished tasks will notify you like this.",
	"toast.completed": "Task {id} completed",
	"toast.failed": "Task {id} failed",
	"tab.tasks": "Tasks",
	"tab.history": "History",
	"tasks.empty": "No scheduled tasks yet. Just say it in chat, e.g. \"remind me every Monday at 9am to submit the weekly report\".",
	"history.empty": "No runs yet.",
	"origin.config": "config",
	"origin.dynamic": "dynamic",
	"schedule.at": "once · {time}",
	"schedule.every.seconds": "every {count}s",
	"schedule.every.minutes": "every {count}m",
	"schedule.every.hours": "every {count}h",
	"schedule.daily": "daily {time}",
	"schedule.cron": "cron: {expr}",
	"task.next": "next: {time}",
	"task.bound": "bound session",
	"task.boundTo": "Runs in the session it was created in (session {id})",
	"task.newSession": "own chat",
	"task.newSessionTitle": "Runs in a conversation of its own, opened for this task (session {id})",
	"form.target": "Conversation",
	"form.target.current": "This one",
	"form.target.pick": "Pick another",
	"form.target.new": "A new one",
	"form.target.none": "(no conversations to pick)",
	"form.target.loading": "Loading conversations…",
	"form.target.failed": "Could not load conversations: {message}",
	"form.target.untitled": "chat {id}",
	"form.target.newNote": "Saving opens a new conversation now; later firings continue it.",
	"action.run": "Run now",
	"action.pause": "Pause",
	"action.resume": "Resume",
	"action.remove": "Delete",
	"action.edit": "Edit",
	"action.save": "Save",
	"action.cancel": "Cancel",
	"form.prompt": "What should the agent do when it fires?",
	"form.goal": "Goal (optional): each firing carries the goal and the last 3 progress notes so the agent continues it",
	"task.add": "+ task",
	"task.goalBadge": "goal",
	"task.goalTitle": "Ongoing goal: {text}",
	"task.goalNote": "goal: {text}",
	"form.rule.daily": "Daily",
	"form.rule.every": "Every",
	"form.rule.cron": "cron expression",
	"form.rule.at": "Once",
	"form.value.daily": "HH:MM (e.g. 09:00)",
	"form.value.every": "seconds (e.g. 1800)",
	"form.value.cron": "min hour dom mon dow (e.g. 0 9 * * 1)",
	"form.value.at": "ISO time (e.g. 2026-08-24T09:00:00+08:00)",
	"history.status.delivered": "delivered",
	"history.status.running": "running",
	"history.status.completed": "completed",
	"history.status.failed": "failed",
	"history.scheduled": "scheduled: {time}",
	"goal.section": "Scheduled goals (/goal)",
	"task.section": "Chat scheduled tasks",
	"goal.badge": "goal",
	"goal.status.pending": "pending",
	"goal.status.fired": "fired",
	"goal.status.failed": "failed",
	"goal.rounds": "{count} rounds",
	"goal.add": "+ goal",
	"goal.addPrompt": "What should the agent do when it fires?",
	"goal.addWhen": "When: 2026-10-27 09:00",
	"goal.addRounds": "Rounds (optional)",
	"duration.seconds": "{count}s",
	"duration.minutes": "{count}m{seconds}s"
};

//#endregion
//#region src/client/styles.ts
const styles = {
	trigger: "dsh-schedule-trigger",
	triggerLabel: "dsh-schedule-triggerLabel",
	chip: "dsh-schedule-chip",
	chipActive: "dsh-schedule-chip dsh-schedule-chipActive",
	chipIcon: "dsh-schedule-chipIcon",
	chipCount: "dsh-schedule-chipCount",
	triggerActive: "dsh-schedule-trigger dsh-schedule-triggerActive",
	count: "dsh-schedule-count",
	drawer: "dsh-schedule-drawer",
	drawerOpen: "dsh-schedule-drawer dsh-schedule-drawerOpen",
	drawerHead: "dsh-schedule-drawerHead",
	drawerTitle: "dsh-schedule-drawerTitle",
	drawerClose: "dsh-schedule-drawerClose",
	headSpacer: "dsh-schedule-headSpacer",
	headText: "dsh-schedule-headText",
	headTextOn: "dsh-schedule-headText dsh-schedule-headTextOn",
	tabs: "dsh-schedule-tabs",
	tab: "dsh-schedule-tab",
	tabActive: "dsh-schedule-tab dsh-schedule-tabActive",
	body: "dsh-schedule-body",
	list: "dsh-schedule-list",
	empty: "dsh-schedule-empty",
	row: "dsh-schedule-row",
	rowDisabled: "dsh-schedule-row dsh-schedule-rowDisabled",
	rowHead: "dsh-schedule-rowHead",
	taskId: "dsh-schedule-taskId",
	badge: "dsh-schedule-badge",
	time: "dsh-schedule-time",
	prompt: "dsh-schedule-prompt",
	goalNote: "dsh-schedule-goalNote",
	meta: "dsh-schedule-meta",
	actions: "dsh-schedule-actions",
	action: "dsh-schedule-action",
	actionDanger: "dsh-schedule-action dsh-schedule-actionDanger",
	addButton: "dsh-schedule-addButton",
	form: "dsh-schedule-form",
	formRow: "dsh-schedule-formRow",
	input: "dsh-schedule-input",
	textarea: "dsh-schedule-textarea",
	select: "dsh-schedule-select",
	primaryButton: "dsh-schedule-primaryButton",
	ghostButton: "dsh-schedule-ghostButton",
	error: "dsh-schedule-error",
	dotOn: "dsh-schedule-dot dsh-schedule-dotOn",
	dotOff: "dsh-schedule-dot dsh-schedule-dotOff",
	dot_delivered: "dsh-schedule-dot dsh-schedule-dotDelivered",
	dot_running: "dsh-schedule-dot dsh-schedule-dotRunning",
	dot_completed: "dsh-schedule-dot dsh-schedule-dotCompleted",
	dot_failed: "dsh-schedule-dot dsh-schedule-dotFailed",
	unreadBadge: "dsh-schedule-unreadBadge",
	badgeGoal: "dsh-schedule-badge dsh-schedule-badgeGoal",
	sectionLabel: "dsh-schedule-sectionLabel",
	toastStack: "dsh-schedule-toastStack",
	toast: "dsh-schedule-toast",
	toastFailed: "dsh-schedule-toast dsh-schedule-toastFailed",
	toastTitle: "dsh-schedule-toastTitle",
	toastBody: "dsh-schedule-toastBody"
};
const css = `
/* composer chip trigger (always visible in the input tool row) */
.dsh-schedule-chip {
  box-sizing: border-box; display: inline-flex; flex: none; align-items: center; gap: 4px;
  height: 22px; padding: 0 6px; margin: 0; border: 1px solid transparent; border-radius: 6px;
  background: 0; color: var(--dsw-alias-label-secondary, #8a8a8a);
  font-family: inherit; font-size: 12px; line-height: 1; cursor: pointer;
  -webkit-app-region: no-drag;
}
.dsh-schedule-chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16)); color: var(--dsw-alias-label-primary, #222); }
.dsh-schedule-chip:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 1px; }
.dsh-schedule-chipActive { color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-button-ghost-active-fill, rgba(127,127,127,.16)); }
.dsh-schedule-chipIcon { width: 14px; height: 14px; flex: none; }
.dsh-schedule-chipCount { font-variant-numeric: tabular-nums; opacity: .85; }
/* header trigger */
.dsh-schedule-trigger {
  min-height: 28px; color: var(--dsw-alias-label-tertiary, #888); cursor: pointer;
  background: 0; border: 0; border-radius: 6px; align-items: center; gap: 3px;
  padding: 3px 6px; font-size: 12px; line-height: 18px; display: inline-flex;
}
.dsh-schedule-trigger:hover, .dsh-schedule-trigger:focus-visible { color: var(--dsw-alias-label-secondary, #555); }
.dsh-schedule-triggerActive { color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-button-ghost-active-fill, rgba(127, 127, 127, .16)); }
.dsh-schedule-triggerLabel { font-size: 12px; }
.dsh-schedule-count { margin: 0 2px; font-variant-numeric: tabular-nums; }

/* floating window: portaled into <body> (see portalTo), so neither the shell
   overlay stacking context (z-index:20) nor .frame { overflow: hidden } can clip
   or cover it. z-index sits above every other plugin in this profile
   (dsh-pet / dsh-better-sidebar use 2147483000..3002). */
.dsh-schedule-drawer {
  /* !important 是防别人的样式表把浮窗按死：dsh-dream-skin 会把本窗口误当成聊天输入框卡片
     （它的卡片规则带 position:relative，特异性相同却排在后面），一旦被改成 relative，
     窗口就掉进 body 普通流、跑到屏幕外面去。aside 上另外挂了 role="dialog"，dream-skin
     的探测会主动跳过 dialog 子树（见它的 isInDialog），两处一起上。 */
  position: fixed !important; z-index: 2147483200 !important;
  width: 420px !important; height: 560px !important;
  max-width: calc(100vw - 24px); max-height: calc(100vh - 24px);
  box-sizing: border-box;
  display: flex; flex-direction: column;
  background: var(--dsw-specific-menu, #fff);
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
  border: 1px solid var(--dsw-alias-border-l2, #ddd);
  border-radius: 14px; overflow: hidden;
  box-shadow: var(--dsw-shadow-lv3, 0 18px 48px rgba(0, 0, 0, .24));
  opacity: 0; visibility: hidden; pointer-events: none;
  transform: translateY(8px) scale(.985); transform-origin: center top;
  transition: opacity .18s ease, transform .18s ease, visibility 0s linear .18s;
}
.dsh-schedule-drawerOpen {
  opacity: 1; visibility: visible; pointer-events: auto;
  transform: none;
  transition: opacity .18s ease, transform .18s ease, visibility 0s linear 0s;
}
.dsh-schedule-drawerHead {
  flex: none; display: flex; align-items: center; justify-content: space-between;
  gap: 4px; padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #eee);
  cursor: grab; user-select: none; touch-action: none;
}
.dsh-schedule-drawerHead:active { cursor: grabbing; }
.dsh-schedule-drawerTitle { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #222); }
.dsh-schedule-drawerClose {
  border: 0; background: 0; cursor: pointer; font-size: 18px; line-height: 1;
  color: var(--dsw-alias-label-tertiary, #888); padding: 2px 6px; border-radius: 6px;
}
.dsh-schedule-drawerClose:hover { color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-interactive-bg-hover-solid, rgba(127, 127, 127, .14)); }
.dsh-schedule-headSpacer { flex: 1; }
.dsh-schedule-headText {
  border: 0; background: 0; cursor: pointer; font-size: 11px; line-height: 1;
  color: var(--dsw-alias-label-tertiary, #999); padding: 5px 6px; border-radius: 6px;
  white-space: nowrap;
}
.dsh-schedule-headText:hover { color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-interactive-bg-hover-solid, rgba(127, 127, 127, .14)); }
.dsh-schedule-headTextOn {
  color: var(--dsw-alias-button-primary-fill, #6b4cff); background: var(--dsw-alias-button-ghost-active-fill, rgba(127, 127, 127, .16));
  font-weight: 600;
}

/* panel body */
.dsh-schedule-tabs { flex: none; display: flex; gap: 2px; padding: 8px 10px 6px; border-bottom: 1px solid var(--dsw-alias-border-l2, #eee); }
.dsh-schedule-tab {
  flex: 1; border: 0; background: 0; cursor: pointer; padding: 6px 0; font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #888); border-radius: 6px;
}
.dsh-schedule-tab:hover { color: var(--dsw-alias-label-secondary, #555); }
.dsh-schedule-tabActive { color: var(--dsw-alias-button-primary-fill, #6b4cff); background: var(--dsw-alias-button-ghost-active-fill, rgba(127, 127, 127, .16)); font-weight: 600; }
.dsh-schedule-body { flex: 1; overflow: auto; padding: 6px; }
.dsh-schedule-list { display: flex; flex-direction: column; gap: 4px; }
.dsh-schedule-empty { padding: 18px 10px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary, #999); }
.dsh-schedule-row {
  box-sizing: border-box; border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px;
  background: var(--dsw-alias-bg-multi-select, rgba(127, 127, 127, .1));
}
.dsh-schedule-row:hover { background: var(--dsw-alias-interactive-bg-hover-solid, rgba(127, 127, 127, .14)); }
.dsh-schedule-rowDisabled { opacity: .55; }
.dsh-schedule-rowHead { display: flex; align-items: center; gap: 6px; }
.dsh-schedule-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; }
.dsh-schedule-dotOn { background: #22c55e; }
.dsh-schedule-dotOff { background: #a3a3a3; }
.dsh-schedule-dotDelivered { background: #a3a3a3; }
.dsh-schedule-dotRunning { background: #3b82f6; }
.dsh-schedule-dotCompleted { background: #22c55e; }
.dsh-schedule-dotFailed { background: #ef4444; }
.dsh-schedule-taskId { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-primary, #222); flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-schedule-badge {
  flex: none; font-size: 10px; line-height: 16px; padding: 0 6px; border-radius: 5px;
  background: var(--dsw-alias-bg-multi-select, rgba(127, 127, 127, .1)); color: var(--dsw-alias-label-secondary, #666);
}
.dsh-schedule-time { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); }
.dsh-schedule-prompt {
  font-size: 12px; color: var(--dsw-alias-label-secondary, #555);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.dsh-schedule-goalNote {
  font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary, #888);
  border-left: 2px solid var(--dsw-alias-brand-primary, #4f6ef7); padding-left: 6px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.dsh-schedule-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); }
.dsh-schedule-actions { display: flex; gap: 8px; }
.dsh-schedule-action {
  border: 0; background: 0; cursor: pointer; padding: 2px 0; font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #888);
}
.dsh-schedule-action:hover { color: var(--dsw-alias-label-primary, #222); text-decoration: underline; }
.dsh-schedule-actionDanger:hover { color: #ef4444; }
.dsh-schedule-addButton {
  margin: 4px; padding: 7px 0; border: 1px dashed var(--dsw-alias-border-l2, #ddd); border-radius: 8px;
  background: 0; cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-tertiary, #888);
}
.dsh-schedule-addButton:hover { color: var(--dsw-alias-label-primary, #222); border-color: var(--dsw-alias-label-tertiary, #aaa); }
.dsh-schedule-form { display: flex; flex-direction: column; gap: 6px; padding: 8px 4px; }
.dsh-schedule-formRow { display: flex; gap: 6px; }
.dsh-schedule-input, .dsh-schedule-textarea, .dsh-schedule-select {
  box-sizing: border-box; width: 100%; border: 1px solid var(--dsw-alias-border-l2, #ddd); border-radius: 6px;
  background: var(--dsw-specific-menu, #fff); color: var(--dsw-alias-label-primary, #222);
  font-size: 12px; padding: 6px 8px; font-family: inherit;
}
.dsh-schedule-textarea { resize: vertical; }
.dsh-schedule-select { width: auto; flex: none; }
.dsh-schedule-input:focus, .dsh-schedule-textarea:focus, .dsh-schedule-select:focus { outline: 1px solid var(--dsw-alias-label-tertiary, #aaa); }
.dsh-schedule-primaryButton {
  border: 0; border-radius: 6px; padding: 7px 0; cursor: pointer; font-size: 12px;
  background: var(--dsw-alias-button-primary-fill, #6b4cff); color: var(--dsw-alias-label-primary-foreground, #fff);
}
.dsh-schedule-primaryButton:disabled { opacity: .5; cursor: default; }
.dsh-schedule-ghostButton {
  border: 1px solid var(--dsw-alias-border-l2, #ddd); border-radius: 6px; padding: 6px 0; cursor: pointer;
  font-size: 12px; background: 0; color: var(--dsw-alias-label-secondary, #666); width: 100%;
}
.dsh-schedule-ghostButton:hover { color: var(--dsw-alias-label-primary, #222); }
.dsh-schedule-form .dsh-schedule-primaryButton { flex: 1; }
.dsh-schedule-form .dsh-schedule-ghostButton { flex: 1; width: auto; }
.dsh-schedule-unreadBadge {
  position: absolute; top: -4px; right: -6px; min-width: 14px; height: 14px; padding: 0 3px;
  border-radius: 7px; background: #ef4444; color: #fff; font-size: 9px; line-height: 14px;
  text-align: center; font-variant-numeric: tabular-nums; box-sizing: border-box;
}
.dsh-schedule-trigger { position: relative; }
.dsh-schedule-toastStack {
  position: fixed; top: 56px; right: 16px; z-index: 2147483300;
  display: flex; flex-direction: column; gap: 8px; pointer-events: none;
}
.dsh-schedule-toast {
  pointer-events: auto; width: 300px; max-width: 80vw; text-align: left; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, #ddd); border-left: 3px solid #22c55e;
  background: var(--dsw-specific-menu, #fff); border-radius: 10px; padding: 10px 12px;
  box-shadow: var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.14));
  display: flex; flex-direction: column; gap: 3px;
  animation: dsh-schedule-toast-in .18s ease;
}
.dsh-schedule-toastFailed { border-left-color: #ef4444; }
.dsh-schedule-toastTitle { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #222); }
.dsh-schedule-toastBody {
  font-size: 11px; color: var(--dsw-alias-label-secondary, #666);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
/* dsh-schedule: goals in drawer */
.dsh-schedule-sectionLabel {
  padding: 8px 8px 2px; font-size: 11px; font-weight: 600; letter-spacing: .02em;
  color: var(--dsw-alias-label-tertiary, #999);
}
.dsh-schedule-badgeGoal {
  color: var(--dsw-alias-button-primary-fill, #6b4cff); border-color: currentColor; opacity: 1;
}
@keyframes dsh-schedule-toast-in {
  from { opacity: 0; transform: translateX(16px); }
  to { opacity: 1; transform: translateX(0); }
}
.dsh-schedule-error {
  margin: 4px; padding: 6px 8px; border-radius: 6px; font-size: 11px;
  background: rgba(239, 68, 68, .1); color: #ef4444;
}
`;

//#endregion
//#region src/client/index.tsx
/** Services required from the client runtime. */
const inject = ["slots", "locale"];
let drawerOpen = false;
let enabledCount = 0;
let unreadCount = 0;
let drawerTab = "tasks";
let toastSeq = 0;
let toasts = [];
const TOAST_MS = 8e3;
const PREFS_KEY = "dsh-schedule:prefs";
function loadPrefs() {
	try {
		const raw = typeof localStorage !== "undefined" ? localStorage.getItem(PREFS_KEY) : null;
		if (raw) {
			const parsed = JSON.parse(raw);
			return {
				sound: parsed.sound !== false,
				system: parsed.system === true
			};
		}
	} catch {}
	return {
		sound: true,
		system: false
	};
}
let prefs = loadPrefs();
function setPref(key, value) {
	prefs = {
		...prefs,
		[key]: value
	};
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
	} catch {}
	storeNotify();
}
/**
 * Conversation the drawer was opened from. The drawer lives in the app-wide
 * overlay slot, so it cannot see a session on its own; the composer chip and
 * the header button report the session they render in, and the "this
 * conversation" default of the task forms follows it.
 */
let activeSessionId = null;
let snapshot = {
	open: drawerOpen,
	count: enabledCount,
	unread: unreadCount,
	tab: drawerTab,
	toasts,
	prefs,
	activeSessionId
};
const storeListeners = /* @__PURE__ */ new Set();
function storeSubscribe(listener) {
	storeListeners.add(listener);
	return () => {
		storeListeners.delete(listener);
	};
}
function storeNotify() {
	snapshot = {
		open: drawerOpen,
		count: enabledCount,
		unread: unreadCount,
		tab: drawerTab,
		toasts,
		prefs,
		activeSessionId
	};
	for (const listener of storeListeners) listener();
}
function setDrawerOpen(open) {
	if (drawerOpen === open) return;
	drawerOpen = open;
	if (open) unreadCount = 0;
	storeNotify();
}
/** Open the drawer on a specific tab (e.g. a toast click opens history). */
function openDrawer(tab) {
	drawerTab = tab;
	setDrawerOpen(true);
}
function setActiveSession(id) {
	activeSessionId = typeof id === "string" && id !== "" ? id : null;
}
function setEnabledCount(count) {
	if (enabledCount === count) return;
	enabledCount = count;
	storeNotify();
}
/** New finished-run activity: bump the badge only while the drawer is closed. */
function bumpUnread(by) {
	if (drawerOpen || by === 0) return;
	unreadCount += by;
	storeNotify();
}
function setDrawerTab(tab) {
	if (drawerTab === tab) return;
	drawerTab = tab;
	storeNotify();
}
/** Push one toast onto the stack (shared by the watcher and the test button). */
function pushToast(event) {
	toasts = [...toasts, {
		...event,
		key: toastSeq++
	}].slice(-3);
	storeNotify();
}
function dismissToast(key) {
	toasts = toasts.filter((item) => item.key !== key);
	storeNotify();
}
function useDrawerState() {
	return (0, react.useSyncExternalStore)(storeSubscribe, () => snapshot);
}
/**
 * Report the conversation a slotted trigger renders in. The slot hands its
 * session id to props, so the drawer can point "this conversation" at the
 * session the panel was opened from.
 */
function useReportSession(sessionId) {
	(0, react.useEffect)(() => {
		if (typeof sessionId === "string" && sessionId !== "") setActiveSession(sessionId);
	}, [sessionId]);
}
async function api(method, payload) {
	const res = await fetch(`/schedule/api/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload ?? {})
	});
	const data = await res.json().catch(() => null);
	// The server answers a bare "forbidden" when the Host-header fence rejects this
	// deployment's authority; say what it means and how to fix it instead of
	// echoing a word nobody can act on.
	if (data?.error?.code === "forbidden") throw new Error(fallbackT("error.forbidden", { host: typeof location === "undefined" ? "" : location.host }));
	if (!data?.ok) throw new Error(data?.error?.message ?? `request failed (${res.status})`);
	return data.result;
}
/** Fallback translator when a slot supplies no locale seat: zh + {param} interpolation. */
const fallbackT = (key, params) => (zh[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ""));
/**
* Pure status-diff for polling: which records newly reached a terminal state
* (completed / failed) since the previous snapshot. Records absent from the
* previous snapshot count as new (a fast task can fire and finish between two
* polls). Exported for tests.
*/
function diffRecords(prev, records) {
	const events = [];
	for (const record of records) {
		if (record.status !== "completed" && record.status !== "failed") continue;
		if (prev.get(record.id) === record.status) continue;
		events.push({
			record,
			kind: record.status
		});
	}
	return events;
}
const POLL_MS = 2e4;
/**
* Short synthesized chime (no audio asset needed). Completed: rising major
* fifth; failed: falling minor second. Autoplay policies may block the very
* first playback before any user gesture — silently skipped.
*/
function playChime(kind) {
	try {
		const Ctor = window.AudioContext ?? window.webkitAudioContext;
		if (!Ctor) return;
		const audio = new Ctor();
		audio.resume?.();
		(kind === "failed" ? [311.13, 293.66] : [523.25, 783.99]).forEach((freq, index) => {
			const osc = audio.createOscillator();
			const gain = audio.createGain();
			osc.type = "sine";
			osc.frequency.value = freq;
			const t0 = audio.currentTime + index * .12;
			gain.gain.setValueAtTime(0, t0);
			gain.gain.linearRampToValueAtTime(.12, t0 + .02);
			gain.gain.exponentialRampToValueAtTime(.001, t0 + .35);
			osc.connect(gain).connect(audio.destination);
			osc.start(t0);
			osc.stop(t0 + .4);
		});
		setTimeout(() => void audio.close().catch(() => {}), 1200);
	} catch {}
}
/** Browser-level system notification: appears even when this tab is backgrounded. */
function sendBrowserNotification(event) {
	try {
		if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
		const title = fallbackT(`toast.${event.kind}`, { id: event.record.taskId });
		const body = (event.record.excerpt || event.record.prompt || "").slice(0, 200);
		const notification = new Notification(title, {
			body,
			tag: event.record.id
		});
		notification.onclick = () => {
			window.focus();
			openDrawer("history");
		};
	} catch {}
}
/** Central fan-out for newly finished runs: toasts + badge + sound + system. */
function notifyEvents(events) {
	if (events.length === 0) return;
	bumpUnread(events.length);
	for (const event of events) pushToast(event);
	if (prefs.sound) playChime(events.some((e) => e.kind === "failed") ? "failed" : "completed");
	if (prefs.system) for (const event of events) sendBrowserNotification(event);
}
/** One toast card; auto-dismisses, click opens the drawer on the history tab. */
function ToastCard({ t, item }) {
	const sticky = item.kind === "failed";
	(0, react.useEffect)(() => {
		if (sticky) return;
		const timer = setTimeout(() => dismissToast(item.key), TOAST_MS);
		return () => clearTimeout(timer);
	}, [item.key, sticky]);
	const open = () => {
		dismissToast(item.key);
		openDrawer("history");
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		type: "button",
		className: item.kind === "failed" ? styles.toastFailed : styles.toast,
		onClick: open,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: styles.toastTitle,
			children: t(`toast.${item.kind}`, { id: item.record.taskId })
		}), item.record.excerpt ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: styles.toastBody,
			children: item.record.excerpt
		}) : null]
	});
}
/**
* Polls run history and surfaces finished runs as toasts + badge counts.
* Lives in the root-scoped overlay component so exactly ONE watcher exists no
* matter how many sessions are open. The first poll only primes the snapshot
* (old records never toast).
*/
function useCronWatcher() {
	const snapshotRef = (0, react.useRef)(null);
	(0, react.useEffect)(() => {
		let stopped = false;
		console.info("[dsh-schedule] watcher started (poll every %ds)", POLL_MS / 1e3);
		const poll = async () => {
			if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
			try {
				const { records } = await api("history", { limit: 20 });
				if (stopped) return;
				const prev = snapshotRef.current;
				snapshotRef.current = new Map(records.map((r) => [r.id, r.status]));
				if (prev === null) {
					console.info("[dsh-schedule] watcher primed with %d record(s)", records.length);
					return;
				}
				const events = diffRecords(prev, records);
				if (events.length === 0) return;
				console.info("[dsh-schedule]", events.length, "task run(s) finished:", events.map((e) => `${e.record.taskId}:${e.kind}`).join(", "));
				notifyEvents(events);
			} catch (error) {
				console.warn("[dsh-schedule] watcher poll failed:", error);
			}
		};
		poll();
		const timer = setInterval(poll, POLL_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, []);
}
function formatTime(iso) {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString();
}
function scheduleText(task, t) {
	if (task.schedule.at) return t("schedule.at", { time: formatTime(task.schedule.at) });
	if (task.schedule.everySeconds != null) {
		const seconds = task.schedule.everySeconds;
		if (seconds % 3600 === 0) return t("schedule.every.hours", { count: seconds / 3600 });
		if (seconds % 60 === 0) return t("schedule.every.minutes", { count: seconds / 60 });
		return t("schedule.every.seconds", { count: seconds });
	}
	if (task.schedule.daily) return t("schedule.daily", { time: task.schedule.daily });
	if (task.schedule.cron) return t("schedule.cron", { expr: task.schedule.cron });
	return "";
}
function durationText(record, t) {
	if (record.startedAt == null || record.completedAt == null) return "";
	const seconds = Math.max(0, Math.round((record.completedAt - record.startedAt) / 1e3));
	if (seconds < 60) return t("duration.seconds", { count: seconds });
	return t("duration.minutes", {
		count: Math.floor(seconds / 60),
		seconds: seconds % 60
	});
}
/** Local "YYYY-MM-DDTHH:MM" for an ISO instant (what <input type="datetime-local"> wants). */
function toLocalInput(iso) {
	const ms = Date.parse(String(iso ?? ""));
	if (!Number.isFinite(ms)) return String(iso ?? "");
	const date = new Date(ms);
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** ISO instant for a local "YYYY-MM-DDTHH:MM" value, so the host sees an unambiguous at. */
function fromLocalInput(value) {
	const text = String(value ?? "").trim();
	if (text === "") return text;
	const ms = Date.parse(text);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : text;
}
function ruleOf(task) {
	if (task.schedule.cron) return "cron";
	if (task.schedule.daily) return "daily";
	if (task.schedule.everySeconds != null) return "every";
	return "at";
}
function ruleValueOf(task) {
	if (task.schedule.cron) return task.schedule.cron;
	if (task.schedule.daily) return task.schedule.daily;
	if (task.schedule.everySeconds != null) return String(task.schedule.everySeconds);
	return task.schedule.at ? toLocalInput(task.schedule.at) : "";
}
/**
 * Load the conversation directory only while a form actually needs it.
 *
 * The host reads one session log per row to find its title, so the first answer
 * can arrive with titles still missing; `loading`/`error` keep the picker from
 * looking empty while that request is in flight, and a second pass fills in the
 * titles the host cached in the meantime.
 */
function useSessionDirectory(enabled) {
	const [state, setState] = (0, react.useState)({ sessions: [], loading: false, error: null });
	const [attempt, setAttempt] = (0, react.useState)(0);
	(0, react.useEffect)(() => {
		if (!enabled) return undefined;
		let alive = true;
		let retryTimer = null;
		setState((prev) => ({ sessions: prev.sessions, loading: true, error: null }));
		api("sessions").then((result) => {
			if (!alive) return;
			const rows = Array.isArray(result?.sessions) ? result.sessions : [];
			setState({ sessions: rows, loading: false, error: null });
			if (attempt === 0 && rows.some((row) => typeof row?.title !== "string" || row.title === "")) {
				retryTimer = window.setTimeout(() => { if (alive) setAttempt(1); }, 1200);
			}
		}).catch((error) => {
			if (!alive) return;
			setState({ sessions: [], loading: false, error: error instanceof Error ? error.message : String(error) });
		});
		return () => {
			alive = false;
			if (retryTimer !== null) window.clearTimeout(retryTimer);
		};
	}, [enabled, attempt]);
	return { sessions: state.sessions, loading: state.loading, error: state.error };
}
/** Full text of one picker row: its title, or "对话 xxxxxxxx" while it has none. */
function sessionFullLabel(row, t) {
	const title = typeof row?.title === "string" && row.title.trim() !== "" ? row.title.trim() : null;
	return title ?? t("form.target.untitled", { id: String(row?.id ?? "").replace(/^session-/, "").slice(0, 8) });
}
/**
 * Picker label: a few characters are enough to tell conversations apart, and
 * long titles made the dropdown unreadable. The full title stays in the row's
 * tooltip (`sessionFullLabel`), and counting by code point keeps CJK whole.
 */
function sessionLabel(row, t) {
	// Spaces would eat the few characters on show ("寻找 dsh 定时…"), so drop them.
	const chars = Array.from(sessionFullLabel(row, t).replace(/\s+/g, ""));
	const short = chars.length <= 5 ? chars.join("") : `${chars.slice(0, 5).join("")}…`;
	return row?.live === true ? `${short} · ●` : short;
}
/** Which of the three target choices a task currently represents. */
function targetModeOf(task, currentId) {
	if (task.sessionMode === "new") return "new";
	if (typeof task.sessionId === "string" && task.sessionId !== "" && task.sessionId !== currentId) return "pick";
	return "current";
}
/**
 * add/update payload for the target choice: naming a conversation pins the
 * task there (bound), while "new" asks the host to open one of its own.
 */
function targetPayload(mode, target, currentId) {
	if (mode === "new") return { newSession: true };
	if (mode === "pick") return { sessionMode: "bound", sessionId: target };
	return { sessionMode: "bound", sessionId: typeof currentId === "string" ? currentId : "" };
}
/** The "conversation" row shared by the add and edit forms. */
function TargetFields({ t, mode, target, directory, onMode, onTarget }) {
	const sessions = directory.sessions;
	const emptyText = directory.loading
		? t("form.target.loading")
		: directory.error !== null
			? t("form.target.failed", { message: directory.error })
			: t("form.target.none");
	const options = sessions.length === 0
		? [(0, react_jsx_runtime.jsx)("option", { value: "", children: emptyText }, "none")]
		: sessions.map((row) => (0, react_jsx_runtime.jsx)("option", {
			value: row.id,
			title: sessionFullLabel(row, t),
			children: sessionLabel(row, t)
		}, row.id));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: styles.formRow,
		"data-dsh-schedule": "target-row",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
			className: styles.select,
			"data-dsh-schedule": "target-mode",
			value: mode,
			onChange: (e) => onMode(e.target.value),
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", { value: "current", children: t("form.target.current") }, "current"),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", { value: "pick", children: t("form.target.pick") }, "pick"),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", { value: "new", children: t("form.target.new") }, "new")
			]
		}), mode === "pick"
			? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
				className: styles.select,
				"data-dsh-schedule": "target-session",
				value: target,
				onChange: (e) => onTarget(e.target.value),
				children: options
			})
			: null, mode === "new"
				? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: styles.goalNote,
					children: t("form.target.newNote")
				})
				: null]
	});
}

/** Inline editor for one dynamic task (prompt + schedule rule). */
function EditTaskForm({ t, task, onDone }) {
	const [form, setForm] = (0, react.useState)({
		prompt: task.prompt,
		rule: ruleOf(task),
		value: ruleValueOf(task),
		goal: task.goal ?? ""
	});
	const [targetMode, setTargetMode] = (0, react.useState)(() => targetModeOf(task, activeSessionId));
	const [targetId, setTargetId] = (0, react.useState)(task.sessionId ?? "");
	const directory = useSessionDirectory(targetMode === "pick");
	(0, react.useEffect)(() => {
		if (targetMode !== "pick" || targetId !== "" || directory.sessions.length === 0) return;
		setTargetId(directory.sessions[0].id);
	}, [targetMode, targetId, directory.sessions]);

	const [error, setError] = (0, react.useState)("");
	const [busy, setBusy] = (0, react.useState)(false);
	const submit = async () => {
		setBusy(true);
		setError("");
		try {
			const payload = {
				id: task.id,
				prompt: form.prompt.trim()
			};
			if (form.rule === "daily") payload.daily = form.value.trim();
			else if (form.rule === "every") payload.every = Number(form.value.trim());
			else if (form.rule === "cron") payload.cron = form.value.trim();
			else payload.at = fromLocalInput(form.value);
			// Always send the goal so clearing the box removes it (empty string).
			payload.goal = form.goal.trim();
			// Where the runs go: this conversation, a picked one, or its own.
			Object.assign(payload, targetPayload(targetMode, targetId, activeSessionId));
			await api("update", payload);
			onDone();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	const valuePlaceholder = t(`form.value.${form.rule}`);
	const inputType = form.rule === "at" ? "datetime-local" : form.rule === "daily" ? "time" : "text";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: styles.form,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				className: styles.textarea,
				value: form.prompt,
				placeholder: t("form.prompt"),
				rows: 2,
				onChange: (e) => setForm({
					...form,
					prompt: e.target.value
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: styles.formRow,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					className: styles.select,
					value: form.rule,
					onChange: (e) => setForm({
						...form,
						rule: e.target.value,
						value: ""
					}),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "daily",
							children: t("form.rule.daily")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "every",
							children: t("form.rule.every")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "cron",
							children: t("form.rule.cron")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "at",
							children: t("form.rule.at")
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					className: styles.input,
					type: inputType,
					value: form.value,
					placeholder: valuePlaceholder,
					onChange: (e) => setForm({
						...form,
						value: e.target.value
					})
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TargetFields, {
				t,
				mode: targetMode,
				target: targetId,
				directory,
				onMode: setTargetMode,
				onTarget: setTargetId
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				className: styles.textarea,
				rows: 2,
				value: form.goal,
				placeholder: t("form.goal"),
				onChange: (e) => setForm({
					...form,
					goal: e.target.value
				})
			}),
			error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: styles.error,
				children: error
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: styles.formRow,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: styles.primaryButton,
					disabled: busy || form.prompt.trim() === "" || form.value.trim() === "",
					onClick: () => void submit(),
					children: t("action.save")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: styles.ghostButton,
					onClick: onDone,
					children: t("action.cancel")
				})]
			})
		]
	});
}
/**
 * 抽屉里新建一个定时任务（等价于 sched_add 工具）：任务内容 + 触发规则 + 可选目标。
 * 目标填了就变成「持续推进型」任务：每次触发宿主都会把目标 + 最近几次进展一起带给 Agent。
 */
function AddTaskForm({ t, onDone }) {
	const [form, setForm] = (0, react.useState)({
		prompt: "",
		rule: "daily",
		value: "09:00",
		goal: ""
	});
	const [targetMode, setTargetMode] = (0, react.useState)("current");
	const [targetId, setTargetId] = (0, react.useState)("");
	const directory = useSessionDirectory(targetMode === "pick");
	(0, react.useEffect)(() => {
		if (targetMode !== "pick" || targetId !== "" || directory.sessions.length === 0) return;
		setTargetId(directory.sessions[0].id);
	}, [targetMode, targetId, directory.sessions]);

	const [error, setError] = (0, react.useState)("");
	const [busy, setBusy] = (0, react.useState)(false);
	const submit = async () => {
		setBusy(true);
		setError("");
		try {
			const payload = { prompt: form.prompt.trim() };
			const raw = form.value.trim();
			if (form.rule === "daily") payload.daily = raw;
			else if (form.rule === "every") payload.every = Number(raw);
			else if (form.rule === "cron") payload.schedule = raw;
			else payload.at = fromLocalInput(raw);
			const goal = form.goal.trim();
			if (goal !== "") payload.goal = goal;
			// Bind the task to a conversation now; "new" lets the host open one.
			Object.assign(payload, targetPayload(targetMode, targetId, activeSessionId));
			await api("add", payload);
			onDone();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	const inputType = form.rule === "at" ? "datetime-local" : form.rule === "daily" ? "time" : "text";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: styles.form,
		"data-dsh-schedule": "add-task-form",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				className: styles.textarea,
				rows: 2,
				value: form.prompt,
				placeholder: t("form.prompt"),
				onChange: (e) => setForm({
					...form,
					prompt: e.target.value
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: styles.formRow,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					className: styles.select,
					value: form.rule,
					onChange: (e) => setForm({
						...form,
						rule: e.target.value,
						value: e.target.value === "daily" ? "09:00" : ""
					}),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "daily",
							children: t("form.rule.daily")
						}, "daily"),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "every",
							children: t("form.rule.every")
						}, "every"),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "cron",
							children: t("form.rule.cron")
						}, "cron"),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "at",
							children: t("form.rule.at")
						}, "at")
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					className: styles.input,
					type: inputType,
					value: form.value,
					placeholder: t(`form.value.${form.rule}`),
					onChange: (e) => setForm({
						...form,
						value: e.target.value
					})
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TargetFields, {
				t,
				mode: targetMode,
				target: targetId,
				directory,
				onMode: setTargetMode,
				onTarget: setTargetId
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				className: styles.textarea,
				rows: 2,
				value: form.goal,
				placeholder: t("form.goal"),
				onChange: (e) => setForm({
					...form,
					goal: e.target.value
				})
			}),
			error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: styles.error,
				children: error
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: styles.formRow,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: styles.primaryButton,
					disabled: busy || form.prompt.trim() === "" || form.value.trim() === "",
					onClick: () => void submit(),
					children: t("action.save")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: styles.ghostButton,
					onClick: onDone,
					children: t("action.cancel")
				})]
			})
		]
	});
}
function goalRank(goal) {
	if (goal.status === "pending") return 0;
	if (goal.status === "fired") return 1;
	return 2;
}
/** pending 在前、已触发/失败在后；同组按计划时间升序。 */
function sortGoals(goals) {
	return goals.slice().sort((a, b) => goalRank(a) - goalRank(b) || (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
}
function goalDotClass(goal) {
	if (goal.status === "pending") return styles.dotOn;
	if (goal.status === "failed") return styles.dot_failed;
	return styles.dot_completed;
}
function goalScheduleText(goal, t) {
	const time = formatTime(new Date(goal.scheduledAt ?? 0).toISOString());
	return goal.repeat === "daily" ? t("schedule.daily", { time }) : t("schedule.at", { time });
}
function goalMetaText(goal, t) {
	const parts = [goalScheduleText(goal, t)];
	if (goal.rounds !== undefined && goal.rounds !== null) parts.push(t("goal.rounds", { count: goal.rounds }));
	if (typeof goal.permission === "string" && goal.permission !== "") parts.push(goal.permission);
	return parts.join(" · ");
}
function CronGoalRow({ t, goal, onRemove }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: styles.row,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: styles.rowHead,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: goalDotClass(goal) }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: styles.taskId, children: goal.id }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: styles.badgeGoal, children: t("goal.badge") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: styles.badge, children: t("goal.status." + goal.status) }),
				goal.sessionId ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: styles.badge, title: goal.sessionId, children: t("task.bound") }) : null
			]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: styles.prompt, title: goal.prompt, children: goal.prompt }),
		goal.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: styles.error, children: goal.error }) : null,
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { className: styles.meta, children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: goalMetaText(goal, t) }),
			goal.status === "pending" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("task.next", { time: formatTime(new Date(goal.scheduledAt ?? 0).toISOString()) }) }) : null
		] }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: styles.actions, children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			className: styles.actionDanger,
			onClick: () => void onRemove(goal.id),
			children: t("action.remove")
		}) })]
	});
}
/** 抽屉里新建一个定时目标（等价于 schedule_goal_add 工具）。 */
function AddGoalForm({ t, onDone }) {
	const [form, setForm] = (0, react.useState)({ prompt: "", when: "", rounds: "", permission: "full-access" });
	const [error, setError] = (0, react.useState)("");
	const [busy, setBusy] = (0, react.useState)(false);
	const submit = async () => {
		setBusy(true);
		setError("");
		try {
			const payload = {
				prompt: form.prompt.trim(),
				when: form.when.trim(),
				permission: form.permission
			};
			const rounds = Number(form.rounds);
			if (form.rounds.trim() !== "" && Number.isFinite(rounds) && rounds > 0) payload.rounds = rounds;
			await api("goal_add", payload);
			onDone();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: styles.form,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				className: styles.textarea,
				rows: 2,
				value: form.prompt,
				placeholder: t("goal.addPrompt"),
				onChange: (event) => setForm({ ...form, prompt: event.target.value })
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: styles.formRow,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						className: styles.input,
						value: form.when,
						placeholder: t("goal.addWhen"),
						onChange: (event) => setForm({ ...form, when: event.target.value })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						className: styles.input,
						value: form.rounds,
						placeholder: t("goal.addRounds"),
						onChange: (event) => setForm({ ...form, rounds: event.target.value })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
						className: styles.select,
						value: form.permission,
						onChange: (event) => setForm({ ...form, permission: event.target.value }),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "full-access",
							children: "full-access"
						}, "full-access"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "workspace-write",
							children: "workspace-write"
						}, "workspace-write")]
					})
				]
			}),
			error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: styles.error,
				children: error
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: styles.formRow,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: styles.primaryButton,
					disabled: busy || form.prompt.trim() === "" || form.when.trim() === "",
					onClick: () => void submit(),
					children: t("action.save")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: styles.ghostButton,
					onClick: onDone,
					children: t("action.cancel")
				})]
			})
		]
	});
}
function CronPanel({ t, tab, setTab }) {
	const [tasks, setTasks] = (0, react.useState)([]);
	const [records, setRecords] = (0, react.useState)([]);
	const [error, setError] = (0, react.useState)("");
	const [editingId, setEditingId] = (0, react.useState)(null);
	const [goals, setGoals] = (0, react.useState)([]);
	const [addingGoal, setAddingGoal] = (0, react.useState)(false);
	const [addingTask, setAddingTask] = (0, react.useState)(false);
	const refresh = (0, react.useCallback)(async () => {
		try {
			// One round trip: /schedule/api/list returns reminder tasks and timed goals together.
			const [listResult, historyResult] = await Promise.all([api("list"), api("history", { limit: 50 })]);
			const nextGoals = sortGoals(Array.isArray(listResult.goals) ? listResult.goals : []);
			setTasks(listResult.tasks);
			setRecords(historyResult.records);
			setGoals(nextGoals);
			setEnabledCount(listResult.tasks.filter((task) => task.enabled).length + nextGoals.filter((goal) => goal.status === "pending").length);
			setError("");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);
	(0, react.useEffect)(() => {
		refresh();
		const timer = setInterval(() => void refresh(), 1e4);
		return () => clearInterval(timer);
	}, [refresh]);
	/** 删除一条定时目标。 */
	const removeGoal = async (id) => {
		try {
			await api("goal_remove", { id });
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};
	const act = async (method, payload) => {
		try {
			await api(method, payload);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: styles.tabs,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: tab === "tasks" ? styles.tabActive : styles.tab,
				onClick: () => setTab("tasks"),
				children: t("tab.tasks")
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: tab === "history" ? styles.tabActive : styles.tab,
				onClick: () => setTab("history"),
				children: t("tab.history")
			})]
		}),
		error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: styles.error,
			children: error
		}) : null,
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: styles.body,
			children: tab === "tasks" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: styles.list,
				children: [...(goals.length === 0 ? [] : [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: styles.sectionLabel, children: t("goal.section") }, "goal-section"),
					...goals.map((goal) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CronGoalRow, {
						t,
						goal,
						onRemove: removeGoal
					}, goal.id)),
					tasks.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: styles.sectionLabel, children: t("task.section") }, "task-section")
				]), tasks.length === 0 && goals.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: styles.empty,
					children: t("tasks.empty")
				}) : null, tasks.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: task.enabled ? styles.row : styles.rowDisabled,
					children: editingId === task.id ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EditTaskForm, {
						t,
						task,
						onDone: () => {
							setEditingId(null);
							refresh();
						}
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: styles.rowHead,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: task.enabled ? styles.dotOn : styles.dotOff }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: styles.taskId,
									children: task.id
								}),
								task.sessionMode === "new" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: styles.badge,
									title: t("task.newSessionTitle", { id: task.sessionId ?? "…" }),
									children: t("task.newSession")
								}) : task.sessionId ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: styles.badge,
									title: t("task.boundTo", { id: task.sessionId }),
									children: t("task.bound")
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: styles.badge,
									children: t(`origin.${task.origin}`)
								}),
								task.goal ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: styles.badge,
									title: t("task.goalTitle", { text: task.goal }),
									children: t("task.goalBadge")
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: styles.prompt,
							title: task.prompt,
							children: task.prompt
						}),
						task.goal ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: styles.goalNote,
							title: task.goal,
							children: t("task.goalNote", { text: task.goal })
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: styles.meta,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: scheduleText(task, t) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("task.next", { time: formatTime(task.nextRunAt) }) })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: styles.actions,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: styles.action,
									onClick: () => void act("run", { id: task.id }),
									children: t("action.run")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: styles.action,
									onClick: () => void act("toggle", {
										id: task.id,
										enabled: !task.enabled
									}),
									children: task.enabled ? t("action.pause") : t("action.resume")
								}),
								task.origin === "dynamic" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: styles.action,
									onClick: () => setEditingId(task.id),
									children: t("action.edit")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: styles.actionDanger,
									onClick: () => void act("remove", { id: task.id }),
									children: t("action.remove")
								})] }) : null
							]
						})
					] })
				}, task.id)), addingTask ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AddTaskForm, {
					t,
					onDone: () => {
						setAddingTask(false);
						refresh();
					}
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: styles.addButton,
					"data-dsh-schedule": "add-task",
					onClick: () => setAddingTask(true),
					children: t("task.add")
				}, "add-task"), addingGoal ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AddGoalForm, {
					t,
					onDone: () => {
						setAddingGoal(false);
						refresh();
					}
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: styles.addButton,
					onClick: () => setAddingGoal(true),
					children: t("goal.add")
				}, "add-goal")]
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: styles.list,
				children: [records.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: styles.empty,
					children: t("history.empty")
				}) : null, records.map((record) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: styles.row,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: styles.rowHead,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: styles[`dot_${record.status}`] ?? styles.dotOff }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: styles.taskId,
									children: record.taskId
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: styles.badge,
									children: t(`history.status.${record.status}`)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: styles.time,
									children: formatTime(record.firedAt)
								})
							]
						}),
						record.excerpt ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: styles.prompt,
							title: record.excerpt,
							children: record.excerpt
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: styles.meta,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("history.scheduled", { time: formatTime(record.scheduledFor) }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: durationText(record, t) })]
						})
					]
				}, record.id))]
			})
		})
	] });
}
//#region src/client/floating-window.ts
/** 浮窗位置的 localStorage 键（拖动结束后写入）。 */
const FLOAT_POS_KEY = "dsh-schedule:float-pos";
const FLOAT_WIDTH = 420;
const FLOAT_HEIGHT = 560;
const FLOAT_MARGIN = 12;
/** 夹进可视区：拖动、resize、还原历史位置都要过这一关，窗口永远完整可见。 */
function clampFloatPos(x, y) {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const width = Math.min(FLOAT_WIDTH, vw - FLOAT_MARGIN * 2);
	const height = Math.min(FLOAT_HEIGHT, vh - FLOAT_MARGIN * 2);
	const maxX = Math.max(FLOAT_MARGIN, vw - width - FLOAT_MARGIN);
	const maxY = Math.max(FLOAT_MARGIN, vh - height - FLOAT_MARGIN);
	return {
		x: Math.min(Math.max(FLOAT_MARGIN, Math.round(x)), maxX),
		y: Math.min(Math.max(FLOAT_MARGIN, Math.round(y)), maxY)
	};
}
/** 读回上次位置；没有记录就用「右上角、避开 header」的默认位置。 */
function readFloatPos() {
	try {
		const raw = window.localStorage.getItem(FLOAT_POS_KEY);
		if (raw !== null) {
			const parsed = JSON.parse(raw);
			if (parsed !== null && typeof parsed.x === "number" && typeof parsed.y === "number") return clampFloatPos(parsed.x, parsed.y);
		}
	} catch {}
	return clampFloatPos(window.innerWidth - FLOAT_WIDTH - 28, 88);
}
function writeFloatPos(pos) {
	try {
		window.localStorage.setItem(FLOAT_POS_KEY, JSON.stringify(pos));
	} catch {}
}
/** 挂到 <body>：抽离一切祖先层叠上下文、overflow 裁剪和 transform 定位。 */
function portalTo(node) {
	if (react_dom !== null && typeof react_dom.createPortal === "function" && typeof document !== "undefined") return react_dom.createPortal(node, document.body);
	return node;
}
//#endregion
function CronDrawer({ t }) {
	const tr = t ?? fallbackT;
	const { open, tab, toasts, prefs: currentPrefs } = useDrawerState();
	useCronWatcher();
	const [floatPos, setFloatPos] = (0, react.useState)(() => readFloatPos());
	const floatRef = (0, react.useRef)(null);
	const dragRef = (0, react.useRef)(null);
	const posRef = (0, react.useRef)(floatPos);
	// 按住标题栏拖动（按钮 / 输入框上不抢事件，否则点关闭会变成拖动）
	const beginDrag = (event) => {
		if (event.button !== 0) return;
		const target = event.target;
		if (target instanceof Element && target.closest("button, input, textarea, select, a") !== null) return;
		const rect = floatRef.current === null ? null : floatRef.current.getBoundingClientRect();
		dragRef.current = {
			dx: event.clientX - (rect === null ? 0 : rect.left),
			dy: event.clientY - (rect === null ? 0 : rect.top)
		};
		event.preventDefault();
	};
	(0, react.useEffect)(() => {
		if (!open) return;
		const onMove = (event) => {
			const drag = dragRef.current;
			if (drag === null) return;
			const next = clampFloatPos(event.clientX - drag.dx, event.clientY - drag.dy);
			posRef.current = next;
			setFloatPos(next);
		};
		const onUp = () => {
			if (dragRef.current === null) return;
			dragRef.current = null;
			writeFloatPos(posRef.current);
		};
		const onResize = () => {
			const next = clampFloatPos(posRef.current.x, posRef.current.y);
			posRef.current = next;
			setFloatPos(next);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			window.removeEventListener("resize", onResize);
			dragRef.current = null;
		};
	}, [open]);
	// 遮罩没了，所以「点窗口外面」关闭（header 上的触发器除外，它自己会 toggle）
	(0, react.useEffect)(() => {
		if (!open) return;
		const onPointerDown = (event) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (floatRef.current !== null && floatRef.current.contains(target)) return;
			// header 上的触发器、composer 上的 chip 都算「触发器」，它们自己 toggle。
			// 少了 chip 这一项的话，每次点 chip 都先被这里关掉、再被 click 打开，
			// 看起来就是在选中/未选中之间闪而进不去。
			if (target instanceof Element && target.closest("[data-dsh-schedule=\"trigger\"], [data-dsh-schedule=\"input-trigger\"]") !== null) return;
			setDrawerOpen(false);
		};
		const timer = setTimeout(() => document.addEventListener("pointerdown", onPointerDown, true), 0);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [open]);
	(0, react.useEffect)(() => {
		if (!open) return;
		const onKeyDown = (event) => {
			if (event.key === "Escape") setDrawerOpen(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open]);
	// 兜底：万一别的插件（目前是 dsh-dream-skin 的输入框卡片探测）还是把标记贴到本窗口上，
	// 立刻摘掉，不让它的整套卡片样式糊上来。role="dialog" 才是第一道防线（见 aside）。
	(0, react.useEffect)(() => {
		const node = floatRef.current;
		if (node === null || typeof MutationObserver === "undefined") return;
		const strip = () => {
			if (node.getAttribute("data-dsh-dream-skin-composer") !== null) node.removeAttribute("data-dsh-dream-skin-composer");
		};
		strip();
		const observer = new MutationObserver(strip);
		observer.observe(node, { attributes: true, attributeFilter: ["data-dsh-dream-skin-composer"] });
		return () => observer.disconnect();
	}, []);
	const testToast = () => {
		console.info("[dsh-schedule] test notification pushed from the drawer header");
		notifyEvents([{
			kind: "completed",
			record: {
				id: "toast-test",
				taskId: "toast-test",
				prompt: "",
				scheduledFor: "",
				firedAt: "",
				status: "completed",
				excerpt: tr("toast.testBody")
			}
		}]);
	};
	const toggleSystem = async () => {
		if (currentPrefs.system) {
			setPref("system", false);
			return;
		}
		if (typeof Notification === "undefined") return;
		if (Notification.permission === "default") try {
			await Notification.requestPermission();
		} catch {}
		if (Notification.permission === "granted") setPref("system", true);
		else console.warn("[dsh-schedule] notification permission:", Notification.permission);
	};
	return portalTo(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
			ref: floatRef,
			className: open ? styles.drawerOpen : styles.drawer,
			"aria-hidden": !open,
			"data-dsh-schedule": "float",
			// role="dialog" 不只是无障碍语义：dsh-dream-skin 的「聊天输入框卡片」探测会跳过
			// dialog 子树，否则「新任务」表单里的 textarea 一出现，它就把
			// data-dsh-dream-skin-composer 贴到本窗口上，连带改掉 position（窗口随之消失）。
			role: "dialog",
			"aria-modal": false,
			"aria-label": tr("trigger.aria"),
			style: {
				left: floatPos.x + "px",
				top: floatPos.y + "px"
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: styles.drawerHead,
				onPointerDown: beginDrag,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: styles.drawerTitle,
						children: tr("trigger.aria")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: styles.headSpacer }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: currentPrefs.system ? styles.headTextOn : styles.headText,
						"aria-label": tr("prefs.system"),
						title: tr("prefs.system"),
						onClick: () => void toggleSystem(),
						children: tr("prefs.systemShort")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: currentPrefs.sound ? styles.headTextOn : styles.headText,
						"aria-label": tr("prefs.sound"),
						title: tr("prefs.sound"),
						onClick: () => setPref("sound", !currentPrefs.sound),
						children: tr("prefs.soundShort")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: styles.headText,
						"aria-label": tr("drawer.test"),
						title: tr("drawer.test"),
						onClick: testToast,
						children: tr("drawer.testShort")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: styles.headText,
						"aria-label": tr("drawer.close"),
						title: tr("drawer.close"),
						onClick: () => setDrawerOpen(false),
						children: tr("drawer.close")
					})
				]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CronPanel, {
				t: tr,
				tab,
				setTab: setDrawerTab
			})]
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: styles.toastStack,
			"aria-live": "polite",
			children: toasts.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToastCard, {
				t: tr,
				item
			}, item.key))
		})
	] }));
}
function CronAction({ t, sessionId }) {
	const tr = t ?? fallbackT;
	useReportSession(sessionId);
	const { open, count, unread } = useDrawerState();
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		type: "button",
		className: open ? styles.triggerActive : styles.trigger,
		"data-dsh-schedule": "trigger",
		"aria-expanded": open,
		"aria-label": tr("trigger.aria"),
		title: tr("trigger.aria"),
		onClick: () => setDrawerOpen(!open),
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: styles.triggerLabel,
				children: tr("trigger.aria")
			}),
			count > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: styles.count,
				children: count
			}) : null,
			unread > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: styles.unreadBadge,
				children: unread
			}) : null
		]
	});
}
/** Compact trigger for the composer tool row; survives the header-collapse plugin. */
function CronInputAction({ t, sessionId }) {
	const tr = t ?? fallbackT;
	useReportSession(sessionId);
	const { open, count, unread } = useDrawerState();
	const label = tr("trigger.aria");
	return react_jsx_runtime.jsxs("button", {
		type: "button",
		className: open ? styles.chipActive : styles.chip,
		"data-dsh-schedule": "input-trigger",
		"aria-expanded": open,
		"aria-label": label,
		title: count > 0 ? label + " · " + count : label,
		onClick: () => setDrawerOpen(!open),
		children: [
			react_jsx_runtime.jsxs("svg", {
				className: styles.chipIcon,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: [
					react_jsx_runtime.jsx("circle", { cx: 8, cy: 8, r: 6.25, stroke: "currentColor", strokeWidth: 1.3 }),
					react_jsx_runtime.jsx("path", { d: "M8 4.6V8l2.4 1.5", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })
				]
			}),
			count > 0 ? react_jsx_runtime.jsx("span", { className: styles.chipCount, children: count }) : null,
			unread > 0 ? react_jsx_runtime.jsx("span", { className: styles.unreadBadge, children: unread }) : null
		]
	});
}
/** Client plugin body: dictionaries, styles, header trigger, and the drawer. */
function apply(ctx) {
	ctx.effect(() => ctx.locale.register("schedule", {
		zh,
		en
	}), "dsh-schedule: dictionaries");
	ctx.effect(() => {
		const tag = document.createElement("style");
		tag.dataset.plugin = "dsh-schedule";
		tag.textContent = css;
		document.head.append(tag);
		return () => tag.remove();
	}, "dsh-schedule: styles");
	ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
		name: "conversation.session.header.utilities",
		id: "schedule-trigger",
		order: -50,
		locale: "schedule",
		// The slot hands over its session id; the drawer needs it to default new
		// tasks to "this conversation".
		inject: (sessionId) => ({ sessionId })
	}, CronAction));
	ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
		name: "conversation.input.right",
		id: "schedule-input-trigger",
		order: 10,
		locale: "schedule",
		inject: (sessionId) => ({ sessionId })
	}, CronInputAction));
	ctx.slots.inject("shell.overlay", () => ctx.slots.register({
		name: "shell.overlay",
		id: "schedule-drawer",
		order: 100,
		locale: "schedule"
	}, CronDrawer));
}

//#endregion
exports.apply = apply;
exports.diffRecords = diffRecords;
exports.inject = inject;
		return module.exports;
	}
});
