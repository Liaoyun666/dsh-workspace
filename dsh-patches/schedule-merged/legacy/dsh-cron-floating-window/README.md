# dsh-cron 浮窗补丁

把 dsh-cron 右上角的「定时任务」面板，从**贴边抽屉**改成**浮在页面最上层、可拖动的浮窗**，
不再被宠物 / 侧栏 / 其它插件的浮层盖住，也不再被 shell 的圆角边框裁掉。

## 症状

- 点开会话头部的「定时任务」，面板有时**整个看不见**，或者只露出右边缘一截。
- 面板虽然在，但点不到里面的按钮 —— 点击落到了别的浮层（比如桌宠）上。
- 换窗口大小 / 多开插件之后更容易复现，看起来像「面板藏在某个东西下面」。

## 根因

dsh-cron 把面板 `inject` 进 `shell.overlay` 槽位，而 shell 的布局是：

```css
/* @deepseek-ai/dsh-client-ui-layout  AppFrame.module.css */
.mP3x-q_frame      { position: relative; overflow: hidden; height: 100%; display: grid; }
.mP3x-q_overlayLayer { position: absolute; inset: 0; z-index: 20; pointer-events: none; }
.mP3x-q_overlayLayer > * { pointer-events: auto; }
```

`.overlayLayer` 带 `z-index: 20` 且自身有定位 → 它**开了一个层叠上下文**。
抽屉里写的 `z-index: 900 / 901` 只在这层内部比较，整层的实际层级固定是 20，
于是永远排在 `document.body` 下其它浮层之下：

| 插件 | 用的 z-index |
| --- | --- |
| dsh-pet（菜单 / 多开面板 / 聊天 / 气泡） | 2147483000 / 2147483001 / 2147483002 |
| dsh-better-sidebar（诊断条） | 2147483000 |
| dsh-work-components | 2147483000 / 1100 |
| dsh-memory-evolve | 900 / 920（!important） |
| dsh-cost-meter | 9999 |

加上 `.frame { overflow: hidden }`，超出圆角的部分会被直接裁掉 —— 所以既遮挡又裁切。

## 补丁内容

只改 Web 客户端 bundle `node_modules/dsh-cron/lib/client.js`（宿主 `index.js` 不动）：

1. `require("react-dom")`（包一层 try/catch，缺了就退回原位置渲染），
   把面板 `createPortal` 到 `document.body` —— 脱离 `shell.overlay` 的层叠上下文和 `overflow: hidden`；
2. 抽屉样式改成圆角浮窗：`position: fixed`、`420×560`、`border-radius: 14px`、
   阴影 + 淡入位移过渡，`z-index: 2147483200`（高于本 profile 里所有其它插件）；
3. 标题栏当拖动条（`cursor: grab`，按钮 / 输入框上不抢事件），
   位置存 `localStorage["dsh-cron:float-pos"]`，下次打开还在原地；
   拖动、窗口 resize、读到历史位置时都过一遍 `clampFloatPos`，保证整窗留在可视区；
4. 去掉半透明遮罩，改成「点窗口外关闭」（保留 ESC 关闭；头部触发器自己 toggle，所以放过它）；
5. toast 栈 `z-index: 1200 → 2147483300`，通知不会被浮窗压住；
6. **顺手修掉插件里 5 个写错的主题变量**（`--dsw-alias-fill-l1/l2/l3`、`--dsw-alias-label-brand`、
   `--dsw-font-mono` 在本版 Harness 里都不存在），否则浏览器只能吃 `var()` 的硬编码兜底浅色，
   深色主题下「提示音」「任务」这类 active 态会变成白底白字的白块：

   | 用途 | 原来（不存在） | 改成（真实、随主题变化） |
   | --- | --- | --- |
   | active 态填充 | `fill-l2` → `#f2f2f2` | `--dsw-alias-button-ghost-active-fill`（深 `#43454a` / 浅 `#ebeef2`） |
   | active 态文字 | `label-primary` | `--dsw-alias-button-primary-fill` |
   | 行底 / 徽标 | `fill-l1` / `fill-l2` | `--dsw-alias-bg-multi-select`（深 `#212123` / 浅 `#f5f6f7`） |
   | hover | `fill-l2` | `--dsw-alias-interactive-bg-hover-solid`（深 `#353638` / 浅 `#f1f3f5`） |
   | 主按钮 | `fill-l3` → `#e5e5e5` | `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground` |
   | 等宽字体 | `--dsw-font-mono` | `ui-monospace, SFMono-Regular, Menlo, monospace` |

   同时给浮窗补上 `backdrop-filter: var(--dsw-menu-backdrop-filter, none)`，
   和 DSH 原生菜单/弹层同一套毛玻璃材质，拖动时背后内容不会糊成一片。

> 为什么用 `2147483200` 这个数：dsh-pet 用到 `2147483002`，取比它大、又低于 `2147483647`
> （32 位有符号上限，也是浏览器实际钳制的上限）的值，给以后的插件留了余量。

## 用法

```bash
node patch.mjs
```

- 幂等：已打过会打印「已打过补丁，跳过」并 exit 0。
- 锚点找不到 / 不唯一 / 写完自检不过 → 打印 `PATCH FAILED: …` 并 exit 1，不写坏文件。
- 首次运行把原文件备份到 `~/.dsh/dsh-cron-patches/backup/client.js`
  （和 `dsh-cron-web-drawer/` 补丁的 `index.js` 备份不同名，互不覆盖）。
- 环境变量：`DSH_CRON_DIR`（插件根目录）、`DSH_CRON_BACKUP`（备份目录）。

**插件升级会覆盖补丁**，升级后重跑一次即可。

### 和其它 dsh-cron 补丁的顺序

同一个 `lib/client.js` 上还有一个 `dsh-patches/cron-timed-goal-integration/patch.mjs`
（在抽屉里加「自动目标」段）。两者互不知情，**必须按这个顺序重打**：

```bash
cp ~/.dsh/dsh-cron-patches/backup/client.js \
   ~/.dsh/profiles/desktop/node_modules/dsh-cron/lib/client.js   # 先还原原件
node dsh-patches/cron-timed-goal-integration/patch.mjs
node dsh-patches/dsh-cron-floating-window/patch.mjs             # 本补丁最后
```

倒过来（先浮窗后 goal）会让 goal 补丁把 `.dsh-cron-badgeGoal` 的 `color` 重新写回
不存在的 `--dsw-alias-label-brand`，深色主题下那枚徽标又变回浅色兜底 —— 本补丁的自检
`bad vars` 会因此不为 0。

## 生效

客户端 bundle 是页面加载时取的，所以改完**刷新页面**即可（`Ctrl+Shift+R` 更保险），
不用重启 Desktop，也不用 nudge 宿主 HMR（那是 `index.js` 补丁才需要的）。

## 验证

改完可以直接用无头浏览器在假页面里验证（不需要登录 Web GUI）：

- 造一个 `.frame{overflow:hidden}` + `.overlayLayer{z-index:20}` + 一个
  `z-index:2147483000` 的全屏假浮层，模拟真实遮挡；
- 用 `react@18.3.1` 的 UMD 版 + 手写 `react/jsx-runtime` shim 把 `client.js` 跑起来，
  假 `window.fetch` 返回 `/cron/api/list` 与 `/cron/api/history`；
- 断言：面板 `parentElement === document.body`、`position: fixed`、`z-index: 2147483200`、
  浮窗中心 `elementFromPoint` 命中面板自身、拖动后仍在视口内且 localStorage 有记录、
  点外部后 `aria-hidden="true"`。

本地这次实测全部通过（1280×900 与 760×520 两种视口，含 2147483000 假遮挡层），
并在**真实 Web GUI**（`http://127.0.0.1:49599`，CDP 驱动无头 Edge + 自签会话 cookie）里复验：
`parentIsBody: true`、`z-index: 2147483200`、`elementFromPoint` 命中自身、`higherBlockers: []`、
拖动到 `[200,188]` 后仍完整可见且位置落盘、点外部关闭、`console errors: none`。

> 真实 GUI 里要注意 `dsh-header-collapse`：窗口不够宽时它会把头部胶囊全收进「⋯」，
> 此时 `[data-dsh-cron="trigger"]` 的 `display` 是 `none`，自动化脚本会以为「触发器没渲染」。
> 正确做法是先点 `[data-hc-trigger]`（那枚「⋯」）把 header 展开成 `data-hc="open"`，再点「定时任务」。

效果图：[`preview.png`](preview.png) —— 真实 GUI 里挂假任务数据（`window.fetch` 桩只拦
`/cron/api/list` 与 `/cron/api/history`）截的 2x 图，深色主题。

> 注意：`--force-device-scale-factor=2` 下 `Page.captureScreenshot` 的 clip 必须用 CSS 像素而不是设备像素，
> 否则会截到窗口外面去。

## 回滚

```bash
cp ~/.dsh/dsh-cron-patches/backup/client.js \
   ~/.dsh/profiles/desktop/node_modules/dsh-cron/lib/client.js
```

再刷新页面。
