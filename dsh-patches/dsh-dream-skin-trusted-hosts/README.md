# dsh-dream-skin — trusted hosts 合并补丁（403 over tunnel）

## 为什么

桌面版 DSH 不传 `--trusted-host`，所以 `webStartup.trustedHosts` 是空数组；公网域名
（本机是 `dsh-tunnel.example.com`）只写在桌面 profile 的 `cordis.patch.yml` 里
`- id: connection` 那条。dream-skin 的栅栏 `trustedAuthorities(ctx)` 只读
`webStartup` / `webRuntime`，于是经隧道/反代访问时它的 `/api` 一律 403，
而界面其余部分正常（`/api` 网关看的是 connection 服务的列表）。

修法（与 dshmarket 的 `setTrustedHostsSource` 同构）：再合并一份
`ctx.get("connection")?.trustedHosts`，去重后返回。

## 改哪个文件

`C:/Users/user\.dsh\profiles\desktop\node_modules\dsh-dream-skin\lib\index.js`

- `function trustedAuthorities(ctx)` 的原体（提前 return 版）：

```js
function trustedAuthorities(ctx) {
	const startup = ctx.get("webStartup");
	if (startup !== undefined && startup !== null) return startup.trustedHosts ?? [];
	const runtime = ctx.get("webRuntime");
	if (runtime !== undefined && runtime !== null) return runtime.trustedHosts ?? [];
	return [];
}
```

- 补丁后：收集三份、过滤非字符串、`[...new Set(hosts)]` 返回（见 `install.mjs` 里的 PATCHED 常量）。

## 重新应用（插件升级后会被覆盖）

```bash
cd /e/工作区/dsh-patches/dsh-dream-skin-trusted-hosts
ELECTRON_RUN_AS_NODE=1 "/e/Deepseek/DeepSeek Harness.exe" install.mjs --check   # 只看状态
ELECTRON_RUN_AS_NODE=1 "/e/Deepseek/DeepSeek Harness.exe" install.mjs           # 应用
```

脚本是幂等的：已经打过就报 `already patched` 退出 0；打之前把原文件备份到 `backup/`。
改完 **必须重启 Desktop** 才生效（服务端插件没有 HMR）。

## 验证

```bash
# <port> 看 runtime context，每次重启会变；<host> 换成隧道域名
curl -s -X POST -H "Host: <host>" -H "content-type: application/json" -d "{}" http://127.0.0.1:<port>/schedule/api/list
```

（`/schedule/api` 走的是 dsh-schedule 自己的同一套栅栏，两个插件一起修好后这条命令应回 `{"ok":true,...}`。）
