# schedule-merged — 三份 dsh-cron 补丁的来龙去脉（已并入 dsh-schedule，不再需要打）

本目录**不是可执行的补丁**，是归档：原来分别打在 profile `node_modules` 里的三份
`dsh-cron` 补丁，它们解决的三类问题现在已经**以源码形式固化**进工作区插件
`E:/工作区/dsh-plugins/dsh-schedule/`，而 `dsh-cron` / `dsh-timed-goal` 两个包
已经从 desktop profile 里卸载，补丁失去了对象。

原始 `patch.mjs` 与各自的 README 保留在 `legacy/` 下，只为可追溯（历史症状、根因推导、
尺寸指纹、踩坑），**不要再运行**——它们锚定的是 `node_modules/dsh-cron` 下已不存在的文件。

## 为什么合并

| 补丁 | 打在哪 | 解决什么 |
| --- | --- | --- |
| `legacy/dsh-cron-web-drawer/` | 宿主 `dsh-cron/index.js` | 上游 `ctx.inject(['webServer','webRuntime'])`，而 DSH 0.2.1 起没有 `webRuntime` 服务 → entry 永久 pending（上游 issue #109）→ `/cron/api` 前缀路由从不注册 → 宿主 webserver 对未匹配路径回落 **405**，Web 抽屉永远是空的（但模型侧 `cron_*` 工具、到点触发都正常） |
| `legacy/dsh-cron-floating-window/` | 客户端 `dsh-cron/lib/client.js` | 面板 inject 进 `shell.overlay`，而 `.mP3x-q_overlayLayer{position:absolute;inset:0;z-index:20}` **自带层叠上下文** → 插件里写的 900/901 只在层内比较，整层实际是 20，被 dsh-pet(2147483002)/better-sidebar(2147483000)/memory-evolve(920 !important)/cost-meter(9999) 压住；再加 `.mP3x-q_frame{overflow:hidden}` 把超出部分裁掉 |
| `legacy/cron-timed-goal-integration/` | 客户端 `dsh-cron/lib/client.js` | `dsh-cron` 与 `dsh-timed-goal` 各存一套数据、各有一个入口，`[⏱ 定时]` 排的目标在抽屉里看不见，用户得记住去两个地方找 |

三者都不是配置问题，是**宿主 API 变迁（0.1 → 0.2 的 webRuntime→webStartup）+ 层叠上下文 + 两套数据模型**，
所以修法只能进代码。

## 三份补丁的修法，以及它们现在在 dsh-schedule 里的位置

1. **webServer-only inject + `ctx.get` 取 trustedHosts**

   ```js
   // 旧补丁（打在上游 index.js 上）
   ctx.inject(['webServer'], (webCtx) => {
     const trustedHosts = () => {
       const s = ctx.get('webStartup'); if (s) return s.trustedHosts ?? []
       const r = ctx.get('webRuntime'); if (r) return r.trustedHosts ?? []
       return []
     }
     const fence = (req) => isTrustedApiRequest(req, trustedHosts())
   ```

   → 直接写成 `dsh-schedule/lib/index.js` 的设计：`export const inject = ['agents', 'tools']`，
   `webServer.run` 走 `ctx.get()`，宿主没有的服务**绝不进 inject**（进 inject 就永久 pending）。
   安全面不变：`isTrustedApiRequest` 仍要求 Host 是回环或命中 trustedHosts，再拒绝 `sec-fetch-site: cross-site`。

2. **portal 到 body 的浮窗**

   → `lib/client.js` 的 `portalTo(document.body)`：`position: fixed` 420×560、`border-radius:14px`、
   `z-index: 2147483200`（> dsh-pet 的 2147483002，< 浏览器上限 2147483647）、标题栏拖动 +
   `localStorage["dsh-schedule:float-pos"]` + `clampFloatPos`、点窗外关闭、toast `z-index: 2147483300`、
   `backdrop-filter: var(--dsw-menu-backdrop-filter, none)`。
   顺手修掉上游 5 个**不存在**的主题变量（`--dsw-alias-fill-l1/l2/l3`、`--dsw-alias-label-brand`、
   `--dsw-font-mono`），换成真实的 `--dsw-alias-button-ghost-active-fill` /
   `--dsw-alias-bg-multi-select` / `--dsw-alias-interactive-bg-hover-solid` /
   `--dsw-alias-button-primary-fill` / `--dsw-alias-label-primary-foreground` /
   `ui-monospace, SFMono-Regular, Menlo, monospace`——否则深色主题下 active 态是白底白字。

3. **goals 并入同一个面板**

   → `/schedule/api/list` 一次返回 `{tasks, goals}`，两者存同一个 `schedule-tasks.json`；
   浮窗第三个 tab「目标」显示状态/时间/轮数/权限/绑定会话，删除走 `/schedule/api/goal_remove`。
   旧补丁里「插件不在就静默降级」的写法不必再要：现在是同一个插件，没有第二个 HTTP 前缀。

## 尺寸指纹（v0.3.1 基准，判断某个文件里到底有没有补丁）

| 状态 | 字节数 | 特征 |
| --- | --- | --- |
| `dsh-cron/lib/client.js` 原版 | 39302 | 无 `portalTo` |
| + 浮窗 | 44601 | 有 `portalTo`，无 goals 标记 |
| + 浮窗 + goals | 49984 | 有 `portalTo` 且有 `dsh-timed-goal: goals in drawer` |

踩坑：浮窗那条线重跑会把 `client.js` 还原成 44601 B，goals 就没了，要再跑一次 goals 补丁。
**合并后的 `dsh-schedule/lib/client.js` 是独立文件（53844 B），不受这套指纹约束。**

## 还有一件事：v4 source kind

旧 `dsh-cron` 的 `fire()` 用 `createUserMessage({ source: { kind: 'plugin', plugin: 'cron' } })`，
而 DSH 0.1.7-rc.2 起 session format v4 只接受**生产者自有**的 kind，实时注入的 v4 事件不会被迁移器改写，
于是每次触发都让整轮 turn 直接死在「format v4 message requires a producer-owned source kind」。
相关补丁是 `dsh-patches/dsh-v4-source-kind/`（那份仍然有效，因为 `dsh-work-components` 还在）。

合并插件里已经写成 `dsh-schedule/lib/index.js` 的 `source: { kind: 'plugin:dsh-schedule' }`，
**不需要再打那份补丁的 dsh-cron 部分**；`verify_v4_source_kind.mjs` 顺手会扫到工作区插件，别再写回退役形状。

## 现在的部署形态

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": { "dsh-schedule": "link:E:/工作区/dsh-plugins/dsh-schedule" }
```

原因：**pnpm 会还原本地补丁**——`dsh plugin add/remove` 触发安装时会用上游文件覆盖
`node_modules/dsh-cron/index.js`（实测 line 910 从 `inject(['webServer'])` 变回
`inject(['webServer','webRuntime'])`），补丁线永远在跟包管理器打架。
换成工作区 `link:` 之后源码即部署，HMR 一次就生效，只在升级 DSH 本身时才需要复核 API。
