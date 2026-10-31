# dsh-relay-pair

把一台 DSH（桌面端）或 DSHA（手机端）配到 **DSH 中继台**（`dsh-relay/relay/server.py`）。

它解决的问题：本机开着 DSH 时，手机上/网页上能看见本机状态、能往本机存任务（你在网页点「派发」才真跑）；
本机关了，任务就留在中继库里等设备上线（云端执行器已停用）。两边的任务历史默认**互不干扰**，只有你点名要同步时才上传。

## 两种配法（都一样，选顺手的）

1. **设置页**（推荐）：DSH → 设置 → **中继配对**，填中继地址 + 配对码，点「配对」。
   桌面端和手机端（DSHA）都会出现这一页，用的是同一份客户端插件。
2. **对话里**：`relay_pair { code: "WFQT-GRKK-L3LK", relayUrl: "https://你的中继地址" }`。

配对令牌存到 `$DSH_HOME/relay-device.json`（0600），随后心跳与长轮询自动跑起来。
配对码在中继网页点「生成配对码」拿，10 分钟有效、只用一次。

## 工具

| 工具 | 干什么 |
| --- | --- |
| `relay_pair` | 用配对码换设备令牌并启动心跳/轮询 |
| `relay_status` | 连接状态、心跳年龄、中继排队数、本机最近任务 |
| `relay_task_add` | **存**一条任务到中继（只入库成 `stored`，不会自己跑）：`target=local/dsha/cloud/auto`；你在中继网页上点「派发」才真正派给在线设备 |
| `relay_tasks` | 看中继上的任务（含云端结果、错误） |
| `relay_sync_task` | **按需**把本地任务历史推到中继（按 id 去重） |
| `relay_unpair` | 清令牌、停轮询 |

## 模型与思考强度（0.3.0+）

每条中继任务可以单独指定「用哪个模型、思考强度多高」，不写就是跟随设备默认。

- **设备上报目录**：心跳里的 `meta.models` 带上本机的模型目录（`{default,groups,failures,generatedAt}`，
  5 分钟刷新一次），中继网页据此给每台设备列出可选模型与强度。
- **投递前切换**：插件拿到任务后先 `sessionController.agents.selectForNextRequest(agent, {provider,model,reasoningEffort})`，
  只作用于**这条任务的那个会话**，不改你的默认模型。
- **两种情况不硬来**：
  - 设备上没有这个 `provider/model` → 不投递，直接上报 `blocked`，网页上写着「这台设备没有模型 …，未执行」；
  - 有这个模型但没有这个强度 → 按模型默认强度跑，并在注入的消息里写一行「注意：…没有强度 X，已按模型默认强度执行」。
- **注入消息带说明**：指定了模型的任务，消息里会多一行「本条工单由中继台指定了模型：provider/model（思考强度 x）。」
- `relay_status` 会多一行「模型：…」告诉你上报的目录摘要。

## 设置页背后调的本机接口

设置页由 `lib/client.js` 渲染，数据来自本机路由（带信任围栏，只认 loopback / trustedHosts）：

| 路由 | 干什么 |
| --- | --- |
| `GET /relay/api/state` | 配对状态、设备名、心跳年龄、最近任务 |
| `POST /relay/api/pair` | `{code, relayUrl, name}` → 配对并启动心跳 |
| `POST /relay/api/unpair` | 断开并清本机凭据 |
| `GET /relay/api/tasks` | 本地任务流水 |
| `POST /relay/api/submit` | 把一段 prompt 直接投进当前会话 |
| `GET /relay/api/enter` | **登录中转页**：中继网页「打开本机 DSH」点的就是它（只认 loopback 或隧道公网主机，见下） |
| `GET /relay/api/sessions` | 本机最近 8 条会话快照（调试用，内容和上报中继的一致） |

### 为什么要中转页

中继网页在 https 上，直接跳 `http://127.0.0.1:端口/?token=…` 属于**跨站着陆**，
而 DSH 的登录 cookie 是 `SameSite=Strict`，浏览器不会带过去 —— 结果就是 401
`dsh web authentication required`。

所以插件只上报**中转页**地址（不带令牌）：

1. 浏览器跨站打开 `http://127.0.0.1:端口/relay/api/enter`；
2. 这个页面同源，自己 `location.replace` 到带令牌的地址；
3. 同站导航，cookie 正常落地，跳到干净的根地址。

中转页只接受 **Host 是回环地址**（或反向隧道那条公网主机，见下一节）的 GET/HEAD，
其它一律 403/405，也不把令牌写进中继。

## 会话快照（sessions）

配对之后插件会自动把本机**最近 8 条会话**（按会话算，不是消息流水）同步到中继 —— 配对成功立刻一次，
之后每 90 秒一次，`turn/end` 结束后 4 秒防抖再补一次。

- **最近 8 条、全额保存**：按会话列表的更新时间取最新 8 条，正文不截断（上限对齐中继的
  4000 条消息 / 40 万字），只取用户/助手正文；`runtime-context`、`agent-instructions`、
  `compact-checkpoint` 这类 DSH 自己塞的消息会被过滤掉（它们不是人说的）。
- **归档（回档）的不算**：归档名单在 `$DSH_HOME/storages/workspace.json` 的
  `global.archivedSessionIds`，里面的会话不会出现在「最近 8 条」里。
- **双端隔离**：桌面 8 条、手机 8 条各存一份（中继按 `(device_id, session_id)` 唯一），
  同一个会话在两端互不覆盖，也不会互相同步。

- **只存不下发**：同步上去的会话只写中继的库，`poll` 不会把它们发给任何设备；别的设备看不到你这台的内容。
- **你选才送**：中继网页「会话」面板选中一张卡片 → 选目标设备 → 「送过去」，中继才生成一条定向 handoff，
  只投给那一台。设备收到后：本地已有同 `sessionId` 的会话就直接注入那条接着聊；没有就新建一条
  （`sessionController.create({ sessionId })`）再注入，标题一起补上；落地成功 `POST /api/agent/handoffs/ack` 回报 `delivered`。
- 关掉：`sessionSnapshot: false` 之后不再上报（网页那一列就是空的，配对/派活/接续都不受影响）。
- 想看插件到底上报了什么：`GET /relay/api/sessions`（只认本机）。

## 任务隔离：一条任务一个会话（0.2.2+）

中继派来的活不再塞进「当前最活跃的那个会话」，而是按任务隔离：

- **新任务 → 新会话**：`deliver()` 看到任务没有 `sessionId`，就 `sessionController.create({})` 开一条新会话
  （标题用任务标题），投进去之后第一次 `POST /api/agent/report`（`running`）把 `sessionId` 一起回传。
  宿主没有 `sessionController` 时退回原来的「最活跃会话」。
- **接着做 → 回原会话**：任务带 `sessionId` 就 `ensureSession(sessionId)`：
  本机有这条会话就接上，没有就 `create({ sessionId })` 用同一个 id 建一条，**不会另开**。
  中继台从 2026-10-29 起把「接着做」做成**原任务里加一轮**（`task_rounds`）：设备领到的是这一轮的正文、
  同一个 `sessionId` 和 `round`（0 是原始任务），注入消息里会多一行「这是这条任务的第 N 轮：接着往下做，别从头重来」。
- **同会话串行**：一条会话里上一单还没 `turn/end`，新来的单子进内存队列（`runtime.queued`），
  等那一轮结束再投（`drainQueue`）；插件停止/解绑时队列里的单子统一回报 `failed`（`failQueue`）。
- **本机流水只留 20 个任务**：`relay-local-tasks.jsonl` 追加后按 task id 倒序截到最近 20 个
  （`MAX_LOCAL_TASKS`），追加写、不整表重排。
- **送过来的会话只注入、不跑**：`handleHandoffs` 用 `agent.send(message, 'next-turn', false)`
  （没有 `send` 才退 `inject`），把对话搬进目标会话就完事，不会自己开跑；回执里写明「只传对话，不自动运行」。

## 网络模型
设备只做出站请求，不监听公网端口：

```
设备 --心跳/长轮询--> 中继
                    <-- 任务帧 / 隧道帧 --
```

网页要看本机状态时，中继在长轮询回包里塞一个 tunnel 帧，本机处理完再回传结果。
隧道只允许白名单路径（`/relay/api/*`、`/schedule/api/*`、`/api/*`、`/v1/*`）。

## 反向隧道：让手机浏览器打开本机 DSH（0.2.1+）

「打开本机 DSH」报的是 `http://127.0.0.1:<端口>/relay/api/enter` —— 在电脑上点得开，
在手机上点就是手机自己。0.2.1 起桌面端插件可以开一条 **SSH 反向隧道**，把本机 DSH 网页
临时映射到中继服务器的回环口，再由 nginx 挂成 https，于是手机上也能点开。

它**不是常驻**：门禁一失效就关，中继上不会留一个永远开着的公网口。

```
手机浏览器 --https--> dsh-tunnel.example.com (nginx) --> 127.0.0.1:18944 (sshd 转发)
                                                              ^
                                         ssh -R（由桌面端插件按需 spawn）
                                                              |
                                                    127.0.0.1:<本机 DSH 端口>
```

### 桌面端配置（profile 的 `cordis.patch.yml` 里 `id: dsh-relay-pair` 那行）

```yaml
webTunnel:
  enabled: true
  sshHost: 1.2.3.4
  sshUser: root
  sshPort: 22
  keyPath: 'C:/Users/user\.dsh\relay-tunnel\id_ed25519'
  remotePort: 18944
  publicUrl: https://dsh-tunnel.example.com
  closeGraceSeconds: 45
  requireMobilePeer: true
  idleMinutes: 0        # 0 = 只要手机端还配对在就一直开；>0 = 手机端这么久没心跳就收
```

`sshHost` 或 `keyPath` 为空时自动按关闭处理（`enabled: false`），不会去 spawn 一个必然失败的 ssh。

### 服务器侧三件事

1. **授权键**（`/root/.ssh/authorized_keys`，只给端口转发、只许这一个口）：

   ```
   restrict,port-forwarding,permitlisten="127.0.0.1:18944" ssh-ed25519 AAAA... dsh-relay-tunnel
   ```

   `permitlisten` 实测有效：换 18945 会直接 `remote port forwarding failed for listen port 18945`。

2. **nginx vhost**：`deploy/nginx-dsh-desktop.conf` → `/www/server/panel/vhost/nginx/dsh-desktop.conf`，
   `nginx -t && nginx -s reload`。删掉这个文件就撤销公网入口。

3. 回环口只在 `127.0.0.1` 上，公网只能经 nginx 进；DSH 自己的登录令牌仍然要验，没 `?token=` 一律 401。

### DSH 侧：公网域名要进 /api 信任名单（否则全 403）

DSH 的 `connection` 插件有一道 Host/Origin 栅栏：只认 loopback、监听器绑定的地址和
`trustedHosts`（CLI 的 `--trusted-host`，或在 profile 里覆盖 `connection` 行）。隧道下
nginx 透传的 Host 是公网域名，没列进去时每个 `/api`（含 SSE / WebSocket 升级）都返回
`403 forbidden` —— 手机上表现就是「无法打开文件夹」弹窗加底部一直「重新连接中」。

桌面 profile（`C:/Users/user\.dsh\profiles\desktop\cordis.patch.yml`）加这一段，**重启 DSH 生效**：

```yaml
- id: connection
  name: "@deepseek-ai/dsh-client-connection"
  config:
    trustedHosts:
      - dsh-tunnel.example.com
```

这条是**整块替换** config（`connection` 的默认值只有 `trustedHosts` 一项），以后换域名要同步改这里。
配好之后 DSH 会把远端 authority 当成「远程浏览器」，文件夹选择器自动切到网页内选择器
（不再是电脑上的系统对话框）——手机才选得动。

0.2.3 起插件自己会查：隧道 `up` 之后拿公网 Host 打一次本机 `/api`（403 = 被栅栏挡住，
401/404 = 放行），结果显示在 `/relay/api/state` 的 `web.fence` 与 `relay_status` 的「隧道 /api」那行，
中继设备的 `webTunnel.fence` 也会带 `ok` / `blocked`。看到 `blocked` 就说明上面那段没配或没重启。

### 可信地址白名单（中继网页存，插件自动放行）

只改 profile 那一段太笨：换域名/多域名就得改文件重启。所以写好了一条链路 ——
中继网页「设置 → 可信地址」里存的每个域名/IP，插件都自动当成放行名单：

1. 中继 `GET/POST /api/web/trusted-hosts` 把名单存进中继库（最多 20 条，config.json 里的
   `trustedTunnelHosts` 永远在最前且网页删不掉）。
2. 插件每次心跳（`/api/agent/heartbeat`）回包里拿到 `trustedHosts`，落到内存，
   见效两处：中转页 `/relay/api/enter` 认这个名单（不再只认 `webTunnel.publicUrl`），
   同时把名单里的主机名**注入** `connection.trustedHosts`，让 DSH 自己的 /api 栅栏也放行。
3. 注入是加法且可回收：只撤自己加过、且名单里已经删掉的那几条，profile 里手写的绝不动；
   名单一变就重放一轮，所以网页上加/删域名**不用改 profile，也不用为它重启**（插件这段代码生效要重启一次）。

敢照中继名单放行的理由：中继本来就是控制面（它能给本机派任意任务），域名判给谁不额外扩大风险；
而改名单只有拿着中继 `webToken` 在网页上能做。

还差最后一步是 nginx：域名得有自己的 `server_name` 反代到 `127.0.0.1:18944`，
否则请求打不到隧道这头（网页「检查」按钮给的 verdict 里 `novhost` 就是在说这个）。
### 什么时候开、什么时候关

| 情况 | 状态 |
| --- | --- |
| `enabled: false` / 缺 `sshHost` 或 `keyPath` | `disabled`，不 spawn |
| 本机没配对 | `idle` |
| 中继 60 秒内没心跳（网络断了） | `idle`，隧道随心跳一起收 |
| `requireMobilePeer` 且中继上一个手机设备都没有 | `waiting-mobile-peer` |
| `idleMinutes > 0` 且手机端 `lastSeen` 超过该分钟数 | `waiting-mobile-idle` |
| 以上全过 | `starting` → 1.2 秒没退出 → `up` |
| `up` 之后门禁失效 | `closing`：等 `closeGraceSeconds`（45 秒，防抖，网络抖一下不会断） |
| 宽限期过完还在 | 先 `SIGTERM`，5 秒没退再 `SIGKILL` |
| ssh 自己挂了（非门禁原因） | `restarting`，退避重连 2s→4s→…→30s |

「双端任意一端未配对就关隧道」就是表里第 2 行和第 4 行：本机没配对直接 idle；
手机端一个都没有就 `waiting-mobile-peer`。手机端配了但长期不在，用 `idleMinutes` 收口。

### 怎么看状态

- 本机：`GET /relay/api/state` 的 `web.tunnel`（`state/reason/publicUrl/restarts/lastError`）、`web.gate`
  与 `web.fence`（隧道下 /api 有没有被 DSH 的信任栅栏挡掉）；`relay_status` 也会打两行。
- 中继网页：设备卡片上会带 `webTunnel` 状态；隧道 `up` 时「打开本机 DSH」按钮指向
  `https://dsh-tunnel.example.com/relay/api/enter`（手机可点），否则退回 loopback 地址并提示原因。

### 注意

- 自签证书：手机第一次打开要点一次「继续访问」（或用 `sslip.io` + 自己的域名换真证书）。
- 隧道只转发 DSH 网页本身；`/relay/api/*` 的中转页放行条件是 Host 等于 `publicUrl` 的主机名，或在中继网页「可信地址」名单里。
- 桌面端和手机端**只装一个**插件（同一个 `$DSH_HOME`），否则两条心跳抢任务。

## 本机离线怎么办

中继的 `target=auto` 会按「桌面在线 → 本机；否则手机在线 → 手机；都不在 → **留在库里（stored）**」挑目标。
云端执行器**已停用**（2026-10-28 审查修订版起云端只做储存，`cloud_view` 恒返回 `storageOnly:true`），
所以「都不在线」时任务不会自己跑，等设备上线后去中继网页任务表点「派发」（`POST /api/web/tasks/:id/dispatch`）。

建任务（含 `relay_task_add`）一律只入库成 `stored`；只有人在网页上点「派发」才会变 `queued`
被设备长轮询领走。想建单即派，可以调 `POST /api/web/tasks` 时带 `dispatch:true`。

## 隐私

- 默认**不上传**任何本地任务历史；只有 `relay_sync_task` 或 `syncMode: auto` 才 push。
- 会话快照是**默认开启**的例外：只传最近 8 条会话（正文全额，上限 4000 条消息 / 40 万字，归档的不传），
  只写中继库、不下发给任何设备；不想要就 `sessionSnapshot: false`。
  `relay_unpair` 只删本机令牌，云端那 8 条快照要删设备时才会一起没。
- 本机任务流水在 `$DSH_HOME/relay-local-tasks.jsonl`，一行一条，随时可删。
  流水是追加写的，同一个任务会有 running 和 done 两条；`relay_status` 和隧道
  `/relay/api/tasks` 会按任务 id 折叠成一条，只看最终态。
- `relay_unpair` 会删本机令牌；中继侧的设备记录要在网页上单独删。

## 配对能留住：重启不用重新配、令牌失效自己续（0.3.2+ / 0.4.0+ / 0.4.1+）

配对结果落在 `$DSH_HOME/relay-device.json`，同时留一份 `relay-device.backup.json`。
启动时主文件读不到（被清理软件删了、关机没落盘、写坏了）就自动用备份接上并把主文件写回去，
不用再去中继网页要配对码。`relay_unpair` 会把两份一起删，不会「断开之后又被备份复活」。

**0.4.0 起还多一张自愈券。** 配对时中继会下发 `renewSecret`（只存它的哈希），
插件把它和 `deviceId` 一起写进同一份凭据文件。之后心跳或长轮询一旦收到 **401**（中继换库、设备行被删、
手滑在网页上删了这台），插件不再只是喊「请重新配对」，而是自己拿
`deviceId + renewSecret` 打 `POST /api/device/renew` 换一张新令牌，**当场补发一拍心跳**，
并把新令牌与新自愈券一起落盘 —— 主人不用去够配对码，面板上也不会再出现「心跳中断」。

自愈券是一次性的：每次续期成功中继都会轮换它，旧券再用就是 401 `RENEW_DENIED`。
续期失败（设备行真的被删干净了）才需要人工配对，面板会显示「令牌已失效」，错误文案里写着重新配对。

`relay_status` 多两样东西：`lastAuthError`（最近一次是不是 401）与 `renewCount` / `renewAt`
（续过几次、最近一次什么时候），面板上对应「自动续期  N 次（最近 …）」这一行。

排查「重启后显示未配对」，看 `$DSH_HOME/relay-pair.log`（一行一个 JSON，超过 64KB 清空）：

| 日志里看到 | 意思 |
| --- | --- |
| 连 `{"event":"apply"}` 都没有 | 插件这次根本没加载（查 profile 里的 `id: dsh-relay-pair`） |
| `"event":"apply","creds":false,"source":"none"` | 插件加载了，主文件和备份都没有 → 真没凭据，要重新配 |
| `"source":"backup","restored":true` | 主文件丢了，靠备份接上（正常，不用管） |
| `"event":"recovered"` | 启动时没凭据、后来发现凭据文件出现，自动开始心跳 |
| `"event":"renewed"` | 令牌 401 → 用自愈券换到新令牌（0.4.0+，正常，不用管） |
| `"event":"heartbeat","ok":false,"status":401` | 中继不认这个令牌，且续期也失败（设备行被彻底删 / 自愈券丢了）→ 只能重新配对，`relay_status` 会明说 |
| `"event":"autostart-failed"` | 自动启动那一步崩了，后面不会再有 heartbeat（0.4.1 起才落盘）。`error` 里附原文，按它查；老版本对应的宿主日志是 `autostart failed: cannot get property "…" without inject`（0.4.1 已修） |

`GET /relay/api/state` 里 `relay.credsSource`（`primary` / `backup` / `pair` / `none`）、
`relay.credsPath`、`relay.credsBackupPath`、`relay.bootLog` 能看到这次用的是哪份、日志在哪。
「没配对」时插件每 30 秒看一眼凭据文件：DSH 比凭据先起来也能自己接上，不用再重启一次。

## 排障

**网页上点「打开本机 DSH」打不开 / 401。** 中继拿到的地址是插件的
`/relay/api/enter` 中转页（**不带令牌**），页面自己再跳到带令牌的地址。
排查顺序：

1. `relay_status` 看「本机中转页」那一行，端口要和当前 DSH 一致（端口每次启动都可能变）；
2. 浏览器直接打开 `http://127.0.0.1:<端口>/relay/api/enter` 能不能跳进去；
3. 还是 401 说明插件太老（0.1.0 没有中转页，只报裸 origin）——升级插件后重启 DSH。
   中继网页上按钮的提示文案也会写「把 dsh-relay-pair 插件升级到带中转页（/relay/api/enter）的版本」。

**手机上点「打开本机 DSH」打不开。** 手机不在本机回环网段，必须走隧道：

1. `GET /relay/api/state` 看 `web.tunnel.state`：
   `disabled` → 配置没生效（`enabled`/`sshHost`/`keyPath` 三样齐不齐，改完要重启 DSH）；
   `waiting`（reason `no-local-port`）→ 还没问到本机 Web 端口，等一拍就好，一直如此就是 `webServer` 服务没起来；
   `no-mobile-peer` → 中继上还没有手机设备，先在手机上配对；
   `mobile-idle` → 手机端太久没心跳（`idleMinutes`），把手机 App 打开；
   `relay-offline` → 自己跟中继的心跳断了（见上面 401 / autostart-failed 两行），隧道不敢开；
   `failed` / `restarting` → 看 `lastError`，多半是授权键没写对或 `permitlisten` 端口不一致。
2. 手动验隧道：`ssh -i <keyPath> -N -R 127.0.0.1:18944:127.0.0.1:<本机端口> root@<sshHost>`，
   然后 `curl -k https://<publicUrl 主机>/relay/api/enter`，应当 200 而不是 403。
3. 403 `entry page is loopback or tunnel only` → 插件的 `publicUrl` 与 nginx 的 `server_name` 不一致
   （Host 对不上就拒）。
4. `lastError` 是 `remote port forwarding failed for listen port 18944` → 服务器上那个口被上一条
   没退干净的 ssh 占着（DSH 被强杀时 ssh 子进程可能活下来）：`ssh root@<sshHost> "ss -lntp | grep 18944"`
   找到 pid `kill` 掉即可，插件在 `restarting` 里会自己重连。

## 自测

```bash
cd dsh-relay/plugins/dsh-relay-pair
export ELECTRON_RUN_AS_NODE=1 NODE='/e/Deepseek/DeepSeek Harness.exe'   # 没装 node 时用 DSH 自带的
"$NODE" --test tests/*.test.mjs  # 全部（npm test 同此）
"$NODE" tests/apply.test.mjs     # 107 项：工具、投递、排队、收尾、流水折叠、路由、中转页（loopback / 隧道主机）、信任围栏、会话快照、凭据备份自愈、令牌自动续期
"$NODE" tests/protocol.test.mjs  # 53 项：配置、任务框转义、隧道白名单/穿越、发件箱、退避、body 超时、凭据备份与恢复
"$NODE" tests/client.test.mjs    # 14 项：客户端插件加载、字典、样式、设置页槽位
"$NODE" tests/tunnel.test.mjs    # 29 项：ssh 参数、端口解析、门禁开关、宽限防抖、退避重连、端口变了重开
"$NODE" tests/models.test.mjs    # 47 项：模型目录分组、思考强度、任务选择落库
```
