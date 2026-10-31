# Antigravity 简体中文插件（antigravity-zh-cn）

给 Google Antigravity 2.24.0 增加简体中文界面，并让内置智能体默认使用中文交流。

## 已安装内容

| 项目 | 路径 |
| --- | --- |
| 插件目录 | `C:/Users/user\\.gemini\\config\\plugins\\antigravity-zh-cn\\` |
| 配置开关 | `C:/Users/user\\.gemini\\config\\config.json` 中的 `plugins.antigravity-zh-cn` 与 `sidecars["antigravity-zh-cn/zh-cn-ui"]` |
| 运行数据/日志 | `C:/Users/user\\.gemini\\antigravity\\sidecar_data\\antigravity-zh-cn\\zh-cn-ui\\` |

## 工作原理

Antigravity 的界面是一个本地 Web 应用（由 `language_server.exe` 通过 `https://127.0.0.1:<随机端口>` 提供）。
插件包含一个由 Antigravity 托管的 **Sidecar**（`sidecars/zh-cn-ui`）：

1. 读取 `%APPDATA%\\Antigravity\\DevToolsActivePort`，拿到内置 Chromium 的调试端口；
2. 通过 CDP 连接界面页面，注入 `translator.js`；
3. 翻译脚本按词典 `translations.json` 翻译文本节点与 `placeholder/aria-label/title/alt`，并用 `MutationObserver` 持续翻译新渲染的内容；
4. 通过 `Page.addScriptToEvaluateOnNewDocument` 保证页面重载后依然生效；
5. 应用重启后 Sidecar 自动重启，无需手动操作。

另外插件还带一个始终生效的规则 `rules/AGENTS.md`，要求智能体用简体中文回复。

## 启用 / 停用 / 卸载

- **停用**：设置 → 自定义 → 停用「简体中文界面」，或在 `config.json` 中把
  `plugins.antigravity-zh-cn.enabled` 与 `sidecars["antigravity-zh-cn/zh-cn-ui"].enabled` 改为 `false`，重启应用。
- **卸载**：删除插件目录 `~\\.gemini\\config\\plugins\\antigravity-zh-cn`，并删除 `config.json` 中对应的 `plugins` / `sidecars` 条目；重启应用。
- **补充翻译**：编辑 `sidecars/zh-cn-ui/translations.json`（英文 → 中文），然后重启应用；
  动态文本（带数字/模型名等）在 `sidecars/zh-cn-ui/translator.js` 的 `PATTERNS` 中添加正则。

## 已知限制

- 翻译只作用于 HTML 界面；极少数内嵌 iframe（如第三方页面）与 AI 生成的对话内容不会翻译。
- Antigravity 升级后若新增界面文案，未收录的文案会保持英文，可按上面的方法补充词典。
- 应用会为 Sidecar 自动创建一个内部项目条目（名称 `antigravity-zh-cn/zh-cn-ui`），属于正常现象。
