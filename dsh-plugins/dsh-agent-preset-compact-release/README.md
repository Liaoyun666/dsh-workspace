# dsh-agent-preset-compact 0.1.0

独立、预构建的 Web 客户端插件，目标是把原生 Agent preset 菜单收敛为紧凑布局：双列、短说明、暗/亮主题适配，同时保留原生选中、键盘导航与滚动。Host 入口是 no-op，不新增服务或 UI bundling 依赖。

只改变 preset 菜单展示；不更改 core、permissions、defaults、provider、模型或用户预设配置。实际紧凑效果及兼容性以 [UI 说明](<./docs/ui.md>) 和 UI 执行者验证为准；**已安全安装真实 desktop profile，现有服务 graph/script 加载已验，当前打开 GUI 刷新/视觉未自动验**。详见 [实际安装记录](<./docs/installed.md>)。

## 显式 profile 安装

在本包目录运行，使用本机 Node 24.21.0 的完整路径。status/install 已对以下真实 profile 执行并验证幂等；卸载命令仅供以后明确需要时使用，本次保留安装：

```powershell
& "C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" tools/install.mjs --profile-dir "C:/Users/user/.dsh/profiles/desktop" --status
& "C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" tools/install.mjs --profile-dir "C:/Users/user/.dsh/profiles/desktop" --install
& "C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" tools/install.mjs --profile-dir "C:/Users/user/.dsh/profiles/desktop" --uninstall
```

省略动作默认为只读 `--status`；必须显式提供绝对 profile 路径。安装器不会自动发现或写入另一个 profile，不运行 package manager，不启动或重启服务器。

安装仅创建指向 **E:/工作区/dsh-agent-preset-compact-release** 的 profile node_modules 链接及一个自有 BEGIN/END v1 登记块；保留原 patch 字节及用户后加编辑。卸载只移除有证明的自有登记/链接/收据；同目标预存在链接保留。每次有 patch 写入前生成独立备份，备份不自动删除。

现有 `http://127.0.0.1:59809` 的服务端 graph 已出现唯一 package id `dsh-agent-preset-compact`（loader patch id 为 `agent-preset-compact`），script HTTP 200 且审查源码哈希匹配；本次未 restart。当前已打开页面需由用户刷新并只打开菜单目视验证，**尚未自动验收实际 GUI，不承诺以后刷新即可加载或无需 restart**；若 graph 未发现插件，停止并按 [安装安全说明](<./docs/install.md>) 诊断，不擅自改 core 或重启。

## 验证

```powershell
& "C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" --check lib/index.js
& "C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" --check lib/client.js
& "C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" --check tools/install.mjs
& "C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" --test test/install.test.mjs
```

测试的全部 profile 写入仅位于 `test/install-fixtures`，不触碰真实 profile 或 UI artifacts。发布 `files` 仅包含 lib、安装器、必要 vendor 与 license、cordis patch、README 和 docs；不带测试、浏览器、profile。YAML parser 使用 [本机提取的 js-yaml](<./tools/vendor/PROVENANCE.md>)，没有 registry 运行依赖。
