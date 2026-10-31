# dsh-planning-preset —— 「规划」Agent 预设

给 DeepSeek Harness Web GUI 的两个配套 Agent 预设：**规划（planning）** 与 **执行（executor）**。
装上之后在「设置 → Agent 预设」里新建会话时选「规划」，主 Agent 就只做规划与审查，
一切动手的工作都交给它 spawn 出来的执行子 Agent。

## 它解决什么

普通会话里，主 Agent 既做计划又动手，容易一边改一边想、越权修改、跳步验证。
这个预设把职责切开：

| | 规划（planning）—— 主 Leader | 执行（executor）—— 子 Agent |
| --- | --- | --- |
| 人设 | 只规划、审查、汇报，不执行 | 按自包含任务单动手，结构化回报 |
| 工具面 | **只读**：read / read_image / glob / grep、技能、待办、web、plan mode | 完整：shell（bash 或 pwsh）、文件读写、检索、后台任务、技能、待办、web |
| 写文件 | ✗（tool-fs 关闭 write / edit） | ✓ |
| 跑命令 | ✗（不挂 bash / pwsh / jobs） | ✓ |
| 执行通道 | 只有 `subagent`，且子 Agent 被**固定绑定**到「执行」预设 | 不向下分派 |
| 与用户对话 | ✓ 汇报与确认 | ✗（看不到用户） |

工作循环：**调研 → 出计划 → 用户确认 → 拆任务单分派 → 审查产出 →（不合格则发修复单）→ 汇报**。

## 安装

```bash
# patch 方式（默认，热生效）：追加到 profile 的 cordis.patch.yml，刷新页面即可用
node tools/install.mjs                    # 装进 desktop profile
node tools/install.mjs web                # 装进名为 web 的 profile

# bundle 方式（写成一层 bundle patch，需要重启 dsh）
node tools/install.mjs desktop --bundle

node tools/install.mjs --status           # 看当前登记状态
node tools/install.mjs --uninstall        # 两种登记都撤掉
```

装完后在 GUI 里 **刷新页面 → 设置 → Agent 预设**，应该能看到「规划」和「执行」两个预设
（自定义预设显示在「自定义」分组）。新建会话选「规划」即可。

## 典型用法

1. 选「规划」预设新建会话，说出你想做的事（"给 X 加一个 Y 功能"）。
2. Leader 用只读工具调研，给出 decision-complete 的计划；需要你拍板的点会用 `ask_user_question` 问你。
3. 你说「开始 / 就按这个做」之后，Leader 把实施拆成自包含任务单，用 `subagent` 分派给执行子 Agent。
4. 执行子 Agent 动手、自测，用五节格式回报（结论 / 改动清单 / 验证 / 边界与假设 / 遗留风险）。
5. Leader 对照验收标准审查（必要时自己抽读文件），不合格就带着具体问题再发修复单；完成后给你总结。

会话里输入 `/plan` 会进入 plan mode：Leader 用 `exit_plan_mode` 把完整计划交给你在界面上审批；
批准后实施仍然由执行子 Agent 完成。

## 设计边界（重要）

- **预设不是安全沙箱**。DeepSeek Harness 的每一层宿主级插件（例如本 profile 里由 `dsh-ops`、
  MCP、memory 等 bundle 提供的 `ops_bash`、`ops_replace`、Blender MCP 工具等）都会出现在每个会话里，
  预设无法按 id 把它从某一个预设中移除。因此「规划」预设的硬边界是：
  **预设本身不挂任何写文件 / 跑命令的工具**（`tool-fs` 关闭 write/edit，不挂 bash/pwsh/jobs），
  以此保证 Leader 没有常规执行手段；至于环境附带的其它工具，靠人设明确禁用（人设里点名
  「ops_ 开头的工具、MCP 工具一律不可用」）。
- 不要用团队工具（`spawn_teammate` 等）做执行：团队队友会继承 Leader 当前预设，
  也就是继承「规划」这套只读工具面，同样不能执行。执行只走 `subagent`。
- 会话日志里只保存预设 **id**；重启后按当前定义恢复。把本包卸载后再打开旧会话，
  该会话会因子 Agent 的 `executor` 预设缺失而无法恢复——先装回包再看旧会话。
- 规划 Leader 与执行子 Agent 的协作是「任务单一进、报告一出」：子 Agent 看不到 Leader 的对话，
  也看不到上一轮执行的会话。要追加修改就再发一张自包含的修复任务单（写明现状、要改的文件、验收标准），
  不要指望子 Agent 记得上一轮。
- 如果 profile 启用了 `billion-context`，它的自动压缩叠加层会按模块名禁用嵌套在预设里的
  `compaction-basic` / `command-compact`（本包预设里保留这两行是为了与官方预设结构一致），
  实际压缩由 billion-context 接管；两者不冲突，不需要额外配置。

- 在 persona 等提示词 section 里**不要写 `{{cwd}}` 这类未注册的模板变量**：本版 Harness 只注册
  `{{provider}}` 与 `{{model}}` 两个提示词变量，写 `{{cwd}}` 会让新会话第一轮直接失败
  （`unknown prompt variable`）。工作目录由 runtime context 自动提供，不需要写进 persona。

## 文件

| 文件 | 说明 |
| --- | --- |
| `cordis.patch.yml` | 两个 preset 的完整声明（先 executor 后 planning：planning 的 `subagent` 挂载时会校验 executor 定义） |
| `tools/install.mjs` | 安装 / 卸载 / 状态查询（patch 与 bundle 两种登记） |
| `README.md` | 本文件 |
| `LICENSE` | MIT |

## 卸载

```bash
node tools/install.mjs --uninstall
```

刷新页面后「规划」「执行」从预设列表消失；profile 的补丁层会恢复成安装前的状态
（安装器保留 `.bak-dsh-planning-preset` 备份）。

## 兼容性

- DeepSeek Harness `>= 0.2.0-rc.2`（Web 表面 / desktop profile）
- Node.js `>= 20`
- 依赖宿主能力：`agent-preset-registry`、`agentPresets` 服务、`subagent`（spawn provider）、
  `tool-subagent` 的 `agentPreset` 选项（spawn in-process provider 支持独立子预设）
