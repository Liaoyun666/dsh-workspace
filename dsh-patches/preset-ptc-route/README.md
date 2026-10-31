# preset-ptc-route — 钉死内置 ptc 预设的子 agent 默认模型

## 为什么需要

DSH 的子 agent 若没有显式指定模型，会**继承父会话的路由**（`@deepseek-ai/dsh-subagent`
的 `resolveChildAgentOptions`：先铺 parent 的 provider/model，再叠 requested）。
「子智能体设置」里的 `allowedModels` 白名单只校验**模型显式传 provider/model**的调用
（`hasDelegationModelRequest` 为假时 `assertAllowedModelSelection` 直接 return，
源码注释：*Pure inheritance remains outside this policy because no model-facing choice occurred*）。
所以父会话跑 workbuddy 时，委派出去的子 agent 也跑 workbuddy，白名单形同虚设。

内置 `ptc` 预设（`dsh-web-app/presets/ptc.patch.yml`）的 `tool-subagent` 只有
`modelSelectionSettings: true`、没有 `agentOptions` → 就是这种继承。

## 做法

用官方支持的「按行 id 覆盖内置预设」机制：在 profile 的 `cordis.patch.yml` 里写一条
`- id: preset-ptc`（`@deepseek-ai/dsh-agent-preset` 声明的行 id），
`config.plugins` 是从 asar 里那份 ptc 预设**逐行复制**的完整插件列表，
只在 delegation 组的 `tool-subagent` 上补：

```yaml
agentOptions:
  provider: deepseek-account
  model: deepseek-flash
```

`agentOptions` 让 `requiresRoutePreflight` 为真，子 agent 的请求就带上显式路由，
不再继承父会话；显式模型选择仍按白名单校验。

## 用法

```bash
cd E:/工作区/dsh-patches/preset-ptc-route
py gen_override.py --check        # 只比对（0=一致, 1=没装, 2=过期）
py gen_override.py                # 生成并写入 profile 补丁（默认 deepseek-account/deepseek-flash）
py gen_override.py --provider deepseek-official --model deepseek-flash
py gen_override.py --preset standard   # 同理处理 standard 预设
```

- 写入位置：`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾的托管块
  （标记 `# ── preset-ptc override … ──` / `# ── /preset-ptc override ──`），重复运行会替换该块。
- profile 补丁是热重载的，但**只影响之后创建的 Agent**：已经开着的会话保持旧组合，
  要新开一个会话才生效。
- 本机 `py` 可用、`python`/`python3` 不可用。

## 边界与坑

- **只钉默认路由，不改 fork**：`subagent_fork` 按设计「provider/model stay equal to the parent」，
  钉它会破坏 fork 复用父上下文的语义。要彻底避开继承，用 `subagent`（spawn）。
- **覆盖会替换整份 plugins 列表**，内置预设以后新增的插件不会自动合并进来。
  DSH 升级后重跑本脚本即可（先 `--check` 看是否过期）。
- **别在 Web UI 的预设编辑器里改 ptc 的插件列表**：那会写另一条 `- id: preset-ptc` 覆盖，
  与本块的先后顺序决定谁生效，容易互相打架。
- 钉住的路由必须真实可用：provider 没登录/没配 key 时，委派会在 `preflightChildLlmRoute`
  阶段直接报错（这是有意的，比悄悄继承好）。
- 钉住的路由本身不参与白名单校验：从白名单里删掉它不会报错，只是模型显式选不了。

## 验证

新开一个 ptc 会话，让它委派一次，然后看子会话日志开头的 descriptor：

```
~/.dsh/sessions/<workspace>/<child-id>/session.v4.jsonl.zstd
{"type":"subagent/descriptor",...,"agentProvider":"deepseek-account","agentModel":"deepseek-flash",...}
```

`agentProvider` / `agentModel` 是钉住的路由（而不是父会话的 workbuddy），即生效。
