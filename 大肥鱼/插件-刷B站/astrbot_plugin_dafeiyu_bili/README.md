# 大肥鱼刷B站（astrbot_plugin_dafeiyu_bili）

给 AstrBot 的 QQ 版大肥鱼加一个「自己去刷 B 站」的能耐：随机挑一条视频，
抓标题/简介/标签/热评/弹幕采样，交给模型以大肥鱼人格说两句话，配上封面和链接发到 QQ。

## 指令

- `/刷b站`（别名 /刷视频 /刷b /刷bilibili）—— 立刻刷一条
- `/看b站 BV1xxxxxxxxx`（别名 /看看这个 /b站看看）—— 指定看一条
- `/b行为`（别名 /b日志 /b汇报 /b在干嘛 /b干了啥 /b记录）—— 一键查她今天刷了几条、
  评论/弹幕/动态各多少、最近 8 笔都干了啥（带时间、标题、内容）

## 自动互动（刷完顺手留个脚印）

自动刷完一条、推送成功之后，在真实登录态下按概率顺手互动：

- 弹幕：`auto_danmaku`（默认开）+ `auto_danmaku_prob`（默认 0.6），8~18 字随手飘一句
- 评论：`auto_comment`（默认开）+ `auto_comment_prob`（默认 0.35），20~45 字随手回一句

两者都受 `max_danmaku_per_day` / `max_comments_per_day` 限制（防小号被限流），
没登录就整个跳过；被 B 站拒绝只写 warning 日志，不打扰聊天。
每次互动的动作都记进 `state.json` 的 `log`（留最近 150 条），`/b行为` 就是读它。

**评论会抄送主人**：自动评论发出去后，立刻私聊主人报一份

```
本鱼在《视频标题》底下评了一句：
评论内容
https://www.bilibili.com/video/BVxxxx
不满意就发 /b删评论，本鱼立刻撤
```

同时把这条评论的 `rpid` 记进 `state.json` 的 `last_comment`（bvid / text / rpid / t），
主人回一句 `/b删评论`（别名 /删评论 /b删评）就能一键撤回刚那条（走 `POST /x/v2/reply/del`，
需要 oid=aid、type=1、rpid、csrf）。只有主人能用；删掉后 `last_comment` 清空。

**每日自动动态不重复**：`state.json` 多一个 `dynamic_date`，当天发过就跳过——
以前每次重启都会在过点后重算一次、把当天的动态又发一遍。

## 自己录视频投稿（/b投稿）

让她自己做一条竖屏短视频（1080×1920）投到 B 站小号上。全流程都在容器里跑：

1. 用当前人格写稿：模型只吐 JSON `{title, desc, tag, lines}`，6~10 句口语，一句一个意思；
2. 逐句 edge-tts 配音（默认 `zh-CN-XiaoyiNeural`，语速 `+8%`），失败重试 3 次；
3. PIL 画深蓝渐变底图 + 金色标题，ffmpeg concat 音轨、drawtext 按时间轴逐句上字幕、
   底部一条进度条，`libx264 -crf 24` 出片；
4. 用 B 站网页版新版 upos 链路投稿（`/upload/file` 传 ffprobe 派生的 meta → `/upload/multipart/*`
   传分片 → `/x/vu/web/add/v3` 建稿），cover 留空由 B 站自动配。

指令：

- `/b拍片 主题`（别名 `/b投稿 主题`、`/b发视频`、`/b视频`）—— 不写主题她自己挑方向；
  交给本机工作室拍，**拍完不会直接投**，先发到 QQ 给主人过目；
- `/b过`（别名 `/b投稿确认`、`/b通过`、`/b同意`、`/b发吧`）—— 点头，这才真正上传 B 站；
- `/b毙`（别名 `/b投稿取消`、`/b否决`、`/b不要`、`/b撤`）—— 不发，原件一起删掉；
  **私聊里不带斜杠的「过 / 毙 / 通过 / 否决 / 投稿确认 / 投稿取消」也算**（只认主人，且当时确实有待审的片子）；
- `/b本地投稿`（`/b本地拍`）—— 不用本机工作室，就在容器里合一条（同样要先过审）。

「主人说人话也能拍」：插件用 `@filter.on_llm_request` 每轮往系统提示里塞一段能力说明，
所以主人随口说「用本机做 / 用本机拍 / 接到电脑那边做 / 让工作室做 / 用 DSH 去做 / 录一条发B站」时，
模型会直接调 `bili_do(action="video", text=主题)`，由 `video_engine` 决定交给本机工作室还是容器合成。
她**不该**再回「电脑权限没开」「我只有聊天这扇窗」「去 WebUI 打开 Computer Use」——那是模型瞎编的。

配置：

- `video_enable`（默认开）
- `video_voice` / `video_rate`：配音音色与语速
- `video_tid`：分区，默认 160（生活），211 是美食，21 是日常
- `video_per_day_min` / `video_per_day_max`：每天自动拍 1~3 条，每天在这个区间里随机定一个数
- `video_review_timeout_hours`：片子做好后最多等几小时，超时自己撤（默认 24）
- `relay_url` / `relay_token` / `relay_video_enable`：把待审片子推到中继台网页，让主人也能在网页上批
- `video_dry_run`：干跑，只走流程不真上传（测试用，平时关着）

自然语言也行：主人说「发个视频投到B站」她自己会调用 `bili_do(action="video", text="主题")`。
没登录、今天投够了、B 站拒绝，都会用鱼的口吻回你一句。
`/b行为` 的一行统计里也会带上「投稿 N/上限」。

**注意**：投稿前必须确认 `video_enable` 打开、cookie 还在（`/b状态` 看），
并且容器里有 ffmpeg / edge-tts / 中文字体。

## 视频审核（投稿前必须主人点头）

主人定的规矩：**没点头就不许上传。**

1. 片子做好（本机工作室交活 / 容器里合成）→ 插件写 `data/plugin_data/astrbot_plugin_dafeiyu_bili/video_review.json`，
   把标题、简介、时长、逐句口播、查证来源一起记下；
2. 双通道推送给主人：**QQ 私聊**发一条说明 + 视频文件本身；同时 POST 到中继台
   （`/api/video/submit` + `/api/video/upload`），主人可以在中继网页的「视频审核」栏里直接看片、点通过/毙掉；
3. 决定来自哪边都行：
   - QQ 发 `/b过` 或 `/b毙`；
   - 中继网页点按钮 —— `_review_loop` 每 45 秒拉一次 `/api/video/poll`，看到 approved/rejected 就照办；
   - 24 小时没人理 → 超时自动撤（记一条日志，不投稿）；
4. 通过 → 上传 B 站；然后 **本机 `E:/工作区/肥鱼之家/jobs/<jid>`、云端 outbox/done 里的成品、
   `video_share_dir` 里的副本、中继上的文件全部删掉**，只留 B 站那一份；
   否决 → 同样全删。本机那边靠往队列里塞一条 `kind="cleanup"` 的任务让 worker 去删。

**额度**：每天自动拍 1~3 条（`video_per_day_min`~`video_per_day_max`，每天随机）。
只有**确认或否决**时才消耗一条额度，pending 不算；主人手动 `/b拍片` 自己下的单不占额度。
同一时间只允许一条在等审，等审期间不再开新活。

**实现注意（2026-10-31 踩过）**：AstrBot 的指令处理是**异步生成器**，管道拿到第一条结果后
就不再往下迭代（日志里紧跟 `clean_outgoing stopped event propagation`）。所以「先 `yield` 一句
进度提示、再 `await` 真干活」的写法会让活儿**根本不执行**（当时 `/b过` 只回了「这就传上去」，
投稿和清理全没发生）。规矩：进度话一律 `await self._say(umo, "…")` 直接说出去，
所有 `await` 干完，最后**只 yield 一次**最终结果。

**内容**：主题按方向轮换 —— AI 快报（多做，最受欢迎）、闲谈牢骚、社会热点、历史科普。
时长 30~180 秒。**讲事实的内容必须查证**：DSH 侧的 brief 要求用 web_search/web_fetch 查，
把来源写进 `meta.json` 的 `sources`；查不到就换主题，绝不编造数字、日期、人名。

- 官方镜像 `soulter/astrbot:latest` 里 **没有 edge-tts**，重新 `docker compose up -d` 后会消失。
  `/opt/dafeiyu/Dockerfile` 里 `FROM soulter/astrbot:latest` + `RUN python -m pip install --no-cache-dir edge-tts==7.3.1`，
  build 成 `dafeiyu/astrbot:edge-tts` 并在 compose 里用这个镜像。
- **NapCat 看不到 `/AstrBot/data`**，所以要发视频必须让两个容器共享一个目录：
  compose 里 astrbot 和 napcat 都挂 `- ./share:/share`，插件把成品复制到 `video_share_dir`（默认 `/share/dafeiyu-video`）再发。
- `video_tid` 填了之后 B 站可能仍把分区改回默认（实测填 160 建稿后显示 21），不影响审核和播放。

## 配置要点

- `auto_interval_hours`：固定间隔（旧参数）；现在优先用 `auto_min_hours` ~ `auto_max_hours`
  的随机区间（当前云端 **2~4 小时**），两者都没配就按 `auto_interval_hours`。
  下一次的时间会写进 `state.json` 的 `next_ts`，重启后接着等，不会一启动就连推。
  留空 `auto_targets` 则推到最近一次用 `/刷b站` 的会话。
- `max_per_day` / `quiet_start` / `quiet_end`：防刷屏、半夜闭嘴（默认 `max_per_day=6`，
  安静时段 `1~8` 点）。`_next_gap()` 会按配额兜底：今天没刷完的份必须在安静时段之前排完，
  所以剩余条数多、剩下的钟点少时，间隔自动压缩到 `剩余秒数 / 剩余条数`，下限 1 小时（不至于刷屏），
  保证一天正好刷满 `max_per_day` 条。
- `persona_id`：默认读数据库里名叫「大肥鱼」的人格提示词。

## 实现说明

- 全部用公开接口，不需要登录 cookie：`/x/web-interface/popular`、`/x/web-interface/ranking/v2`、
  `/x/web-interface/view`、`/x/v2/reply`、`/x/v1/dm/list.so`。
- 会先取 `/x/frontend/finger/spi` 的 buvid3/4 降低风控概率。
- 看过的 bvid 记在 `data/plugin_data/astrbot_plugin_dafeiyu_bili/seen.json`（留最近 300 条）。

## 自然语言指挥（说人话就行）

除了斜杠指令，主人直接在 QQ 里说「去刷个视频」「查查你今天在 B 站干了啥」「发条动态」
「评论一下 BV1xx411c7mD 说得好」这类话，她自己会调用 `bili_do` 工具真的去做，做完用自己的话回你。

- `action` 可选：`browse` / `dynamic` / `comment` / `danmaku` / `video` / `report`
- 发动态 / 评论 / 弹幕是公开动作，只有 `owner_ids`（默认 `["100000000"]`）里的号能让她做；
  别人叫她做，她会用鱼的口吻推掉，不动手。
- 没登录、今日上限到了、B 站拒绝，都会返回一句人话（「今天评论 10 条了，嘴上歇歇」这种），
  她自己会顺口告诉你。

