# dsh-cron 右侧抽屉补丁

修 dsh-cron 0.3.1 在 DSH 0.2.1 上「Web 抽屉点开是空的 / 请求 405」的问题。

## 症状

- 会话头部有 cron 按钮，点开右侧抽屉，任务与历史永远加载不出来。
- `POST http://127.0.0.1:<port>/cron/api/list` → **405**（空 body）。
- 插件日志里**没有** `cron: HTTP API mounted at /cron/api` 这一行。
- 模型侧的 `cron_add` / `cron_list` / `cron_history` 全部正常，到点也真的会触发。

## 根因

上游 `index.js` 用 `ctx.inject(['webServer', 'webRuntime'], …)` 挂 HTTP API，
并在里面读 `webCtx.webRuntime.trustedHosts`。

DSH 0.2.1 起 `webRuntime` 这个服务**不存在**了，`trustedHosts` 搬到了
`webStartup`（见 `@deepseek-ai/dsh-web-app/lib/startup.js` 的
`ctx.provide('webStartup', { …, trustedHosts })`）。

Cordis 的规则：`inject` 里列了宿主没有的服务，该 entry 会**永久 pending**
（上游 issue #109）。于是整块 inject 从不激活 → `/cron/api` 前缀路由一次都没注册
→ 宿主 webserver 对未匹配路径回落 405。

## 补丁内容

只改宿主半边 `node_modules/dsh-cron/index.js`：

1. `ctx.inject(['webServer', 'webRuntime'], …)` → `ctx.inject(['webServer'], …)`；
2. fence 里的 trustedHosts 改用 `ctx.get()` 现取：

```js
const trustedHosts = () => {
  const startup = ctx.get('webStartup')
  if (startup !== undefined && startup !== null) return startup.trustedHosts ?? []
  const runtime = ctx.get('webRuntime')
  if (runtime !== undefined && runtime !== null) return runtime.trustedHosts ?? []
  return []
}
const fence = (req) => isTrustedApiRequest(req, trustedHosts())
```

同一套路在 `dsh-dream-skin/lib/index.js`（line 74 `export const inject = ["webServer"]`，
line 95-99 用 `ctx.get("webStartup")` 取 trustedHosts）里已经跑通了，可直接对照。

客户端 bundle（`lib/client.js`）**不需要改**：它只依赖 `slots` / `locale`，
两个插槽（`conversation.session.header.utilities`、`shell.overlay`）在 0.2.1 里都在；
`package.json` 的 `dsh.client.inject` 里那两个不存在的包名会被客户端模块图静默跳过
（`dsh-client-modules/lib/client.js` 的 `arriveGraphRow` 对缺失包名直接 continue）。

安全面不变：`isTrustedApiRequest` 仍要求 Host 头是回环地址或命中 trustedHosts，
再拒绝 `sec-fetch-site: cross-site`。

## 用法

```bash
node patch.mjs
```

- 幂等：已打过会打印「已打过补丁，跳过」并 exit 0。
- 锚点找不到 / 不唯一 / 写完自检不过 → 打印 `PATCH FAILED: …` 并 exit 1，不写坏文件。
- 首次运行把原文件备份到 `~/.dsh/dsh-cron-patches/backup/index.js`。
- 环境变量：`DSH_CRON_DIR`（插件根目录）、`DSH_CRON_BACKUP`（备份目录）。

**插件升级会覆盖补丁**，升级后重跑一次即可。

## 让运行中的 DSH 生效

宿主 HMR（`@deepseek-ai/dsh-hmr`）只在 profile 的
`package.json` / `cordis.patch.yml` 内容变化时才 recompose。改完插件文件后触发一次：

```bash
printf '\n# hmr nudge %s\n' "$(date +%Y%m%d-%H%M%S)" >> ~/.dsh/profiles/desktop/cordis.patch.yml
```

HMR 会比较 profile 下已加载模块与磁盘，发现 `dsh-cron/index.js` 变旧 → 停掉 cron entry
并用新文件重启它，**不用重启 Desktop**。等价的手工入口：dshmarket 的
`POST /dsh-market/api/v1/restart`（真要整进程重启时用）。

## 验证

```bash
# 1) 路由回来没有 405
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Host: 127.0.0.1:<port>' -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:<port>/cron/api/list        # 期望 200

# 2) 抽屉：刷新页面 → 会话头部 cron 按钮 → 右侧抽屉能列出任务与历史
```

`<port>` 是当前 Web GUI 端口（本机曾为 55575 → 57238，Desktop 重启会变）。

## 回滚

```bash
cp ~/.dsh/dsh-cron-patches/backup/index.js \
   ~/.dsh/profiles/desktop/node_modules/dsh-cron/index.js
```
再触发一次 HMR nudge 即可。
