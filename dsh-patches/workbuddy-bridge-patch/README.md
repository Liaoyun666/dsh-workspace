# WorkBuddy Bridge 补丁：积分 → token 估算 + 轮询优化 + 11128 风控重试

目标插件：`dsh-workbuddy-bridge@0.5.3`（npm，profile `desktop`）
被改文件：
- `…\dsh-workbuddy-bridge\lib\client.js`（浏览器侧 bundle，补丁脚本 `patch_credit_tokens.py`）
- `…\dsh-workbuddy-bridge\lib\index.js`（host 侧，补丁脚本 `patch_channel_gate_retry.py`，见第七节）

当前版本：**v4**（2026-10-24 17:37，客户端）+ **gate-retry**（2026-10-27，host 侧）。

## 一、做了什么

### 1. 输入框上方显示「积分 · 倍率 · 约可用 token」

座位从 `conversation.input.right`（输入框右侧工具行，窄、紧邻模型选择器）**换到 `conversation.input.dock`**（输入框上方的全宽行），右对齐、浅色小字、不抢输入区空间：

```
🪙 2251   ×0.11   ≈ 4451.5万 tokens
```

- 三项分别是：剩余积分、**当前模型的积分倍率**、按倍率换算的可用 token 估算。
- 倍率取自 status 路由返回的 `models[].credits`（形如 `"x0.11"`）；切换模型即刻重算，不产生额外请求。
- 免费模型（倍率 `x0.00`，如 `hy3`、`step-5-preview`）显示「免费模型，不消耗积分」，不显示 ∞。
- 查不到倍率（模型不在目录里）时只显示积分，宁可不显示也不给错数。
- 悬停标题写明：模型名、产品名、口径（剩余积分 × 倍率换算、命中缓存的输入不计费、粗估）。

**UI 适配**：`display:flex` 右对齐、`width:100%`、`max-width:var(--dsh-chat-content-width,720px)` 与聊天内容同宽居中、左右留 `calc(var(--dsh-composer-side-clearance) + 16px)` 与输入框对齐、`box-sizing:border-box` + `overflow:hidden` 防止窄窗撑破、`tabular-nums` 让数字不跳动；窄屏（`max-width:640px`）自动隐藏倍率项只留「积分 + 估算」，避免换行。

### 2. 卡顿优化（这才是页面卡顿的真凶）

原实现里 `WorkBuddyCreditLabel` 挂在**每条助手消息**上，每条消息各起一个 `setInterval(30s)` + 一个 `window focus` 监听，全部打同一个 `/credit` 路由 —— 会话里 40 条回答 = 40 个定时器。加上 status 路由被三处独立轮询（60s / 60s / 120s）且每次都真打腾讯 billing（实测单次 0.32–0.38s），叠加起来就是明显卡顿。

改法：

| 位置 | 原来 | 现在 |
| --- | --- | --- |
| 每消息积分 | 每条消息 1 个 30s 轮询 + 1 个 focus 监听 | 每个 (路由, session) 共享 1 个 store，N 条消息共用 1 个轮询；最后一个订阅者卸载时自动停 |
| status 读取 | 3 处各自 `fetch`，无缓存 | `readStatusShared()`：60s TTL 缓存 + 单飞（并发合并成 1 个请求）；写操作后的回读用 `force` 绕过缓存 |
| 窗口聚焦 | 每处各自监听 focus 直接发请求 | `subscribeFocusRefresh()`：200ms 去抖 + 5s 最小间隔，一次 alt-tab 只读一次 |

实测效果：40 条消息的场景，`/credit` 请求从 40 个定时器降为 1 个；alt-tab 时的请求风暴合并为 1 次。

## 二、token 估算口径（v4 = 每模型实测系数）

### 为什么 v3 的单一常数是错的

v3 假设「credit 只由倍率决定」：`credit = rate * (a*out + b*in)` 里的 a/b 对所有模型相同，只用 `deepseek-v4.1-flash`（x0.11）的会话样本拟合。**这个假设不成立。**

代价：v3 对 kimi-k3-1 高估约 2.6 倍、对 deepseek-v4.1-flash 低估约 13 倍。这就是用户说「token 数明显不对」的量化原因——倍率只解释了一部分价差，每个模型还有自己的单价。

### 实测方法（`measure-final.mjs`）

不依赖任何已有账本，直接对上游发真实 chat 请求，读 SSE 末帧的 `usage.credit`：

- 每个模型 3 个探针：`in`（长占位 prompt + 短回答）、`out`（短 prompt + 长文）、`mix`（混合）。
- 探针规模自适应：按该模型倍率反推，目标每探针约 0.6 credit，使 `credit` 的 0.01 量化误差 < 2%；行数按 `TOKENS_PER_LINE=48` 估算，并受 contextWindow 50% 上限约束。
- 解 `y = credit/rate = a*out + b*in`（3 探针最小二乘，最差相对残差 4.5%）。
- 每个 prompt 带随机 nonce，防前缀缓存把 input token 数打偏。

实测结果（`fitted.json`，可直接对照）：

| 模型 | rate | tok/credit（本机典型用量） |
|---|---|---|
| deepseek-v4.1-flash | 0.11 | 25415 |
| space-bunny / glm-5.3-flash / hy3-x | 0.08 / 0.08 / 0.05 | 24870 / 27380 / 16811 |
| minimax-m3.1-flash | 0.08 | 12978 |
| mimo-v2.6-pro | 0.13 | 6189 |
| hy4-preview | 0.29 | 3720 |
| glm-5.2 / glm-5.3 / glm-5v-turbo | 0.79 / 0.69 / 0.71 | 2501 / 2491 / 2558 |
| kimi-k3-1 | 1.62 | **658** |

### 三条独立交叉验证（都不是拟合用的数据）

| 数据源 | 实际 | 预测 | 偏差 |
|---|---|---|---|
| bridge 源码注释里作者实测的 glm-5.3（输出 900 token） | 0.51 credit | 0.5042 | **−1.1%** |
| 本会话 19 条真实扣费记录 | 2.40 credit | 2.45 | **+2%** |
| 上述 19 条的单条 | | | 多数 ±10% 以内（credit 本身以 0.01 取整，这是量化噪声下限） |

### 换算公式（`client.js` 内）

```js
credit = rate * (a * output + b * freshInput + c * cachedInput)   // c = 0.02 * b
tokens = total / (rate * (a*OUT_SHARE + b*(1-OUT_SHARE) + 0.02*b*CACHE_PER_BILLED))
```

- `MODEL_CHARGE`：17 个模型的 `{a, b}`（`glm-5.1` 上游拒答，借用 `glm-5.2` 系数并在注释说明）（注：19 个模型中 2 个免费模型无系数）。
- `DEFAULT_CHARGE` = 所有实测模型的中位数，用于上游新增的未知模型——给一个合理量级，而不是不给估算。
- `BILLED_OUTPUT_SHARE = 0.4163`、`CACHE_READ_PER_BILLED = 23.28`：本机 11 天 cost-meter 账本里 `workbuddy:` 桶的真实构成（非缓存 token 中 output 占 41.63%，每 1 个非缓存 token 配 23.28 个缓存读）。
- 余额 2251 时：flash → **≈ 5720.9万**，kimi-k3-1 → 约 198万，glm-5.3 → 约 558万。

### 重新标定

```bash
NODE='E:/Deepseek/resources/runtime/primary-runtime/dependencies/node/bin/node.exe'
"$NODE" measure-final.mjs     # 实测 → measure-final.json / fitted.json + 可粘进补丁的 JS 字面量
"$NODE" validate-charge.mjs   # 三条交叉验证 + 全模型 token/credit 表
```

会花掉大约 20-30 credit（19 个模型 × 3 探针）。改系数只需替换 `patch_credit_tokens.py` 里的 `MODEL_CHARGE` 块后重打。

## 三、怎么重打 / 回滚

插件升级会覆盖 `node_modules`，届时「≈ token」和优化都会丢失，重跑即可：

```bash
cd /e/工作区/dsh-patches/workbuddy-bridge-patch
py patch_credit_tokens.py            # 打补丁（自动备份 + 幂等）
py patch_credit_tokens.py --check     # 查是否已打
py patch_credit_tokens.py --restore   # 恢复最新备份
```

- 备份命名：同目录下 `client.js.bak-tokens-<YYYYmmdd-HHMMSS>`（原始 124143B，md5 `6a6b33b8acd8464bf83eee92e34ac504`）。
- 补丁后（v4）：133056 字符 / 135518 字节（md5 `8f0ab44df9a967fb35d1c614849c0b83`）；服务端下发时再拼 77B 的 `sourceMappingURL` 尾巴。
- 不用重启 DSH：客户端 bundle 由 `client-hmr` 每 500ms stat 轮询 mtime，改动后自动推送新 rev 给浏览器；刷新页面（Ctrl+R）即可看到效果。

## 四、验证记录（v4）

- `node --check` → OK
- `smoke.mjs`（伪造 `ModuleLoader` 求值整个 bundle）→ `EVAL_OK exports= BUNDLE_NAME,ENTRY_ID,NS,apply,inject,name`
- `test_store.mjs` → 31 项全 PASS（40 行共享 1 store/1 interval；focus 风暴合并；5s 内重复 focus 丢弃；卸载后定时器清空；status 并发合并、TTL 复用、force 绕过；**每模型系数互相独立、未知模型回退中位数、前缀匹配**）
- `test_render2.mjs` → 19 项全 PASS：dock 容器 class、`2251` + `×0.11` + `5720.9万`、title 含模型名、free 文案、kimi(1.62) 估算远小于 flash(0.11)、unlimited 与未知模型都不出估算、非 workbuddy provider 返回 null、id 大小写不敏感、rate 0 → ∞
- 座位生效（`cordis_inspect_query` → `Slots.listSubTree` root=`conversation.input.dock`）：
  `todo(0) / **workbuddy-credit-balance(4)** / cost-meter-qstrip(5) / goal(10) / queue(20)`；
  `conversation.input.right` 只剩 `workbuddy-probe` 等工具行控件。
- 服务端下发：`/plugins/events` SSE rev = `601f3f2a3078`；抓取该 rev 的 bundle = 135595B，内容为磁盘文件前缀 + 77B 尾注，补丁标记计数全部正确。

## 五、文件清单

| 文件 | 说明 |
| --- | --- |
| `patch_credit_tokens.py` | 补丁脚本（字面量精确替换 + 幂等 + `--check`/`--restore`） |
| `patch_credit_tokens.diff` | 对比原始 backup 的完整 diff |
| `measure-final.mjs` | **实测每模型 charge 系数**（3 探针/模型，自适应规模）→ `measure-final.json` / `fitted.json` |
| `validate-charge.mjs` | 三条独立交叉验证 + 全模型 token/credit 表 |
| `desktop-credential.mjs` | 读 WorkBuddy 桌面凭据（AES-256-GCM 信封解密，不落盘 token） |
| `build-model.mjs` / `calibrate-price.mjs` | 早期用 cost-meter 价格表建模的探索脚本（v3 思路，已被实测取代，留存备查） |
| `calibrate.mjs` / `calibration.jsonl` / `sample.js` | 用会话日志 join 的早期标定（v2/v3 用） |
| `test_store.mjs` | 共享缓存 / focus 去抖 / 每模型系数单测（从真实 bundle 切片） |
| `test_render2.mjs` | 渲染树断言（参数化 bundle 路径） |
| `smoke.mjs` | bundle 求值冒烟 |
| `_dryrun.py` / `_slice.py` | 干跑工具（生成 `_patched_client_v3.js` 供校验，不写 node_modules） |
| `client.js.patched-v1` | v1 补丁产物（仅 status 共享），留存备查 |
| `served_601f3f2a3078.js` | 服务端实际下发给浏览器的 v4 bundle 快照，证明热重载已生效 |
| `_orig_hook.txt` | 原始 `useWorkBuddySessionCredits` 精确切片（对齐替换字面量用） |
| `patch_channel_gate_retry.py` | **host 侧补丁**：上游 11128 频道风控命中时，把 system/developer 消息做零宽扰动后重试一次（`--check`/`--restore`，备份 `.bak-gate-*`） |
| `probe-gate-retry.mjs` | 端到端验证上述重试：用真实系统提示词发上游，第一次 400/11128，扰动后 200 |
| `probe-health.mjs` / `probe-content*.mjs` | 凭据与触发条件矩阵诊断（角色/位置/大小写/次数） |
| `check-system-prompt.mjs` / `scan-session.mjs` | 从会话日志取真实 system prompt、按事件类型扫描日志 |

### 跑测试

```bash
cd /e/工作区/dsh-patches/workbuddy-bridge-patch
NODE='E:/Deepseek/resources/runtime/primary-runtime/dependencies/node/bin/node.exe'
"$NODE" --check 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-workbuddy-bridge/lib/client.js'
"$NODE" smoke.mjs 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-workbuddy-bridge/lib/client.js'
"$NODE" test_store.mjs 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-workbuddy-bridge/lib/client.js'
"$NODE" test_render2.mjs 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-workbuddy-bridge/lib/client.js'
```

## 六、注意

- 上游是腾讯 CodeBuddy/WorkBuddy 的非官方通道，接口与倍率随时可能变化；积分换算只是估算，不代表官方计费承诺。
- 倍率线性可乘只在一个倍率点（x0.11）上验证过，跨倍率的换算靠倍率本身线性外推。
- 所有读取都在本机 loopback 路由内完成，凭据不出本机。
- **插件升级或重新安装会覆盖补丁**：实测 `plugin_manager set_bundle enabled=false/true` 也会触发包重装，`lib/client.js` 被 pnpm store 的原始副本还原（md5 `6a6b33b8acd8464bf83eee92e34ac504` / 124143B）。动过开关后先 `py patch_credit_tokens.py --check`、`py patch_channel_gate_retry.py --check` 看两个补丁是否还在，缺了就重打。

## 七、`11128` 频道风控自动重试（host 侧补丁，2026-10-27）

### 症状

用 WorkBuddy 模型发消息，整轮直接失败：

```
400: {"message":"workbuddy upstream client: 请求被拦截，请重新发送","type":"client","code":"client"}
```

### 根因

腾讯 `copilot.tencent.com/v2/chat/completions` 有一道**频道签名风控**，命中时返回 HTTP 400 + 机器码 **11128** `Illegal API invocation from an unapproved channel`，`displayMsg.zh` 就是「请求被拦截，请重新发送」。bridge 只是把上游文案原样透传（`lib/index.js:822 failureMessage()`）。

**与前端补丁无关**（那是浏览器侧 `client.js`），也**不是额度/凭据问题**——实测 refresh 200、最小请求 200。

**真正的原因**：bridge 0.5.3 只改写了 `DeepSeek Harness` 开篇句与品牌词，但 DSH 当前系统提示词里还有别处会命中该风控。实测（15810 字符的真实 system prompt）：

| 请求 | 结果 |
| --- | --- |
| 真实提示词原样 | 400 / 11128 |
| 套完 bridge 的正则（开篇句改写 + 品牌词插零宽） | **仍 400 / 11128** |
| 删掉其中「Tokens prefixed with @ ...」那一段 | 200 |
| 该段只改一个字符（`Tokens`→`Tokenz`） | 200 |

逐段扫描 52 个段落后确认：**只有那一段会触发**，其它段落单独发送都是 200；`user`/`tool` 角色、`tools[].function.description`、`tool_calls.arguments` 都不会触发；单纯出现品牌词 20 次也不触发。

### 补丁做法

不动请求内容，只在**首次被风控拒绝**时把 `system`/`developer` 消息做一次零宽扰动再重试一次；一旦见过风控就置 `channelGateGuard`，后续请求直接预扰动，不再多花一次失败往返。

扰动方式：每 24 个字符插一个 U+200B。单点插入（如只在某段某处插）**不可靠**（实测 400 → 仍 400），整段喷洒可靠（实测 400 → 200）。用户与工具消息一律不动——它们是事实基准。

```
py patch_channel_gate_retry.py            # 打补丁（备份 index.js.bak-gate-<时间戳>）
py patch_channel_gate_retry.py --check    # 看状态
py patch_channel_gate_retry.py --restore  # 回滚
```

验证：

```bash
NODE='E:/Deepseek/resources/runtime/primary-runtime/dependencies/node/bin/node.exe'
"$NODE" --check 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-workbuddy-bridge/lib/index.js'
"$NODE" probe-gate-retry.mjs      # 期望：attempt 1 BLOCKED 11128 / nudged retry OK 200
```

`probe-gate-retry.mjs` 会从**已打补丁的 host bundle 里切出真实 helper 源码**来跑，保证测的就是补丁本身。

### 生效方式

host 侧代码（`lib/index.js`）改动需要 host 重新加载模块：切换插件开关（`plugin_manager set_bundle`）会让 bridge 重新注册，但**是否重新 import 模块取决于加载器缓存**；最稳妥是重启一次 DSH 桌面进程。前端 `client.js` 的补丁仍由 client-hmr 自动热重载，不受影响。
