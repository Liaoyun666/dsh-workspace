# dsh-relay-think

> 给 DSH 的**中转站（llm-pi-ai）模型**加一个「思考强度」开关：在 Models 页为每个模型声明
> 可用档位（低/中/高/极高…），随后输入框的模型菜单里就会出现真正的思考强度子菜单；
> 输入框右侧还会多一个「思考 · 高」小胶囊，随时切换当前会话的档位。

DSH 的 Models 设置页**刻意不提供推理强度编辑**——它是逐模型能力，一个提供商下的模型可能
各自支持不同档位。而中转站模型（手写进 `llm-pi-ai` 的自定义路由）默认没有
`reasoningEfforts` 声明，模型选择器里就只有模型、没有档位。这个插件把这块补上：

```
Models 页的中转站卡片
  └─ 思考强度（逐模型下拉：不声明 / 两档 / 常用三档 / 四档 / 全档 / 非推理）
       │  写入 llm-pi-ai 的 providers.<route>.models[].reasoningEfforts
       ▼
DSH 热重载 llm-pi-ai → 模型目录出现推理档位
       ▼
输入框模型菜单的「思考强度」子菜单 + 右侧「思考 · 高」胶囊
```

## 它不会做什么

- **不代理请求、不改协议、不读取模型输出**：插件只写配置，真正的思考参数由
  `@deepseek-ai/dsh-llm-pi-ai` 在发请求时按 `reasoningEfforts` 的线缆拼写发送。
- **不碰 API Key、不碰 baseURL**：写入只经过宿主的 `settings.mutate` seam（与 Models 页同一条路），
  并复用宿主自己的 schema 校验、revision 冲突检测与 profile patch 持久化。
- **不落盘自有状态**：界面读的是宿主设置与模型目录的实时快照。

## 界面

### 1. Models → 中转站提供商卡片 →「思考强度」

每个中转站卡片多一块可折叠面板：

| 控件 | 作用 |
| --- | --- |
| 每个模型的档位下拉 | 声明该模型可选的思考档位；选择「不声明」即清除 |
| 默认档位下拉 | 写入 `providers.<route>.reasoning`，模型选择器打开时预选这一档 |
| 状态行 | 展示「已声明档位 / 目录实际生效 / 等待刷新 / 非推理」 |

预设（线缆拼写与 `reasoningEfforts` 完全同构）：

| 预设 | 写入值 |
| --- | --- |
| 两档（低/高） | `{off: null, low: low, high: high}` |
| 常用三档（低/中/高） | `{off: null, low: low, medium: medium, high: high}` |
| 四档（极简/低/中/高） | `{off: null, minimal: minimal, low: low, medium: medium, high: high}` |
| 全档（极简…最高） | 再加 `xhigh: xhigh, max: max` |
| 声明为非推理模型 | `reasoningEfforts: false` |

`off: null` 的含义是「不发送思考参数，交给中转站默认行为」；其余键的值就是发给中转站的
线缆拼写。如果你的中转站用的是非标准拼写，可以在 `cordis.patch.yml` 里手写
`reasoningEfforts`，插件会把它识别为「自定义（保持现状）」并在清除时原样保留其他字段。

### 2. 输入框右侧「思考 · 高」胶囊

只对**当前模型确实有档位**时出现。点开列出该模型支持的档位与「默认」，选择后立即用宿主的
`session.selectModel` 切换当前会话，效果与模型菜单里的档位子菜单相同。

## 安装

```sh
# 默认安装到 desktop profile（若不存在则 web）；自动写 profile patch + node_modules 软链
node tools/install.mjs

# 指定 profile
node tools/install.mjs web

# bundle 方式（等价于 dsh plugin --profile <p> add link:<本包>，需重启 dsh）
node tools/install.mjs desktop --bundle

# 看现状 / 卸载
node tools/install.mjs --status
node tools/install.mjs --uninstall
```

安装器做的事：

1. 在 `$DSH_HOME/profiles/<profile>/node_modules/` 放一个指向本包的软链（Loader 靠它解析包名）；
2. 在 profile 的 `cordis.patch.yml` 追加一段托管块（`id: relay-think`），或写 bundle 清单；
3. 改文件前留一份 `*.bak-dsh-relay-think`，写 patch 时用临时文件 + 原子改名，避免运行中的 dsh 读到半截 YAML。

生效方式：

- **profile patch 热重载**的部署：装配行会热加载；浏览器刷新一次页面即可看到界面。
- 宿主半（`lib/index.js`）的代码改动**不在** HMR 的模块监听范围内，改代码后需要重启一次 dsh；
  浏览器半（`lib/client.js`）刷新页面即可。

## 配置

在 profile 自己的 `cordis.patch.yml` 里按行 id 覆写：

```yaml
- id: relay-think
  config:
    settingsNs: llm-pi-ai   # 要编辑的设置命名空间（默认就是 llm-pi-ai）
```

如果你的 profile 把 `llm-pi-ai` 那一行的 id 改成了别的名字，把这里同步改掉即可。

## 接口

宿主半提供两条 JSON 路由（与官方插件一样先过 connection 的信任围栏：Host/Origin + 浏览器登录 cookie）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/relay-think/state` | 当前命名空间、revision、预设、每条路由与模型（配置声明 + 目录实际档位） |
| POST | `/relay-think/apply` | `{operation, provider, model?, preset?, levels?, effort?, expectedRevision?}` |

`POST` 的 `operation` 为 `levels`（声明/清除某模型）或 `defaultEffort`（路由默认档位）；
`expectedRevision` 来自 `GET state`，用于并发写入的 409 冲突检测。

## 故障排查

| 现象 | 排查 |
| --- | --- |
| Models 页没有「思考强度」 | 确认 profile 里 `llm-pi-ai` 行是激活的；确认 `settingsNs` 与那一行的 id 一致 |
| 面板里某模型不可编辑 | 该提供商不在本 profile 的用户配置层（例如来自 home patch/命令行覆盖），无法安全写回 |
| 声明后模型菜单仍无档位 | 看面板状态行是否「已写入，等待目录刷新」；确认模型在该路由的 `models` 列表（或目录）里；必要时重启 dsh |
| 发请求报 unsupported reasoning effort / 400 | 中转站不支持声明的线缆拼写：换「两档（低/高）」或手写 `reasoningEfforts` 自定义拼写 |
| 胶囊不出现 | 当前模型没有声明档位（目录里 `reasoning` 为空）；先到 Models 页声明 |

## 开发

```sh
# 用 DSH 自带的 node 跑（本机路径示例）
& 'E:\Deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' --test test/plan.test.mjs
& 'E:\Deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' --test test/client.test.mjs
```

- `lib/plan.js` 纯逻辑（预设、声明校验、配置路径规划），`test/plan.test.mjs` 覆盖；
- `lib/index.js` 宿主半（`/state`、`/apply`、index 注入）；
- `lib/client.js` 浏览器半（`settings.models.provider-card`、`conversation.input.right`），
  `test/client.test.mjs` 用桩验证模块能装载并注册两个界面席位。

运行时依赖为零：宿主半只用 `node:` 内建能力，浏览器半只用平台种子模块 `react` / `react-dom`。

## License

MIT
