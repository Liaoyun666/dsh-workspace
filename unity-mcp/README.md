# Unity DSH 桥

让 DSH 的 Agent 直接在 **Unity 编辑器**里建模：读场景、建物体、上材质、跑 C# 片段、截图。

## 本机现状（2026-10-29 已验证）

| 项 | 值 |
| --- | --- |
| Unity | 2019.4.15f1c1（中国版）装在 `E:\Unity\2019.4.15f1\Editor\Unity.exe` |
| 许可证 | Unity Personal，已通过 Unity Hub 登录激活；`C:\ProgramData\Unity\Unity_lic.ulf`（2026-10-29 18:05） |
| Unity Hub | 3.3.7，`C:\Program Files\Unity Hub\Unity Hub.exe` |
| 工程 | `E:\Unity\DSHProject`（空场景 + 桥包） |
| 桥包 | `Packages/com.dsh.unitybridge`，编辑期程序集 `DSHUnityBridge.Editor` |
| 桥端口 | `127.0.0.1:6401`，编辑器加载后**自动启动** |
| DSH 组件 | 本地组件 `unity-dsh`，serverName = `unity` → 工具前缀 `mcp__unity__` |
| 端到端测试 | `mcp-server/test/smoke.mjs` 全过（13/13，真 Unity） |

## 架构

```
DSH (mcp__unity__*)
  └─ Node stdio MCP server   mcp-server/server.mjs      （零依赖，换行 JSON-RPC）
       └─ TCP 127.0.0.1:6401 一行一个 JSON
            └─ Unity 编辑器 C# 桥  unity-package/Editor/DSHBridge.cs
                 └─ 主线程执行：场景/材质/截图/编译并运行 C# 片段
```

- 插件侧：`C:/Users/user\.dsh\data\dsh-work-components\local-components\unity-dsh\index.mjs`（DSH 本地组件，serverName = unity）
- 配置：`config.json`（端口、Unity 工程、Unity.exe 路径；Node 服务启动时读取）
- 协议：`docs/PROTOCOL.md`

## 一次性安装（本机已完成，重装才需要）

1. **装 Unity**

   ```powershell
   powershell -ExecutionPolicy Bypass -File E:\工作区\unity-mcp\tools\install-unity.ps1
   ```

2. **激活许可证（必须人工）**：装 Unity Hub → 登录 Unity ID → Hub 自动发 Personal 许可证。
   细节与坑见 `docs/activation.md`。

3. **建工程并装桥包**

   ```powershell
   powershell -ExecutionPolicy Bypass -File E:\工作区\unity-mcp\tools\setup-project.ps1
   ```

4. 打开 Unity 工程，菜单出现 **DSH / Unity Bridge**，底部状态栏可看「运行中 / 端口 6401」。

5. **启用 DSH 组件**：DSH 设置 → 工作组件 → 本地 → 「Unity（DSH 建模桥）」打开开关，重启 DSH。
   新会话里出现 `mcp__unity__*` 工具。（内置的 Coplay `unity` 组件保持关闭，避免同名冲突。）

## 日常使用

- 双击 `tools\open-unity.cmd` 打开 DSHProject，或 `"E:\Unity\2019.4.15f1\Editor\Unity.exe" -projectPath E:\Unity\DSHProject`。
- 桥随编辑器自动启动，不用手点菜单。
- DSH 里直接说：「用 Unity 建一艘 055 的 blockout：船体、上层建筑、主炮、雷达，红白材质，截个图」。
- 截图默认写到 `E:\Unity\DSHProject\DSH_Screenshots\`。

## 工具

```
mcp__unity__status           桥状态（Unity 没开/桥没启动会明确提示）
mcp__unity__launch           启动 Unity 并等桥就绪
mcp__unity__scene_info       场景层级 + 变换 + 组件
mcp__unity__execute_code     在编辑器里跑 C#（等价 object Run() { ... }）
mcp__unity__create_primitive 建 Cube/Sphere/Cylinder/Capsule/Plane/Quad
mcp__unity__create_empty     建空物体（分组用）
mcp__unity__set_transform    改位置/旋转/缩放
mcp__unity__duplicate_object / delete_object
mcp__unity__add_component    加组件并设属性
mcp__unity__create_material / assign_material
mcp__unity__import_asset     把外部 fbx/obj 复制进工程并实例化
mcp__unity__instantiate_prefab
mcp__unity__screenshot       渲染截图（自动取景）
mcp__unity__save_scene / open_scene / new_scene
mcp__unity__menu             执行编辑器菜单
mcp__unity__logs / clear_logs
mcp__unity__selection / select
mcp__unity__undo / redo
mcp__unity__play_mode
mcp__unity__asset_search
mcp__unity__import_package
```

## 排错

- **status: connected=false** — Unity 没开，或桥没启动（菜单 DSH/Unity Bridge），或端口被占（换端口要同步改 `config.json`）。
- **connect ECONNREFUSED** — 同上。
- **Unity Hub 一启动就退出 / `--help` 打出 node 的 usage** — 进程继承了 `ELECTRON_RUN_AS_NODE=1`（从 DSH 的 Electron 环境带下来的）。用 `tools\start-hub.cmd` 启动，或在干净 shell 里启动。
- **桥包脚本没编译（没有 `DSHUnityBridge.Editor.dll`、桥不监听）** — `Packages/` 里的散装脚本不会被编译，必须有 `Editor/DSHUnityBridge.Editor.asmdef`。已随包提供，别删。
- **execute_code 报 CS0433「类型同时存在于 UnityEngine.CoreModule 和 UnityEngine」** — 引用里同时有外观程序集和模块程序集；`DSHCodeRunner.CollectReferences()` 已自动去掉重复的 `UnityEngine.dll` / `UnityEditor.dll`。
- **编译失败** — error 是 csc 原始诊断（已加 `/utf8output`，中文不再乱码）；Unity 2019.4 只支持 C# 7.3，别写 C# 8+ 语法。
- **截图全黑** — 场景没有相机且对象不可见；给 `target` 让临时相机自动取景。
- **DSH 新会话没有 mcp__unity__ 工具** — 组件开关没开，或 DSH 没重启。

## 测试

```powershell
# 单元测试（mock 桥，不需要 Unity）
& 'C:/Users/user\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' E:\工作区\unity-mcp\mcp-server\test\run-tests.mjs

# 端到端（真 Unity + 真桥，需要编辑器开着）
& 'C:/Users/user\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' E:\工作区\unity-mcp\mcp-server\test\smoke.mjs
```
