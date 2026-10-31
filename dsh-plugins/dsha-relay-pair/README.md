# dsha-relay-pair

把一台 **安卓手机上的 DSHA** 接进 DSH 中继台。

中继台（`dsh-relay`）是任务队列：网页/桌面/手机都能往里存任务，但**不会自己跑**——
要在网页上点「派发」，才会派给当时在线的那台设备。
这个插件是**手机端那一半**——装进 DSHA，让手机能领任务、跑任务、把结果交回去。

和桌面端 `dsh-relay-pair`（[`plugins/dsh-relay-pair`](../dsh-relay-pair/README.md)）协议完全一致，
所以**同一个中继上，一个 $DSH_HOME 只装一个**：两个一起装会有两条心跳、两条长轮询抢同一批任务。

手机端比桌面端多干三件桌面端不用操心的事：

| 手机端的额外职责 | 为什么 |
| --- | --- |
| **通知** | 手机锁屏时看不见会话，任务到了得弹一条系统通知（走 3090 设备桥）。 |
| **落盘** | 手机随时可能被杀进程/断网，任务到达与执行结果都先写本地流水，不留事故现场。 |
| **重放** | 结果回传失败不算丢：进 `relay-outbox.jsonl`，下次启动或联网后自动补发。 |

---

## 一、装

```bash
# 在 DSHA（或桌面端）里装本目录（换成你 clone 下来的绝对路径）
dsh plugin add /path/to/dsh-relay/plugins/dsha-relay-pair
```

`cordis.patch.yml` 会自动把插件插进 profile 名册，**不要**再手写同一行——重复 id 会让 loader 崩。

---

## 二、配对（两种方式，二选一）

### 方式 A：设置页

DSHA 里打开 **设置 → 中继配对**：填中继地址 → 填配对码 → 点「配对」。

### 方式 B：对话里

```
relay_pair({ code: "AB12-CD34", relayUrl: "http://1.2.3.4" })
```

配对码在中继网页上点「生成配对码」拿，形如 `WFQT-GRKK-L3LK`（12 位字母数字，四段式里的三段），**10 分钟有效、用一次作废**。

配对成功后：

- 凭据写在 `$DSH_HOME/relay-device.json`（权限 0600），里面有 `deviceId` / `deviceToken` / `relayUrl`。
- 心跳（默认 20 秒一次）与长轮询（默认挂 25 秒）立刻开始。
- 下次启动若发现凭据，`autostart: true` 会自动接上，不用再配对。

> **地址怎么填**：中继在公网就用公网地址。https 走自签证书时 Node 的 fetch 会拒，**手机端建议填 `http://`**；
> 桌面浏览器访问 https 面板只需点一次「继续访问」，但插件里的 fetch 没这个交互。

---

## 三、六个工具（与桌面端同名同义）

| 工具 | 作用 |
| --- | --- |
| `relay_pair` | 用配对码配对，并启动心跳+轮询。 |
| `relay_status` | 看配对状态、心跳年龄、设备桥是否可用、能不能拉起 DSHA、未回传报告数。 |
| `relay_task_add` | **存**一条任务到中继（只入库成 `stored`，不会自己跑；要你在中继网页点「派发」）；没配对时**直接投进本机会话**。`target` 可写 `local` / `cloud` / `dsha` / `auto`（`mobile` 会自动归一到 `local`）。 |
| `relay_tasks` | 读中继上的任务列表（需要已配对）。 |
| `relay_sync_task` | 把本地流水推给中继（默认 `syncMode: manual`，只有手动调用才上传）。 |
| `relay_unpair` | 断开配对并删掉本机令牌。 |

---

## 三点五、模型与思考强度（0.3.0+）

中继网页派任务时可以给**这一条**任务指定模型和思考强度，不指定就跟随手机自己的默认。

- 心跳里的 `meta.models` 上报手机端的模型目录（5 分钟刷新），网页按设备列出可选模型。
- 投递前用 `sessionController.agents.selectForNextRequest` 只切这条任务的会话，不动全局默认。
- 手机上没有这个模型 → 上报 `blocked`（不跑）；没有这个强度 → 降级成模型默认强度，并在注入消息里注明。
- `relay_status` 多一行「模型：…」，`/relay/api/state` 的 `models` 字段有摘要。

## 四、本机 HTTP 路由

设置页读的就是这些（带**信任围栏**：只认 loopback / `trustedHosts`，且 `sec-fetch-site` 不能是 `cross-site`）：

| 路径 | 方法 | 作用 |
| --- | --- | --- |
| `/relay/api/state`（别名 `/status`） | GET | 配对、心跳、发件箱、最近任务 |
| `/relay/api/tasks` | GET | 本地流水 |
| `/relay/api/submit` | POST | 派活给本机（`{ prompt }`，不经过中继、不占中继任务号） |
| `/relay/api/pair` | POST | `{ code, relayUrl?, name? }` |
| `/relay/api/open` | 隧道 | 拉起 DSHA（走 3090 桥的 `/app/launch` 或 `/app/open`） |
| `/relay/api/unpair` | POST | 断开配对 |
| `/relay/api/sessions` | GET | 本机最近 3 条会话快照（调试用，内容和上报中继的一致） |

围栏挡掉时返回 **403**，路径不存在返回 **404**——设置页据此分别提示「只能在本机页面里配对」与「插件没加载起来」。

---

## 五、网络模型

```
中继（服务器）  ←── 长轮询（手机主动发起的出站请求，25 秒一轮）──  手机
       ↑                                                          │
       └──── POST /api/agent/report（结果回传，失败进发件箱）───────┘
```

- 手机**从不监听公网端口**，全部是出站长连接：运营商网络、NAT 后面都能用。
- 中继把请求挂住（长轮询），任务一到立刻返回，不必等下一次轮询。
- 空转一段时间（`idleBackoffAfterSeconds`，默认 180 秒）后轮询间隔逐步拉长到 `idleBackoffMaxSeconds`（默认 120 秒），
  省电；一旦有任务/隧道/心跳恢复立刻回到 `pollSeconds`。

### 隧道

中继可以要求设备代理某个路径（`/schedule/api`、`/relay/api`、`/api/`、`/v1/`）。
桌面端会把这类请求转到本机 56246；**手机端不转发**，非 `/relay/api/*` 的隧道直接回 `501 TUNNEL_UNSUPPORTED`——
手机上没跑网页服务，硬转只会超时。

例外是 `/relay/api/open`：网页上点「打开手机 DSHA」，中继发一帧隧道过来，
手机端调本机 3090 桥把 App 拉起来（详见下一节）。

---

## 六、离线与失败

| 情况 | 行为 |
| --- | --- |
| 手机被系统杀掉 | 中继按 `deviceOfflineAfter` 判离线，`target=auto` 的任务转给桌面端；桌面也不在线就**留在库里 `stored`**，等设备上线后由人在网页点「派发」。 |
| 手机断网 | 报告进 `relay-outbox.jsonl`，日志记一条，状态页显示「未回传报告 N」。联网后自动重放。 |
| 报告重放成功 | 从发件箱删掉对应条目，不重复投递。 |
| 启动时发现残留 `running` | 说明上次跑到一半被杀：标成 `failed` 并**主动回传**，不留悬空任务。 |
| 没有中继任务号（本机派活） | 不产生报告——不是中继派来的活，没必要回传。 |
| 任务一直 `stored` | 正常：现在建任务只入库，要在中继网页任务表点「派发」（或建单带 `dispatch:true`）才排队被领走。 |

`$DSH_HOME` 下三个文件：

- `relay-device.json` —— 配对凭据（0600，`unpair` 会删）。
- `relay-local-tasks.jsonl` —— 本地任务流水（到达/完成/失败），倒序读。
- `relay-outbox.jsonl` —— 还没送出去的报告。**别手动删**，网络恢复会自己重放。

---

## 七、通知（设备桥）

通知与震动走 DSHA 的 3090 桥，不走中继：

```
GET http://127.0.0.1:3090/app/notify?text=...&title=...   （带 X-Token）
GET http://127.0.0.1:3090/app/vibrate?ms=120
```

- 令牌来源：配置 `bridgeToken` > 环境变量 `DSHA_BRIDGE_TOKEN` > `bridgeTokenPath`（默认 `/root/.dsh/.bridge_token`，
  也认 `.bridge_headers` 里的 `X-Token`）。
- **通知失败不影响主流程**：只记日志，任务照常投递。桥不在时 `relay_status` 会显示「设备桥不可用」。
- 从没送达过就别指望通知——先用 `relay_status` 确认桥活着。

---

## 七点一、打开手机 DSHA（网页 → 手机）

网页没法直接拉起安卓 App，只能借手机自己。链路是：

```
中继网页「打开手机 DSHA」 → POST /api/web/tunnel {path:'/relay/api/open'}
        → 手机长轮询收到 tunnel 帧 → 插件 GET http://127.0.0.1:3090/app/launch?pkg=<包名>
        → 结果回传 POST /api/agent/tunnel/result
```

- 填了 `appPackage`（如 `com.deepseek.dsha`）→ 走 `/app/launch?pkg=`，优先它。
- 只填了 `appUrl`（如 `dsha://chat`）→ 走 `/app/open?url=`。
- 两个都没填 → 隧道回 **409 `NO_APP_TARGET`**，网页按钮是灰的（心跳 `meta.canOpen=false`）。
- 桥给的失败原话（`code`/`text`）会原样带回网页，不自己编一句「打不开」。

---

## 八、配置

见 `config.example.json` 与 `cordis.patch.yml`。常用的几个：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `relayUrl` | `''` | 中继地址；留空则用凭据里记的地址。 |
| `deviceKind` | `mobile` | 决定设备名前缀 `DSHA@`。 |
| `heartbeatSeconds` | 20 | 心跳间隔（夹取 5–600）。 |
| `pollSeconds` | 25 | 长轮询窗口（夹取 5–120）。 |
| `idleBackoffAfterSeconds` | 180 | 空转多久开始退避（0–86400）。 |
| `idleBackoffMaxSeconds` | 120 | 退避上限间隔（5–3600）。 |
| `localExec` | true | 中继派来的任务投进最近活跃会话；关掉则只回 `blocked`。 |
| `sessionSnapshot` | true | 自动把本机最近 3 条会话同步到中继（只存库、不下发）；关掉则网页「会话」那列为空。 |
| `notifyOnTask` | true | 任务到达弹通知。 |
| `notifyOnResult` | true | 结果回传后弹通知。 |
| `vibrateOnTask` | false | 任务到达震一下。 |
| `syncMode` | `manual` | `manual` = 只有 `relay_sync_task` 才上传本地流水。 |
| `appPackage` | `''` | DSHA 的包名，网页「打开手机 DSHA」走 `/app/launch`。留空不接管。 |
| `appUrl` | `''` | 深链（如 `dsha://chat`），走 `/app/open`；`appPackage` 优先。 |

---

## 九、隐私

- 默认**不上传任何本地历史**：流水只写在 `relay-local-tasks.jsonl`，要传得手动 `relay_sync_task`。
- 中继只收到：任务到达/开始/完成的状态与汇报正文、心跳元信息（平台、架构、版本），以及**默认开启**的最近 3 条会话快照
  （各最多 40 条消息、单条 6000 字；只写库、不下发给任何设备，不要就 `sessionSnapshot: false`）。
- `relay_unpair` 删除本机令牌，之后这个设备在中继那边就是个离线的空壳。

---

## 十、会话快照（自动上报 / 送过来）

配对后手机端会把本机最近 **3 条会话**同步到中继（配对成功一次，之后每 90 秒一次，`turn/end` 后 4 秒防抖补一次；
每条最多 40 条消息、单条 6000 字，只取用户/助手正文，DSH 注入的 `runtime-context` 之类过滤掉）。

- **只存不下发**：同步只写中继的库，长轮询不会把别人的会话发给你，你的也不会发给别人。
- **你选才送**：中继网页选一张卡片 + 选「手机」→「送过去」，中继才生成一条定向 handoff。
  手机本地已有同 `sessionId` 的会话 → 直接注入那条接上；没有 → 新建一条再注入，标题一起补上；
  落地成功 `POST /api/agent/handoffs/ack` 回报 `delivered`，失败回报 `failed`。
- 手机断网时收到的 handoff 会走发件箱（`relay-outbox.jsonl`，`kind: 'handoff'`），联网后重放。
- 关掉：`sessionSnapshot: false`；想看本机上报了什么：`GET /relay/api/sessions`（只认本机）。

---

## 十点二、任务隔离：一条任务一个会话（0.2.1+）

和桌面端同构（`sessions.js` 两份完全一致）：

- 中继任务没有 `sessionId` → `sessionController.create({})` 新开一条会话再投；`running` 回报带上 `sessionId`。
- 带 `sessionId` → `ensureSession` 回原会话，没有就用同一个 id 建一条。
- 网页「接着做」现在是在原任务里加一轮（`task_rounds`）：领到的是这一轮的正文 + 同一个 `sessionId` + `round`，
  注入消息里会写明「这是这条任务的第 N 轮：接着往下做，别从头重来」。
- 同一会话上一单没跑完 → 进内存队列等 `turn/end`；插件停止/解绑时队列里的单子统一回报 `failed`。
- 本机流水 `relay-local-tasks.jsonl` 只留最近 20 个任务（`MAX_LOCAL_TASKS`）。
- 送过来的会话快照只静默注入（`send(message,'next-turn',false)`），不会自动跑起来。

## 十一、自测

手机上没有 `node` 命令时，用 Electron 当 node（Windows）：

```bash
cd dsh-relay/plugins/dsha-relay-pair
export ELECTRON_RUN_AS_NODE=1
N='/e/Deepseek/DeepSeek Harness.exe'

"$N" tests/protocol.test.mjs   # 58 项：配置夹取、凭据、流水、发件箱（含串行写）、消息框、退避
"$N" tests/bridge.test.mjs     # 25 项：3090 桥：令牌解析、错误码归类、通知/震动
"$N" tests/apply.test.mjs      # 76 项：工具、路由、围栏、配对、轮询、断网重放、打开手机 DSHA
"$N" tests/client.test.mjs     # 56 项：设置页：字典、样式、槽位、包元信息
```

有 node 时直接 `npm test`（即 `node --test tests/*.test.mjs`）。

这四份共 **215 项**，都不碰外网：中继与桥都是本地起假服务器，跑完就关。

### 十点一、真中继联调（会打外网）

`tests/e2e-cloud.mjs` 打的是真中继，验证「手机 → 公网 → 中继网页」整条链路：

```bash
RELAY_BASE=http://1.2.3.4 \
RELAY_WEB_TOKEN=<中继 config.json 里的 webToken> \
  "$N" tests/e2e-cloud.mjs
```

16 项：临时 DSH_HOME → 网页生成配对码 → `relay_pair` 真配对 → 心跳 → 网页
`target=dsha` 建单（`dispatch:true`）→ 长轮询领单投进会话 → 中继里变 running → 隧道
`/relay/api/state` 拿到插件本地状态 → `turn/end` 后中继显示 done + 输出 →
本地流水与发件箱收干净 → `relay_unpair` 断开。

跑完会在中继里留下一条名带 `E2E` 的设备与任务记录，对账后删：

```sql
DELETE FROM tasks       WHERE title LIKE 'E2E%';
DELETE FROM devices     WHERE name  LIKE 'E2E%';
DELETE FROM task_events WHERE task_id NOT IN (SELECT id FROM tasks);
```

---

## 十二、排错

| 现象 | 查什么 |
| --- | --- |
| 设置页显示「插件没加载起来」 | `/relay/api/state` 404：插件没进 profile，或 `dsh plugin add` 后没重启。 |
| 设置页显示「只能在本机页面里配对」 | 403：用了非回环地址访问，或在别的站点里嵌了页面。 |
| 配对成功但一直收不到任务 | 中继网页看设备是否 online；`relay_status` 看心跳年龄；确认任务 `target` 不是 `cloud`。 |
| 任务跑了但中继一直显示 running | 看状态页「未回传报告」；中继不通时报告会留在发件箱等重放。 |
| 没弹通知 | `relay_status` 里「设备桥」那一行；桥不可用时通知静默失败（不影响任务）。 |
| 手机上两条心跳 | 同时装了桌面端和手机端插件，卸一个。 |
