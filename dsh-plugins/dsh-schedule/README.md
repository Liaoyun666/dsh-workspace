# dsh-schedule — 一个插件管完所有「到点干活」

DeepSeek Harness 的本地插件（`link:` 方式挂在 desktop profile 里），把原本两个上游插件的
定时能力合并成一套：**同一个存储、同一个 HTTP 前缀、同一个浮窗**。

| 能力 | 到点做什么 | 谁执行 |
| --- | --- | --- |
| **定时任务（remind）** | 往会话里投一条 prompt（`agent.followup()`，source=plugin），当成普通用户消息跑一轮；**任务可以带 `goal`（持续目标），每次触发都带上目标 + 前几轮进度摘要，让同一件事接着往前推** | 会话自己的 agent loop |
| **定时目标（goal）** | 先把会话权限钉成指定预设，再用 `ctx.get('goals').create()` 建一个 armed goal，交给部署里的 goal-round-driver 自动跑 | goal-round-driver |

> 只想要「到点提醒我一句」用 `sched_add`；想要「每隔一段时间推进同一个目标、轮与轮之间接着走」，
> 用 `sched_add({prompt, goal, daily|every|cron|at})` —— 这是**目标续跑型任务**；
> 想要「先钉住权限再用 goal-round-driver 一路跑完」才用 `sched_goal_add`。

## 文件

```
dsh-plugins/dsh-schedule/
├── package.json          # name=dsh-schedule，dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml      # 一行 insert，携带全部 config（可在 profile 的 patch 层按 id 覆盖）
├── lib/index.js          # 宿主半边：任务引擎（含 goal 续跑）+ 9 个工具 + /schedule/api
├── lib/goals.js          # 定时目标引擎（无 IO、无 @deepseek-ai 依赖，只用 node: 内置）
├── lib/client.js         # Web 半边：会话头部按钮 + 可拖动浮窗（预览/执行记录/目标）
└── README.md
```

**设计约束（重要）**：插件是从工作区路径加载的，realpath 下没有 `node_modules`，
所以 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`
**一个都不能 import**（实测 `createRequire` 解析全部 MODULE_NOT_FOUND）。因此：

- `defineTool` / `createUserMessage` 在 `lib/index.js` 里内联了最小等价实现；
- 所有宿主服务（`webServer`、`webStartup`、`goals`、`permission-presets`、`agents`）
  一律走 `ctx.get()` 鸭子类型读取，缺了就告警降级，**绝不写进 `inject`**
  （inject 里列了宿主没有的服务 → entry 永久 pending，上游 issue #109）。

## 安装 / 重装

profile 里已经是 `link:` 依赖 + `dsh.profile.bundles` 里一行：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": { "dsh-schedule": "link:E:/工作区/dsh-plugins/dsh-schedule" },
"dsh": { "profile": { "bundles": [ /* … */ "dsh-schedule" ] } }
```

`node_modules/dsh-schedule` 是指向本目录的符号链接。改了 `lib/*.js` 之后让宿主 recompose：

```bash
printf '\n# hmr nudge %s\n' "$(date +%Y%m%d-%H%M%S)" >> ~/.dsh/profiles/desktop/cordis.patch.yml
# 等 8-10 秒，浏览器刷新
```

> HMR 只在 profile 的 `package.json` / `cordis.patch.yml` **内容变化**时才 recompose，
> 追加一行注释就够，不用重启 Desktop。宿主侧新注册的工具会立即出现在模型工具表里。

## 存储

| 文件 | 内容 |
| --- | --- |
| `$DSH_HOME/schedule-tasks.json`（默认 `~/.dsh/`，version 2） | 动态任务 + 每个任务的 `lastRunAt` / `firedAt` / enabled 覆盖 + **定时目标**（同一文件） |
| `$DSH_HOME/schedule-history.jsonl` | 执行记录，一行一条，滚动封顶 500 条 |

两个路径都能用 config 的 `storagePath` / `historyPath` 改。重启后不会重放已消费的时间槽。

## config（`cordis.patch.yml` 那一行）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `storagePath` | `''` = `$DSH_HOME/schedule-tasks.json` | 任务 + 目标 |
| `historyPath` | `''` = `$DSH_HOME/schedule-history.jsonl` | 执行记录 |
| `tickSeconds` | `15` | 提醒任务的唤醒间隔（到点最多晚这么多） |
| `goalTickSeconds` | `1` | 定时目标的唤醒间隔（秒级精度） |
| `systemNotify` / `systemNotifySound` | `true` / `true` | 跑完后发系统通知 / 提示音 |
| `autoRemoveFinished` | `true` | 一次性任务（`at`）跑完自动从任务栏删掉，见下 |
| `tasks` | `[]` | 静态任务（形状同 `sched_add`，origin=config，不能运行时删） |

**注意**：patch 层覆盖是按 id **整行替换**，要保留的键必须全部重写一遍。

## 模型工具（全部 `sched_*` 前缀）

> 原来的 `schedule_*` 名字与 DSH 内置提醒插件（`@deepseek-ai/dsh-schedule`）**同名冲突**，
> 内置的会赢，所以统一加了 `sched_` 前缀。

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `sched_list` | — | 列全部任务（config + 动态）含状态与下次运行时间 |
| `sched_add` | `prompt` 必填；`goal`（持续目标，可选）；`id`；at/every/daily/schedule 四选一；`sessionId`（投递到指定会话）；`newSession`（true=新开专属会话） | 新建提醒任务；默认绑定调用它的会话 |
| `sched_update` | `id` 必填；prompt / 一条新规则 / `goal`（空串=清空）/ `sessionId` / `newSession` | 改动态任务 |
| `sched_sessions` | — | 列可选会话（`{id,title,cwd,live}`，新的在前，最多 60 条；标题带缓存，见下） |
| `sched_remove` | `id` | 删动态任务（config 任务不可删） |
| `sched_history` | `limit`（默认 20） | 执行记录，最新在前 |
| `sched_goal_add` | `when`、`prompt` 必填；`rounds`、`daily`、`permission` | 排一个定时目标 |
| `sched_goal_list` | — | 列目标（pending / fired / failed） |
| `sched_goal_update` | `id`、`when`、`prompt` 必填 | 改目标（改完回到 pending） |
| `sched_goal_remove` | `id` | 删目标 |

规则语义：`at` ISO 即时一次性；`every` 固定秒数（**最少 10 秒**，每次触发都是真实一轮模型调用，别设太小）；
`daily` 本地 `HH:MM`；`schedule` 标准五段 cron（`0 9 * * 1` = 每周一 09:00，本地时区）。

一次性（`at`）任务**跑完就自动消失**：见「## 一次性任务跑完自动清理」。

> 字段名：工具和 Web 表单里 cron 那一项叫 `schedule`，**记录里存的是 `cron`**（`dueSlot`/`nextRunAt`/`taskView`/落盘都读 `cron`）。
> `add` 与 `update` 两个入口都会把 `schedule` 规范化成 `cron`；`taskView` 输出 `schedule:{cron:"…"}`，
> 所以 `sched_list` 里看到 `schedule:{cron:…}` 才是正常的。（历史上这里断过：`addTask` 只写 `schedule`，
> 结果 cron 任务 `nextRunAt` 永远 null、从不触发，2026-10-29 已修。）

## HTTP API（Web 半边用）

前缀 `/schedule/api`，**只接受 POST**，body 是 JSON，返回 `{ok:true,result:…}` 或
`{ok:false,error:{code,message}}`。

| method | payload | 返回 |
| --- | --- | --- |
| `list` | — | `{tasks, goals}` |
| `sessions` | — | `{sessions:[{id,title,cwd,live}]}` —— 新建/编辑任务时选「对话目标」用（最新 60 个会话，标题走缓存） |
| `add` / `update` / `remove` | 同 `sched_add`/`sched_update`；`remove:{id}` | `{task}` |
| `toggle` | `{id, enabled}` | `{task}` |
| `run` | `{id}` | 立即跑一次 |
| `history` | `{limit}` | `{records}` |
| `detail` | `{id}` | `{task, progress}` —— `progress:{round, previous:[{at,excerpt}]}` |
| `goal_list` / `goal_add` / `goal_update` / `goal_remove` / `goal_clear` | 同上 | `{goals}` / `{goal}` |

安全面：`isTrustedApiRequest` 要求 Host 头是回环地址或命中 `webStartup.trustedHosts`
（`ctx.get('webStartup')` 读，不 import），再拒绝 `sec-fetch-site: cross-site`；
不满足返回 403。所有 `/api/*` 之外的路由仍受 DSH 全局登录 cookie 约束。

## Web 界面

- **入口（两个，点哪个都开同一个浮窗）**：
  1. **输入栏 chip**（slot `conversation.input.right`，order 10，id `schedule-input-trigger`）：
     22px 高的时钟图标按钮，永远在输入框右侧工具行里，**不受会话头部折叠影响**；
  2. **会话头部按钮**（slot `conversation.session.header.utilities`，order -50，id `schedule-trigger`）。
  徽标数 = 已启用任务数 + pending 目标数。
- **头部按钮会被折叠插件吞掉**：`dsh-header-collapse` 在窗口放不下时给
  `<html data-hc="collapsed">`，其规则 `[data-hc-part] > *:not([data-hc-trigger]){display:none!important}`
  把头部所有胶囊收进「⋯ 更多插件」面板（定时任务也在里面，点过 ⋯ 能点到）。
  头部宽度不够时只剩输入栏那个 chip —— 这就是「输入栏的定时任务」该存在的位置。
- **空白会话 / 首页没有头部**：没有打开会话时宿主不渲染 `conversation.session.header`，
  头部按钮不存在；输入栏 chip 只在该会话打开后出现（`scope: session` 槽位）。
- **面板**：`createPortal` 到 `document.body` 的 420×560 可拖动浮窗
  （`localStorage["dsh-schedule:float-pos"]` 记位置），`z-index: 2147483200`
  —— 必须高于 `shell.overlay` 那一层（`.overlayLayer{z-index:20}` 自带层叠上下文，
  插件里写 900 只在层内比较），也要高于桌宠的 2147483002。`aside` 带 `role="dialog"`
  且定位属性写了 `!important`，都是为了防别的插件改掉它的定位（见「已知坑」最后一条）。
- **点窗口外面关闭**：`document` 捕获阶段的 `pointerdown`；`[data-dsh-schedule="trigger"]`
  和 `"input-trigger"` 都豁免——它们自己 toggle，不豁免的话点 chip 每次都「先关后开」，
  看着就是在选中/未选中之间闪。
- **任务 tab 有「＋ 新任务」表单**（`data-dsh-schedule="add-task"` → `"add-task-form"`）：
  任务内容 + 触发规则（每天 / 每隔 / cron / 一次性，一次性用 `datetime-local`）+ **对话目标** + **目标（goal）**
  + 保存/取消，提交走 `POST /schedule/api/add`；编辑表单（`EditTaskForm`）同样能改/清空 goal、改对话目标。
- **对话目标三选一**（`data-dsh-schedule="target-mode"` 下拉 + `"target-session"` 第二个下拉）：
  「本对话」/「指定对话」（从 `/schedule/api/sessions` 拉列表，`●` 表示会话还活着）/「新开专属对话」。
  列表没回来时下拉里显示「正在读取对话列表…」，失败显示「读取对话列表失败：…」；
  没有标题的会话用 `对话 <id 前 8 位>` 兜底，不会再是一串裸 UUID。
  下拉里每个会话**只显示 5 个字**（去掉空格后按字符算，超出加省略号），鼠标悬停可看完整标题；
  带 `●` 的是还开着的会话。
  表单默认「本对话」——那个 id 来自插槽注册时注入的 `sessionId`（`inject: (sessionId) => ({sessionId})`，
  由 `useReportSession` 写进抽屉 store）。任务行里：绑了具体会话显示「绑定会话」徽章，专属对话显示「专属对话」徽章。
- **带 goal 的任务**在行里多一个「目标」徽章（hover 看全文），prompt 下面多一行 `目标：…`。
- **三个 tab**：任务 / 执行记录 / 目标。任务行支持启用开关、立即测试、编辑、删除；
  执行记录显示完成/失败 + 结果摘要；目标行显示状态、计划时间、轮数、权限、绑定会话。
- **通知**：跑完弹 toast（`z-index: 2147483300`）+ 提示音 + 可选的系统通知；  面板开着时不叠加未读。
- 主题变量用的是本版 Harness 真实存在的 `--dsw-alias-*`（`--dsw-alias-fill-l1/l2/l3`、
  `--dsw-font-mono` 这些**不存在**，深色主题下会变成白底白字）。

## 对话目标（sessionMode）

| sessionMode | 投递到哪 | 关闭后 |
| --- | --- | --- |
| `bound`（默认，`sessionId` 见下） | 有 `sessionId` → 那个会话；没有 → 当前活跃会话 | `sessionController.resolveAgent(id)` 把会话**从磁盘恢复**再投递，所以任务真的「固定在」那个对话里 |
| `new` | 首次投递前 `sessionController.create({cwd})` 新开一个会话，id 写回任务 | 同上，恢复它自己的会话 |

- 会话的服务入口统一走宿主 `sessionController`（`ctx.get('sessionController')`）：
  `resolveAgent(id)` 取/恢复 agent，`create({cwd})` 新建；**不直接调 `agents.create`/`agents.resume`**，
  否则会撞 session 所有权、cwd 和 preset setup 那些坑。
- 取不到会话（服务缺失 / 恢复失败）才回退到当前活跃会话，并打 warn 日志。
- `add` 用 `newSession:true` 或 `sessionMode:'new'`；`update` 用同样两个键切模式（切到 `new` 会丢掉旧绑定）。
- 服务缺失时 `sched_sessions` 报错、`new` 模式退化成「当前活跃会话」。

### 会话标题与缓存

- 宿主读标题走 `sessionQuery.readTitleSnapshots(ids)`，每个会话要折叠一遍自己的日志（约 40ms/个）。
  实测 147 个会话会拖到 6 秒，前端在这段时间里列表是空的 —— 所以 `listSessionDirectory()` **只取最新
  `SESSION_DIRECTORY_LIMIT = 60` 个会话**。
- 返回值形状：宿主 settle 成 `{status:'fulfilled', value:{session, title:<titleSnapshot>}}`，
  而 `titleSnapshot.title` 才是文本（`foldSessionTitle` 返回 `{title, messageSeqs, source, eventSeq, updatedAt}`）。
  早期版本按 `value.title` 是字符串写，结果**所有标题都变成 null**，选择器里只剩 UUID —— 这就是「会话列表空白」的根因。
  `titleTextOf(value)` 两种形状都吃（字符串 / 嵌套快照），空串当无标题。
- 标题落盘缓存 `$DSH_HOME/schedule-session-titles.json`（`{version:1, titles:{id:标题}}`，最多 300 条，`saveTitleCache()` 裁剪）：
  重启后直接复用，热缓存路径实测 1~2ms。
- 冷缓存时 `sessions` 请求最多等 `TITLE_WAIT_MS = 2000`ms（`Promise.race`），没等到就先返回 id 让前端先渲染，
  后台那次读取仍会写回缓存，客户端 1.2s 后自动再取一次补标题。

## 一次性任务跑完自动清理

`at` 规则的任务（一次性）**跑完一轮就从任务栏消失**，不再堆在抽屉里。判定与时机：

| 时机 | 行为 |
| --- | --- |
| 那一轮的 `turn/end` 到达 | 立刻删掉任务（列表、落盘文件同时变干净；执行记录保留） |
| `tick` 兜底扫描 | 已触发（`firedAt` 有值）且没有待办轮次（`pendingRuns` 里没有它）的一次性任务，直接删 |
| 插件启动 | 从落盘恢复后，已触发过的一次性动态任务直接清掉（重启前没等到 `turn/end` 的也能收干净） |

不清理的情况：

- **循环规则**（`every` / `daily` / `cron`）不动，它们还有下一轮。
- **cordis.yml 里 `tasks` 的静态任务**不动（origin=config，插件不替主人改配置文件）。
- 配置 `autoRemoveFinished: false` 时全部不自动删。

失败的一次性任务也按「跑完」处理（`turn/end` 的 reason 是 error 也算）：`at` 已过不会再触发，留着只会是死行；
失败信息仍在执行记录（`sched_history` / 抽屉「执行记录」页）里，那条记录不会被删。

## 目标续跑（goal）语义

任务带 `goal` 后，每次触发投进会话的消息长这样：

```text
[Scheduled task …] <prompt>

<goal round="2">
<目标全文>

Progress from earlier rounds (oldest first):
- 2026-10-28T05:36:09.780Z: 已把宿主 API 补上 detail 端点
Continue this goal from the progress above: do not redo what is already done, take the next concrete step, and end your reply with one short line saying what you advanced this round.
</goal>
```

- `round` = 该任务 `status=completed` 的历史条数 + 1；
- `previous` = 同一 `taskId` 最近 3 条带 `excerpt` 的记录（`firedAt` + 回复摘要）；
  第一轮没有历史时写 `This is the first round of this goal.`；
- 摘要来自宿主 `session/event` 的 `assistant/message`（`EXCERPT_LENGTH` 截断），
  所以**回复里最后那句「本轮推进了什么」会被下一轮看见**，这就是接续的锚点；
- `goal` 存在 `schedule-tasks.json` 的任务对象里（`taskView` 输出 `goal`，无则 `null`），
  上限 `MAX_GOAL_LENGTH=4000`。

## 从两个旧插件迁移过来的东西

本插件取代：

1. **ZhuoSir/dsh-cron v0.3.1**（remind 半边 + `/cron/api` + 右侧抽屉）；
2. **gfds2005/dsh-timed-goal 0.6.0**（goal 半边 + `/timed-goal/jobs`）。

三者当年在 profile 里靠本地补丁才跑得动，那三份补丁的能力已经**以源码形式固化进本插件**，
补丁本身不会再打（对应包已卸载）。来龙去脉归档在
`E:/工作区/dsh-patches/schedule-merged/`（含 `legacy/` 下三份原始 patch.mjs + README）：

| 旧补丁 | 解决什么 | 在本插件里的位置 |
| --- | --- | --- |
| `dsh-cron-web-drawer` | 上游 `inject(['webServer','webRuntime'])` 里 webRuntime 在 DSH 0.2.1 已不存在 → entry 永久 pending → `/cron/api` 404/405 | `lib/index.js` 只 `ctx.inject(['webServer'])`，trustedHosts 用 `ctx.get('webStartup')` |
| `dsh-cron-floating-window` | 抽屉被 `shell.overlay` 的层叠上下文 + `.frame{overflow:hidden}` 压住/裁掉 | `lib/client.js` 的 `portalTo(document.body)` + fixed 420×560 + z-index 2147483200 |
| `cron-timed-goal-integration` | cron 抽屉看不见 timed-goal 的目标 | `/schedule/api/list` 一次返回 `{tasks, goals}`，存储同文件 |

**没有移植**：timed-goal 的输入行 `[⏱ 定时]` 弹窗、设置页那张「定时任务」卡片
（现在统一走浮窗 + `sched_goal_*` 工具）。

## 验收清单

```bash
# 1) 宿主路由活着（<port> = 当前 Web GUI 端口，每次重启 Desktop 会变）
curl -s -X POST http://127.0.0.1:<port>/schedule/api/list \
  -H 'content-type: application/json' -d '{}'      # {"ok":true,"result":{"tasks":[],"goals":[]}}

# 2) 客户端 entry 进了 boot 图
#    GET / 的 HTML 里 globalThis["__DSH_BOOT__"] 的 entries 应有 id=dsh-schedule
#    GET /plugins/??dsh-schedule/client.js&rev=<rev> → 200（必须带登录 cookie，否则 404）

# 3) 真触发：排一个 2 分钟后的自检任务，之后看 sched_history() 里 status=delivered
```

模型侧自检（一条就够）：`sched_add({at:"<2 分钟后>", prompt:"只回复一句「自检通过」"})`
→ 到点看 `sched_history({limit:5})` 的 `status` 应为 `delivered`，
→ **再 `sched_list` 应已看不到这个一次性任务**（跑完自动清）；循环任务（`every`/`daily`/`cron`）仍在列表里。

## 已知坑

- **端口会变**：Desktop 重启后 Web GUI 端口变（55575 → 57238 → 49599 → 50825 …），
  curl 验证前先看 runtime context。
- **卸载旧插件后残留客户端 entry**：`dsh-cron` / `dsh-timed-goal` 从 profile 卸载后，
  运行中的进程仍会继续服务它们的 `client.js`（boot 图不剪旧 entry），
  **重启一次 Desktop** 才会消失，否则可能看到多余的「定时任务」按钮。
- **pnpm 会还原本地补丁**：`plugin add/remove` 触发的 pnpm 安装会把
  `node_modules/<pkg>` 下的手改文件覆盖回去 —— 所以本插件走 `link:` 工作区路径，不再打补丁。
- **`context.session.header.utilities` 与 `shell.overlay` 都必须存在**：缺一个就整个
  `apply` 报错，按钮和浮窗一起消失。
- **dsh-dream-skin 会抢走浮窗的 `position`**（2026-10-29 修）：它按 DOM 形状找「聊天输入框
  卡片」——textarea 往上 6 层内最近的 `border-radius >= 8px` 祖先——命中就给元素贴
  `data-dsh-dream-skin-composer`，并套一条 `position: relative` 的卡片规则；那条规则和
  `.dsh-schedule-drawer{position:fixed}` 特异性相同却排在后面，于是窗口掉进 body 普通流、
  跑到视口下方（表现为点「新任务」后窗口直接消失，而 chip 只是闪）。
  现在两道防线：① `aside` 上的 `role="dialog"`（dream-skin 的 `isInDialog` 会跳过
  dialog 子树，从源头不让它标记）；② 定位属性 `!important`；另有一个 MutationObserver
  兜底摘掉该属性。**别把 `role="dialog"` 从 aside 上摘掉，也别去掉那几个 `!important`。**- **经反代 / 隧道打开网页时 `/schedule/api` 一律 403 `forbidden`**（2026-10-29 修）：
  服务端栅栏的 `trustedHosts()` 原来只读 `webStartup`（CLI `--trusted-host`）和
  `webRuntime`，而公网域名是配在 connection 插件自己的 config 里（桌面 profile 的
  `cordis.patch.yml`：`- id: connection` / `trustedHosts: [...]`）→ 栅栏拿到空数组，
  隧道 Host 全被拒，面板上只剩一条红字 `forbidden`（其余界面正常，所以很难想到是这里）。
  现在额外合并 `ctx.get('connection')?.trustedHosts` —— 那是 `HostConnectionService`
  的公开字段，就是 `/api` 网关看门用的同一份列表 —— 去重后返回；dshmarket 的
  `setTrustedHostsSource` 也是这个写法。客户端把 `forbidden` 换成了「当前访问域名不在
  信任名单里」的可操作提示。**服务端改动要重启 Desktop 才生效**，验证：
  `curl -s -X POST -H 'Host: <隧道域名>' -H 'content-type: application/json' -d '{}' http://127.0.0.1:<port>/schedule/api/list`
  应回 `{"ok":true,...}`；Host 换成隧道域名仍 403 说明没重启，或域名没写进 connection config。
