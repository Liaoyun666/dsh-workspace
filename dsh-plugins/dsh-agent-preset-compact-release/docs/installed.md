# 本机实际安装记录

## 安装事实与当前页面

- 实际安装核验时间：2026-10-23 20:41:57–20:42:17 +08:00（Asia/Shanghai）。
- 包：dsh-agent-preset-compact 0.1.0；发布根：[release](<E:/工作区/dsh-plugins/dsh-agent-preset-compact-release>)。
- 真实 profile：[desktop](<C:/Users/user/.dsh/profiles/desktop>)；现有 GUI：<http://127.0.0.1:59809>。
- 监听地址 127.0.0.1:59809，安装前后 PID 均为 3560，命令行只核验 desktop profile 元数据，不输出启动参数。
- 首次安装 changed=true；后续 status installed=true、patchManaged=true；重复安装 changed=false。保留安装，未卸载、启动新服务或重启。
- **服务端loaded已验，当前打开页面刷新/视觉未自动验。** 无可复用的现有 CDP 端口；其他进程的 CDP pipe 未复用。无凭证 GET 根页 HTTP 401，未绕过认证或读取 boot/auth、Cookies、Login Data。

## 实际验证

- Node v24.21.0；三个发布源码语法检查 exit 0；隔离安装器回归 tests 22 / pass 22 / fail 0。
- [client.js](<../lib/client.js>) 9934 bytes，SHA-256 `9b2409c995df1074efffea89069fcceb16c32036648cad5b29dd7b9e098924fa`，与审查值完全相同。
- `/plugins/events` HTTP 200：安装前目标 count=0，安装后 count=1；唯一 package id `dsh-agent-preset-compact`，rev `41f908a0c716`，url `plugins/??dsh-agent-preset-compact/client.js&rev=41f908a0c716`。platform/dependencies 未出现在目标条目，不补造值。loader patch id 为 `agent-preset-compact`。
- 目标 script HTTP 200、10015 bytes；含 package id/factory。服务器附加 81 bytes，因此整个 HTTP body SHA 不等于 client 文件 SHA；前 9934 bytes 与审查源文件逐字节相同，提取后 SHA-256 匹配上值。graph rev 并非 client SHA 标记，未为迎合验证修改 client。
- 两次 status 快照无变化；重复 install 快照无变化。自有 BEGIN/END/id/name 各唯一一次，exact block 匹配；junction 解析到发布根；无自有 lock/temp 残留。
- 原 patch 和去掉自有块后的 patch 均为 24630 bytes，SHA-256 `2c661c7da85a303fcc6d979a43633c53f1bc87f6e0a20939eb7d3ff468f5a9ae`。敏感备份 hash/bytes 同原始值。
- profile manifest 始终 997 bytes，SHA-256 `c4128a86538831ea19c78a59fe3b370163a34fcdb6c38a365bdacc3fff356398`，安装器未写 manifest。
- 全阶段证据仅含 hashes、bytes、目标元数据、状态与命令输出：[installation-result.json](<../test/artifacts/installation-result.json>)，不含 config/receipt/boot/credential 全文。

## UI 尺寸：既有 production native Menu fixture，不是当前 GUI 实测

既有 fixture 为 PASS ALL BROWSER ACCEPTANCE，本单未重跑浏览器或冒称真实 GUI：

| Viewport | 菜单宽×高 | top | 列数 |
| --- | --- | --- | --- |
| 1000×700 compact | 420×316 | 12 | 2 |
| 540×550 compact | 420×316 | 12 | 1 |
| 560×550 compact | 420×316 | 12 | 2 |
| 320×240，clearance 42 | 296×162 | 62 | 1 |

尺寸来源：[UI 说明](<./ui.md#L56-L70>) 与 [browser-result.json](<../test/artifacts/browser-result.json>)。真实 graph/script 加载通过只证明服务端已提供此客户端，不证明现有已打开页面完成 mount 或视觉效果。

## 已观察边界与风险

- 安装及重复安装完成时，profile 顶层/模块外来条目 hash 均不变。随后读取真实 graph 后，[cordis.yml](<C:/Users/user/.dsh/profiles/desktop/cordis.yml>) 从 66060 bytes / `7e5e11453fb384b90038cf8d29135b901d0aa2870d3bc867c8867cc96ab61336` 变为 66120 bytes / `e16f8548562c5f37cfdd4b849a90e75f1f3aadbee723922598b099bd094d65ac`。本执行者/安装器未写该文件，可能为运行中服务物化 patch；因禁止读取全文，归因未核验。已记录而未回滚未知外来变更，不能声称整个 profile 最终字节未变化。
- patch、manifest、receipt 及自身 junction 在最终快照仍与安装后相同。没有 core、权限、defaults 或用户预设直接写入；不修改旧工作目录，不新增 manifest 登记，不打包。
- [install.md](<./install.md#L61-L63>) / [ui.md](<./ui.md#L81-L83>) 的未安装措辞是前一阶段历史，本记录说明本次实际安装；保留原文作为审查阶段边界。

## 本地备份、卸载与刷新指引

敏感备份：[安装前 patch 备份](<C:/Users/user/.dsh/profiles/desktop/cordis.patch.yml.bak-dsh-agent-preset-compact-ce8938d4-7cec-49f7-94eb-e67dddc64e3f>)。备份和收据含配置，仅本地保留，不上传/打印。

以后确需卸载时，在发布目录运行（本单未执行）：

```powershell
& "C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" tools/install.mjs --profile-dir "C:/Users/user/.dsh/profiles/desktop" --uninstall
```

当前已登录窗口刷新 <http://127.0.0.1:59809> 后，可只打开 Agent preset 菜单，不选择预设、不发送消息、不新建会话；目视核验紧凑布局。如未出现，先查当前页面加载状态并记录，不自动重启、不追加 manifests、不绕过认证。安全恢复与原生 API 限制继续遵循 [安装安全](<./install.md>) 和 [UI 约束](<./ui.md>)。
