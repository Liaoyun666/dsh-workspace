# dsh-workspace — DSH 插件与配套框架

本仓库是 DSH（DeepSeek Harness，本地 Agent 运行时）桌面端的**插件、补丁与配套工程合集**：
十几个自研插件的完整源码、Unity / Blender / NavalArt 的 MCP 桥、以及一条「AI 养成」人格套件。

仓库定位是**框架与实现方法的公开镜像**：代码、文档结构、踩坑记录、测试都在，方便别人照着复刻；
但**不含**任何个人隐私——本机路径、服务器地址、账号、令牌、二维码图片全部替换或移除
（替换用的都是 RFC 5737 文档保留地址与 `example.com` 之类占位）。

> 这是公开镜像，不是某个人的日常仓库。文中的「工作区」指本仓库根目录，
> 路径示例里的 `C:/Users/user` 只是占位——换成你自己的用户目录即可。
> 改文件的流程约定（快照 → 干活 → 验收 → 删快照和临时文件）见 [AGENTS.md](AGENTS.md)。

## 这里面有什么

| 目录 | 内容 |
| --- | --- |
| `dsh-plugins/` | **主体**：十几个 DSH 插件的完整源码（见下表） |
| `dsh-patches/` | 打在已安装插件上的运行时补丁（插件升级会覆盖，需重打） |
| `unity-mcp/`、`other-apps/antigravity-zh-cn/` | Unity / NavalArt 建模管线，Antigravity 中文插件 |
| `navalart mod/` | 游戏模组成品交付区 |
| `大肥鱼/` | AstrBot + NapCat 的 QQ/B 站人格套件与 DSH 侧的「养鱼」插件 |
| `scripts/` | 快照工具 `snapshot.sh` |

## 仓库里放什么

内容取舍规则写在 [.gitignore](.gitignore)：

| 进仓库 | 不进仓库（留在本机） |
| --- | --- |
| 根目录文档（AGENTS.md、README.md、两份清单） | `.snapshots/`、`90-归档/`、`tmp/`、`.hc2/`、`*.log` |
| `dsh-plugins/`（除 `dsh-liangwen-tide`，它有自己的上游仓库） | `node_modules/`、`.venv/`、`astrbot-venv*/`、`vendor/` |
| `dsh-patches/`、`scripts/`、`unity-mcp/`、`other-apps/antigravity-zh-cn/`、`大肥鱼/` | `other-apps/dafeiyu-qq/`（**含 QQ 账号密码、AstrBot 运行时、NapCat 2G 安装目录**） |
| | 安装包与二进制：`*.exe/*.zip/*.7z/*.tgz/*.pdb`；`*.blend`（`build_store.py` 可重建） |
| | 凭据：`Unity_v*.alf`、`config.local.json`、`relay-device*.json`、`*.pem`、`id_ed25519*` |

**另有几个独立仓库**（各自 push，不嵌套进本仓库）：`dsh-relay/`（中继台服务端 + 插件）、
`dsha-native-tools/`、`dsha-capability-map/`、`dsh-android-portability/`、`dsh-workbuddy-android/`。
它们不在这里，按需各自 clone。

`blender-mcp/` 与 `convenience_store/` 是**符号链接**，指向工作区外的实体目录（如 `E:\blender\`），
所以不在本仓库里（也别 `git add`，.gitignore 已挡住）。

---

## dsh-plugins/ — 本地开发中的 DSH 插件源码

这些目录通过 **NTFS junction** 链接进 profile 的 `node_modules`，DSH 启动时按链接加载。

| 目录 | 包名 | 版本 | 说明 |
| --- | --- | --- | --- |
| `dsh-anim-pack/` | dsh-anim-pack | 0.1.0 | **341 种代码动画风格提示词 + 193 张参考静帧的本地素材包**（素材来自 `XiaoyeCodes/code-animation-prompts`）。7 个 `anim_*` 工具；素材 76MB 在 `assets/library/`，`node tools/install.mjs` 装进 profile，`node tools/verify.mjs` 自检（53 项） |
| `dsh-agent-preset-compact-release/` | dsh-agent-preset-compact | 0.1.0 | **发布根 / profile 实际链接的就是它**，含独立安装器 `tools/install.mjs` |
| `dsh-agent-preset-compact/` | dsh-agent-preset-compact | 0.1.0 | 开发副本。**不能删**：`-release/test/fixtures/prepare.mjs` 从这里取 fixture |
| `dsh-schedule/` | dsh-schedule | 0.1.0 | **定时任务 + 定时目标合一**（取代 dsh-cron / dsh-timed-goal）：9 个 `sched_*` 工具 + `/schedule/api` + 会话头部浮窗。改完 `lib/*.js` 追加一行注释到 profile 的 `cordis.patch.yml` 触发 HMR |
| `dsh-relay-pair/` | dsh-relay-pair | 0.3.2 | 桌面端中继配对：心跳、任务拉取、会话快照、web 隧道（sslip.io + ssh -R）。**0.3.2 起配对凭据留备份**，重启 DSH 不用重新配（对账日志 `~/.dsh/relay-pair.log`） |
| `dsha-relay-pair/` | dsha-relay-pair | 0.3.1 | 手机端（DSHA）中继配对：通知、落盘、任务在手机上跑；与桌面版是两个包 |
| `dsh-mobile-ui/` | dsh-mobile-ui | 0.1.1 | 网页/桌面壳的手机适配：悬浮侧栏卡片 + 42px 浮键 + 顶栏让位 |
| `dsh-header-collapse/` | dsh-header-collapse | 0.1.0 | 顶栏插件药丸过多时折叠成省略号 |
| `dsh-font-lab/` | dsh-font-lab | 0.1.0 | 字体实验室：扫描本机字体并列表预览 |
| `dsh-web-overscroll/` | dsh-web-overscroll | 0.1.0 | 关掉根节点 overscroll，防止滚轮串到外层 |
| `dsh-relay-think/` | dsh-relay-think | 1.0.0 | 为中转站模型声明/切换思考强度（写 `reasoningEfforts`） |
| `dsh-planning-preset/` | dsh-planning-preset | 1.0.0 | 规划 Agent 预设：Leader 只规划审查，执行全部委派 |
| `dsh-writing-preset/` | dsh-writing-preset | 1.0.0 | 写作 Agent 预设 |
| `dsh-liangwen-tide/` | dsh-liangwen-tide | 1.4.0 | **第三方**，remote 为 `gh-proxy.com/https://github.com/ZiqiaoFang/dsh-liangwen-tide.git`，不在本仓库 |

**profile 链接位置**：`C:/Users/user\.dsh\profiles\desktop\node_modules\<包名>` →
`E:\工作区\dsh-plugins\<目录名>`。

> ⚠️ **移动这些目录后必须重建 junction**，否则 DSH 启动时找不到插件。
> `dsh-agent-preset-compact` 还额外有安装收据
> `C:/Users/user\.dsh\profiles\desktop\.dsh-agent-preset-compact.json`，
> 里面的 `plugin` 字段（绝对路径）与 `linkIdentity`（junction 的 dev/ino/birthtimeNs）
> 必须同步更新，否则 `tools/install.mjs --status` 会报
> `Refusing foreign link` / `Invalid ownership receipt`。
>
> 重建方法（node，**不要用 `rm -rf`**，那会删掉目标内容）：
> ```js
> fs.rmdirSync(link);                                   // 只摘除 junction 本身
> fs.symlinkSync(target, link, 'junction');
> ```

各目录的 `tools/install.mjs` 都用 `fileURLToPath(import.meta.url)` 自定位 + `DSH_HOME ?? ~/.dsh`
找 profile，所以移动后仍可用；但 **preset-compact 需要重绑收据**（见上）。

---

## dsh-patches/ — 插件运行时补丁（升级后需重打）

这些是打在 profile `node_modules` 里已安装插件上的补丁，**插件升级会覆盖它们**，需要重跑。

| 目录 | 目标插件 | 重打命令 |
| --- | --- | --- |
| `dsh-persona-patch/` | dsh-persona-dafeiyu | 双击 `apply.cmd` 或 `powershell -File apply.ps1` |
| `dsh-pet-close-button/` | dsh-pet | `node patch.mjs` |
| `workbuddy-bridge-patch/` | dsh-workbuddy-bridge | `py patch_credit_tokens.py`（`--check` / `--restore`） |
| `dsh-v4-source-kind/` | dsh-work-components（原 dsh-cron 那处已随包卸载，其写法由 dsh-schedule 直接写对） | `py patch_v4_source_kind.py`（`--check` / `--restore`），再用 `node verify_v4_source_kind.mjs` 验收 |
| `schedule-merged/` | （归档，无对象可打） | 三份 dsh-cron 补丁（web-drawer / floating-window / timed-goal 联动）的来龙去脉，能力已并入 `dsh-plugins/dsh-schedule`；原 patch.mjs 在 `legacy/` 下只作追溯，**不要再运行** |
| `preset-ptc-route/` | （不是插件补丁）profile `cordis.patch.yml` 里的 `preset-ptc` 预设声明 | `py gen_override.py`（`--check` / `--preset standard`） |
| `ultra-preset/` | （不是插件补丁）profile `cordis.patch.yml` 里的 `preset-ultra` 预设声明 | `py install.py`（`--check` / `--remove` / `--print`） |

> `dsh-work-components` 的补丁**不在这里**：它是 `blender-mcp/scripts/patch_work_components.py`，
> 文档见 `blender-mcp/docs/work-components-connection-fix.md`。

---

## blender-mcp/ — Blender MCP 服务与本地插件（真实位置在 E:\blender）

Python 端 Blender MCP server + `bundle/`（`@local/blender-mcp` 插件本体，也被 profile 以
junction 方式链接）。含 `vendor/`(0.93G，仅 `blender-5.3.0`)、`.venv/`(65M)、`run/`、`screenshots/`、`projects/`。

> ⚠️ **不要移动本目录**。至少 5 处硬编码了 `E:\工作区\blender-mcp\...`：
> - `bundle/cordis.patch.yml`（python.exe、blender_mcp_server.py、cwd、BLENDER_MCP_HOME）
> - `C:/Users/user\.dsh\data\dsh-work-components\tools\blender\.venv\Lib\site-packages\sitecustomize.py`
>   里 `os.environ.get("DSH_BLENDER_TMP") or r"E:\工作区\blender-mcp\run\temp"`

---

## convenience_store/ — Blender 便利店建模项目

含 `build_store.py`、`night_setup.py`、`renders/`、`blender-config/`（Blender 书签与最近文件都指向这里）。

> ⚠️ **不要移动本目录**：`build_store.py:9 ROOT = r"E:\工作区\convenience_store"`、
> `night_setup.py:9 R = r"E:\工作区\convenience_store\renders"`。

---

## other-apps/ — 与 DSH 无关的独立项目

- `antigravity-zh-cn/` — Antigravity 中文插件（装到 `C:/Users/user\.gemini\config\plugins\`，与 DSH 无关）。

---

## navalart mod/ — 模组成品交付区（2026-10-31 起）

**只放能直接装进游戏的成品**，工程中间产物不放这里（规矩同时写在 AGENTS.md §4 与技能 `navalart-mod-building`）。

```
navalart mod/
├─ README.md            交付约定 + 现有成品索引
└─ YJ37/                NavalArt YJ-37 六联装垂发（2026-10-31 起）
   ├─ yj37.namod            1.48 MB  Unity 2019.4.15f1 AssetBundle
   ├─ yj37.namod.manifest   Unity 构建清单
   ├─ YJ37config.xml        ModName=YJ37，Part 99037001 / Weapon / Missiles / China
   └─ Preview.png           512×512
```

- 一个 mod 一个子目录，目录名 = `config.xml` 的 `ModName` = 游戏 `NavalArt_Data\Mods\` 下的目录名；目录里恰好 4 个文件。
- 建模脚本、审查渲染图、README、MANIFEST 留在 `unity-mcp\mods\<ModName>\`。
- 打包脚本 `OUT_DIR` 指向交付子目录，而它会 `Directory.Delete(OUT_DIR, true)` 清空它 —— 文档只放上一级。
- 体检：`C:/Users/user\.agents\skills\navalart-mod-building\tools\check-mod.mjs` 与 `check-deliverable.mjs` 都 PASS 才算成品。

---

## 90-归档/ — 归档区（本机目录，不进本仓库）

工作约定里有一条：**一次性产物、旧备份、过期离线包一律进 `90-归档/`，不要堆在根目录。**
归档区被 `.gitignore` 排除，所以公开镜像里看不到它，但目录结构是这样的：

| 子目录 | 内容 |
| --- | --- |
| `backups/` | DSH profile 配置备份（`cordis.patch.yml` 之类的快照） |
| `nm-snapshots/` | 插件升级前后的 node_modules 版本/条目快照 txt |
| `DSH插件离线包/` | 离线重装包脚本与补丁（`install.ps1`、`verify.ps1`、`patches/`、`versions.json`） |
| `blender-*-vendor-backup/` | Blender 便携版**回滚副本**（几百 MB 级）。升级到 Beta 时留着上一版做退路，**不许删**（见 AGENTS.md §2） |
| `navalart-yj37-old/` | 旧建模脚本与旧渲染图；成品在 `navalart mod/YJ37/`，工程在 `unity-mcp/mods/YJ37/` |

---

## 根目录文件

- `AGENTS.md` — **工作约定**：快照/回滚/收尾清理流程，可删与不可删清单。动文件前必读。
- `scripts/snapshot.sh` — 快照工具：`begin` / `list` / `rollback` / `end` / `prune`。
- `scripts/public-mirror.py` — **本仓库是怎么生成的**：从私有工作区按 `git ls-files` 导出、跑一遍脱敏替换、
  丢掉不该公开的文件，再 squash 成一条提交推到公有仓。个人信息与服务器地址全在
  `scripts/public-mirror.rules.json`（**不进本仓库**），格式见 `scripts/public-mirror.rules.example.json`——
  想给自己仓也生成一份脱敏镜像，照那个例子写规则即可。
- `DSH插件精选清单.md` — DSH 插件选型笔记（2026-10-18）。
- `插件审阅清单.md` — 已安装插件的审阅记录。
- `README.md` — 本文件。

---

## 维护约定

0. **改文件前先留快照，验收通过后再删快照和临时文件**（完整说明见 [AGENTS.md](AGENTS.md)）：
   ```bash
   bash scripts/snapshot.sh begin <任务名>      # 开工：留回滚点（25MB ~ 2.2GB，见 AGENTS.md）
   bash scripts/snapshot.sh list                # 看现有快照
   bash scripts/snapshot.sh rollback <任务名>    # 搞砸了就回滚（需 y 确认）
   bash scripts/snapshot.sh end <任务名>         # 验收通过：删快照 + 清临时文件
   bash scripts/snapshot.sh prune               # 清理超过 3 天的残留快照（SNAPSHOT_KEEP_DAYS=n 可改天数）
   ```
   快照排除 vendor/.venv/node_modules/90-归档/__pycache__/*.blend1 等可重建的大目录；
   但 `other-apps/`（约 3.2GB）未排除，所以工作区快照会到 2GB 级、`begin` 要跑 8~12 分钟。
   产物是 `<任务名>.tar.gz` + `.meta.txt` + `.tar.log`（tar 的 stderr）。tar **exit 1 = 打包期间有文件被改动**，
   归档仍完整算成功（meta 的 `warn` 行记条数）；**exit ≥2 才真失败**，脚本会删半成品。想确认能不能回滚，
   用 `gzip -t .snapshots/<任务名>.tar.gz` 加 `tar -tzf … | wc -l` 验一遍。
1. **移动 `dsh-plugins/*` 后立刻重建对应 junction**，并验证：
   `node -e "console.log(require('fs').readFileSync('C:/Users/user/.dsh/profiles/desktop/node_modules/<包名>/package.json','utf8').slice(0,60))"`
2. 移动 `dsh-agent-preset-compact-release` 后还要重绑收据，然后跑
   `node tools/install.mjs --profile-dir "C:/Users/user\.dsh\profiles\desktop" --status`
   确认输出 `{"installed":true,"patchManaged":true}`。
3. `blender-mcp/` 与 `convenience_store/` 的真实位置是 `E:\blender\blender-mcp` 与
   `E:\blender\convenience_store`，工作区里是 NTFS Junction（`cmd /c dir /AL E:\工作区` 可见）。
   两处都**不要删 junction、不要单独搬动**；硬编码仍指向 `E:\工作区\...`，靠 junction 生效。
4. 一次性产物、旧备份、过期离线包一律进 `90-归档/`，不要堆在根目录。
5. **游戏模组成品进 `navalart mod/<ModName>/`**，目录里只留 4 个成品文件；源码/渲染图/说明留在 `unity-mcp/mods/<ModName>/`（详见 AGENTS.md §4 与本文件对应小节）。
