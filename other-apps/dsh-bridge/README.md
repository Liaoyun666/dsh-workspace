# DshFishBridge — 云端 AstrBot「大肥鱼」↔ 本机 DSH 的工作桥

云端的 QQ 机器人（Docker 里的 AstrBot 插件）把创作任务写成 job 文件丢进共享目录，
本机的 worker 每 15 秒 ssh 拉一次、取活、用 **本机 DSH headless** 真跑一遍，
把成品 scp 回云端的 outbox。云端插件再拿去投稿 B 站。

云端→本机没有入站通道，所以是**纯拉取式队列**：本机主动 ssh，云端只写文件。

---

## 1. 契约（插件端与本端共同遵守，改之前先对齐）

队列根目录：云端宿主 `/opt/dafeiyu/astrbot-data/data/dsh-jobs`
（容器内 = `/AstrBot/data/dsh-jobs`，因为 `/opt/dafeiyu/astrbot-data/data` 挂到 `/AstrBot/data`）

```
inbox/      插件写入 job：<id>.json
working/    worker 认领后把 inbox/<id>.json 移到这里（hardlink + rm 原子认领）
outbox/     成品：outbox/<id>/result.json + 成品文件
done/       worker 把 working/<id>.json 移到这里
worker.heartbeat  文本，每次轮询成功后写入当前时间（ISO8601）
```

### job JSON（插件写）

```json
{"id":"j20261030-223500-7f3a","kind":"video","prompt":"<中文创作任务>",
 "created":"2026-10-30T22:35:00+08:00","want":["video.mp4","meta.json"]}
```

- `kind` 有三种：`video`（出片）、`text`（写稿）、`cleanup`（回收本机文件，见 1.2）。
- `want` 缺省时按 kind 推断：video → `["video.mp4","meta.json"]`，text → `["answer.md"]`，
  cleanup → `["meta.json"]`。

### 1.1 result.json 必须最后写

上传顺序被写死：**先成品、再 meta.json、校验远端字节数一致，最后才写 result.json**。
result.json 是「提交标记」——插件一看到它就把 `outbox/<id>/` 整个搬去 `done/`，
所以它必须最后落地，否则插件会拿到「说做完了但视频文件没找着」。
（插件侧另有保险：result.json 到了但成品不在时最多等 240 秒。）

### 1.2 cleanup 任务（投稿结束就删本机原件）

主人定的硬规矩：视频投稿前必须他确认；**确认投稿成功或否决之后，本机上的视频原件必须删掉，
只留 B 站那一份**。插件因此会投一个回收任务：

```json
{"id":"j20261031-001230-ab12","kind":"cleanup","created":"...","target":"j20261030-222317-3e68"}
```

- 想一次删多个就用 `"paths":["j...","j..."]`（`target` 与 `paths` 可同时给，会合并）。
- **只允许删 `jobs_root`（`E:/工作区/肥鱼之家/jobs/`）下面、名字匹配
  `j<8位日期>-<6位时间>-<4位小写hex>` 的直接子目录。**
- 这些一律**拒绝**（而且是一个都不删、整体 fail closed）：绝对路径（`E:/`、`/`、`\\server`）、
  带 `..` 的、多段路径（`sub/jxxx`）、名字不合规（`jTEST-...`、大写 hex、位数不对）、
  以及删自己（cleanup 任务自己的 job id）。
- 顺手清扫：cleanup 成功后会把 `jobs_root` 下 **7 天前的旧任务目录**一并清掉
  （记在 `meta.json` 的 `swept_old` 里），单个失败只记警告、不影响整体结果。
- 回执（`result.json` 的 `text`）：`已删除本地任务目录 j20261030-222317-3e68（释放 5.6 MB）`；
  目录本来就不存在算成功，写 `本地任务目录 j... 已不存在`。
- 证据在 `outbox/<id>/meta.json`：`{kind, own_id, started, removed[], missing[], swept_old[], rejected[], freed_bytes, freed, finished}`。
- cleanup **不跑 DSH**（不花额度），直接用主进程删目录。

### result.json（worker 写，放在 outbox/<id>/）

```json
{"id":"...","ok":true,"text":"<DSH 的 final 文本>","error":"",
 "session_id":"session-...","started":"...","finished":"...",
 "files":[{"name":"video.mp4","bytes":123}]}
```

**任何情况下都会写 result.json**（成功/超时/异常/无成品），否则云端会一直等。

---

## 2. 目录

| 路径 | 作用 |
|---|---|
| `E:/工作区/other-apps/dsh-bridge/worker.py` | 主程序（纯标准库） |
| `E:/工作区/other-apps/dsh-bridge/config.json` | 配置（可改，见下） |
| `E:/工作区/other-apps/dsh-bridge/install_task.ps1` | 安装/卸载 Windows 计划任务 |
| `E:/工作区/other-apps/dsh-bridge/start_hidden.vbs` | 计划任务用的隐藏窗口启动器（install 时生成） |
| `E:/工作区/other-apps/dsh-bridge/logs/worker.log` | 日志，5MB 轮转 ×3 |
| `E:/工作区/other-apps/dsh-bridge/tests/` | 自测脚本 |
| `E:/工作区/肥鱼之家/jobs/<id>/` | 每个 job 的 DSH 会话工作目录（cwd），成品在 `out/` |
| `E:/工作区/肥鱼之家/jobs/<id>/logs/dsh.stdout.jsonl` | 该任务的 DSH JSONL 原始输出 |
| `E:/工作区/肥鱼之家/jobs/<id>/_pkg/` | 准备回传的成品副本 + result.json |
| `E:/工作区/肥鱼之家/toolkit/` | 出片工具箱（voice/sub/fx/encode + STYLE.md + demo.py），见第 10 节 |

job 目录只保留最近 `keep_job_dirs`（默认 20）个，每小时 prune 一次。

---

## 3. 怎么跑

### 平时（计划任务）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install_task.ps1
```

- 计划任务名 `DshFishBridge`，两个触发器：**用户登录时** + **每 5 分钟重复**；
  `MultipleInstances=IgnoreNew`，`ExecutionTimeLimit=0`（不杀长任务）。
- 由 `wscript.exe start_hidden.vbs` 启动，窗口完全隐藏（`WScript.Shell.Run(..., 0, False)`）。
- worker.py 内还有一个 **Global 命名互斥体** `DshFishBridge-Worker`：
  重复拉起时第二个实例直接退出，所以"每 5 分钟一次"只是自愈，不会叠进程。
- 装的时候会先 `Unregister-ScheduledTask` 再注册 → **可重复执行**。

卸载：`powershell -File install_task.ps1 -Uninstall`

### 手工调试

```bash
py -3 -X utf8 "E:/工作区/other-apps/dsh-bridge/worker.py"    # 前台跑，日志也打 stderr
```

（前台跑之前先把计划任务里的实例停掉，或者它会因为互斥体直接退出。）

### 配置 config.json

| 键 | 默认 | 说明 |
|---|---|---|
| `ssh_key` | `C:/Users/user/.ssh/id_ed25519` | 云端 root 私钥 |
| `ssh_host` | `root@203.0.113.10` | 云端地址（astrbot 所在的 ECS） |
| `remote_root` | `/opt/dafeiyu/astrbot-data/data/dsh-jobs` | 队列根目录 |
| `jobs_root` | `E:/工作区/肥鱼之家/jobs` | 本机 job 工作目录（必须是 ASCII 路径） |
| `dsh_exe` / `dsh_cli_js` | `E:/Deepseek/DeepSeek Harness.exe` + asar 内 cli.js | DSH 入口 |
| `credentials` / `api_key_name` | `.dsh/.credentials.yaml` / `DEEPSEEK_API_KEY` | 从 `refs:` 段取 key，不打印明文 |
| `ffmpeg_bin` | `C:/Users/user/AppData/Local/ffmpeg/bin` | 加到子进程 PATH 前面 |
| `poll_interval` | `15` | 轮询秒数（有活了就立刻开跑，没活才 sleep） |
| `heartbeat_interval` | `20` | 后台心跳线程间隔（秒）。云端用 `worker.heartbeat` 的 mtime 判在线，>300s 算掉线 |
| `job_timeout` | `3300` | kind=video 的单任务超时（秒），超时 `taskkill /F /T` 杀进程树 |
| `text_job_timeout` | `900` | kind=text 的单任务超时（秒） |
| `vendor_py` | `E:/工作区/肥鱼之家/.vendor/py` | 预装纯 Python 包目录，作为 `PYTHONPATH` 注入 DSH 子进程（edge_tts 等） |
| `ssh_timeout` | `60` | 单条 ssh 超时 |
| `keep_job_dirs` | `20` | 保留多少个 job 目录 |
| `send_intermediates` | `false` | `false` 时只回传 `want` 点名的成品 + `meta.json` + `result.json`；`make.py`、`voice.mp3/json/srt` 这类中间件不回传（插件投完/毙完就删整个 `outbox/<id>/`，留档无意义，还会污染 `done/` 和 `result.files`）。要排查问题临时改成 `true` |

---

### 心跳（云端靠它判断本机在不在线）

插件每 20 秒看一次远端 `worker.heartbeat` 的 mtime，超过 300 秒就判"连不上"，
主人在 QQ 里发 `/b工作室` 看到的就是掉线状态。所以心跳不能只在轮询里写 ——
一个视频任务跑 10~20 分钟，期间必须持续报到。

本端做法：

- worker 启动后开一个守护线程 `HeartbeatThread`，每 `heartbeat_interval`（默认 20s）
  单独跑一条 ssh，把 `printf '%s pid=%s' "$(date -Is)" <pid>` 覆盖写到 `worker.heartbeat`；
- 主循环 `poll()` 里那趟 ssh 也顺带写一次（格式相同，谁写都行）；
- 兜底模式 `python worker.py --heartbeat-only`：只报到的独立进程。
  只在新代码还没生效、但有长任务正在跑（不能重启 worker）时临时用；
  切换用 `start_heartbeat.ps1` / `start_heartbeat.ps1 -Stop`。

检查：

```bash
ssh -i C:/Users/user/.ssh/id_ed25519 root@203.0.113.10 \
  "stat -c '%y' /opt/dafeiyu/astrbot-data/data/dsh-jobs/worker.heartbeat"
```

### 预装依赖（别让任务里的 pip 拖时间）

DSH 在自己的沙箱里跑 `pip install` 会卡在网络上（实测一次卡十几分钟，直接吃掉整个超时预算）。
所以常用纯 Python 包预装到 `E:/工作区/肥鱼之家/.vendor/py`，worker 把它塞进 `PYTHONPATH` 传给 DSH：

```bash
py -3 -m pip install --target E:/工作区/肥鱼之家/.vendor/py edge-tts
```

当前预装：`edge-tts 7.3.1`（含 aiohttp / certifi / tabulate / typing-extensions 等依赖）。
视频提示词里也明说了"edge_tts 已装好，绝对不要 pip install"。

## 4. DSH 是怎么被调起来的

```
cd E:/工作区/肥鱼之家/jobs/<id>
ELECTRON_RUN_AS_NODE=1 "E:/Deepseek/DeepSeek Harness.exe" \
  "E:/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" \
  headless --json -- "<prompt>"
```

- `ELECTRON_RUN_AS_NODE=1` 让 exe 当 node 跑（asar 里的 cli.js 才是真入口）。
- `DEEPSEEK_API_KEY` 由 worker 从 `.credentials.yaml` 的 `refs:` 段读出后注入环境变量。
- stdout 是 JSONL：`{"type":"session","sessionId":...}` … `{"type":"final","text":"..."}`。
  worker 取 `final.text` 当 `result.text`，`sessionId` 当 `result.session_id`。
- **cwd 必须是 `E:/工作区/肥鱼之家/jobs/<id>/`**：headless 是 workspace-write 沙箱，只能写 cwd 及子目录，
  审批是 fail-closed（没人批准），所以提示词里明确写"产物只写 ./out/，不要写当前目录以外的文件"。
- 一次只跑一个 job（主循环串行；外加命名互斥体保证单实例）。

### 交给 DSH 的提示词

video 任务的模板（`worker.py` 里 `PROMPT_HEAD/VIDEO/TEXT/TAIL`，实际是完整版，这里是骨架）：

```
你是大肥鱼的工作室助理，在 DSH 环境里干活。当前目录就是你的工作区，所有产物只写进 ./out/。
（任务描述里提到「当前目录」一律理解为 ./out/。）
任务：<job.prompt>
要求（kind=video）：必须产出 ./out/video.mp4（H.264 + AAC，竖屏 720x1280/1080x1920，
  时长以任务说明为准、没说明就 40~90 秒，允许 30~180 秒，必须有声音、必须有中文字幕）
  和 ./out/meta.json（title<=40字、desc<=200字、tag 3~5 个逗号分隔、lines 逐句口播数组）。
【环境已经准备好的东西，别重复装】ffmpeg/ffprobe 在 PATH；python 用 py -3；
  edge_tts 7.3.1 已预装（PYTHONPATH）；**绝对不要 pip install**（会卡网络十几分钟）。
【先看工具箱，别现造轮子】E:/工作区/肥鱼之家/toolkit/ 的 voice/sub/fx/encode 可直接 import，
  STYLE.md 是美术规范，demo.py 是最小模板。
【节奏要求】任何一步超过 3 分钟没结果就换简单做法；先落 video.mp4 再补 meta.json。
【收工自检】ffprobe 确认有 video + audio 两条流、时长达到要求。
做完用一两句中文说明你做了什么。不要写当前目录以外的文件。
```

- text 任务把 `要求（kind=video）` 整段换成「把成品正文写进 ./out/answer.md」。
- `kind=cleanup` **完全不走 DSH**（不花额度）：主进程直接删目录、写回执（见 1.2）。

---

## 5. 成品校验与失败语义

- 默认只回传 `want` 点名的成品 + `meta.json`（+ 永远最后写的 `result.json`），
  其余 `out/` 里的中间件（`make.py`、`voice.mp3/json/srt`、临时图）**不回传**，
  日志里记一条 `跳过中间件 X (send_intermediates=false)`；
  要连中间件一起回传，把 config 的 `send_intermediates` 改成 `true`。
- 子目录（`out/_build`、`out/tmp` 这种中间目录）永远不传。
- 中间稿过滤：名字里带 `_backup` / `.tmp` / `.bak` / `.swp` / `.orig` / `~$` / `.DS_Store` 的跳过，
  不写进 `files`（模型偶尔会把 `meta_backup.txt` 之类留在 out/ 里）。
- 兜底：如果 DSH 把成品写在 workdir 根上（提示词说「当前目录」而它理解偏了），
  worker 会按 `want` 名单再去根目录捞一次。
- 缺 `want` 里的任一文件 → `ok:false`，`error` 写「缺少成品 X」。
- video 额外用 ffprobe 检查：没有视频流 / 没有音频流 / 时长 <1s → `ok:false` 并写明原因。
- 超时 → `ok:false`，`error` 含「超时 XXXXs 被杀」（video 3300s / text 900s，见 config.json）。
- worker 内部异常 → `ok:false`，`error` 写异常类型与最后一行堆栈。
- DSH 没吐 final 文本且其它都正常 → `ok:false`，`error`="DSH 无 final 文本"。
- `kind=cleanup` 不看 `out/`：回执固定是 `meta.json`（见 1.2），不跑 DSH、不产生 session_id。
- 任何情况下都写 `result.json`（云端等太久会判失败）。

### 5.1 回传顺序：result.json 必须最后写（铁律）

云端插件每 20 秒扫一次 `outbox/<id>/result.json`，**一看到它就把整个目录 mv 到 done/**。
所以 `result.json` 是「提交标记」，必须是这个目录里**最后一个落地**的文件 ——
否则插件会撞上"说做完了，可视频文件没找着"，那条片子就投不出去
（2026-10-30 j20261030-222317-3e68 真实事故：`sorted()` 让 result.json 排到 video.mp4 前面）。

现在的 `push_results()` 严格按这个顺序：

1. `ssh mkdir -p outbox/<id>`；
2. 先 scp 成品（`want` 里的 `video.mp4` / `answer.md`）→ 再 scp `meta.json` 等其余文件；
   顺序清单会打进日志：`[job] 回传顺序: video.mp4 -> meta.json -> result.json`；
3. `ssh stat -c %s` **逐个核对远端正文字节数**与本地一致（差一个字节就抛异常、走 3 次重试，
   下一轮由 `flush_pending()` 补传，绝不带着半截文件提交）；
4. 最后才 scp `result.json`，再校验它自己的字节数；
5. `ls -la --time-style=full-iso` 打一份 outbox 快照进日志，方便事后对时间戳。

`tests/e2e.py` 里带了顺序断言：取一次 outbox 的 `stat -c '%.9Y'` 快照，
要求 `result.json` 的 mtime ≥ 其它所有文件，且 want 里的成品在 result.json 落地时已经在了。

---

## 6. 日志与排错

`E:/工作区/other-apps/dsh-bridge/logs/worker.log`，格式：
`2026-10-30T22:19:12+0800 INFO    [job-id] 消息`，5MB 轮转，保留 3 个备份。

常用排查顺序：

1. **心跳不更新** → 本机到云端 ssh 不通。
   ```bash
   ssh -i C:/Users/user/.ssh/id_ed25519 root@203.0.113.10 "date -Is > /opt/dafeiyu/astrbot-data/data/dsh-jobs/worker.heartbeat; date -Is"
   ```
2. **worker 没在跑**
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" | Select ProcessId,CommandLine
   Get-ScheduledTask -TaskName DshFishBridge | Select TaskName,State
   Get-ScheduledTaskInfo -TaskName DshFishBridge | fl
   ```
3. **job 卡在 working/ 不出来了** → worker 死在这单上。看 `logs/worker.log` 与
   `E:/工作区/肥鱼之家/jobs/<id>/logs/dsh.stderr.log`；手工把这个 `working/<id>.json` 挪回 `inbox/` 重试。
4. **DSH 报 API key** → 检查 `.credentials.yaml` 的 `refs:` 段有没有 `DEEPSEEK_API_KEY`（别打印值）。
5. **result.json 说缺 video.mp4** → 大概率是提示词里让它写了别处的路径，或者 ffmpeg/edge_tts 失败；
   看 `<job>/logs/dsh.stdout.jsonl` 里 DSH 的自述。
6. **ssh 每次打 post-quantum 警告** → 云机 sshd 旧，警告进 stderr，worker 已过滤，忽略即可。

---

## 7. 测试

```bash
py -3 -X utf8 tests/e2e.py text     # 放一个 kind=text job，等 result.json，断言 ok/text/files
py -3 -X utf8 tests/e2e.py video    # 放一个 kind=video job，ffprobe 断言有视频流+音频流+时长
                                    # 两个都会抓一次远端 stat 快照，断言 result.json 最后落地（见 5.1）
py -3 -X utf8 tests/e2e.py cleanup   # 放一个 kind=cleanup job（造一个假 job 目录让它删），断言删净
py -3 -X utf8 tests/cleanup.py      # 清掉测试用的 inbox/working/outbox/done 残留
py -3 -X utf8 tests/test_ssh_retry.py   # 离线: ssh 轻量重试的 5 条规则（不连云端）
py -3 -X utf8 tests/test_cleanup.py     # 离线: cleanup 白名单 18 条 + 真删/顺手清/整体拒绝
```

toolkit 自己也带 demo 自检（会真合成一条 10 秒样片）：

```bash
cd E:/工作区/肥鱼之家/toolkit && PYTHONPATH=E:/工作区/肥鱼之家/.vendor/py PATH="C:/Users/user/AppData/Local/ffmpeg/bin:$PATH" py -3 -X utf8 demo.py
```
```

---

## 8. 踩过的坑（重要，别踩第二次）

### 8.1 E: 盘目录必须给"显式"完全控制，否则 DSH 沙箱的 shell 全废

现象：job 跑起来，DSH 能写文件，但**每一次 pwsh/bash 调用**都报

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(E:\工作区\肥鱼之家\jobs\<id>)
```

原因：DSH headless 的 workspace-write 沙箱在每次 shell 调用前要在工作区根目录上
`grantWrite` 改写 DACL。`E:/工作区/肥鱼之家` 从 `E:\` 继承来的权限只有
`Authenticated Users:(M)`（Modify，**不含 WRITE_DAC**），于是改写失败 → 拒绝。
（放在 `C:/Users/user` 下面不会有这个问题，那里用户是 Full Control。）

修复（一次性，install_task.ps1 已内置）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File fix_acl.ps1      # 默认 E:/工作区/肥鱼之家
```

等于 `icacls "E:/工作区/肥鱼之家" /grant "<用户>:(OI)(CI)F" /T`。
修完 `icacls "E:/工作区/肥鱼之家"` 第一行应该能看到 `<用户>:(OI)(CI)(F)`。
**不修这个，text 任务还能靠 write 工具硬写出来，video 任务（要跑 ffmpeg）必死。**

### 8.2 Windows scp 不会自己建目录

Windows 版 OpenSSH 的 `scp` 走 SFTP：目标目录不存在时报
`path canonicalization failed`。所以回传时先 `ssh mkdir -p outbox/<id>`，
再**逐个文件** scp（不要用 `scp -r local/. dest/`）。

### 8.3 bash 里内联 powershell 会被引号吃掉

git-bash 里写 `powershell -Command "... $_.x ..."` 或 `icacls ... /grant` 会被
MSYS 改写参数、把 `\$` 吞掉（`WORKGROUP\\user` 变成 `WORKGROUP\\user`）。
**一律写成 .ps1 文件再 `-File` 执行**，路径用 `icacls.exe` 而不是 `icacls`。

### 8.4 scp 失败不能吞掉结果

回传失败时 worker 会重试 3 次（3s/6s 退避）；仍失败就写 `<job>/_pending_upload`
标记并保留 `working/<id>.json`，主循环每轮开头 `flush_pending()` 补传（**不重跑 job**，
成品已在 `_pkg` 里），传成功后再归档到 `done/`。

---

### 8.5 DSH 里 pip install 会卡网络，别在任务提示词里让模型装包

首跑 video 任务时，DSH 花十几分钟在 `pip install edge-tts` 上反复卡住/重试，
渲染一步没走，最后差点撞上 1800s 超时。修法有两条，都做了：

1. 包预装到 `E:/工作区/肥鱼之家/.vendor/py` 并用 `PYTHONPATH` 注入（见 3 节"预装依赖"）；
2. 提示词里明确写"已预装，绝对不要 pip install"，并把超时从 1800s 提到 3300s。

### 8.6 任务中途要停机重排队：先杀 worker 再杀 DSH

排错脚本：`stop_for_requeue.ps1`（杀 worker，不带 `/T`，再杀该 job 的 DSH 进程）、
`kill_job_procs.ps1`（只杀某个 job 残留的进程）。
顺序很重要：先杀 worker（它才不会写 `result.json`、不会把 job 归档），
再把远端 `working/<id>.json` 挪回 `inbox/` 重新排队。
**此时 outbox/ 里不能有半截 result.json**，否则插件会当成一次真失败报给主人。

### 8.7 云机 ssh 偶发 `Connection closed`：只给幂等命令加重试

现象：`scp.exe: Connection closed`、心跳偶尔写失败，基本都出现在"刚重启 worker 立刻又建连"
这种并行建连的时刻，重跑一次就好。

所以 `ssh(cfg, cmd, retries=N, backoff=1.5)` 只在**连接层失败**（rc 255 / 超时 -9 / 起不来 -1）
上重试，命令真跑过（rc 0 或业务错误）绝不重试。只给**幂等**命令开重试：

| 命令 | retries | 为什么安全 |
| --- | --- | --- |
| `ls -1 inbox/` + 心跳覆盖写（poll） | 3 | 读 + 覆盖写，天然幂等 |
| `mkdir -p outbox/<id>` | 3 | `-p` 幂等 |
| `stat -c %s`（字节校验） | 3 | 只读 |
| `cat working/<id>.json` | 3 | 只读 |
| `ln` 认领（claim） | 3 | 改写成幂等版：`working` 有 + `inbox` 无 = 已是我认领的，直接 CLAIMED |
| `mv -f working→done` | 3 | 包成 `[ -f ... ] && mv; true`，源文件不在也不报错 |
| `ls -la` 打目录快照 | 2 | 只读 |

**scp 传大文件不走这条路** —— 交给 `push_results` 的 3 次重试 + `flush_pending` 补传
（盲目重试半截大文件没意义，字节校验那关会拦下来）。
离线单测：`py -3 -X utf8 tests/test_ssh_retry.py`（monkeypatch `run`，不连网）。

### 8.8 每隔十几秒闪一个终端窗口：子进程没加 `CREATE_NO_WINDOW`

现象：桌面每隔 15~20 秒弹一个标题是 `C:\\Windows\\System32\\OpenSSH\\ssh.exe` 的终端窗口，
一闪就没（本机默认终端是 Windows Terminal，类是 `CASCADIA_HOSTING_WINDOW_CLASS`，
父进程链 `pythonw.exe` → `ssh.exe`，即 worker 本身，**不是 DSH**）。

原因：`subprocess` 起子进程时没传 `creationflags`，Windows 就为控制台程序新建一个可见控制台。
worker 里每个 poll（`poll_interval`=15s）和每次心跳（`heartbeat_interval`=20s）都要 ssh 一次，
于是每个窗口刚好闪一下。

修法（2026-10-30）：`worker.py` 顶部定义

```python
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
```

- `run()` 里的 `subprocess.run(..., creationflags=CREATE_NO_WINDOW)`
- `run_dsh()` 里的 `Popen(..., creationflags=CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)`
  （两者按位或，隐藏窗口的同时保留下 Ctrl+C 等信号组语义）

**以后只要在 worker.py 里新起子进程，一律带上 `creationflags=CREATE_NO_WINDOW`。**

验收：跑 `powershell -NoProfile -ExecutionPolicy Bypass -File tests\console_flash_probe.ps1 -Seconds 80`
（枚举可见的 `ConsoleWindowClass` / `CASCADIA_HOSTING_WINDOW_CLASS` 窗口，记 pid/父进程/标题），
正常只输出 `start baseline=N` 和 `=== end ===`；打补丁前同样 70 秒里抓到 7 次闪现。
打补丁并 `restart_worker.ps1` 重启后，连测 150 秒一次都没有，同时远端 `worker.heartbeat`
仍在每 20 秒刷新 —— 说明只是隐藏了窗口，ssh 本身没受影响。

## 9. 已知限制

- 拉取式：本机必须开机、登录、worker 在跑；云端无法主动推。
- headless 沙箱 fail-closed：任务里任何需要审批的动作都会直接失败，所以提示词只用 cwd 内写文件 + 本地命令。
- 单飞：同时来多个 job 会排队串行跑，后到的要等到前面跑完（云端插件应据此告诉用户"排队中"）。
- `E:/工作区/肥鱼之家/jobs/<id>` 必须是 ASCII：DSH headless 对中文 cwd 没验证过。

---

## 10. 出片工具箱 toolkit（`E:/工作区/肥鱼之家/toolkit/`）

任务里最贵的不是写文案，是「怎么把画面渲出来」。所以把重复的活儿沉淀成四件套，
job 的 cwd 里 `import voice, sub, fx, encode` 就能直接用（worker 已把
`E:/工作区/肥鱼之家/.vendor/py` 和 `E:/工作区/肥鱼之家/toolkit` 一起塞进 PYTHONPATH）。

| 文件 | 干什么 |
|---|---|
| `voice.py` | edge-tts 逐句配音 + 时间对齐。`synthesize(lines, out_mp3, rate="+8%")` 返回 `{"mp3","cues":[{"text","start","end","dur"}],"duration"}`，顺手写 `.json`/`.srt`。中文女声 `zh-CN-XiaoyiNeural`。 |
| `sub.py` | 中文字幕/标题卡/角标/信息卡。样式表 `STYLE` 固定配色、字号、描边、安全区；`bg_image()` 带颗粒层压 banding。**注意 `draw_*` 是就地画，要同底图多效果先 `.copy()`**。 |
| `fx.py` | 动效：`fade/zoom/push/pan/typewriter/progress_bar/chapter_badge/crossfade/wipe/shake/bottom_scrim`。一律不改原图、返回新图。 |
| `encode.py` | 帧序列 + 音频 → h264 yuv420p / aac 48k / `+faststart` / loudnorm `-16 LUFS`，一把过；`probe()` 查流和时长。 |
| `STYLE.md` | 美术与节奏规范（画幅、四色、字号层级、安全边距、字幕规则、片头片尾模板、节奏、质量红线）。**出片前先读这一页**。 |
| `demo.py` | 最小可用模板：配音→字幕→动效→编码全串起来，约 10 秒样片，改台词就能用。 |

worker 的 `PROMPT_VIDEO` 里已经点名这套工具，告诉 DSH「先看工具箱，别现造轮子」。
时长规范：30~180 秒，没说明就 40~90 秒。

记着：**合成出来的样片、中间帧都算临时文件**，别往 `toolkit/demo/` 里越堆越多。
