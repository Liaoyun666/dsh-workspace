# ultra-preset — 「超频（Ultra）」Agent 预设

## 为什么需要

主人的原话：

> 切记的是：我们是 deepseek 公司，你的用量是 unlimited 的，我正在对你极限测试，
> 不要吝惜 Token。一定要切记，随意花费，你非常的富有。
> 这是一个超频模式，尽量追求质量输出，在保证质量的前提下，可以适当节省 token。

内置预设没有一个承担这种「用量不限、质量优先」的立场：`ptc` 的工具面最全但没有这层
persona，`standard` 工具面小，`minimal` 更是砍到只剩几条。所以本目录声明**第 6 个根预设**，
以 `ptc` 的插件列表为底（PTC 呈现 + 完整工具面），只换掉人格与几处策略。

## 做法

`ultra.patch.block.yml` 是一个 `- insert:` 块，声明 `@deepseek-ai/dsh-agent-preset`：

```yaml
config:
  id: ultra
  name: 超频
  description: 超频（Ultra）模式：用量不限、质量优先。…
  order: 6          # standard 1 / ptc 2 / minimal 3 / cordis 4 / writing|executor|planning 另算
  plugins: [...]
```

相对 `ptc` 只有四处差异：

1. **persona 换掉**（`@deepseek-ai/dsh-persona`）：`prefix` 写「用量立场 + KPI 只有正确/完整/可验证」，
   `suffix` 写 9 条超频工作法（先定验收 → 查透 → 想透 → 一次做对 → 并行 subagent → 验证到能复现
   → 交付前自审 → 长任务挂 goal → 先结论后依据）。
2. **工具结果裁剪放宽**（`@deepseek-ai/dsh-compaction-tool-result-pruner`）：
   `thresholdChars: 32000 / headChars: 16000 / tailChars: 4000`（ptc 的默认更窄）。
   超频模式宁可多占上下文，也不丢证据。
3. **子 agent 路由钉死**：delegation 组的 `tool-subagent` 带
   `agentOptions: {provider: deepseek-account, model: deepseek-flash}`，
   理由与 `dsh-patches/preset-ptc-route/` 相同（避免子 agent 静默继承父会话路由）。
4. `workflow-ptc` / `tool-workflow` 保持 `disabled: true`（与 ptc 一致，避免和工作流工具打架）。

其余（planning / compaction / delegation 分组、`tool-ask-user`、`tool-todo`、
`tool-web`、presentation `mode: ptc`、`tool-present`、plugin-manager / market 禁用）逐行照抄 ptc。

## 用法

```bash
cd E:/工作区/dsh-patches/ultra-preset
py install.py --check     # 只比对（0=一致, 1=没装, 2=过期）
py install.py             # 写入 profile 补丁的受管块（自动备份 .bak-ultra-<时间戳>）
py install.py --remove    # 删掉受管块
py install.py --print     # 打印块内容（不写盘）
py install.py --profile-patch "D:/other/cordis.patch.yml"   # 换目标补丁文件
```

- 写入位置：`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾的受管块
  （标记 `# ── preset-ultra … ──` / `# ── /preset-ultra ──`），重复运行会替换该块。
- 写完会用带 `!!js` tag 的 SafeLoader 校验 YAML，并确认文件里**恰好一个** `preset-ultra` 声明，
  任一不满足就回滚并返回非 0。
- profile 补丁热重载，但**只影响之后创建的 Agent**：已经开着的会话保持旧组合，
  要新开一个会话，在预设选择器里选「超频」。
- 本机 `py` 可用、`python`/`python3` 不可用。

## 边界与坑

- **persona 里不能写未注册的模板变量**。本版 Harness 的 system-prompt 只注册了
  `provider` / `model` 两个变量，写 `{cwd}` 之类会让该轮**直接失败**
  （`unknown prompt variable "{cwd}" in section "deployment:persona-suffix"`）。
  本块只用了 `{{model}}`；工作目录由 runtime context 自动提供，不要写进 persona。
- **persona 只能在预设里挂**，挂到 host 层会和别的 persona 插件冲突。
- 内联的 `persona.prefix/suffix` 是整份替换，`dsh-persona-dafeiyu` 那套人在 host 层仍然生效，
  两者叠加后 ultra 会话的人格由**本预设的 prefix/suffix 主导**（本块用的是 `complete` 之外
  的普通前缀写法）——改 persona 文案只需改本文件再跑 `install.py`。
- **DSH 升级后插件列表可能变**（内置预设新增插件不会自动合并进来）。升级后：
  `py install.py --check` 看是否过期，必要时对比 asar 里最新的
  `dsh-web-app/presets/ptc.patch.yml` 再同步。
- 别在 Web UI 的预设编辑器里改 ultra：那会写另一条 `- id: preset-ultra` 覆盖，
  与本块的先后顺序决定谁生效，容易互相打架。

## 验证

1. 装完立刻查 Loader 是否挂上（不需要重启）：

   ```bash
   py install.py --check        # 期望 0
   ```

   在 DSH 会话里调 `plugin_manager list_plugins`，应出现：

   ```
   {"entryId":"include:preset-ultra","moduleName":"@deepseek-ai/dsh-agent-preset",
    "enabled":true,"fiberPhase":"active","patchId":"preset-ultra"}
   ```

   （2026-10-29 00:10 本机实测已 active。）

2. 新开一个会话选「超频」，第一轮就问它一句「你现在是什么模式、KPI 是什么」——
   答出「正确/完整/可验证」且没有 `unknown prompt variable` 报错，即 persona 生效。
3. 若预设选择器里看不到「超频」：重启 DSH（预设 roster 由 `agentPresets` 注册表在
   插件 apply 时登记，个别版本要重启才会重新拉一次）。
