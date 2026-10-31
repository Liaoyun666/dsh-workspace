# dsh-font-lab

本机字体实验室 —— 把 Windows 上真实装了的字体读出来，摊在一个「字体」标签页里看。

## 它做什么

- 服务端 `lib/scan.js` 只读 `%WINDIR%\Fonts` 与 `%LOCALAPPDATA%\Microsoft\Windows\Fonts`，
  解析 sfnt 头（name 表 + OS/2）拿到家族名、字重、CJK / 拉丁 / 等宽特征，5 分钟缓存。
- 接口：`GET /font-lab/api/fonts`（`?refresh=1` 强制重扫），返回
  `{ ok, dirs, files, parsed, failed, families: [{ family, category, weights, subs, cjk, latin, mono, fileNames }] }`。
- 客户端往 `conversation.view` 注册一个 id 为 `font-lab`（order 60）的标签页。

## 面板

- 抬头：三层统计（家族 / 文件 / 中文可选）。
- 筛选条：搜索、分类、字重档、只看中文、字形样张、重新扫描。
- 卡片：家族名用该字体自身渲染，字重胶囊可点切换，右下角一键复制家族名。

截图在 `docs/`：`panel-dark.png`（深色壳）、`panel-light.png`（模拟浅色壳）、
`panel-scrolled.png`（滚动后筛选条钉住）、`panel-mobile.png`（390 宽单列）。

## 明暗适配

面板自己量一次宿主实际渲染的明暗，写在根节点 `data-fl-scheme` 上，
浅色那套值挂在 `.fl-root[data-fl-scheme="light"]` 的变量块里（形状与间距不动，只换颜色）。

判据按顺序（`src/client.template.js` 的 `detectScheme`）：

1. 面板背后实际的底色 —— 从 body 往上收，玻璃层的半透明色按 alpha 叠出等效底色，看亮度。
2. 读不到底色就看 `--dsw-alias-label-primary` 的亮度（正文亮 = 深色壳）。
3. 再退到 `color-scheme`、`data-dsh-dream-skin-scheme`、`data-ds-theme-source`。

**不要只看 `html[data-ds-theme-source]`**：那是主题「偏好来源」，偏好写 light 而皮肤
实际渲染深色时它也照样发 light，于是深底套浅色字 —— 这个面板早先就栽在这上面。
宿主换主题时不重挂面板，`MutationObserver` + `prefers-color-scheme` 只重算一次。

## 开发

```bash
node tools/build.mjs      # src/fontlab.css + src/client.template.js -> lib/client.js
node --check lib/client.js
node tools/test-scan.mjs  # 单独跑一遍本机扫描，打印耗时与统计
```

`src/` 是唯一真源，别手改 `lib/client.js`。

## 截图验收

`tools/shot.mjs` 用无头 Edge 走 CDP 打开本机 DSH 网页，可以在指定视口跑一段 JS 再截图：

```bash
cd ../dsh-mobile-ui   # 脚本的 <out> / <shotOut> 相对当前工作目录，所以借这个目录当工作台
ELECTRON_RUN_AS_NODE=1 DSH_COOKIE="<名字>=<值>" "<node>" ../../dsh-plugins/dsh-font-lab/tools/shot.mjs \
  "http://127.0.0.1:49496/" 1440 900 ../../tmp/fontlab/probe.js eval ../../tmp/fontlab/out.png
```

- `probe.js` 必须是**一个 IIFE 表达式**（脚本把它交给 `Runtime.evaluate`），
  想拿数据就 `return JSON.stringify(...)`；`console.log` 不会回显。
- 打开面板：点会话行 → 点 `button[class*="viewsMore"]` → 点弹层里文本为「字体」的叶子节点；
  这些都要 `dispatchEvent(new MouseEvent('click',{bubbles:true}))`，`.click()` 无效。
- DSH 只在启动那次把 token 打在 URL 上，之后靠 cookie：`DSH_COOKIE` 的拼法与密钥位置写在
  `tools/shot.mjs` 文件头（密钥在 `%USERPROFILE%\.dsh\.credentials.yaml`，别外传）。

## 装机

插件目录 junction 到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-font-lab`，
并在该 profile 的 `cordis.patch.yml` 里 `insert` 一条 `id: font-lab`。
改完代码刷新页面即可；换 `package.json` / `cordis.patch.yml` 要重启宿主。
