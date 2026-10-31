window.__ModuleLoader__.load({
	id: 'dsh-header-collapse',
	factory: (require) => {
		const React = require('react');
		const h = React.createElement;
		const { useCallback, useEffect, useState } = React;

		//#region 文案（走 Client locale 服务，没有 locale 席位时用 zh 兜底）
		const zh = {
			'trigger.aria': '更多插件',
			'panel.title': '插件与工具',
			'panel.hint': '再点「⋯」或按 Esc 收起'
		};
		const en = {
			'trigger.aria': 'More plugins',
			'panel.title': 'Plugins & tools',
			'panel.hint': 'Click the dots again or press Esc to collapse'
		};
		const fallbackT = (key) => zh[key] ?? key;
		//#endregion

		//#region 样式（只用主题变量 --dsw-*，不碰宿主的哈希类名）
		const css = `
[data-hc-trigger]{
	box-sizing:border-box;display:none;flex:none;align-items:center;justify-content:center;
	width:26px;height:24px;padding:0;margin:0;border:1px solid transparent;
	border-radius:var(--dsw-radius-md,6px);background:transparent;
	color:var(--dsw-alias-label-secondary,#8a8a8a);
	font-family:inherit;font-size:15px;font-weight:600;line-height:1;
	cursor:pointer;-webkit-app-region:no-drag;
}
[data-hc-trigger]:hover{
	background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));
	color:var(--dsw-alias-label-primary,#1f1f1f);
}
[data-hc-trigger]:focus-visible{
	outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));
	outline-offset:1px;
}
[data-hc-trigger][aria-expanded=true]{
	background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));
	border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.28));
	color:var(--dsw-alias-label-primary,#1f1f1f);
}

/* 折叠：只留「⋯」，其余胶囊收起（含被宿主包了一层的条目） */
html[data-hc=collapsed] [data-hc-trigger],
html[data-hc=open] [data-hc-trigger]{display:inline-flex}
html[data-hc=collapsed] [data-hc-part] > *:not([data-hc-trigger]):not(:has([data-hc-trigger])){display:none!important}

/* 展开：两个胶囊容器原地变成一张浮层的上下两段 */
/* 宿主给插槽内容套的那层是 display:contents（不生成盒子），
   所以这里必须用 !important 把它改成真盒子，否则 position:fixed 不生效。 */
html[data-hc=open] [data-hc-part]{
	display:flex!important;
	position:fixed!important;z-index:70;box-sizing:border-box;
	width:var(--hc-w,380px);right:var(--hc-right,20px);
	flex-wrap:wrap;align-items:center;justify-content:flex-start;
	gap:10px 8px;padding:10px 12px;
	max-height:min(56vh,440px);overflow:auto;overscroll-behavior:contain;
	background:var(--dsw-specific-menu,var(--dsw-alias-bg-base,#fff));
	-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);
	backdrop-filter:var(--dsw-menu-backdrop-filter,none);
	border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));
}
html[data-hc=open] [data-hc-part=actions]{top:var(--hc-top,60px)}
html[data-hc=open] [data-hc-part=utilities]{top:var(--hc-utils-top,var(--hc-top,60px))}
html[data-hc=open] [data-hc-part] > *{flex:0 0 auto;max-width:100%;min-width:0}
html[data-hc=open] [data-hc-part][data-hc-empty]{display:none}
html[data-hc=open] [data-hc-part][data-hc-first]::before{
	content:attr(data-hc-label);flex:1 1 100%;min-width:0;
	margin:0;padding-bottom:6px;
	border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));
	color:var(--dsw-alias-label-tertiary,#8a8a8a);
	font-size:11px;font-weight:500;line-height:16px;text-align:start;
}
/* 两段拼成一张卡片：中间的接缝既不要双线也不要圆角，只在最外圈收圆、
   投影只落在最下面那段，看起来才是一个整体而不是两个叠着的方块。 */
html[data-hc=open] [data-hc-part]{
	border-radius:0;
}
html[data-hc=open] [data-hc-part][data-hc-first]{
	border-top-left-radius:var(--dsw-radius-lg,12px);
	border-top-right-radius:var(--dsw-radius-lg,12px);
}
html[data-hc=open] [data-hc-part][data-hc-last]{
	border-bottom-left-radius:var(--dsw-radius-lg,12px);
	border-bottom-right-radius:var(--dsw-radius-lg,12px);
	box-shadow:var(--dsw-elevation-panel,0 12px 32px rgba(0,0,0,.26));
}
html[data-hc=open] [data-hc-part]:not([data-hc-first]){border-top:none}
html[data-hc=open] [data-hc-part]:not([data-hc-last]){border-bottom:none}
/* 展开时「⋯」留在面板里当收起键：排在最后、靠右 */
html[data-hc=open] [data-hc-trigger]{
	position:static;margin-inline-start:auto;
}
`;

		//#region 模块级状态（React 与 DOM 侧共用一份）
		const listeners = new Set();
		let open = false;
		const subscribe = (fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		};
		const emit = () => {
			for (const fn of [...listeners]) {
				try {
					fn();
				} catch (error) {
					console.warn('[dsh-header-collapse] listener failed', error);
				}
			}
		};
		const readOpen = () => open;
		//#endregion

		//#region DOM 侧
		const ATTR_TRIGGER = 'data-hc-trigger';
		const ATTR_PART = 'data-hc-part';
		const SLOT_ACTIONS = 'conversation.session.header.actions';
		const SLOT_UTILS = 'conversation.session.header.utilities';
		const GAP = 8;
		// 这些是本插件之外弹出的浮层（菜单/popover/tooltip），点它们不该收起面板
		const FLOATING = '[role=dialog],[role=menu],[role=listbox],[role=tooltip],[data-shell-overlay],.dsw-popover';
		const root = () => document.documentElement;
		const px = (n) => `${Math.round(n)}px`;
		const setVar = (name, value) => root().style.setProperty(name, value);
		const isPill = (node) => node instanceof Element && !node.hasAttribute(ATTR_TRIGGER);
		const pillsOf = (box) => (box ? [...box.children].filter(isPill) : []);
		const holdsTrigger = (node) => node instanceof Element && (node.matches(`[${ATTR_TRIGGER}]`) || node.querySelector(`[${ATTR_TRIGGER}]`) !== null);

		/**
		 * 从「⋯」往上找最近的、装着别的胶囊的祖先，那就是胶囊容器。
		 * 宿主可能直接在容器里渲染条目，也可能给每个条目包一层，两种都适用：
		 *   <div class="headerUtilities">  <pill/><pill/><button data-hc-trigger/>  </div>
		 *   <div class="headerUtilities">  <div><pill/></div><div><button data-hc-trigger/></div>  </div>
		 */
		function containerOf(node) {
			let box = node.parentElement;
			while (box) {
				const others = [...box.children].filter((child) => isPill(child) && !holdsTrigger(child));
				if (others.length > 0) return box;
				const parent = box.parentElement;
				if (!parent || parent === document.body) return null;
				box = parent;
			}
			return null;
		}

		/** 宿主给每个插槽容器打了 data-slot="<插槽名>"，可作为交叉校验。 */
		function slotNode(name, mustContain) {
			for (const node of document.querySelectorAll(`[data-slot="${name}"]`)) {
				if (!mustContain || node.contains(mustContain)) return node;
			}
			return null;
		}

		function locate() {
			const trigger = document.querySelector(`[${ATTR_TRIGGER}]`);
			if (!trigger) return null;
			// 结构判定优先：它一定装着真正的胶囊，槽位标记只用来兜底
			const utilities = containerOf(trigger) ?? slotNode(SLOT_UTILS, trigger);
			if (!utilities || !utilities.contains(trigger)) return null;
			// 宿主会给槽位容器再套一层单子节点的定位 div，往上跨过所有这样的包装层
			let titleRow = utilities.parentElement;
			while (titleRow && titleRow.childElementCount === 1) {
				const up = titleRow.parentElement;
				if (!up || up === document.body) break;
				titleRow = up;
			}
			if (!titleRow) return null;
			const cluster = titleRow.firstElementChild;
			let actions = slotNode(SLOT_ACTIONS, null);
			if (actions && (!titleRow.contains(actions) || actions === utilities || holdsTrigger(actions))) actions = null;
			if (!actions && cluster && cluster !== utilities && !cluster.contains(trigger)) {
				// titleRow 子节点顺序固定是 [titleCluster, headerUtilities]，actions 在 titleCluster 末尾
				let node = cluster;
				while (node && node.lastElementChild && node.lastElementChild.childElementCount > 0) {
					node = node.lastElementChild;
				}
				if (node && node !== cluster && !node.contains(trigger) && pillsOf(node).length > 0) actions = node;
			}
			return { trigger, utilities, titleRow, cluster, actions };
		}

		/** 打标记：谁是胶囊区、谁有内容、谁排第一/最后（决定圆角与标题条归属）。 */
		function tag(parts, translate) {
			const label = translate('panel.title');
			const boxes = [parts.actions, parts.utilities].filter(Boolean);
			const filled = boxes.filter((box) => pillsOf(box).length > 0);
			if (parts.actions) {
				if (filled.includes(parts.actions)) parts.actions.setAttribute(ATTR_PART, 'actions');
				else parts.actions.removeAttribute(ATTR_PART);
			}
			parts.utilities.setAttribute(ATTR_PART, 'utilities');
			for (const box of boxes) {
				box.setAttribute('data-hc-label', label);
				box.removeAttribute('data-hc-first');
				box.removeAttribute('data-hc-last');
				if (filled.includes(box)) box.removeAttribute('data-hc-empty');
				else box.setAttribute('data-hc-empty', '');
			}
			if (filled.length > 0) {
				filled[0].setAttribute('data-hc-first', '');
				filled[filled.length - 1].setAttribute('data-hc-last', '');
			}
		}

		/**
		 * 宽窄判定是量出来的，不是写死阈值：临时撤掉折叠态把胶囊摊平，
		 * 逐个子节点量 offsetWidth 求和，再和 titleRow 的可用宽度比。
		 * 全程同步，不会闪一帧。
		 */
		function measure() {
			const parts = locate();
			if (!parts) return null;
			const previous = root().getAttribute('data-hc');
			if (previous !== null) root().removeAttribute('data-hc');
			const width = (box) => {
				const pills = pillsOf(box);
				if (pills.length === 0) return 0;
				return pills.reduce((sum, node) => sum + node.offsetWidth, 0) + (pills.length - 1) * GAP;
			};
			const actionsWidth = width(parts.actions);
			const utilitiesWidth = width(parts.utilities);
			const pillsWidth = actionsWidth + (actionsWidth > 0 && utilitiesWidth > 0 ? GAP : 0) + utilitiesWidth;
			const crumbs = parts.cluster ? parts.cluster.firstElementChild : null;
			// 标题至少留 100px：宿主的 crumbs 自己会截断，但总得留出能认出会话名的一小段
			const titleWidth = crumbs ? Math.max(100, Math.min(crumbs.scrollWidth, 280)) : 100;
			// utilities 有 margin-left:20，titleCluster 与 utilities 之间是 gap:10
			const need = pillsWidth + titleWidth + (pillsWidth > 0 ? 30 : 0);
			const available = parts.titleRow.clientWidth;
			if (previous !== null) root().setAttribute('data-hc', previous);
			return { need, available };
		}

		/** 展开态定位：宽度、右侧对齐、上段高度（下段要接在上段下面）。 */
		function layoutPanel(anchor) {
			const parts = locate();
			if (!parts) return false;
			const rect = anchor ?? parts.trigger.getBoundingClientRect();
			const right = Math.max(8, window.innerWidth - rect.right);
			const width = Math.min(440, Math.max(280, window.innerWidth - 24));
			const top = rect.bottom + 8;
			setVar('--hc-right', px(right));
			setVar('--hc-trigger-right', px(right));
			setVar('--hc-trigger-top', px(Math.max(4, rect.top)));
			setVar('--hc-top', px(top));
			setVar('--hc-w', px(width));
			const upper = parts.actions && pillsOf(parts.actions).length > 0 ? parts.actions : null;
			const upperHeight = upper ? upper.getBoundingClientRect().height : 0;
			setVar('--hc-utils-top', px(top + upperHeight));
			return true;
		}

		function applyOpen(next) {
			const el = root();
			if (next) {
				const parts = locate();
				if (!parts) return;
				// 必须在切到 open 之前量锚点：切了之后「⋯」自己就是 fixed 的了
				const rect = parts.trigger.getBoundingClientRect();
				el.setAttribute('data-hc', 'open');
				if (!layoutPanel(rect)) {
					el.setAttribute('data-hc', 'collapsed');
					open = false;
					emit();
					return;
				}
				open = true;
			} else {
				open = false;
				el.setAttribute('data-hc', 'collapsed');
			}
			emit();
		}

		function install(getTranslate) {
			let disposed = false;
			let frame = 0;
			let timer = 0;
			let collapsed = null;

			const evaluate = () => {
				if (disposed) return;
				const parts = locate();
				if (!parts) {
					// 空白会话里宿主不渲染会话头，等它回来再算
					collapsed = null;
					root().removeAttribute('data-hc');
					return;
				}
				tag(parts, getTranslate());
				if (open) return;
				const box = measure();
				if (box === null) return;
				// 滞回：放不下就折；留 48px 余量才展开，免得在临界宽度反复横跳
				const next = box.need > box.available - 4
					? true
					: collapsed === true
						? box.need > box.available - 48
						: false;
				if (next) root().setAttribute('data-hc', 'collapsed');
				else root().removeAttribute('data-hc');
				collapsed = next;
			};

			const run = () => {
				try {
					evaluate();
				} catch (error) {
					console.warn('[dsh-header-collapse] layout pass failed', error);
				}
			};
			const scheduleNow = () => {
				if (disposed || frame) return;
				frame = window.requestAnimationFrame(() => {
					frame = 0;
					run();
				});
			};
			// 聊天流式输出时 body 每帧都变：这类改动加 250ms 节流，
			// 免得每帧为了量宽度强制一次重排
			const scheduleSoon = () => {
				if (disposed || timer) return;
				timer = window.setTimeout(() => {
					timer = 0;
					run();
				}, 250);
			};

			const onKey = (event) => {
				if (event.key === 'Escape' && open) {
					event.stopPropagation();
					applyOpen(false);
				}
			};
			const onPointerDown = (event) => {
				if (!open) return;
				const target = event.target;
				if (!(target instanceof Element)) return;
				if (target.closest(`[${ATTR_TRIGGER}]`) || target.closest(`[${ATTR_PART}]`)) return;
				// 面板里某个胶囊自己弹出的菜单/浮层：点它别把面板收掉
				if (target.closest(FLOATING)) return;
				applyOpen(false);
			};
			const onResize = () => {
				// 面板锚点是打开那一刻的坐标，窗口一变就收起，免得飘到别处
				if (open) applyOpen(false);
				scheduleNow();
			};

			const resizeObserver = new ResizeObserver(scheduleNow);
			const observeRow = () => {
				resizeObserver.disconnect();
				const parts = locate();
				if (parts) resizeObserver.observe(parts.titleRow);
			};
			const mutationObserver = new MutationObserver(() => {
				observeRow();
				scheduleSoon();
			});
			mutationObserver.observe(document.body, { childList: true, subtree: true });
			window.addEventListener('resize', onResize);
			document.addEventListener('keydown', onKey, true);
			document.addEventListener('pointerdown', onPointerDown, true);
			observeRow();
			scheduleNow();

			return () => {
				disposed = true;
				if (frame) window.cancelAnimationFrame(frame);
				if (timer) window.clearTimeout(timer);
				mutationObserver.disconnect();
				resizeObserver.disconnect();
				window.removeEventListener('resize', onResize);
				document.removeEventListener('keydown', onKey, true);
				document.removeEventListener('pointerdown', onPointerDown, true);
				const el = root();
				el.removeAttribute('data-hc');
				for (const name of ['--hc-top', '--hc-right', '--hc-w', '--hc-utils-top', '--hc-trigger-top', '--hc-trigger-right']) {
					el.style.removeProperty(name);
				}
				for (const node of document.querySelectorAll(`[${ATTR_PART}]`)) {
					for (const attr of [ATTR_PART, 'data-hc-label', 'data-hc-empty', 'data-hc-first', 'data-hc-last']) {
						node.removeAttribute(attr);
					}
				}
				open = false;
			};
		}
		//#endregion

		//#region 「⋯」按钮
		function HeaderCollapseTrigger({ t }) {
			const tr = typeof t === 'function' ? t : fallbackT;
			const [expanded, setExpanded] = useState(readOpen);
			useEffect(() => subscribe(() => setExpanded(readOpen())), []);
			const toggle = useCallback(() => applyOpen(!readOpen()), []);
			const onContextMenu = useCallback((event) => {
				// 左右键等价：挡掉系统菜单，再当一次点击处理
				event.preventDefault();
				event.stopPropagation();
				applyOpen(!readOpen());
			}, []);
			const label = tr('trigger.aria');
			return h('button', {
				type: 'button',
				[ATTR_TRIGGER]: '',
				'aria-haspopup': 'dialog',
				'aria-expanded': expanded ? 'true' : 'false',
				'aria-label': label,
				title: expanded ? tr('panel.hint') : label,
				onClick: toggle,
				onContextMenu,
				children: h('span', { 'aria-hidden': 'true', children: '\u22ef' })
			});
		}
		//#endregion

		function apply(ctx) {
			try {
				const state = { translate: fallbackT };
				const getTranslate = () => state.translate;

				ctx.effect(() => ctx.locale.register('header-collapse', { zh, en }), 'dsh-header-collapse: dictionaries');
				ctx.effect(() => {
					const style = document.createElement('style');
					style.dataset.plugin = 'dsh-header-collapse';
					style.textContent = css;
					document.head.append(style);
					return () => style.remove();
				}, 'dsh-header-collapse: styles');
				ctx.effect(() => install(getTranslate), 'dsh-header-collapse: layout');
				ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
					name: 'conversation.session.header.utilities',
					id: 'header-collapse',
					// 排在所有胶囊之后：折叠时它就站在这一排的末尾
					order: 999,
					locale: 'header-collapse'
				}, (props) => {
					const tr = typeof props?.t === 'function' ? props.t : fallbackT;
					state.translate = tr;
					return h(HeaderCollapseTrigger, { ...props, t: tr });
				}));
			} catch (error) {
				// 本插件坏掉不该连累整个界面
				console.warn('[dsh-header-collapse] apply failed', error);
			}
		}

		return {
			inject: ['slots', 'locale'],
			apply
		};
	}
});
