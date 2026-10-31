# dsh-web-overscroll

修 DSH Web / 桌面窗口的「滚轮过度下拉把整个页面拖出视口」。

## 症状与根因

滚轮或触控板一旦把内部滚动容器（消息列表、侧栏、面板）滚到尽头，继续下拉会沿滚动链
一路传到文档根；根节点不是滚动容器、也没有关掉 overscroll，于是触发 Chromium 根滚动器
的边界回弹，整个界面被拽出视口、露出底色。

前端本体（`@deepseek-ai/dsh-web-frontend/dist/assets/index-*.css`）只有
`html,body,#root{height:100%;margin:0}`，全文仅弹窗内容区出现过一次 `overscroll-behavior`。
缺的就是视口这一层的守卫。

## 做法

纯客户端样式注入，不碰 `app.asar`，不改任何界面结构：

```css
html, body { height:100%; overflow:hidden; overscroll-behavior:none; }
#root      { height:100%; overflow:hidden; overscroll-behavior-y:contain; }
```

- `html,body` 不再是滚动容器、也不再回弹 → 根滚动器无从被拖动。
- `#root` 自己成为链路上的一层屏障（`contain`），内部容器的滚动链到它为止。
- **不动任何内部滚动容器**：消息列表 `overflow-y:auto`、侧栏、各面板的滚动、惯性和
  滚动条都保持原样。

## 安装 / 生效

- 代码位置：`E:\工作区\dsh-plugins\dsh-web-overscroll`
- profile junction：`C:/Users/user\.dsh\profiles\desktop\node_modules\dsh-web-overscroll`
  → 指向上面这个目录。
- profile 注册：`C:/Users/user\.dsh\profiles\desktop\cordis.patch.yml` 里

  ```yaml
  - insert:
      - id: web-overscroll
        name: dsh-web-overscroll
  ```

- 客户端插件只在**进程启动时**加载，**改完必须重启 DSH 桌面**（关掉窗口重开），
  单纯刷新页面不生效。

## 验证

页面里应能看到：

```js
document.querySelector('style[data-plugin="dsh-web-overscroll"]')  // 存在
getComputedStyle(document.documentElement).overscrollBehaviorY      // "none"
document.documentElement.scrollHeight === document.documentElement.clientHeight
document.querySelector('div[class*="_scrollBody"]').scrollTop       // 仍可滚动
```

## 关闭

删掉 profile `cordis.patch.yml` 里那段 `insert` 并重启即可；样式会随插件卸载移除。
