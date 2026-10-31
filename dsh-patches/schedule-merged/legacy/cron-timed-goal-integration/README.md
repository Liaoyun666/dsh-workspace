# cron-timed-goal-integration — 让 dsh-cron 抽屉显示 dsh-timed-goal 的定时目标

## 解决什么问题

两个插件的定时功能各管一套数据：

| 插件 | 存哪 | 谁看得见 |
| --- | --- | --- |
| **dsh-cron** | `~/.dsh/cron-tasks.json` + `/cron/api/*` | 会话头部「定时任务」按钮 → 右侧抽屉 |
| **dsh-timed-goal** | `~/.dsh/plugins/dsh-timed-goal/jobs.json` + `/timed-goal/jobs` | 输入行 `[⏱ 定时]` 弹窗、设置页「定时任务」卡片 |

在 `[⏱ 定时]` 里安排的目标（到点钉权限 + 建 goal 自动跑若干轮），在 dsh-cron 的抽屉里**看不见**，
用户得记住去两个地方找。本补丁把两者合并显示。

## 补丁做了什么（只改 dsh-cron 的 Web 客户端 bundle，宿主代码不动）

文件：`~/.dsh/profiles/desktop/node_modules/dsh-cron/lib/client.js`

1. `CronPanel` 的 `refresh()` 并行多拉一次 `GET /timed-goal/jobs`；**插件不存在时静默降级为空列表**
   （`goalApi("GET").catch(() => null)`），不报错、不影响原功能。
2. 任务 tab 顶部多一段分组标题「**自动目标（定时 /goal）**」，下面是目标行：状态点、job id、
   「目标」徽章、待触发/已触发/失败、「绑定会话」徽章、提示词、`一次性 · 时间 · N 轮 · 权限`、
   `下次: …`（仅 pending 显示）、「删除」按钮。
3. 「删除」走 `DELETE /timed-goal/jobs/<id>`，与设置页那张卡片的删除完全等价（删完自动 `refresh()`）。
4. 头部触发按钮上的数字徽标 = cron 已启用任务数 + pending 目标数。
5. 空态文案补一句「也可以用输入行的 [定时] 安排一个到点自动执行的 goal」。
6. 中英文字典都补齐（`goal.section` / `goal.badge` / `goal.status.*` / `goal.rounds` / `task.section`）。

排序：pending 在前、已触发/失败在后；同组按计划时间升序。

## 怎么打

```powershell
# 注意：本机 shell 常设 ELECTRON_RUN_AS_NODE=1，直接用 electron.exe 跑脚本更稳
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& 'C:/Users/user/.dsh/electron/electron.exe' 'E:/工作区/dsh-patches/cron-timed-goal-integration/patch.mjs'
```

成功输出 `PATCH OK: <client.js 路径>`。脚本是**幂等**的（文件里已有 `dsh-timed-goal: goals in drawer`
标记就跳过），所以重复跑安全。

打完**必须让宿主 recompose 一次**，否则浏览器还拿旧 bundle：

```powershell
Add-Content 'C:/Users/user/.dsh/profiles/desktop/cordis.patch.yml' "# hmr nudge $(Get-Date -Format yyyyMMddHHmmss)"
# 等 8-10 秒
```

> 宿主 HMR 只在 profile 的 `package.json` / `cordis.patch.yml` **内容变化**时才 recompose，
> 追加一行注释就够，**不需要重启 Desktop**。

## 与其他补丁的叠加顺序（重要）

`dsh-cron/lib/client.js` 上同时挂着三个补丁，必须在 **原版** 上按顺序叠：

1. `dsh-patches/dsh-cron-web-drawer/` —— 宿主 `index.js`（`webServer`-only inject + `ctx.get` 取 trustedHosts）
2. `dsh-patches/dsh-cron-floating-window/` —— 客户端 `client.js`（面板 portal 到 body 的浮窗）
3. **本补丁** —— 客户端 `client.js`（goals 联动，叠在浮窗补丁之上）

尺寸指纹（v0.3.1 基准，用来判断现在文件里到底有什么）：

| 状态 | 字节数 | 特征 |
| --- | --- | --- |
| 0.3.1 原版 | 39302 | 无 `portalTo` |
| + 浮窗 | 44601 | 有 `portalTo`，无 goals 标记 |
| + 浮窗 + goals | 49984 | 有 `portalTo` 且有 `dsh-timed-goal: goals in drawer` |

**踩过的坑**：浮窗补丁那条线重跑时会把 `client.js` 还原成「原版 + 浮窗」（44601 B），
goals 补丁就没了。判断方法就是量字节数 / 查标记；补法是**再跑一次本补丁**（它会叠回去）。

检查命令：

```bash
f=~/.dsh/profiles/desktop/node_modules/dsh-cron/lib/client.js
wc -c "$f"; grep -c 'dsh-timed-goal: goals in drawer' "$f"
```

## 验收（都已实测通过）

宿主路由与 bundle：

```bash
curl -s -X POST http://127.0.0.1:49599/cron/api/list -H 'content-type: application/json' -d '{}'   # {"ok":true,"result":{"tasks":[]}}
curl -s http://127.0.0.1:49599/timed-goal/jobs                                                       # {"ok":true,"jobs":[...]}
```

> `GET /plugins/??dsh-cron/client.js&rev=<rev>` 必须带登录 cookie，否则 404。
> rev = sha1('plugin-artifact' + '\0' + 每个 [mtimeMs, ctimeMs, size] 的 `byteLen:part`) 前 12 位。

UI（Electron offscreen 探针，无头跑）：抽屉渲染出「自动目标（定时 /goal）」分组、
行内 `tg-xxxx 目标 待触发 绑定会话`、meta `一次性 · 2026/10/27 09:00:00 · 1 轮 · full-access`、
`下次: 2026/10/27 09:00:00`、`删除`；点「删除」后 `GET /timed-goal/jobs` 变 `{"ok":true,"jobs":[]}`，
抽屉回到空态并显示新文案。

证据截图（验证时留下，可删）：`E:/工作区/tmp/timed-goal-ui/10-cron-drawer-goals.png`。

## 还原

```bash
# 只撤 goals 补丁 → 回到「原版 + 浮窗」
cp ~/.dsh/dsh-cron-patches/backup/client.js \
   ~/.dsh/profiles/desktop/node_modules/dsh-cron/lib/client.js
# 然后按需重跑浮窗补丁
```

备份目录 `~/.dsh/dsh-cron-patches/backup/`：`client.js`（0.3.1 原版）、
`client.goals-integrated.js`（打好 goals 的成品）、`index.js`（宿主原版）。
