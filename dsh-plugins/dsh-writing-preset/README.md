# dsh-writing-preset

> DeepSeek Harness 的**写作 Agent 预设**：在 Web GUI 的 Agent 预设列表里多出一个「写作」模式——中文写作人设、4 个写作技能、检索 / 文件 / 文档交付工具，面向长文、报告、提案、文案与改稿。

## 它包含什么

**一个 agent preset（id: `writing`，展示名「写作」，排在预设列表第一位）**，由一份普通的 Cordis 声明组成：

| 组成 | 内容 |
|---|---|
| 人设 | 中文写作助手的身份与工作原则：先澄清需求、先结构后文字、事实优先、改稿独立成步、成稿落到工作区文件 |
| 技能 | `writing-workflow`（长文流程）、`chinese-editing`（中文改稿清单）、`marketing-copy`（营销文案）、`research-and-citation`（调研与引注），随包提供、按需加载 |
| 工具 | 文件读写 / 检索（fs、fs-search）、Shell（bash / pwsh 按平台）、后台作业、web_search / web_fetch、ask_user_question、todo、present、skill |
| 压缩 | 自动压缩 + `/compact` + 工具结果修剪，长文写作不易撞上下文上限 |

和默认的 coding preset 相比：**没有** plan-mode、subagent / workflow / ralph、goal 这些偏工程执行的工具；**保留**了调研、文件与交付能力。Office 技能由桌面端宿主提供，写 Word / PPT / Excel 时会自动出现在技能目录里。

## 安装

前提：DeepSeek Harness **0.2.0-rc.2 或更新**，profile 为 `desktop`（桌面端）或 `web`。

三种装法任选其一：

### 1. 本地目录 + 安装脚本（推荐，热生效）

把本目录放在任意位置，然后在目录里运行：

```sh
node tools/install.mjs            # 装进 desktop profile（patch 方式，热生效）
node tools/install.mjs web        # 或装进 web profile
node tools/install.mjs --status   # 看现状
node tools/install.mjs --uninstall
```

脚本做两件事：

1. 在 `~/.dsh/profiles/<profile>/node_modules/` 放一个指向本包的 junction（Loader 靠它解析 preset 里的技能目录表达式）；
2. 把本包的 `cordis.patch.yml` 原样追加进 profile 的 `cordis.patch.yml`（托管块，带首尾标记，可精确卸载）。

profile 的配置层是**热重载**的：脚本跑完，运行中的 DeepSeek Harness 会立即应用这行声明，**刷新页面**后就能在「设置 → Agent 预设」看到「写作」。不需要重启应用。

### 2. bundle 方式（等价于官方 `dsh plugin add`，需重启）

```sh
node tools/install.mjs desktop --bundle
```

本包被登记进 profile 的 `dependencies` 与 `dsh.profile.bundles`，成为一层 bundle patch。bundle 列表在启动时结算，**需要重启一次** DeepSeek Harness。

### 3. 已经装了 pnpm 的机器

```sh
dsh plugin --profile desktop add link:/path/to/dsh-writing-preset
```

（`dsh plugin` 默认拒绝操作 desktop profile；桌面端由应用自身管理插件。所以在桌面端场景请用方式 1 或 2。）

## 怎么用

1. 刷新页面（`Ctrl+R` / `⌘+R`）。
2. 打开 **设置 → Agent 预设**：列表里出现「写作」卡片，点「查看配置」可以看到它声明的完整插件列表。
3. 三种用法：
   - **设置 → Agent 预设** → 「自定义」分组里会出现「写作」卡片，点卡片可选中并设为新任务默认；
   - 新建任务页的模式选择器里直接选「写作」；
   - 任务标题旁的 preset 标签也会显示当前任务用的是哪个模式。
4. 已有会话不会改变预设——预设只影响之后新建的会话（和空白会话切换模式）。

想回到别的模式：在同一个选择器里选回「标准 / PTC / 极简 / Cordis」。

## 自定义

预设就是一份普通 YAML 声明，改它不需要写代码：

- 改**本包的** `cordis.patch.yml`（人设文字、工具增减、参数），然后重新跑 `node tools/install.mjs`；
- 或者直接改 profile 补丁层里 `# ── dsh-writing-preset ──` 托管块内的同名 YAML（下次重装会被本包内容覆盖）；
- 加技能：在 `skills/` 下新建 `<名字>/SKILL.md`（YAML frontmatter 至少要有 kebab-case 的 `name` 和 `description`），重装或重载即可，模型会在技能目录里看到它。

常用调整：

| 想改什么 | 改哪里 |
|---|---|
| 人设 / 语气 / 语言 | `persona.config.prefix` |
| 写作技能 | `skills/` 目录 |
| 换模型 | 不用改预设：模型由会话的模型选择器决定，预设不绑定模型 |
| 加委派 / 计划模式 | 参考内置 `standard` preset，把 `dsh-tool-subagent` / `dsh-plan-mode` 行加进 `plugins` |
| 关掉某个工具 | 给对应行加 `disabled: true` |

## 验证与卸载

```sh
node tools/install.mjs --status      # junction / patch / bundle 三种登记状态
node tools/install.mjs --uninstall   # 撤掉两种登记与 junction
```

卸载后刷新页面，「写作」预设与它的技能会一起消失；已有会话不受影响。

## 文件结构

```
dsh-writing-preset/
├── cordis.patch.yml        # 预设声明（agent-preset 行 + 子插件列表）
├── skills/                 # 随包写作技能
│   ├── writing-workflow/SKILL.md
│   ├── chinese-editing/SKILL.md
│   ├── marketing-copy/SKILL.md
│   └── research-and-citation/SKILL.md
├── tools/install.mjs       # 安装 / 卸载 / 状态
├── package.json            # dsh.bundle.patch 元数据
├── README.md
└── LICENSE
```

## 设计说明

- **为什么用 preset 而不是改全局提示词**：preset 只影响选择它的会话，工具、提示词与技能一起生效，还能在设置页只读查看完整声明（`agentPresets/read`）。改全局 `system-prompt` 会把所有会话都变成写作模式。
- **技能目录表达式**：`skill-filesystem` 的 `bundledSkillDir` 通过 profile 的 node_modules 反查本包路径（`createRequire(baseUrl).resolve('dsh-writing-preset/package.json')`）。所以**必须保留安装器建立的 junction**，手动删掉它会让预设的技能行解析失败。
- **与内置 preset 一致的约定**：patching 语义、`disabled` 的 `!!js` 平台条件、compaction 隔离组都与官方 `presets/standard.patch.yml` 保持同构，升级 DSH 时不容易漂移。

## 已知限制

- 现有 Agent 保留创建时的 preset；改装/重装只影响之后创建的会话。
- 预设不是安全沙箱：它声明的插件在宿主进程里运行。
- 写作技能是模型指引，不是硬性校验；事实核查仍依赖模型的检索与判断。
- 若 DSH 升级后 `web_search` / office 技能等能力改名，需要同步调整 `cordis.patch.yml` 中对应行。

## License

MIT
