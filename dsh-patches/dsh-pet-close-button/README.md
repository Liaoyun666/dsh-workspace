# dsh-pet 「关闭」按钮补丁

给 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 桌面桌宠的右键菜单加一个 **「关闭」** 项：
点击后**本次会话**退出插件（桌宠窗口关闭、插件卸载），**不写任何配置**；下次启动 DSH 时插件照常加载。

## 效果

右键桌面桌宠 → 菜单最后一项：

```
打开 DeepSeek Harness
查看余额
碎碎念
对话
回到初始位置
重载配置
关闭          ← 新增
动作 ▸ …
```

点击「关闭」后（实测）：

- 桌面宠物窗口立刻关闭，桌面 Helper（electron）全部退出；
- 插件在本会话内卸载：`/dsh-pet-7340/state`、`/dsh-pet-7340/quit` 等路由返回 404，
  碎碎念/余额等定时任务与 LLM 调用全部停止；
- **不写任何配置文件**：`cordis.yml`、`cordis.patch.yml`、`package.json` 哈希在点击前后完全一致；
- 下次启动 DSH 时，profile 配置未变，插件正常加载。

## 改了哪些文件

装好的插件目录 `~/.dsh/profiles/desktop/node_modules/dsh-pet/`：

| 文件 | 改动 |
|---|---|
| `runtime/electron-helper/sprite.js` | 右键菜单加「关闭」项；`onMenuAction` 分发 `quit`；新增 `quitPlugin()`（`POST {BASE}/quit`） |
| `lib/index.js` | 新增 `POST /dsh-pet-7340/quit` 路由与 `quitForSession()`：停桌面 Helper → 卸载插件 fiber；并给碎碎念/余额轮询、会话事件监听加 `disposed` 守卫 |

原始文件备份在 `~/.dsh/dsh-pet-patches/backup/`（`index.js`、`sprite.js`）。

## 插件升级后重打

npm 更新会覆盖 `node_modules` 里的改动。升级 dsh-pet 后重跑：

```bash
node "E:\工作区\dsh-patches\dsh-pet-close-button\patch.mjs"
```

脚本是幂等的（已打过会跳过）、按内容锚点定位（不依赖行号）；
锚点对不上会报错退出，不会写坏文件。可选环境变量 `DSH_PET_DIR` 指定插件目录。

重打后需要让宿主重新加载插件（改一次 profile 配置触发热重载，或重启 DSH）。
本次实施时已验证：编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`（哪怕只改一个无关配置值）
即可让 DSH 热重载该插件，无需重启应用。

## 回滚

```bash
cp ~/.dsh/dsh-pet-patches/backup/index.js  ~/.dsh/profiles/desktop/node_modules/dsh-pet/lib/index.js
cp ~/.dsh/dsh-pet-patches/backup/sprite.js ~/.dsh/profiles/desktop/node_modules/dsh-pet/runtime/electron-helper/sprite.js
```

或重装插件：`dsh plugin --profile desktop add dsh-pet@0.3.7`。

## 实现说明（为什么这么写）

1. **卸载方式**：Cordis v4 的宿主插件上下文没有 `ctx.scope`（那是 v3 API），
   正确的是 `ctx.fiber.dispose()` —— 它会真正卸载插件并触发所有 `ctx.effect` 清理
   （路由、命令、定时器、事件监听），实测 `/state`、`/quit` 均变 404。
2. **为什么不直接 dispose**：loader 捕获「插件自卸载」时会把该 entry 标记 `disabled`，
   并把**组合后的整棵临时配置树写回 profile 根配置 `cordis.yml`**。那是持久化语义（等于永久禁用），
   与「本次会话退出、下次启动再加载」冲突，且下次启动会把补齐的树和 patch 层重复插入。
   所以 `quitForSession()` 在调用 `fiber.dispose()` 前临时把该 tree 的 `write` 换成空实现，
   卸载完成后恢复 —— 配置文件一字不动。
3. **兜底**：若 `ctx.fiber.dispose` 不存在（未来 Cordis 改 API），会降级为「停 Helper + 停止轮询」，
   并打 warn 日志，不影响使用。

## 范围说明

- 只改了**桌面端**菜单。当前 profile 的 `display` 是 `desktop`（网页端不渲染宠物），
  而桌面 Helper 与网页端共用同一份菜单组件，但菜单项由各自壳注入，所以只加在桌面壳里。
  以后若把 `display` 改回 `both`，网页端那只的右键菜单里不会有「关闭」——需要的话再加。
- 「关闭」是会话级操作，**不动任何配置**；想恢复：重启 DSH（下次启动自动加载），
  或让 profile 配置发生一次变化触发热重载。
