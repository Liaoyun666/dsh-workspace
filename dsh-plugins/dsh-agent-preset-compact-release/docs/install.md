# 安装安全与恢复

## 写入范围

必须 `--profile-dir "ABSOLUTE_PATH"`。默认 `--status` 只读，甚至不创建锁、目录、备份或收据。`--install` / `--uninstall` 只处理指定 profile 的：

- `node_modules/dsh-agent-preset-compact` 指向新发布根的链接；只卸载收据证明由安装器创建且 inode 身份仍相同的链接。
- `cordis.patch.yml` 中唯一、独立成行的自有 BEGIN/END v1 块。
- `.dsh-agent-preset-compact.json` 收据；含原始 patch 的 UTF-8 内容与 dev/ino/birthtimeNs 身份，严格校验类型、完整字段集合、精确 block/replace 和 linkCreated/patchExisted 布尔值。
- `.dsh-agent-preset-compact.lock` 互斥锁以及唯一临时文件/只增备份。

收据包含原 patch 全文，可能包含敏感配置：不要上传、粘贴或共享收据/备份。CLI 不输出 patch、manifest 或 provider credentials。没有 chmod/ACL、更改默认权限、配置序列化、安装依赖、服务器启动或重启。

## 安装、卸载与冲突

重装/重卸载幂等。原 patch 使用真实 js-yaml 验证为单个顶层 sequence；缺失、空白、注释、明确 `[]` 占位符均支持。`[]` 整行（含注释/CRLF）精确保留用于回退；只有明确 `[]` 允许替换。普通内容追加精确自有块，不重写 YAML；无 final newline 仅加一个自有分隔换行。`!!js` 的布尔表达式、scalar、folded scalar 作为惰性字符串读入，绝不 eval；`!!js/function` 等未知 tag 拒绝。

显式 `---` / `...` 边界、多个 document、mapping、parse failure、外部同 id/name、manifest dependencies/受支持 bundles 登记、自有 marker 重复/内联/被改、非法收据、实体或外来链接均拒绝。安装之后在块外新增同 id/name 也会使 status、install、uninstall 全部拒绝，必须先人工消解冲突。外部编辑不被错误当作幂等成功。

每次 patch 写入前生成 `cordis.patch.yml.bak-dsh-agent-preset-compact-UUID`。卸载仅移除自有 exact block，把原 `[]` 恢复，其他安装后新增编辑保留。若原文件不存在且移除后为空，才删除 patch。预存在同目标链接保留。首次创建的空 node_modules 目录留存，避免删用户后加内容；备份也留存。

## 锁与中断恢复

写动作使用 `wx` 互斥锁，内容包含 PID/action/token。锁已存在就拒绝，**绝不自动判 stale 或删除别人的锁**。正常退出只删除身份与内容仍匹配的本次锁。

遇到锁报错，先停止其他安装动作；在 PowerShell 中查看锁和 PID（锁本身不含配置）：

```powershell
$profile = "C:/Users/user/.dsh/profiles/desktop"
$lockPath = Join-Path $profile ".dsh-agent-preset-compact.lock"
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
```

PID 可能重用：进程不存在还需确认没有其他 installer 正在运行，路径确为指定 profile，本次锁内容未变化并保存副本后，才人工执行：

```powershell
Remove-Item -LiteralPath $lockPath
& "C:/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" tools/install.mjs --profile-dir $profile --status
```

事务先写 `pending-install` / `pending-uninstall` 收据，再进行链接/patch 变更，最后提交 `installed` 或删除收据。可捕获的失败逐项回滚，且仅当当前仍为本次写入值和身份才恢复；后来编辑被保留。回滚后的正常状态可直接重试原动作。

进程被强杀、断电或回滚遭并发改动可能留下 pending 收据、unowned block、missing/replaced link。此时安装器**明确拒绝自动推断 ownership**，不提供 `--force`。恢复步骤：

1. 先解决锁；保存当前 patch、收据、备份、链接状态到独立人工备份位置，不输出/共享其配置。
2. 在本地检查收据的 original、state、block、replace、linkCreated、linkIdentity。对照备份判断中断阶段；不要全文件覆盖当前 patch，否则会丢后来编辑。
3. 人工选择回退：只移除收据中的唯一 exact block（独立 marker、完全未改），在原位放回受限 `replace`；保留块外编辑。如果 block 被改/重复/原始数据不可信，停止，交给 lead 审查。original 缺失且剩余为空才可移除 patch。
4. 仅当 linkCreated=true 且 lstat dev/ino/birthtimeNs 与收据完全相符、readlink 仍为新发布根时，才人工移除该链接。缺少 linkIdentity 或身份改变时**不能自动删链接**，按未知所有权处理，保留并审查。同目标预存在链接始终保留。
5. 完成上述人工回退、确认不存在自有 block 后，将收据移到人工备份位置（不是编辑字段让其通过校验）。对于未能确认的 link 保留，后续可作为同目标预存在 link 安装；外来链接先由所有者处理。临时 `*.tmp-UUID` 文件先核对来自本次事务再手动清理。
6. 再执行上面 `--status` 命令；若返回 installed=false 且无冲突，再重试 `--install`。任何拒绝都停止，不绕过检查。

这套恢复不自动覆盖用户 later edits，也不声称强杀后仍会全自动恢复。收据/备份可能包含配置，必须仅本地处理。

## 并发和原子性边界

快照含内容及文件身份；temp 用 wx，提交前再次核对 patch、receipt、link、node_modules 和 manifest。每次 unlink 立即复核目标；回滚同样只恢复本次 own 值/身份。锁只协调本安装器，不阻止编辑器/其他进程。

**不是完整 OS compare-and-swap**：最后一次 check 与 rename/unlink 之间仍有残余竞争窗口。其他进程可在窗口中替换目标；多个文件也不是同一原子事务。请不要在安装/卸载同时编辑 profile。rename 提供单文件提交，不提供跨文件或掉电事务保证；未执行 fsync。发现异常按上文保存证据并人工恢复。

## 本阶段验收边界

安装器测试全部写在新包 `test/install-fixtures`。未对 `C:/Users/user/.dsh/profiles/desktop` 安装、卸载、锁、重启或改配置。真实 GUI 地址 `http://127.0.0.1:59809` 的 graph 加载与 UI 效果应由 lead 审查后另单授权验证；不把隔离测试通过称为真实 GUI 通过。
