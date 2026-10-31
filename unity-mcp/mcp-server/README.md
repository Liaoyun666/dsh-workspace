# unity-mcp · Node 侧 MCP server

把 Unity 编辑器里的 DSH Bridge（本机 TCP、一行一个 JSON）包装成标准 MCP 工具，
供 DSH / 其他 MCP 客户端通过 stdio 调用。零第三方依赖，ESM，Node 22+。

## 目录

```
mcp-server/
  server.mjs            # MCP stdio server（唯一运行入口）
  test/mock-bridge.mjs  # 测试用 mock Unity 桥（随机端口 TCP）
  test/run-tests.mjs    # 端到端测试：spawn server.mjs + mock 桥，退出码表达结果
  README.md
```

## 环境要求

- Node.js ≥ 22（实测 v24.21.0）。不需要 `npm install`，没有 `package.json`，没有第三方依赖。
- Unity 编辑器，且工程里加载了 `unity-package` 提供的 DSH Bridge（默认监听 `127.0.0.1:6401`）。
- 协议细节（全部桥命令、参数、返回结构）以 `../docs/PROTOCOL.md` 为唯一权威。

## 启动

```
node E:\工作区\unity-mcp\mcp-server\server.mjs
```

MCP 客户端（stdio）配置示例，注意 Windows 路径在 JSON 里要写成双反斜杠：

```json
{
  "mcpServers": {
    "unity": {
      "command": "C:/Users/user\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe",
      "args": ["E:\\工作区\\unity-mcp\\mcp-server\\server.mjs"],
      "env": { "UNITY_DSH_PORT": "6401" }
    }
  }
}
```

启动后先调 `status`：返回 `{connected:true,...}` 说明 Unity 桥已就绪；返回 `{connected:false,error}` 说明 Unity
没开或桥没加载，可以接着调 `launch`。

## 传输与日志

- stdin：每行一个 JSON-RPC 2.0 请求（换行分隔，**不是** LSP 的 `Content-Length` 头）。
- stdout：每行一个 JSON-RPC 响应。**stdout 绝不输出日志**，否则客户端会断连。
- 日志：全部写 stderr，带 `[unity-dsh]` 前缀。
- 支持的方法：`initialize`、`notifications/initialized`（通知，不回包）、`ping`（回 `{}`）、
  `tools/list`、`tools/call`；未知方法回 `-32601`，无法解析的行回 `-32700`。
- `initialize` 的 `protocolVersion` 回显客户端请求的值，缺省或空串时回 `"2024-11-05"`；
  `capabilities` 为 `{tools:{}}`，`serverInfo` 为 `{name:"unity-dsh",version:"0.1.0"}`。
- `tools/call`：成功回 2 空格美化的 JSON 文本；失败回 `{content:[{type:"text",text:"..."}],isError:true}`。

## 配置

优先级：**环境变量 > config.json > 内置默认值**。

| 配置项 | 环境变量 | config.json 字段 | 默认值 |
| --- | --- | --- | --- |
| 桥端口 | `UNITY_DSH_PORT` | `port` | `6401` |
| 桥地址 | `UNITY_DSH_HOST` | `host` | `127.0.0.1` |
| Unity 工程 | `UNITY_DSH_PROJECT` | `projectPath` | `E:\Unity\DSHProject` |
| Unity 可执行文件 | `UNITY_DSH_UNITY_EXE` | `unityExe` | `E:\Unity\2019.4.15f1\Editor\Unity.exe` |
| 单条桥命令超时 | `UNITY_DSH_TIMEOUT_MS` | `timeoutMs` | `180000`（180s） |
| launch 等待上限 | `UNITY_DSH_LAUNCH_TIMEOUT_MS` | `launchTimeoutMs` | `120000`（120s） |
| config.json 路径 | `UNITY_DSH_CONFIG` | — | `<server.mjs 的上一级>/config.json` |

`config.json` 固定在 `E:\工作区\unity-mcp\config.json`（即 `server.mjs` 的上一级目录），示例：

```json
{
  "port": 6401,
  "projectPath": "E:\\Unity\\DSHProject",
  "unityExe": "E:\\Unity\\2019.4.15f1\\Editor\\Unity.exe"
}
```

## 工具清单（29 个）

| 工具名 | 桥命令 | 参数（详见 inputSchema / PROTOCOL.md） |
| --- | --- | --- |
| `status` | `ping` | 无。连不上不报错，返回 `{connected:false,error}` |
| `launch` | 本地实现 | 无。拉起 Unity 并等桥上线，见下文 |
| `project_info` | `project_info` | 无 |
| `scene_info` | `get_scene_info` | `limit`、`includeInactive` |
| `execute_code` | `execute_code` | `code`（必填，C# 方法体） |
| `create_primitive` | `create_primitive` | `type`（必填，Cube/Sphere/Cylinder/Capsule/Plane/Quad）、`name`、`position`、`rotation`、`scale`、`parent`、`material` |
| `create_empty` | `create_empty` | `name`、`position`、`parent` |
| `set_transform` | `set_transform` | `target`（必填）、`position`、`rotation`、`scale`、`worldSpace` |
| `delete_object` | `delete_object` | `target`（必填） |
| `duplicate_object` | `duplicate_object` | `target`（必填）、`name` |
| `add_component` | `add_component` | `target`（必填）、`component`（必填）、`properties` |
| `create_material` | `create_material` | `name`（必填）、`color`、`metallic`、`smoothness`、`emission`、`savePath` |
| `assign_material` | `assign_material` | `target`、`material`（必填） |
| `import_asset` | `import_asset` | `sourcePath`（必填）、`destinationFolder`、`instantiate`、`name` |
| `instantiate_prefab` | `instantiate_prefab` | `assetPath`（必填）、`position`、`name` |
| `screenshot` | `screenshot` | `path`（必填）、`width`、`height`、`view`（auto/game/scene）、`target` |
| `save_scene` | `save_scene` | `path` |
| `open_scene` | `open_scene` | `path`（必填） |
| `new_scene` | `new_scene` | `setup` |
| `menu` | `menu` | `path`（必填） |
| `logs` | `get_logs` | `count` |
| `clear_logs` | `clear_logs` | 无 |
| `selection` | `get_selection` | 无 |
| `select` | `select` | `target`（必填） |
| `undo` | `undo` | 无 |
| `redo` | `redo` | 无 |
| `play_mode` | `set_play_mode` | `playing` 或 `action`（play/stop/pause），二选一 |
| `asset_search` | `asset_search` | `query`（必填）、`type`（Model/Prefab/Material/Texture/Scene）、`limit` |
| `import_package` | `import_package` | `path`（必填） |

约定（来自 PROTOCOL.md）：

- `target` 接受层级路径 `"Parent/Child"`、唯一名称 `"Cube"`、instanceId 数字，Schema 用
  `anyOf: [{type:"string"},{type:"integer"}]` 表达。
- 向量一律长度 3 数组；`rotation` 是**欧拉角（度）**，不是四元数。
- 颜色用 `"#RRGGBB"` 或 `[r,g,b,a]`（0-1）。

## 测试

用全路径 node（PATH 里可能没有 node）：

```powershell
& "C:/Users/user\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "E:\工作区\unity-mcp\mcp-server\test\run-tests.mjs"; "ExitCode=$LASTEXITCODE"
```

测试架构：`mock-bridge.mjs` 在 `127.0.0.1` 随机端口起一个纯 Node TCP 服务（实现 `ping`、
`get_scene_info`、`execute_code`、`screenshot`、`get_logs`、`get_selection`、`set_play_mode`、
`project_info`，其他命令回 `Unknown command` 错误），`run-tests.mjs` 用 `child_process.spawn` 拉起
`server.mjs`，按 MCP 协议逐条发换行分隔的 JSON-RPC 并断言响应。

覆盖点（25 项）：

- `initialize` 协议版本回显 / 缺省回退 / `serverInfo` / `capabilities.tools`
- `notifications/initialized` 不回包；`ping` 返回 `{}`
- `tools/list` 返回 29 个工具、名称齐全、中文 description、object inputSchema
- 关键 schema：`create_primitive.type.enum`、`execute_code.required`、`set_transform.target.anyOf`、
  `play_mode` 的 `playing|action`、`screenshot.view`、`asset_search.type`、`add_component.properties`
- `status` / `scene_info` / `execute_code`（含多行代码不丢换行）/ `logs` / `selection` / `play_mode` 参数透传与命令映射
- `screenshot` 返回 `image` content（base64 可解出 PNG 魔数）、结果 JSON 为 2 空格美化
- 未知工具 → `isError:true`；未知方法 → `-32601`；坏 JSON 行 → `-32700`
- `launch`：桥已通 → `alreadyRunning`；exe 不存在 → 明确中文错误；等待超时 → `launched:true` /
  `connected:false` / 有 `pid` 与 `waitedMs`
- 配置：`config.json` 的 port 生效、环境变量覆盖 `config.json`
- 桥断开（mock 停掉）后：`status` 仍成功并给 `{connected:false,error}`，其他工具 `isError:true` 且中文提示带端口
- stdout 纯净性（无非 JSON 行、全部 `jsonrpc:"2.0"`、日志在 stderr）、stdin 关闭后退出码 0

实测（2026-10-29，Node v24.21.0）：

```
共 25 项：PASS 25，FAIL 0，用时 5.1s
结果：ALL PASS
退出码 0
```

## 实现说明与歧义处理

1. **协议版本**：`initialize` 的 `protocolVersion` 原样回显客户端值；为空时回 `"2024-11-05"`（任务要求）。
2. **传输格式**：按任务要求用换行分隔的 JSON-RPC 2.0，而不是 LSP 的 `Content-Length` 头。
   桥侧（TCP）同样是一行一个 JSON：每条命令新建连接、写一行、读一行、关闭。
3. **status 不报错**：`status` 单独处理——桥连不上时返回 `{connected:false, host, port, error}` 且不算
   `isError`；其余工具（含 `launch`）失败时一律 `isError:true` 并把桥的 `error` 原文透出（不二次包装）。
4. **launch 返回值**：`{launched, connected, alreadyRunning, pid, waitedMs, projectPath, message}`。
   TCP 已通时 `launched:false`、`alreadyRunning:true`；否则用 `spawn(unityExe, ["-projectPath", projectPath], {detached:true, stdio:"ignore"})`
   并每 2s 探测、最多 `launchTimeoutMs`；超时返回 `connected:false` 而不抛错（首次打开工程可能很慢，
   可用 `UNITY_DSH_LAUNCH_TIMEOUT_MS` 调大）；exe 不存在直接给明确错误。
5. **launch 的局限**：只负责「没桥就拉起进程」，不检测「已有 Unity 实例但桥没开」的情况（那种情况会再开一个实例）。
   建议先调 `status`，确有需要再 `launch`。
6. **screenshot 图片**：仅当桥返回的 `path` 对应文件真实存在时追加 `{type:"image",data:<base64>,mimeType:"image/png"}`；
   文件缺失时只回 JSON 文本并追加一行说明，不报错。
7. **set_transform 的「至少给一个」**：JSON Schema 里没有优雅写法，且桥自身会校验并返回错误，所以 Schema 只要求
   `target`，其余三者在 description 里说明（避免用 `oneOf` 把合法组合判成非法）。
8. **play_mode 二选一**：Schema 用 `anyOf: [{required:["playing"]},{required:["action"]}]` 表达；两个都给时以桥侧为准。
9. **inputSchema 里的参数名**：MCP 层工具名去掉了 `get_` / `set_` 前缀（`status/logs/selection/play_mode`），
   参数名与 PROTOCOL.md 完全一致，没有做 camelCase 转换。
10. **config.json 定位**：默认解析为 `server.mjs` 的上一级（`unity-mcp/config.json`），可用 `UNITY_DSH_CONFIG` 覆盖，
    便于测试与多工程切换。
11. **stdout 纯净**：所有诊断日志走 stderr；测试里专门断言 stdout 每一行都是合法 JSON-RPC。

## 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| `无法连接 Unity 桥 127.0.0.1:6401（ECONNREFUSED）` | Unity 没启动、工程没加载 DSH Bridge、或端口不一致；先 `status`，再 `launch` |
| `Unity 桥在 180 秒内没有响应` | 编辑器在编译 / Domain Reload / 弹窗阻塞；等编译完再试 |
| 客户端握手后立刻断连 | stdout 被日志污染；本实现已保证只写 stderr，若二次开发请勿用 `console.log` |
| `找不到 Unity 可执行文件` | 改 `config.json` 的 `unityExe` 或设 `UNITY_DSH_UNITY_EXE` |
| 工具返回桥的 C# 编译错误 | `execute_code` 编译失败时桥回 `status:"error"`，原文即编译器诊断 |
