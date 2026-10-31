// dsh-mobile-ui — 手机 / 平板的响应式外壳。
//
// 桌面布局在窄屏上只是把中间列压窄：左栏固定 56px 图标轨，展开侧栏后中间只剩
// ~110px（一个字一行），输入区贴到屏幕最底、没有安全区，宽内容（表格/代码/图片）
// 会把版面顶宽。这里不改宿主代码，只做四件事：
//   1) 注入一份只在 data-mui=phone / tablet 下生效的 CSS；
//   2) 窄屏把左栏从栅格里摘出来，改成**可拖动的浮窗**（标题栏把手 + 收起键 +
//      位置记忆 + 边界夹紧），配一个汉堡浮键；
//   3) 从浮窗里点开的整页面板（插件 / 自动化任务 / 上下文洞察）同样当浮窗处理：
//      宿主没有返回按钮，这里自己补一个收起键，点它回到当前会话；
//   4) 跟随 visualViewport 把 --mui-vh 写对，键盘弹出时输入框不被挡住。
//
// 选择器只用 CSS Modules 类名的后缀做包含匹配（[class*="_sidebarCol"]），不写死
// 哈希前缀。两个坑：
//   · AppFrame 的类名也以 _frame 结尾，消息列表（V4vHZW_frame）和占位（SNx2jG_frame）
//     同样叫 *_frame —— 所以认 AppFrame 一律用 JS 打的 [data-mui-frame]，绝不单独用
//     [class*="_frame"]（这么写过一次：消息列表高度被锁成视口高，输入框被挤出屏幕）。
//   · 插件可能在文档最早期加载，documentElement / body 都还没建好；一律现取，不缓存。
window.__ModuleLoader__.load({
	id: 'dsh-mobile-ui',
	factory: () => {
		const CSS = "/* ============================================================\n   dsh-mobile-ui — 手机 / 平板适配\n   只用「类名后缀包含匹配」([class*=\"_xxx\"])，不写死 CSS Modules 的哈希前缀。\n   ============================================================ */\n\n/* ---------- 1. 通用（手机 + 平板） ---------- */\nhtml[data-mui] body{ -webkit-text-size-adjust:100%; }\n\n/* 消息里的宽内容不许把版面撑破：图片/视频/表格自己滚，不顶宽布局 */\nhtml[data-mui] [class*=\"_scrollBody\"] img,\nhtml[data-mui] [class*=\"_scrollBody\"] video{ max-width:100%; height:auto; }\nhtml[data-mui] [class*=\"_scrollBody\"] table{ max-width:100%; }\nhtml[data-mui] [class*=\"_scrollBody\"] .md-code-block,\nhtml[data-mui] [class*=\"_scrollBody\"] pre{ max-width:100%; }\n\n/* 触摸目标：顶栏那几个小按钮抬到 34px，手指点得中 */\nhtml[data-mui] [class*=\"_headerActions\"] button,\nhtml[data-mui] [class*=\"_headerActions\"] [role=\"button\"]{ min-width:34px; min-height:34px; }\n\n/* ---------- 2. 手机（<=720px）：侧栏变可拖动的浮窗 ---------- */\n/* 注意：AppFrame 用 JS 打的 [data-mui-frame] 认（见 lib/client.js 的 frameEl()）。\n   只写 [class*=\"_frame\"] 会误伤消息列表的 V4vHZW_frame / 占位 SNx2jG_frame（它们也叫\n   *_frame），把高度锁成视口高，整段对话被压扁、输入框被挤到屏幕外。 */\nhtml[data-mui=phone] [data-mui-frame]{\n\tgrid-template-columns: 0 minmax(0, 1fr) minmax(0, 0px) !important;\n\theight: var(--mui-vh, 100%);\n\ttransition: none;\n}\n/* 侧栏/右栏脱离栅格后，中间的列要显式落在第 2 轨，否则会被自动排进 0 宽的第 1 轨 */\nhtml[data-mui=phone] [class*=\"_centerCol\"]{ grid-column: 2; }\nhtml[data-mui=phone] [class*=\"_rightbarCol\"]{ grid-column: 3; }\nhtml[data-mui=phone] [class*=\"_bottomRow\"]{ grid-column: 1 / -1; }\n\n/* 左栏：真正能拖的浮窗 —— 上面一条 34px 的标题栏（[data-mui-winbar]，把手 + 收起键），\n   下面这块是窗身。位置与尺寸全由 client.js 算好写进 --mui-win-*（拖完存 localStorage，\n   边界夹在视口里），CSS 只负责长相。 */\nhtml[data-mui=phone] [class*=\"_sidebarCol\"]{\n\tposition: fixed;\n\tleft: var(--mui-win-x, calc(env(safe-area-inset-left, 0px) + 8px));\n\ttop: calc(var(--mui-win-y, calc(env(safe-area-inset-top, 0px) + 8px)) + 34px);\n\tbottom: auto;\n\twidth: var(--mui-win-w, min(84vw, 312px));\n\tmax-width: 312px;\n\theight: calc(var(--mui-win-h, min(calc(var(--mui-vh, 100vh) - 16px), 620px)) - 34px);\n\tz-index: 60;\n\tborder: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .18));\n\tborder-radius: 0 0 18px 18px;\n\tbox-shadow: 0 18px 46px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .35);\n\t/* 收起：整个挪到屏幕外（不用 -100% —— 浮窗可能被拖到右边，百分比会漏出来） */\n\ttransform: translateX(calc(-100vw - 80px));\n\ttransition: transform .24s cubic-bezier(.2, .7, .2, 1);\n\twill-change: transform;\n\t/* 抽屉是浮层，背后还有内容：宿主的侧栏底色是半透明的（实测 rgba(19,17,22,.4)），\n\t   浮起来会透出对话文字，所以换成不透明的 --mui-drawer-bg（由 client.js 从宿主\n\t   当前主题色算出，浅色主题自动跟着变）。 */\n\tbackground-color: var(--mui-drawer-bg, #121016);\n\toverflow-y: auto;\n\toverflow-x: hidden;\n\toverscroll-behavior: contain;\n\t-webkit-overflow-scrolling: touch;\n}\n/* 宿主把侧栏展开（narrowExpanded）时 = 浮窗打开 */\nhtml[data-mui=phone] [data-mui-frame]:not([data-sidebar-collapsed]) [class*=\"_sidebarCol\"]{ transform: none; }\n\n/* 浮窗的标题栏：拖它挪窗口，右边的 × 收起。只在手机档 + 打开时出现 */\n[data-mui-winbar]{ display: none; }\nhtml[data-mui=phone][data-mui-drawer=open] [data-mui-winbar]{\n\tdisplay: flex;\n\tposition: fixed;\n\tleft: var(--mui-win-x, calc(env(safe-area-inset-left, 0px) + 8px));\n\ttop: var(--mui-win-y, calc(env(safe-area-inset-top, 0px) + 8px));\n\twidth: var(--mui-win-w, min(84vw, 312px));\n\tmax-width: 312px;\n\theight: 34px;\n\tbox-sizing: border-box;\n\tz-index: 62;\n\talign-items: center;\n\tgap: 8px;\n\tpadding: 0 6px 0 12px;\n\tborder: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .18));\n\tborder-bottom: 0;\n\tborder-radius: 18px 18px 0 0;\n\tbackground-color: var(--mui-drawer-bg, #121016);\n\tcolor: var(--dsw-alias-label-secondary, #9a9a9a);\n\t/* 手机上拖窗口：不设 touch-action:none 的话手指一动就去滚页面了 */\n\ttouch-action: none;\n\tcursor: grab;\n\tuser-select: none;\n\t-webkit-user-select: none;\n}\n[data-mui-winbar] [data-mui-winbar-grip]{ display: inline-flex; opacity: .5; }\n[data-mui-winbar] [data-mui-winbar-title]{ flex: 1 1 auto; font-size: 12px; letter-spacing: .04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n[data-mui-winbar] [data-mui-winbar-close]{\n\tdisplay: inline-flex;\n\talign-items: center;\n\tjustify-content: center;\n\twidth: 28px;\n\theight: 28px;\n\tpadding: 0;\n\tmargin: 0;\n\tborder: 0;\n\tborder-radius: 9px;\n\tbackground: transparent;\n\tcolor: inherit;\n\tcursor: pointer;\n\t-webkit-tap-highlight-color: transparent;\n}\n[data-mui-winbar] [data-mui-winbar-close]:active{\n\tbackground: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, .16));\n\tcolor: var(--dsw-alias-label-primary, #f2f2f2);\n}\n\n/* 从浮窗里点开的整页面板（插件 / 自动化任务 / 上下文洞察）也当浮窗：\n   宿主会把整个主区换成这一页，这里把它拎出来做一张能拖的卡片，\n   页头当把手，右上角自己补一个收起键（宿主这一页没有返回按钮）。 */\nhtml[data-mui=phone] [data-slot=\"main\"] > section[class*=\"_page\"]{\n\tposition: fixed !important;\n\tleft: var(--mui-page-x, calc(env(safe-area-inset-left, 0px) + 8px)) !important;\n\ttop: var(--mui-page-y, calc(env(safe-area-inset-top, 0px) + 56px)) !important;\n\twidth: var(--mui-page-w, min(calc(100vw - 16px), 430px)) !important;\n\theight: var(--mui-page-h, min(calc(var(--mui-vh, 100vh) - 16px), 640px)) !important;\n\tz-index: 58 !important;\n\tbox-sizing: border-box;\n\tborder: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .18));\n\tborder-radius: 18px;\n\tbox-shadow: 0 18px 46px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .35);\n\tbackground-color: var(--mui-drawer-bg, #121016);\n\toverflow: auto;\n\toverscroll-behavior: contain;\n\t-webkit-overflow-scrolling: touch;\n}\nhtml[data-mui=phone] [data-slot=\"main\"] > section[class*=\"_page\"] > header[class*=\"_pageHead\"]{\n\tposition: sticky;\n\ttop: 0;\n\tz-index: 2;\n\tbackground-color: var(--mui-drawer-bg, #121016);\n\tcursor: grab;\n\ttouch-action: none;\n\tuser-select: none;\n\t-webkit-user-select: none;\n}\n[data-mui-pageclose]{ display: none; }\nhtml[data-mui=phone][data-mui-page=open] [data-mui-pageclose]{\n\tdisplay: inline-flex;\n\tposition: fixed;\n\tleft: var(--mui-page-close-x, calc(100vw - 48px));\n\ttop: var(--mui-page-close-y, calc(env(safe-area-inset-top, 0px) + 64px));\n\tz-index: 59;\n\talign-items: center;\n\tjustify-content: center;\n\twidth: 30px;\n\theight: 30px;\n\tpadding: 0;\n\tmargin: 0;\n\tborder: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .22));\n\tborder-radius: 10px;\n\tbackground: color-mix(in srgb, var(--mui-drawer-bg, #121016) 88%, transparent);\n\tcolor: var(--dsw-alias-label-secondary, #9a9a9a);\n\tcursor: pointer;\n\t-webkit-tap-highlight-color: transparent;\n\tbox-shadow: 0 4px 14px rgba(0, 0, 0, .4);\n}\n[data-mui-pagebackdrop]{ display: none; }\nhtml[data-mui=phone][data-mui-page=open] [data-mui-pagebackdrop]{\n\tdisplay: block;\n\tposition: fixed;\n\tinset: 0;\n\tz-index: 57;\n\tbackground: rgba(0, 0, 0, .38);\n\tborder: 0;\n\tpadding: 0;\n\tmargin: 0;\n\t-webkit-tap-highlight-color: transparent;\n}\n\n/* 右栏（文件/终端等）：同样是浮层，从右侧滑出 */\nhtml[data-mui=phone] [class*=\"_rightbarCol\"]{\n\tposition: fixed;\n\ttop: 0; right: 0; bottom: 0;\n\twidth: min(94vw, 460px);\n\tz-index: 61;\n\tbox-shadow: -8px 0 28px rgba(0, 0, 0, .45);\n\ttransform: translateX(102%);\n\ttransition: transform .24s cubic-bezier(.2, .7, .2, 1);\n}\nhtml[data-mui=phone] [data-mui-frame]:not([data-rightbar-collapsed]) [class*=\"_rightbarCol\"]{ transform: none; }\n\n/* 浮窗拉开时压暗背后的内容 */\nhtml[data-mui=phone][data-mui-drawer=open] [data-mui-backdrop]{\n\tdisplay: block;\n}\n\n/* 拖拽分隔条在手机上没意义 */\nhtml[data-mui=phone] [class*=\"_handle\"]{ display: none; }\n\n/* 顶栏给悬浮汉堡键让位：标题行和视图标签（对话/轨迹/更多）一起右移，别被按钮压住 */\nhtml[data-mui=phone] [class*=\"_header\"] [class*=\"_titleRow\"],\nhtml[data-mui=phone] [class*=\"_header\"] [class*=\"_tabs\"]{ padding-left: 52px; }\n\n/* 汉堡键：真正的悬浮按钮 —— 不透明一点的底 + 投影，浮在内容之上（不是贴在顶栏里的一块） */\n[data-mui-fab]{ display: none; }\nhtml[data-mui=phone] [data-mui-fab]{\n\tdisplay: inline-flex;\n\tposition: fixed;\n\ttop: calc(env(safe-area-inset-top, 0px) + 6px);\n\tleft: calc(env(safe-area-inset-left, 0px) + 8px);\n\tz-index: 65;\n\tbox-sizing: border-box;\n\talign-items: center;\n\tjustify-content: center;\n\twidth: 42px; height: 42px;\n\tpadding: 0;\n\tmargin: 0;\n\tborder: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .2));\n\tborder-radius: 14px;\n\t/* 宿主自己的 --dsw-alias-bg-base 是半透明的（实测 alpha .4），拿它做底会透出下面的字；\n\t   --mui-drawer-bg 是 client.js 剥掉 alpha 算出来的不透明底色，浅色主题也跟着变 */\n\tbackground: color-mix(in srgb, var(--mui-drawer-bg, #121016) 92%, transparent);\n\t-webkit-backdrop-filter: blur(14px);\n\tbackdrop-filter: blur(14px);\n\tbox-shadow: 0 8px 22px rgba(0, 0, 0, .42), 0 1px 3px rgba(0, 0, 0, .3);\n\tcolor: var(--dsw-alias-label-secondary, #9a9a9a);\n\tcursor: pointer;\n\t-webkit-tap-highlight-color: transparent;\n}\nhtml[data-mui=phone] [data-mui-fab]:active{\n\tbackground: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, .16));\n\tcolor: var(--dsw-alias-label-primary, #f2f2f2);\n}\nhtml[data-mui=phone][data-mui-drawer=open] [data-mui-fab]{ opacity: 0; pointer-events: none; }\n/* 二级页浮窗打开时也藏起来：横屏矮屏上它会被夹到 y=8，正好压住页左上角（页自己有关闭键） */\nhtml[data-mui=phone][data-mui-page=open] [data-mui-fab]{ display: none; }\n\n/* 浮窗外面的遮罩 */\n[data-mui-backdrop]{\n\tdisplay: none;\n\tposition: fixed;\n\tinset: 0;\n\tz-index: 59;\n\tbackground: rgba(0, 0, 0, .48);\n\tborder: 0;\n\tpadding: 0;\n\tmargin: 0;\n\t-webkit-tap-highlight-color: transparent;\n}\n\n/* 输入区：贴底时给安全区留白 */\n/* 浮窗底部（余额/设置那排）也别贴到 home 指示条上 */\nhtml[data-mui=phone] [class*=\"_sidebarCol\"] > *{\n\tpadding-bottom: env(safe-area-inset-bottom, 0px);\n}\n\nhtml[data-mui=phone] [class*=\"_composerSeat\"]{\n\tpadding-bottom: calc(env(safe-area-inset-bottom, 0px) + 2px);\n}\n\n/* 输入框下面那排状态胶囊：手机上不折行，横着滚，别把输入框顶出屏幕 */\nhtml[data-mui=phone] [class*=\"_dock\"]{\n\tflex-wrap: nowrap;\n\toverflow-x: auto;\n\toverflow-y: hidden;\n\tscrollbar-width: none;\n\t-webkit-overflow-scrolling: touch;\n}\nhtml[data-mui=phone] [class*=\"_dock\"]::-webkit-scrollbar{ display: none; }\nhtml[data-mui=phone] [class*=\"_dock\"] > *{ flex: 0 0 auto; }\n\n/* 输入框字号 16px：iOS 上小于 16px 会在聚焦时自动放大页面 */\nhtml[data-mui=phone] [data-composer-input]{\n\tfont-size: 16px;\n\tline-height: 23px;\n}\n\n/* 空态那排胶囊（工作区/人设）允许换行，不要横向溢出被裁 */\nhtml[data-mui=phone] [class*=\"_heroWorkspaceRow\"]{ flex-wrap: wrap; row-gap: 6px; }\nhtml[data-mui=phone] [class*=\"_headline\"]{ max-width: 100%; }\n\n/* 空态输入框上方那排「模型 ×0.11 ≈ tokens」：手机上被挤成 7px 高的一条碎线，\n   还会压到输入框上边框，直接藏掉（要看用量去会话里看） */\nhtml[data-mui=phone] [class*=\"_composerHero\"] [class*=\"_dock\"]{ display: none; }\n\n/* 横屏手机 / 很矮的窗口：空态那两行让位给输入区，否则 390 高的屏幕全被吃掉 */\n@media (max-height: 560px){\n\thtml[data-mui=phone] [class*=\"_composerHero\"] [class*=\"_headline\"],\n\thtml[data-mui=phone] [class*=\"_composerHero\"] [class*=\"_heroWorkspaceRow\"]{\n\t\tdisplay: none;\n\t}\n}\n\n/* ---------- 3. 平板（721-1024px）---------- */\nhtml[data-mui=tablet] [class*=\"_composerSeat\"]{\n\tpadding-bottom: calc(env(safe-area-inset-bottom, 0px) + 2px);\n}\n";

		const PHONE_MAX = 720;
		const TABLET_MAX = 1024;
		const SHORT_MAX = 560;
		const POS_KEY = 'dsh-mobile-ui:win:';
		const HAMBURGER = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
		const GRIP = '<svg width="20" height="8" viewBox="0 0 20 8" fill="none" aria-hidden="true"><path d="M4 2.5h12M4 5.5h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
		const CROSS = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.2 3.2l7.6 7.6M10.8 3.2l-7.6 7.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

		function start() {
			const html = () => document.documentElement;
			const setAttr = (name, value) => { const h = html(); if (h !== null) h.setAttribute(name, value); };
			const delAttr = (name) => { const h = html(); if (h !== null) h.removeAttribute(name); };

			const mode = () => {
				const h = html();
				const w = window.innerWidth || (h === null ? 0 : h.clientWidth) || 0;
				const tall = window.innerHeight || (h === null ? 0 : h.clientHeight) || 0;
				if (w <= PHONE_MAX) return 'phone';
				// 横屏手机（844x390 这种）：宽是够了，高度只有 390，按平板排会把 56px 的
				// 图标栏留在左边、空态又占掉半屏，所以一样走抽屉档。
				if (tall <= SHORT_MAX && w <= TABLET_MAX) return 'phone';
				if (w <= TABLET_MAX) return 'tablet';
				return '';
			};
			// _sidebarCol 的父节点就是 AppFrame —— 不靠 [class*="_frame"] 猜（见文件头）
			const frameEl = () => {
				const col = document.querySelector('[class*="_sidebarCol"]');
				return col === null ? null : col.parentElement;
			};
			const tagFrame = (f) => {
				if (f !== null) f.setAttribute('data-mui-frame', '');
			};
			const isDrawerOpen = () => {
				const f = frameEl();
				return f !== null && !f.hasAttribute('data-sidebar-collapsed');
			};
			const toggleButton = () => {
				const col = document.querySelector('[class*="_sidebarCol"]');
				const inCol = col === null ? null : col.querySelector('button[class*="_toggle"]');
				return inCol || document.querySelector('button[class*="_toggle"]');
			};
			// 二级整页面板：宿主把 [data-slot=main] 换成这一页（section.V7pFBG_page）
			const pageEl = () => {
				if (mode() !== 'phone') return null;
				return document.querySelector('[data-slot="main"] > section[class*="_page"]');
			};

			const fab = document.createElement('button');
			fab.type = 'button';
			fab.dataset.muiFab = '';
			fab.setAttribute('aria-label', '打开侧栏');
			fab.innerHTML = HAMBURGER;

			const backdrop = document.createElement('button');
			backdrop.type = 'button';
			backdrop.dataset.muiBackdrop = '';
			backdrop.setAttribute('aria-label', '关闭侧栏');

			// 浮窗标题栏：左边两道横线当把手，中间标题，右边 × 收起
			const winbar = document.createElement('div');
			winbar.dataset.muiWinbar = '';
			winbar.setAttribute('role', 'presentation');
			const grip = document.createElement('span');
			grip.dataset.muiWinbarGrip = '';
			grip.innerHTML = GRIP;
			const barTitle = document.createElement('span');
			barTitle.dataset.muiWinbarTitle = '';
			barTitle.textContent = '菜单';
			const barClose = document.createElement('button');
			barClose.type = 'button';
			barClose.dataset.muiWinbarClose = '';
			barClose.setAttribute('aria-label', '关闭菜单');
			barClose.innerHTML = CROSS;
			winbar.append(grip, barTitle, barClose);

			// 二级浮窗自己补的收起键 + 背后的遮罩
			const pageClose = document.createElement('button');
			pageClose.type = 'button';
			pageClose.dataset.muiPageclose = '';
			pageClose.setAttribute('aria-label', '收起面板');
			pageClose.innerHTML = CROSS;

			const pageBackdrop = document.createElement('button');
			pageBackdrop.type = 'button';
			pageBackdrop.dataset.muiPagebackdrop = '';
			pageBackdrop.setAttribute('aria-label', '关闭面板');

			// ---- 浮窗的位置与尺寸 ----
			// 尺寸由 JS 算、写进 CSS 变量：CSS 里的 min()/vw 和这里必须一致，
			// 否则夹边界时算的和看到的不一样，窗口会漏到屏幕外。
			let safe = { top: 0, left: 0, bottom: 0 };
			const viewportHeight = () => {
				const vv = window.visualViewport;
				const px = Math.round(vv ? vv.height : (window.innerHeight || 0));
				return px > 0 ? px : 0;
			};
			// env(safe-area-inset-*) 在 JS 里读不到，拿个探针元素量一次
			const readSafeArea = () => {
				const body = document.body;
				const gcs = typeof getComputedStyle === 'function' ? getComputedStyle : null;
				if (body === null || gcs === null) return { top: 0, left: 0, bottom: 0 };
				const probe = document.createElement('div');
				probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px);padding-left:env(safe-area-inset-left,0px);padding-bottom:env(safe-area-inset-bottom,0px);';
				body.append(probe);
				let out = { top: 0, left: 0, bottom: 0 };
				try {
					const cs = gcs(probe);
					out = {
						top: parseFloat(cs.paddingTop) || 0,
						left: parseFloat(cs.paddingLeft) || 0,
						bottom: parseFloat(cs.paddingBottom) || 0,
					};
				} catch (e) { /* 老浏览器：当没有安全区 */ }
				probe.remove();
				return out;
			};
			const winSize = (name) => {
				const vw = window.innerWidth || 0;
				const usableH = Math.max(240, viewportHeight() - safe.top - safe.bottom - 16);
				if (name === 'drawer') {
					return { w: Math.min(Math.round(vw * 0.84), 312), h: Math.min(usableH, 620) };
				}
				return { w: Math.min(Math.max(vw - 16, 240), 430), h: Math.min(usableH, 640) };
			};
			const positions = { drawer: null, page: null };
			const readPos = (name) => {
				try {
					const ls = window.localStorage;
					if (!ls) return null;
					const raw = ls.getItem(POS_KEY + name);
					if (!raw) return null;
					const p = JSON.parse(raw);
					if (p && typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y };
				} catch (e) { /* 隐私模式 / 脏数据：当没存过 */ }
				return null;
			};
			const savePos = (name, p) => {
				try {
					const ls = window.localStorage;
					if (!ls) return;
					ls.setItem(POS_KEY + name, JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) }));
				} catch (e) { /* 存不下就算了，下次回默认位置 */ }
			};
			const clampPos = (name, pos) => {
				const vw = window.innerWidth || 0;
				const vh = viewportHeight();
				const s = winSize(name);
				const minX = safe.left + 8;
				const minY = safe.top + 8;
				const maxX = Math.max(minX, vw - s.w - 8);
				const maxY = Math.max(minY, vh - safe.bottom - 8 - s.h);
				return {
					x: Math.min(Math.max(pos.x, minX), maxX),
					y: Math.min(Math.max(pos.y, minY), maxY),
				};
			};
			const applyPos = (name, pos) => {
				const h = html();
				if (h === null) return;
				const s = winSize(name);
				const p = clampPos(name, pos);
				positions[name] = p;
				if (name === 'drawer') {
					h.style.setProperty('--mui-win-x', p.x + 'px');
					h.style.setProperty('--mui-win-y', p.y + 'px');
					h.style.setProperty('--mui-win-w', s.w + 'px');
					h.style.setProperty('--mui-win-h', s.h + 'px');
					return;
				}
				h.style.setProperty('--mui-page-x', p.x + 'px');
				h.style.setProperty('--mui-page-y', p.y + 'px');
				h.style.setProperty('--mui-page-w', s.w + 'px');
				h.style.setProperty('--mui-page-h', s.h + 'px');
				// 收起键贴在窗口右上角（宿主那一页没有返回按钮，得自己补）
				h.style.setProperty('--mui-page-close-x', (p.x + s.w - 38) + 'px');
				h.style.setProperty('--mui-page-close-y', (p.y + 7) + 'px');
			};
			const ensurePos = (name) => {
				if (positions[name] !== null) return positions[name];
				// 抽屉默认贴左上角；二级页默认往下让开汉堡键，别一开就压住标题
				const fallback = name === 'drawer' ? { x: safe.left + 8, y: safe.top + 8 } : { x: safe.left + 8, y: safe.top + 56 };
				applyPos(name, readPos(name) || fallback);
				return positions[name];
			};
			const syncLayout = () => {
				safe = readSafeArea();
				if (positions.drawer !== null) applyPos('drawer', positions.drawer);
				if (positions.page !== null) applyPos('page', positions.page);
			};

			// ---- 拖动 ----
			const drag = { name: null, id: null, x0: 0, y0: 0, ox: 0, oy: 0 };
			const onDragMove = (e) => {
				if (drag.name === null) return;
				if (drag.id !== null && e.pointerId !== undefined && e.pointerId !== drag.id) return;
				applyPos(drag.name, { x: drag.ox + (e.clientX - drag.x0), y: drag.oy + (e.clientY - drag.y0) });
				if (e.cancelable) e.preventDefault();
			};
			const onDragEnd = () => {
				if (drag.name !== null && positions[drag.name] !== null) savePos(drag.name, positions[drag.name]);
				drag.name = null;
				drag.id = null;
				document.removeEventListener('pointermove', onDragMove, true);
				document.removeEventListener('pointerup', onDragEnd, true);
				document.removeEventListener('pointercancel', onDragEnd, true);
			};
			const startDrag = (name, e) => {
				if (e.button !== undefined && e.button !== 0) return;
				const p = ensurePos(name);
				drag.name = name;
				drag.id = typeof e.pointerId === 'number' ? e.pointerId : null;
				drag.x0 = e.clientX;
				drag.y0 = e.clientY;
				drag.ox = p.x;
				drag.oy = p.y;
				document.addEventListener('pointermove', onDragMove, true);
				document.addEventListener('pointerup', onDragEnd, true);
				document.addEventListener('pointercancel', onDragEnd, true);
				if (e.cancelable) e.preventDefault();
			};
			const onBarDown = (e) => {
				const t = e.target;
				if (t !== null && t.closest && t.closest('[data-mui-winbar-close]') !== null) return;
				startDrag('drawer', e);
			};
			// 二级浮窗用页头当把手；页头上的按钮（刷新/添加插件/两个 tab）照常点
			const onDocPointerDown = (e) => {
				if (mode() !== 'phone') return;
				const t = e.target;
				if (t === null || !t.closest) return;
				if (t.closest('[class*="_pageHead"]') === null) return;
				if (t.closest('button, a, input, textarea, select, [contenteditable], [role="button"]') !== null) return;
				startDrag('page', e);
			};

			// ---- 打开 / 关闭 ----
			const syncDrawer = () => {
				const open = mode() === 'phone' && isDrawerOpen();
				if (open) ensurePos('drawer');
				if (open) setAttr('data-mui-drawer', 'open');
				else delAttr('data-mui-drawer');
				syncWindows();
			};
			const syncWindows = () => {
				const h = html();
				if (h === null) return;
				const page = pageEl();
				if (page !== null) ensurePos('page');
				if (page !== null) h.setAttribute('data-mui-page', 'open');
				else h.removeAttribute('data-mui-page');
			};
			const syncHeight = () => {
				const h = html();
				if (h === null) return;
				h.style.setProperty('--mui-vh', viewportHeight() + 'px');
				syncLayout();
			};
			const syncMode = () => {
				const m = mode();
				if (m === '') delAttr('data-mui');
				else setAttr('data-mui', m);
				safe = readSafeArea();
				syncDrawer();
				syncHeight();
			};
			// 宿主的侧栏底色是半透明的，浮成浮窗后会透出背后的对话；这里读它当前的
			// 颜色、把 alpha 去掉，写成 --mui-drawer-bg 给 CSS 用（浅色主题自动跟着变）。
			const syncDrawerBg = () => {
				const col = document.querySelector('[class*="_sidebarCol"]');
				const h = html();
				const gcs = typeof getComputedStyle === 'function' ? getComputedStyle : null;
				if (col === null || h === null || gcs === null) return;
				const raw = gcs(col).backgroundColor || '';
				const open = raw.indexOf('(');
				const close = raw.lastIndexOf(')');
				if (open < 0 || close <= open) return;
				const parts = raw.slice(open + 1, close).split(',');
				if (parts.length < 3) return;
				h.style.setProperty('--mui-drawer-bg', 'rgb(' + parts[0].trim() + ', ' + parts[1].trim() + ', ' + parts[2].trim() + ')');
			};
			const openDrawer = () => {
				if (isDrawerOpen()) return;
				const b = toggleButton();
				if (b !== null) b.click();
			};
			const closeDrawer = () => {
				if (!isDrawerOpen()) return;
				const b = toggleButton();
				if (b !== null) b.click();
			};
			// 二级页没有返回按钮：点当前会话那一行，宿主就换回对话。
			// 注意面板页打开时宿主会把侧栏的会话列表卸载掉（实测 _sessionRow 数量为 0），
			// 所以点不到就先把自己的抽屉拉起来、等它渲染出来再点（最多试 3 次）。
			const closePage = (attempt) => {
				const tries = typeof attempt === 'number' ? attempt : 0;
				if (pageEl() === null) return;
				const col = document.querySelector('[class*="_sidebarCol"]');
				const rows = col === null ? [] : Array.from(col.querySelectorAll('[class*="_sessionRow"]'));
				if (rows.length > 0) {
					const sel = rows.find((r) => /_selected\b/.test(String(r.className))) || rows[0];
					if (sel !== undefined && typeof sel.click === 'function') { sel.click(); return; }
				}
				if (tries < 3) {
					openDrawer();
					setTimeout(() => closePage(tries + 1), 160);
					return;
				}
				// 实在点不到才退回上一层（history.length 不够就别退，免得退出整个网页）
				if (typeof history !== 'undefined' && history.length > 1) history.back();
			};

			const onFab = () => { if (isDrawerOpen()) closeDrawer(); else openDrawer(); };
			const onBackdrop = () => closeDrawer();
			const onKey = (e) => {
				if (e.key !== 'Escape' || mode() !== 'phone') return;
				if (pageEl() !== null) closePage();
				else closeDrawer();
			};
			const onDocClick = (e) => {
				if (mode() !== 'phone' || !isDrawerOpen()) return;
				const t = e.target;
				if (t === null || !t.closest) return;
				// 点会话行 / 新建会话 / 左侧那几个面板入口：浮窗让开，别挡住刚打开的内容
				const leaves = '[class*="_sessionRow"], [class*="_newSession"], [class*="_panelRow"]';
				if (t.closest(leaves) !== null) setTimeout(closeDrawer, 60);
			};
			const onResize = () => syncMode();

			document.body.append(backdrop, fab, winbar, pageBackdrop, pageClose);
			fab.addEventListener('click', onFab);
			backdrop.addEventListener('click', onBackdrop);
			winbar.addEventListener('pointerdown', onBarDown);
			barClose.addEventListener('click', closeDrawer);
			pageClose.addEventListener('click', closePage);
			pageBackdrop.addEventListener('click', closePage);
			document.addEventListener('pointerdown', onDocPointerDown, true);
			window.addEventListener('keydown', onKey);
			document.addEventListener('click', onDocClick, true);
			window.addEventListener('resize', onResize);
			if (window.visualViewport) {
				window.visualViewport.addEventListener('resize', syncHeight);
				window.visualViewport.addEventListener('scroll', syncHeight);
			}

			// 宿主的 narrowExpanded 是它自己的状态：盯住 AppFrame 的属性变化来同步浮窗
			let observed = null;
			let observer = null;
			const observe = () => {
				const f = frameEl();
				if (f === null || f === observed) return;
				if (observer !== null) observer.disconnect();
				if (observed !== null) observed.removeAttribute('data-mui-frame');
				observed = f;
				tagFrame(f);
				syncDrawerBg();
				observer = new MutationObserver(syncDrawer);
				observer.observe(f, { attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-rightbar-collapsed'] });
				syncDrawer();
			};
			tagFrame(frameEl());
			observe();
			const timer = setInterval(() => {
				observe();
				if (observer !== null) clearInterval(timer);
			}, 600);

			// 二级页是宿主按需挂上/摘掉的：盯 body 看它什么时候出现（节流，别跟着打字抖）
			let pageTimer = null;
			const pageObserver = new MutationObserver(() => {
				if (pageTimer !== null) return;
				pageTimer = setTimeout(() => { pageTimer = null; syncWindows(); }, 120);
			});
			if (document.body !== null) pageObserver.observe(document.body, { childList: true, subtree: true });

			syncMode();

			return () => {
				clearInterval(timer);
				if (pageTimer !== null) clearTimeout(pageTimer);
				pageObserver.disconnect();
				if (observer !== null) observer.disconnect();
				onDragEnd();
				fab.removeEventListener('click', onFab);
				backdrop.removeEventListener('click', onBackdrop);
				winbar.removeEventListener('pointerdown', onBarDown);
				barClose.removeEventListener('click', closeDrawer);
				pageClose.removeEventListener('click', closePage);
				pageBackdrop.removeEventListener('click', closePage);
				document.removeEventListener('pointerdown', onDocPointerDown, true);
				window.removeEventListener('keydown', onKey);
				document.removeEventListener('click', onDocClick, true);
				window.removeEventListener('resize', onResize);
				if (window.visualViewport) {
					window.visualViewport.removeEventListener('resize', syncHeight);
					window.visualViewport.removeEventListener('scroll', syncHeight);
				}
				delAttr('data-mui');
				delAttr('data-mui-drawer');
				delAttr('data-mui-page');
				const h = html();
				if (h !== null) {
					h.style.removeProperty('--mui-vh');
					h.style.removeProperty('--mui-drawer-bg');
					h.style.removeProperty('--mui-win-x');
					h.style.removeProperty('--mui-win-y');
					h.style.removeProperty('--mui-win-w');
					h.style.removeProperty('--mui-win-h');
					h.style.removeProperty('--mui-page-x');
					h.style.removeProperty('--mui-page-y');
					h.style.removeProperty('--mui-page-w');
					h.style.removeProperty('--mui-page-h');
					h.style.removeProperty('--mui-page-close-x');
					h.style.removeProperty('--mui-page-close-y');
				}
				if (observed !== null) observed.removeAttribute('data-mui-frame');
				fab.remove();
				backdrop.remove();
				winbar.remove();
				pageBackdrop.remove();
				pageClose.remove();
			};
		}

		function apply(ctx) {
			ctx.effect(() => {
				// 插件可能在全文档最早期就被加载：那时连 documentElement 都可能是 null，
				// 所以样式与浮键都放进同一个轮询里，等节点出现再挂。
				let style = null;
				let stop = null;
				let timer = null;

				const ensureStyle = () => {
					if (style !== null) return true;
					const h = document.documentElement;
					const parent = document.head === null ? h : document.head;
					if (parent === null) return false;
					for (const stale of document.querySelectorAll('style[data-plugin="dsh-mobile-ui"]')) stale.remove();
					style = document.createElement('style');
					style.dataset.plugin = 'dsh-mobile-ui';
					style.textContent = CSS;
					parent.append(style);
					return true;
				};
				const boot = () => {
					if (stop !== null || timer === null) return;
					if (!ensureStyle() || document.body === null) {
						timer = setTimeout(boot, 30);
						return;
					}
					clearTimeout(timer);
					timer = null;
					stop = start();
				};
				timer = setTimeout(boot, 0);

				return () => {
					if (timer !== null) clearTimeout(timer);
					if (stop !== null) stop();
					if (style !== null) style.remove();
				};
			}, 'dsh-mobile-ui: responsive shell');
		}

		return { inject: [], apply };
	}
});
