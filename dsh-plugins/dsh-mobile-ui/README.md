# dsh-mobile-ui

让 **DSH 网页界面**（`dsh web`，手机经隧道打开的那个聊天界面）在手机 / 平板上好用的浏览器侧插件。

桌面布局在窄屏上只是把中间那列压窄：左栏固定 56px 图标轨，点开侧栏后中间只剩 ~110px
（一个字一行）；输入区贴到屏幕最底、没有安全区；空态大标题和输入框在 390 高的横屏里
把屏幕吃满。这个插件不改宿主代码，只在窄屏下换一套外壳。

## 它做了什么

**手机（宽 ≤ 720px，或横屏矮窗口）**

| 桌面行为 | 手机上 |
| --- | --- |
| 左侧 56px 图标栏常驻，占 14% 宽 | 收成**能拖动的浮窗**（圆角卡片、带标题栏和把手、四周留边、投影）+ 左上角浮键 + 遮罩 |
| 点侧栏后中间列被压到 ~110px | 浮窗浮在上面，中间列始终满宽 |
| 点「插件 / 自动化任务 / 上下文洞察」把主区换成整页，没有返回键 | 那一页也变成**能拖动的浮窗**，右上角补一个 ×，点一下回对话 |
| 顶栏左上角是会话标题和「对话 / 轨迹」标签 | 标题与标签一起右移 52px 给浮键让位，不被 ☰ 压住 |
| 右栏（文件/终端）挤压主区 | 同样改成从右侧滑出的浮层 |
| 侧栏底色半透明（rgba(19,17,22,.4)） | 抽屉用不透明底色（颜色从宿主当前主题算，浅色主题跟着变） |
| 输入框贴到屏幕最底 | 给 home 指示条留 `env(safe-area-inset-bottom)` |
| 输入框字号 < 16px，iOS 聚焦会放大页面 | 强制 16px |
| 输入框下那排状态胶囊折行、把输入框顶出屏幕 | 单行横向滚动 |
| 宽表格/代码/图片把版面顶宽 | 消息区内的宽内容自己滚，不撑破布局 |
| 顶栏小按钮 28px | 抬到 34px，手指点得中 |
| 空态那排「工作区 / 人设」横向溢出被裁 | 允许换行 |
| 空态输入框上方「模型 ×0.11 ≈ tokens」被挤成 7px 碎线 | 手机上藏掉 |
| 横屏（如 844×390）仍按平板排、56px 栏白占 | 按手机档处理，空态标题让位给输入区 |

**平板（宽 721–1024px）**：保留图标栏（平板放得下），只补输入区安全区与宽内容不撑破。

**桌面（> 1024px）**：什么都不做（`html` 上不会有 `data-mui`，所有规则都不生效）。

## 浮窗：能拖、位置记得住

抽屉和二级整页面板都是浮窗，行为一致：

- **把手**：抽屉拖自己那条标题栏（两道横线 + 「菜单」+ ×），二级页拖它自己的页头
  （`header[class*="_pageHead"]`，页头里的按钮照常点，不会误拖）。
- **位置记忆**：松手写 `localStorage` 的 `dsh-mobile-ui:win:drawer` / `dsh-mobile-ui:win:page`
  （`{"x":48,"y":98}`），下次打开还在那儿；隐私模式下存不下就回默认位置，不报错。
- **边界夹紧**：位置一律夹在安全区里（左/上留 8px，右/下留 8px），换屏尺寸、转横屏都会重算，
  窗口不会漏到屏幕外。
- **尺寸**：抽屉 `min(84vw, 312) × min(可视高-安全区-16, 620)`；二级页 `min(宽-16, 430) × min(…, 640)`。
  尺寸由 JS 算好写进 `--mui-win-*` / `--mui-page-*`，CSS 不再重复一套 `min()`（两边算不一致就会漏边）。
- **关**：抽屉点 ×、遮罩或再点浮键；二级页点右上角 ×（贴窗口右上角，跟着窗口走）、
  它背后的遮罩、或按 Esc。二级页自己**没有**返回键，所以收起键是插件补的。
- 二级页浮窗开着时汉堡键自动隐藏（横屏矮屏上它会被夹到页左上角，正好压住标题）。

## 怎么判定

`lib/client.js` 在 `<html>` 上写一个属性，CSS 全部挂在它下面：

- `data-mui="phone"`：`innerWidth ≤ 720`，或 `innerHeight ≤ 560 且 innerWidth ≤ 1024`（横屏手机）
- `data-mui="tablet"`：`721 ≤ innerWidth ≤ 1024`
- 没有这个属性：桌面

抽屉的开合不是插件自己的状态，而是**点宿主自己的折叠按钮**（`[class*="_toggle"]`），
再由 MutationObserver 盯 AppFrame 的 `data-sidebar-collapsed` 决定要不要显示遮罩。
这样和宿主的 `narrowExpanded` 永远一致，不会出现「抽屉开着但宿主以为收着」。

## 装法

```bash
# 1) 链进 desktop profile（Windows 下 mklink /D 要管理员，用 /J 目录联接）
cmd //c "mklink /J C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-mobile-ui E:\工作区\dsh-plugins\dsh-mobile-ui"

# 2) profile 的 cordis.patch.yml 里加一行（顶层数组里）
#    - insert:
#        - id: mobile-ui
#          name: dsh-mobile-ui
```

然后**重启 DSH**（客户端插件在进程启动时才会被编进页面的 bundle 列表；
改完 `lib/client.js` 只刷新页面是不够的）。

## 卸载

删掉 profile `cordis.patch.yml` 里的 `mobile-ui` 那段 insert，重启 DSH；
再删 `node_modules\dsh-mobile-ui` 这个联接即可。插件本身不会改宿主的任何文件。

## 源码结构

```
src/mobile.css          ← 样式源文件（改这里）
src/client.template.js  ← 控制器源文件（改这里，__CSS__ 是占位符）
lib/client.js           ← 由上面两个生成，别手改
lib/index.js            ← 宿主侧空壳（只为能被 cordis 按名字加载）
tools/build.mjs         ← src/* → lib/client.js
tools/shot.mjs          ← 无头 Edge + CDP 截图 / 跑一段 JS
tools/inject-boot.mjs   ← 生成 boot-plugin.js，在页面加载前注入，模拟「插件已装好」
tests/client.test.mjs   ← 22 项自测
```

改完 `src/` 里的东西要重新生成（CSS 里有引号和反斜杠，手写进 JS 字符串会出错，所以走生成）：

```bash
cd E:/工作区/dsh-plugins/dsh-mobile-ui
ELECTRON_RUN_AS_NODE=1 "/e/Deepseek/DeepSeek Harness.exe" tools/build.mjs
```

## 截图验证（宿主升级后重跑一遍）

```bash
cd E:/工作区/dsh-plugins/dsh-mobile-ui
TOKEN=$(curl -s http://127.0.0.1:<DSH 端口>/relay/api/enter | grep -o 'token=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)
URL="http://127.0.0.1:<DSH 端口>/?token=$TOKEN"
NODE='/e/Deepseek/DeepSeek Harness.exe'

# 真页面（插件已生效）：手机 / 平板 / 桌面各来一张
ELECTRON_RUN_AS_NODE=1 "$NODE" tools/shot.mjs "$URL" 390 844 shot-phone.png shot
ELECTRON_RUN_AS_NODE=1 "$NODE" tools/shot.mjs "$URL" 820 1180 shot-tablet.png shot
ELECTRON_RUN_AS_NODE=1 "$NODE" tools/shot.mjs "$URL" 1440 900 shot-desktop.png shot

# 插件还没重启生效时，用注入方式先看效果：
ELECTRON_RUN_AS_NODE=1 "$NODE" tools/inject-boot.mjs
BOOT=tools/boot-plugin.js ELECTRON_RUN_AS_NODE=1 "$NODE" tools/shot.mjs "$URL" 390 844 shot-injected.png shot
```

## 自测

```bash
cd E:/工作区/dsh-plugins/dsh-mobile-ui
ELECTRON_RUN_AS_NODE=1 "/e/Deepseek/DeepSeek Harness.exe" --test tests/client.test.mjs
```

22 项：模块注册 / package.json 形状 / patch 文件 / 样式注入与卸载 / 三档屏宽判定
（含横屏手机）/ visualViewport 写 `--mui-vh` / 汉堡键与遮罩 / CSS 不含裸 `[class*="_frame"]`，
外加浮窗那套：标题栏与二级页收起键挂在 body、抽屉打开时算尺寸、位置记忆与越界夹回、
拖标题栏只松手才落盘、二级页浮窗（尺寸/位置/`data-mui-page`）、没有二级页时不打标记、
卸载时把浮窗节点和 CSS 变量一起清掉。

## 踩过的坑（改之前先看）

1. **`[class*="_frame"]` 会误伤消息列表。** AppFrame 的类名是 `mP3x-q_frame`，但消息列表
   `V4vHZW_frame`、空态占位 `SNx2jG_frame` 也以 `_frame` 结尾。拿它当 AppFrame 选择器、
   再给它 `height: var(--mui-vh)`，消息列表就被锁成视口高：`_viewArea` 算出来 844px（正常 8041px），
   输入框被推到滚动内容中间、屏幕上完全看不见。现在 AppFrame 一律用 JS 打的
   `[data-mui-frame]` 认（`_sidebarCol` 的父节点就是它）。
2. **宿主展开侧栏时会摘掉 `data-sidebar-collapsed`。** 早先的栅格覆盖写成
   `[class*="_frame"][data-sidebar-collapsed]`，抽屉一打开这个选择器就失配，宿主的 inline
   `grid-template-columns: 280px ...` 重新生效，中间列又被压到 110px。
3. **侧栏是半透明的。** 常驻在栅格里时它底下是页面底色，看不出来；浮成抽屉后会透出背后的
   对话文字，所以要从宿主当前配色算出不透明底色（`--mui-drawer-bg`）。
4. **令牌交换会 302 换文档。** 插件可能在文档最早期加载，那时 `documentElement` / `body`
   都可能是 null；一律现取，不缓存，用 30ms 轮询等节点出现（别只靠 DOMContentLoaded，
   它不会落在跳转后的新文档上）。
5. **`>` 直接子元素选择器匹配不到 titleRow。** 顶栏里 `[class*="_header"] > [class*="_titleRow"]`
   在真实 DOM 上命中数是 0（标题行不是 header 的直接子节点，中间还夹着一层），
   但同一条规则里的 `[class*="_header"] [class*="_tabs"]` 是生效的 —— 于是「对话/轨迹」标签
   已经右移让位、标题却仍被浮键压着。顶栏让位一律用后代选择器（不带 `>`）。
6. **类名是 CSS Modules 哈希。** 前缀（`mP3x-q`、`an3WzG`）每个模块不同、升级会变，
   只有后缀（`_sidebarCol`、`_centerCol`、`_composerSeat`）稳定，所以选择器一律用
   `[class*="_xxx"]` 属性包含匹配。宿主大版本升级后建议重跑一遍截图验证。
