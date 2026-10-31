# 大肥鱼（两条鱼）

这里打包了两个「大肥鱼」项目的源码 + 本机实操脚本，换机器或重装时直接取用。

| 目录 | 是什么 | 上游 | 许可证 |
| --- | --- | --- | --- |
| `b站刷视频-dsh-fish/` | DSH 插件：鱼会自己刷 B 站、写日记、按四阶段长人格 | [ssamurias/dsh-fish](https://github.com/ssamurias/dsh-fish) v0.6.10 | MIT |
| `qq聊天-dafeiyu/` | AstrBot + NapCat 的「大肥鱼」QQ 人格配置包 + 本机安装脚本 | [zexuanw958-svg/dafeiyu-config-pack](https://github.com/zexuanw958-svg/dafeiyu-config-pack) | MIT |

---

## 一、b站刷视频-dsh-fish

**要什么**：DSH 本体；ffmpeg 可选（有它才能真看画面，没有就只读文字）。

**装法**（在 DSH 里）：

```
dsh plugin add link:<本目录绝对路径>\b站刷视频-dsh-fish
```

装完必须确认两处同时有 `dsh-fish`：

1. `~/.dsh/profiles/<profile>/package.json` 的 `dependencies`
2. 同一个 package.json 里 `dsh.profile.bundles`

只加一处的话，pnpm 清理会把它删掉（表现：重启后 DSH 崩、设置页没有鱼）。

**数据**：`~/.dsh-fish`（owner.json 存 B 站 cookie，0600，只发 api.bilibili.com；**备份成一份文件会含 cookie**，别外传）。

**ffmpeg**：Windows 用 [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) 的 `ffmpeg-master-latest-win64-gpl.zip`，解压后设 `DSH_FISH_FFMPEG=<路径>\ffmpeg.exe`。别用 gyan.dev（国内 5KB/s）。

---

## 二、qq聊天-dafeiyu

- `pack/`：原作者配置包原样（人格、表情包索引、语音设置、导入工具）。
- `set_platform.py`：往 AstrBot 的 `cmd_config.json` 里写 OneBot v11（aiocqhttp）平台，反代端口 6199。
- `启动NapCat后台.bat`：提权启动 NapCat 注入（本机无管理员权限时用）。
- `安装笔记.md`：本机从零跑通的完整步骤、命令、踩坑。
- `回答.json.template`：导入脚本的回答文件模板（把密码填进去后改名 `回答.json`）。

**一句话流程**：装 AstrBot → 装 NapCat → QQ 小号扫码 → AstrBot 后台出现机器人 → 重跑导入脚本。

---

## 本机状态（2026-10-29）

- AstrBot **4.29.3** 装在 `E:\工作区\other-apps\dafeiyu-qq\astrbot-venv312`（venv + 独立 CPython 3.12.16，体积大，**没进本仓库**）。
- 数据目录 `astrbot-home`；后台 http://127.0.0.1:6185 ；OneBot v11 反向 WS 已开在 **6199**。
- NapCat：OneKey 包装好了 QQ 9.9.33 + NapCat 4.18.41，但 **QQ 没有管理员权限装不进系统**，直接跑 `QQ.exe` 报 `error code v2:-8`，必须用 `NapCatWinBootMain.exe` 注入。
- 导入脚本已经能登录后台，卡在「后台里还没有 QQ 机器人」——就差小号扫码这一步。
