# dsh-web-overscroll —— 重打「整页滚出视口」的守卫

## 症状

DSH Web GUI（桌面窗口 / `http://127.0.0.1:52266` / relay 手机端是同一个页面）里，
鼠标滚轮或触摸滚到消息列表尽头后继续滚，**整个页面会被拖出可视区域**（露出大片背景），
松手/rubber-band 才弹回。列表本身滚动是正常的，坏的是「滚动链继续往上传到了文档根」。

## 根因

页面是 100% 高度的应用外壳：`html,body,#root{height:100%;margin:0}`，**没有任何 `overflow` /
`overscroll-behavior` 声明**，所以文档根仍然是「可滚动 + 会回弹」的容器。
外壳内部（`.mP3x-q_frame`、消息列表 `an3WzG_scrollBody` 等）各自 `overflow:hidden|auto`，
一旦某个浮层 / 瞬态布局把文档的 scrollable overflow 撑高一点，滚到列表尽头的那一下就会
链式传给文档根 —— 整页被拖走。

## 现场（三处，缺哪处补哪处）

| # | 位置 | 内容 |
| - | ---- | ---- |
| 1 | `E:\工作区\dsh-plugins\dsh-web-overscroll\lib\client.js` | 新插件，`ctx.effect` 往 `<head>` 注入 `html,body{height:100%;overflow:hidden;overscroll-behavior:none}` + `#root{height:100%;overflow:hidden;overscroll-behavior-y:contain}`；带 idempotent 清理，重复 apply 不叠标签 |
| 2 | `C:/Users/user\.dsh\profiles\desktop\cordis.patch.yml`（第 737-744 行） | `- insert: [{id: web-overscroll, name: dsh-web-overscroll}]`，把插件挂进桌面 profile |
| 3 | `E:\工作区\dsh-plugins\dsh-agent-preset-compact-release\lib\client.js:6-7`（源码副本 `dsh-plugins\dsh-agent-preset-compact\lib\client.js:9-10` 同步） | 预设紧凑插件 `css` 模板串开头的第二道守卫：`html,body,#root{height:100%;overflow:hidden;overscroll-behavior:none}` |

第 3 处是冗余的第二道保险（预设插件本来就要注入一份全站样式），存在的原因是：
profile 重建 / 预设插件升级时它比新插件更容易被一起重置或丢失，两道任意一道在都能挡住。
两处写的是同一组规则，不冲突。

**没碰 app.asar**（`E:\Deepseek\resources\app.asar` 182 MB，改它要重打包且正在运行）。

## 用法

```powershell
# 状态（不写文件；齐了退出码 0）
node E:\工作区\dsh-patches\dsh-web-overscroll\install.mjs --check

# 重打（profile 重建 / 插件升级后；已打则跳过）
node E:\工作区\dsh-patches\dsh-web-overscroll\install.mjs

# 摘掉（删 insert 块 + junction + 预设里的两行；插件源码保留）
node E:\工作区\dsh-patches\dsh-web-overscroll\install.mjs --uninstall

# 复验（自己起 headless Edge + 自己签 cookie，14 项断言，全过退出码 0）
node E:\工作区\dsh-patches\dsh-web-overscroll\verify-overscroll.mjs
```

- `node` 不在本机 PATH 里时用 DSH 自带的：`& "C:/Users/user\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" ...`（v24.21.0）。
- 环境变量：`DSH_PROFILE_DIR`（默认 `~/.dsh/profiles/desktop`）、`DSH_OVERSCROLL_SRC`、
  `DSH_APC_SRC`（预设插件源码根，默认 `E:\工作区\dsh-plugins`）；`--no-apc` 跳过第 3 处。
- 脚本用 Node 内置模块，无依赖；备份统一落在本目录 `backup/`。
- **生效方式：刷新 DSH 窗口（Ctrl+R），不需要重启 Harness。**
  只有「第一次新增插件、模块图里还认不出这个包」时才需要重启一次桌面应用 —— 本机已经加进去了。

## 验证（2026-10-29，headless Edge，真实运行中的 127.0.0.1:52266）

```
[PASS] desktop-1280x800 · 守卫样式已注入 — style[data-plugin="dsh-web-overscroll"] × 1
[PASS] desktop-1280x800 · html/body/根节点已锁 — html hidden/none body hidden/none #root hidden/none
[PASS] desktop-1280x800 · 40 次硬滚轮后整页仍在原位 — scrollY=0 html.scrollTop=0 body.scrollTop=0 docMax=0
[PASS] desktop-1280x800 · 消息列表仍可滚（两个方向） — an3WzG_scrollBody (max 3018) 3018 → up 0 → 反向 3354；moved=true back=true
[PASS] short-1000x560  · 同上四项
[PASS] mobile-390x844  · 同上四项（an3WzG_scrollBody max 5335，两个方向都动）
[PASS] A/B 守卫在   · 文档被撑高时整页仍不动 — 探针把文档撑到 docMax=1200；列表已滚到尽头；scrollY=0
[PASS] A/B 拆掉守卫 · 同样的滚轮把整页滚出视口（复现故障） — 拆规则 8 条；拆后 html visible/auto；滚后 scrollY=1200
== 14/14 通过 ==
```

A/B 那组是这条补丁的存在理由：往 `<body>` 塞一个 2000px 高的绝对定位探针把文档撑高、
再把内部列表滚到尽头，守卫在时滚轮纹丝不动；用 CSSOM 把 `html/body/#root` 上的 8 条
overflow/overscroll 规则拆掉后，同样的滚轮把 `scrollY` 拉到 1200（= docMax），整页滚出视口 —— 就是用户看到的故障。

## 什么时候需要重打

- DSH 桌面版升级 / profile 重建（`cordis.patch.yml` 被重置）。
- `dsh-agent-preset-compact(-release)` 升级（`lib/client.js` 被覆盖，第 3 处丢）。
- 表现：`--check` 报 `yml: missing` 或 `preset: missing`。

插件目录是 junction（`<profile>\node_modules\dsh-web-overscroll -> E:\工作区\dsh-plugins\dsh-web-overscroll`），
源目录改动后只要刷新页面（HMR 每 500ms 扫一次挂载的 client bundle），不用重启。
