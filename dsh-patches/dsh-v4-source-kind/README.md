# dsh-v4-source-kind —— 修复「format v4 message requires a producer-owned source kind」

## 症状

某个定时任务（或模型切换提示、PTC 图片回填）触发后，整轮运行直接失败，GUI 显示：

    本轮运行失败
    format v4 message requires a producer-owned source kind

**跟模型、跟提示词都没关系。** 是插件注入的消息带了 DSH 已经不接受的 `source.kind`。

## 根因

DSH 从 0.1.7-rc.2 起持久化为 **session format v4**，判定逻辑（`app.asar` 内
`../session-format-v3-to-v4/src/message-sources.ts` 的 `source()`）要求每条落盘消息的
`source.kind` 必须是**生产者自己的名字**：

```js
if (value.kind === "plugin") throw new SessionFormatError(
  "format v4 message requires a producer-owned source kind");
```

旧写法 `{ kind: "plugin", plugin: "<名字>" }` 被 v3 迁移器改写，但**实时注入的 v4 事件不会
被改写**，在接收 session 采纳（adopt）时抛错，于是整轮 turn 直接死掉、连 turn/end 都没有。
重启 DSH 只是清掉 board/节流状态，所以会反复出现（每触发一次死一次）。

v4 里正确的写法是 `plugin:<包名>`，或直接用已发布的同名 kind
（`model-selection`、`ptc-mode`、`schedule` 等）。

## 本机命中的 3 处（已修）

| 文件 | 行 | 修前 | 修后 |
| --- | --- | --- | --- |
| `C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-cron/index.js` | 670 | `{ kind: 'plugin', plugin: 'cron' }` | `{ kind: 'plugin:dsh-cron' }` |
| `.../dsh-work-components/lib/channel-telegram.mjs` | 62361 | `{ kind: "plugin", plugin: "tools-ptc" }` | `{ kind: "ptc-mode" }` |
| `.../dsh-work-components/lib/channel-telegram.mjs` | 70046 | `{ kind: "plugin", plugin: "model-selection", form, summary }` | `{ kind: "model-selection", form, summary }` |

**dsh-cron 是主犯**：它的 `fire()` 用 `createUserMessage({ source: { kind: 'plugin', plugin: 'cron' } })`
+ `agent.followup()` 投递定时任务，所以每次定时任务到点都会打断当前那一轮。
另外两处在 work-components 打包的 telegram 客户端里（PTC 图片回填、模型切换提示），
平时不常走到，但一旦走到同样致命。

## 用法

```bash
PY=C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe
NODE=C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe

$PY  patch_v4_source_kind.py           # 打补丁（已打过会显示 already patched）
$PY  patch_v4_source_kind.py --check   # 只看状态，stale 时退出码 1
$PY  patch_v4_source_kind.py --restore # 回退到补丁前
$NODE verify_v4_source_kind.mjs        # 全 profile 扫一遍「退役写法」，通过才退出 0
```

**打完必须重启 DSH**（插件是启动时加载进 host 的，改文件不会热生效）。

## 什么时候会失效

`dsh-cron`、`dsh-work-components` **升级/重装会覆盖这两个文件**，于是错误复活。
升级后先跑 `verify_v4_source_kind.mjs`，FAIL 就重跑 `patch_v4_source_kind.py`。
上游仍未修（dsh-cron v0.3.1 的 `index.js` 就是这段），故只能本地补。

## 顺带确认

- 只命中这一个形状。全 `profiles/desktop/node_modules` + `E:/工作区/dsh-plugins` 扫描
  `kind:\s*['"]plugin['"]` 后，除上表三处再无其他（`dsh-better-sidebar`、
  `@copylee/dsh-office`、`dsh-pet`、`dsh-memory-evolve` 都已是规范写法）。
- `dsh-agy-link` 里有一句 `kind === "plugin" && src.form === "snapshot"`，是读历史消息的
  容错分支，改不改都行，不影响。
