# 肥鱼之家 · 大肥鱼的工作区

这里是「大肥鱼」这条 AI 鱼做东西的地方。视频、文章的**制作过程与中间产物**都落在这个目录里，
不再散落到 `E:/fish-studio`。

## 目录

| 路径 | 用途 |
| --- | --- |
| `jobs/<jobId>/` | 每一次活的独立工作目录。jobId 形如 `j20261031-001331-3d4d`（j + 日期 + 时间 + 4 位随机）。DSH 就以这里为 cwd 干活，成品写在它自己的 `out/` 下。 |
| `jobs/<jobId>/out/` | 成品：视频 `video.mp4`、文章 `answer.md`、`meta.json`（标题/时长/脚本/参考来源）。 |
| `toolkit/` | 出片四件套：`voice.py`（逐句 edge-tts 配音+时间对齐）、`sub.py`（字幕/标题卡/角标）、`fx.py`（动效）、`encode.py`（h264+aac、-16 LUFS、faststart），另有 `STYLE.md` 美术与节奏规范。job 里直接 import。 |
| `.vendor/py/` | 预装好的 python 包，worker 会塞进 PYTHONPATH，**别重复 pip install**。 |

## 谁在这里干活

- 云端 AstrBot 的「刷B站」插件把活写进 `dsh-jobs/inbox/`（云端路径 `/AstrBot/data/dsh-jobs`）。
- 本机 worker（`E:/工作区/other-apps/dsh-bridge/worker.py`，计划任务 `DshFishBridge`）拉下来，
  在 `jobs/<jobId>/` 里跑 DSH，跑完把成品回传云端，云端插件推给主人审核 → 通过才投稿 B 站。
- 稿件审完（通过或否决）后，插件会发 `kind=cleanup` 的活，本机这里对应的 `jobs/<jobId>/` 会被删掉；
  顺带清理 7 天以前的旧目录。

## 规矩

- 一个活一个 `jobs/<jobId>/`，不要在 `肥鱼之家` 根目录随手写文件。
- 成品一定放 `out/`：文章叫 `answer.md`（云端回收的就是这个名字），视频叫 `video.mp4` 并另写 `meta.json`（标题、时长、脚本、参考来源 URLs ≥2 条）。
- 这里的东西随时可能被 cleanup 清掉，别把「唯一一份」放进来当仓库。
