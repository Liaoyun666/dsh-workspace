# dsh-anim-pack — 代码动画风格素材包

把 [XiaoyeCodes/code-animation-prompts](https://github.com/XiaoyeCodes/code-animation-prompts)
里的 **341 种代码动画风格提示词 + 193 张参考静帧** 变成 DSH 的常驻工具：
想用哪种风格，直接搜、直接读、直接导出到工作目录，不用再把 76MB 素材翻一遍。

素材整份放在本包的 `assets/library/`，工具只按需读一条，不占上下文。

## 装好之后有什么

7 个 `anim_*` 工具，任何会话都能直接调：

| 工具 | 干什么 | 主要参数 |
| --- | --- | --- |
| `anim_list_series` | 列出 10 个系列与条目数，挑风格前先看一眼 | — |
| `anim_search` | 按关键词 / 系列检索，返回编号、名称、适用内容、标签、有无静帧 | `query` `series` `limit` |
| `anim_show` | 读某条的完整提示词（Markdown 原文 + 元信息） | `id`（必填，不区分大小写） |
| `anim_still` | 取参考静帧的绝对路径，直接交给看图工具 | `id` |
| `anim_export` | 把提示词（和静帧）复制进工作目录 | `ids` / `id` / `dir` |
| `anim_random` | 随机抽一条并直接给出完整提示词 | `series` |
| `anim_guide` | 制作指南：选型、占位符、时间接口、渲染成 MP4、验收清单 | — |

`query` 里多个词用空格分隔表示**同时命中**（AND）；直接填编号或风格名会排在最前；
系列代码是 `AG / M / K / Z / H / L / V / X / R / O`。

## 典型用法

```
anim_search query="水墨 粒子"          → 找到候选，看编号与适用场景
anim_show   id="K7"                    → 读它的完整提示词与参考实现
anim_still  id="K7"                    → 看一眼参考静帧长什么样
anim_export ids=["K7","Z1"] dir="E:/工作区/demo/styles"
                                       → 复制到项目里，直接改
anim_guide                             → 动手前读一遍怎么把它做成动画
```

导出默认落在 `<当前会话工作目录>/anim-styles/<编号>_<名称>/`，只复制不移动，
素材库永远原样不动（`exportEntry` 会拒绝写进库内部）。

## 安装

```bash
cd dsh-plugins/dsh-anim-pack
node tools/install.mjs                 # patch 方式装进 desktop profile（默认）
node tools/install.mjs web             # 换 profile
node tools/install.mjs --bundle        # bundle 方式（写进 dependencies + dsh.profile.bundles，需重启）
node tools/install.mjs --status        # 看现状 + 模块自检
node tools/install.mjs --uninstall     # 撤掉 junction、补丁块、bundle 登记
```

安装只做三件轻事：profile `node_modules` 里建 junction、往 profile 的
`cordis.patch.yml` 追加一个托管块（首尾有标记，卸载按标记摘除）、必要时登记 bundle。
**76MB 素材不复制**，junction 直接指向本目录。

patch 方式下 profile 是 `patchReload: live`，补丁层会热重载：刷新页面或开新会话就能看到
`anim_*` 工具；如果没出现，重启一次 DSH 桌面。

## 自检

```bash
node tools/verify.mjs
```

不启动 DSH，纯 node 跑 53 项检查：341 条索引、341 个提示词文件、193 张静帧是否都在磁盘上，
编号查找 / 关键词与系列检索 / 随机 / 读提示词 / 导出 / 拒绝写进库内部，
再用一个假 `ctx` 跑一遍 `apply()`，确认 7 个工具都注册成功且真的能执行。

## 素材库结构

```
assets/
  catalog.json                    341 条索引（id/name/series/category/description/fit/tags/file/image）
  library/
    风格提示词/<系列>_<名称>/<编号>_<名称>.md   提示词 + 参考实现（S.<编号>(c,w,h,t,s)）
    ...同目录 <编号>_<名称>.jpg                 参考静帧（193 条有）
    A-G_代码样片/_公共函数.js                 该系列共用的小工具函数（只有 A–G 有）
    示例/ 第三方许可/ 风格挑选.html 说明.md 许可与来源.md _统计.json
```

10 个系列：AG 26 / M 40 / K 38 / Z 15 / H 12 / L 59 / V 15 / X 31 / R 7 / O 98。

**换库**：插件配置里给 `libraryPath`（指向另一个含 `assets/catalog.json` 的根目录）即可，
默认读本包目录。

## 来源与许可

- 素材整理自 [XiaoyeCodes/code-animation-prompts](https://github.com/XiaoyeCodes/code-animation-prompts)，
  上游许可写在 `assets/library/许可与来源.md` 与 `docs/attribution.md`：
  **原素材可自由转发、禁止包装成付费课程 / 付费 skill**。
- 其中三份子库各自带 MIT 许可：Lemo-Opuscar（L 系列）、mg-styles-15（V 系列）、code-video（X 系列），
  许可见 `assets/library/第三方许可/`。
- 本包（工具与安装脚本）同样按上游精神使用：自己用、随便改，别拿去卖。
