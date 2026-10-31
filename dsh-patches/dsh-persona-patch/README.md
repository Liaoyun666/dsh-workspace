# dsh-persona-dafeiyu 补丁：一键停用 / 启用全部人设

适用于 **dsh-persona-dafeiyu 0.6.0**。保留新版的工作区 / 会话选择、导入导出和原生全局开关，在「当前生效」卡片下增加「一键停用全部 / 一键启用全部」。

## 行为

- `set-all-enabled(false)`：把目录中所有人设写入 `store.disabled`，同时设置 `store.current = null`，关闭全局兜底；不会删除工作区 / 会话选择。
- `set-all-enabled(true)`：清空 `store.disabled`，恢复 `store.current = 'dafeiyu'`。
- `set-enabled` 仍兼容 `id: "all"` / `"*"`，行为与上面一致。
- 中文 / 英文界面都有批量按钮和说明；已处于目标状态时按钮禁用。

## 目录与恢复

- `original/`：0.5.0 原版备份；`original/*-0.4.1.js` 为更老版本留档。
- `patched/`：基于 0.6.0 的完整补丁文件。
- `apply.ps1` / `apply.cmd`：重打到 desktop profile，版本不是 0.6.0 时默认拒绝。
- `test-mutate.mjs`：使用临时 `DSH_HOME`，不碰真实人设库。

恢复命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\工作区\dsh-patches\dsh-persona-patch\apply.ps1"
```

宿主侧重载插件，浏览器刷新页面。状态保存在 `C:/Users/user\.dsh\storages\dsh-persona-dafeiyu\personas.json`。

## 测试

```powershell
& "C:/Users/user\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "E:\工作区\dsh-patches\dsh-persona-patch\test-mutate.mjs"
```

应输出 15 条 PASS，包括全局启停、落盘回读、工作区选择保留、`id:"all"/"*"` 兼容、单项恢复和未知动作报错。
