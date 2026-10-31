# DSH 插件精选清单

> 数据快照：2026-10-18。口径：GitHub ★ 为仓库星标，下载量为 npm 近 30 天下载次数（来自 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 目录，共 5,786 个插件；[dshbase](https://dshbase.com/zh/plugins/) 目录另有 19,992 个）。
> 星标按「仓库」计，所以一个仓库拆多个包时会共享星数（例如 `@linxin666/*` 系列都显示 8.9k）；**下载量比星标更能反映真实使用量**。
> 你当前是桌面应用 `desktop` profile，安装统一用：
> `dsh plugin --profile desktop add <包名>`，装完刷新/重启应用生效；或直接在应用内「插件管理」页搜包名安装。

## 0. 先装「插件市场」入口（之后都在 UI 里点装）

| 插件 | 仓库 | ★ | 30天下载 | 说明 |
|---|---|---|---|---|
| `dshmarket` | [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) | 6.8k | 55.8万 | 设置页内的插件市场：搜索、分类、一键安装/更新/启停、主题商店。**全站下载量第二，装它最省事** |
| `dsh-find-plugin` | [awesome-dsh-plugin/dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin) | 188 | 2.5万 | 让 agent 在对话里按关键词/分类搜插件目录并给出安装命令 |

## 1. 上下文与会话（省 token 最见效）

| 插件 | 仓库 | ★ | 30天下载 | 说明 |
|---|---|---|---|---|
| `billion-context` | [ranxianglei/billion-context](https://github.com/ranxianglei/billion-context) | 1.7k | **134.9万** | 上下文压缩：100K 上下文就够用，长会话约省 5× token，支持超长单会话。**全站下载量第一** |
| `dsh-context` | [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context) | 2.3k | 14.7万 | 上下文洞察面板：仪表盘 + `/context` 命令 + 上下文浏览器，看清构成、管理生命周期 |
| `@michengai/dsh-archive-manager` | [MichengAI/dsh-archive-manager](https://github.com/MichengAI/dsh-archive-manager) | 162 | 17.7万 | 设置页里的归档会话管理：按工作区搜索、恢复、删除 |
| `@michengai/dsh-btw` | [MichengAI/dsh-btw](https://github.com/MichengAI/dsh-btw) | 19 | 8.9万 | `/btw` 旁问：问一句不打断主任务、不执行工具，答案独立气泡可复制收起 |
| `@michengai/dsh-simplify` | [MichengAI/dsh-simplify](https://github.com/MichengAI/dsh-simplify) | 8 | 7.9万 | `/simplify`：在指定 Git 变更范围（暂存区/提交/未跟踪文件）内让 agent 简化代码 |

## 2. 界面 / 侧边栏（提效最直观）

| 插件 | 仓库 | ★ | 30天下载 | 说明 |
|---|---|---|---|---|
| `dsh-better-sidebar` | [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 4.3k | 20.7万 | 全能侧边栏底座：文件渲染/编辑、终端、Git、子代理面板，第三方插件还能注册新标签页 |
| `@michengai/dsh-codex-ui` | [MichengAI/dsh-codex-ui](https://github.com/MichengAI/dsh-codex-ui) | 167 | 25.9万 | 把 Web 侧栏/工作区树/全局搜索/轮次导航改成 Codex 风格的布局 |
| `@linxin666/dsh-client-ui-task-board` | [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) | 8.9k | 12.8万 | 多列看板：每张卡片就是一个真实 DSH 会话，支持 cron 定时 |
| `@linxin666/dsh-client-ui-git-graph` | [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) | 8.9k | 12.0万 | 对话头部直接切分支 + 分支车道/提交图 |
| `@linxin666/dsh-client-ui-skill-explorer` | [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) | 8.9k | 14.2万 | 技能中心：按来源分组浏览已加载 skills、启停模型调用、新建/删除 |

## 3. 成本 / 余额 / 用量

| 插件 | 仓库 | ★ | 30天下载 | 说明 |
|---|---|---|---|---|
| `dsh-cost-meter` | [Han-1413141/dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) | 445 | 10.2万 | 每会话/每日 API 成本、预算与用量%、官方余额、历史面板、一键同步官方价格（含峰谷价） |
| `dsh-whale-widget` | [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) | 5.1k | 18.6万 | 右下角余额小鲸鱼挂件：余额、今日用量、每轮成本，可拖拽吸附、数字滚动 |

## 4. 模型能力扩展（视觉 / 浏览器 / 搜索）

| 插件 | 仓库 | ★ | 30天下载 | 说明 |
|---|---|---|---|---|
| `@liustack/modlens` | [liustack/modlens](https://github.com/liustack/modlens) | 4.3k | 9.4万 | 给纯文本模型加视觉：贴图 → 结构化 JSON 证据（OCR/版面/语义） |
| `@wxg-prc-cpg/browser-skill-dsh-plugin` | [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) | 9.1k | 2.7万 | 让 agent 操控你**真实已登录**的 Chrome/Edge，带可访问性与页面结构观察 |
| `dsh-free-search` | [DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search) | 467 | 4.6万 | 免 key 多引擎搜索（DuckDuckGo/Bing/SearXNG，另接 Exa/Perplexity/DeepSeek 需 key） |

## 5. 记忆（长期项目记忆）

| 插件 | 仓库 | ★ | 30天下载 | 说明 |
|---|---|---|---|---|
| `@openviking/dsh-memory-plugin` | [volcengine/OpenViking](https://github.com/volcengine/OpenViking) | 40.2k | 3.8万 | 记忆+上下文 bundle：pre-step 自动召回、用户画像注入、会话捕获、`viking://` 资源守卫 |
| `@vectorize-io/hindsight-coding-agents` | [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) | 50.9k | 5.6万 | 会学习的长期记忆：自动 recall/retain、知识页、深度反思、按仓库记忆库 |

> 这两个是「大生态集成」，依赖各自后端服务/账号（本地或云端），装前先看 README，不是纯本地小插件。

## 6. 自动化 / 远程 / 集成

| 插件 | 仓库 | ★ | 30天下载 | 说明 |
|---|---|---|---|---|
| `@michengai/dsh-automation` | [MichengAI/dsh-automation](https://github.com/MichengAI/dsh-automation) | 29 | 11.5万 | 在隔离会话里定时跑编码任务，设置页或让 agent 自己管理 cron |
| `@michengai/dsh-im-connect` | [MichengAI/dsh-im-connect](https://github.com/MichengAI/dsh-im-connect) | 67 | 13.4万 | 微信/企业微信/钉钉/飞书/QQ/Telegram 接入，每个 IM 会话=独立工作区频道 |
| `@linxin666/dsh-remote-web-ui` | [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) | 8.8k | 12.9万 | 手机/另一台电脑远程操控 dsh 工作区：扫码配对、token 鉴权、SSE 实时同步 |
| `@linxin666/dsh-ssh` | [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) | 8.8k | 10.7万 | SSH 面板：Web 终端、SFTP 传输、本地端口转发、多主机批量执行 |

## 7. 开发 / 技能 / 子代理

| 插件 | 仓库 | ★ | 30天下载 | 说明 |
|---|---|---|---|---|
| `@michengai/dsh-skills-manager` | [MichengAI/dsh-skills-manager](https://github.com/MichengAI/dsh-skills-manager) | 194 | 20.6万 | 设置页管理本地 skills，共享 agent skills 只读展示 |
| `@michengai/dsh-agency-agents` | [MichengAI/dsh-agency-agents](https://github.com/MichengAI/dsh-agency-agents) | 138 | 15.1万 | 可召唤的领域专家子代理名册：子代理干活，主会话保留任务与最终答复 |
| `@michengai/dsh-code-review` | [MichengAI/dsh-code-review](https://github.com/MichengAI/dsh-code-review) | 10 | 6.5万 | `/review` 起独立子代理做代码评审，支持 `/review-status`、`/review-cancel` |

## 8. 工具与性能（本机已装）

| 插件 | 仓库 | ★ | 30天下载 | 说明 |
|---|---|---|---|---|
| `dsh-ops` ✅已装 | [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops) | 2.8k | 1.5万 | Windows 下用 Rust 工具集替代 bash/pwsh：输入输出更省 token、速度更快（安装阶段已升级为工具层） |
| `@deepseek-harness-tui/dsh-tui` | [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) | 4.8k | 4.3万 | 官方最推荐 TUI 插件：轻量终端界面、像素鲸鱼、鼠标支持（终端党用，桌面/Web 用户不需要） |

## 9. 趣味 / 外观

| 插件 | 仓库 | ★ | 30天下载 | 说明 |
|---|---|---|---|---|
| `dsh-pet` ✅已装 | [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | 1.5k | 5.3万 | 桌面宠物：百余套手绘动画、跟随会话状态、可下桌面、可 DIY 宠物 |
| `dsh-deep-whale--maid-atelier` | [Small-tailqwq/dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) | 2.7k | 4.1万 | 鲸鱼女仆皮肤系列 |
| `dsh-wallpaper-engine` | [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) | 1.5k | 5.0万 | 壁纸引擎；要求 DSH Desktop ≥2.0.7 与 `dsh-better-sidebar` ≥0.19.0 |

## 一键安装（挑几个先试）

```powershell
# 插件市场（装完在设置页里点装其它）
dsh plugin --profile desktop add dshmarket
# 上下文压缩 + 洞察
dsh plugin --profile desktop add billion-context
dsh plugin --profile desktop add dsh-context
# 侧边栏工作台
dsh plugin --profile desktop add dsh-better-sidebar
# 成本看板
dsh plugin --profile desktop add dsh-cost-meter
# 视觉桥
dsh plugin --profile desktop add @liustack/modlens
```

## 挑选建议

- **优先级**：`dshmarket`（入口）→ `billion-context` / `dsh-context`（省钱、看得见上下文）→ `dsh-better-sidebar` 或 `dsh-codex-ui`（界面）→ 再按需加成本/视觉/自动化。
- **看什么**：优先「有公开仓库 + 持续更新 + 有实测说明」的插件；下载量高但星少的多为实用小工具，星高但下载少的多为「大项目的一个集成」。
- **风险**：插件权限等同于 agent 权限（能读写文件、跑命令、发网络请求）。来路不明或长期不更新的插件不要装；装前先看仓库 README 与 npm 版本更新时间。
- **兼容性**：你当前 DSH 为 `0.2.1-rc.2`，部分插件强依赖特定版本（尤其主题/桌面类），装前确认兼容声明；装完让 profile 重载或重启应用生效。
