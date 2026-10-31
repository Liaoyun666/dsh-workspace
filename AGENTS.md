# E:\工作区 工作约定

> 本文件给所有在此目录干活的 AI / 人看。DSH 本身不读 AGENTS.md，
> 所以同样的内容同时写进了 DSH 的**项目关键记忆**（每轮自动注入）和 README.md 的「维护约定」。
> 三处一起改，别只改一处。

---

## 1. 开工留快照，收尾删快照（强制）

**任何会改文件的任务**，按下面三步走，不许跳步。

### ① 开工前：留快照

```bash
bash scripts/snapshot.sh begin <任务名>
```

- 任务名用小写短横线，能一眼看出干了什么：`fix-work-components`、`cleanup-workspace`。
- 生成 `.snapshots/<任务名>.tar.gz` + `.snapshots/<任务名>.meta.txt`（记录 task/time/branch/commit/size/warn）
  + `.snapshots/<任务名>.tar.log`（tar 的 stderr）。tar **exit 1 只表示打包期间有文件被改动**（工作区有活日志时常见），
  归档仍完整、算成功，meta 的 `warn` 行会记条数；**exit ≥2 才是真失败**，脚本会删掉半成品再报错。
  快照能不能用：`gzip -t .snapshots/<任务名>.tar.gz`（整卷 CRC 校验）+ `tar -tzf … | wc -l` 看条目数。
- 实测体积：小任务约 25MB，工作区膨胀后**可达 2.2GB**（2026-10-30 实测最大 2,233,049,346 B），
  单次 `begin` 需 8~12 分钟。原因：下列 EXCLUDES 未覆盖 `other-apps/`（约 3.2GB）。
  快照**不含** `.git`、`.snapshots`、`vendor`、`.venv`、`node_modules`、
  `__pycache__`、`*.blend1`、`*.pyc`、`90-归档`、`blender-mcp/screenshots`、`blender-mcp/logs`
  —— 这些目录大且都能重新生成，回滚时不需要。

### ② 中途：搞砸了就回滚

```bash
bash scripts/snapshot.sh list                # 看有哪些快照
bash scripts/snapshot.sh rollback <任务名>    # 需要输入 y 确认
```

注意：rollback 是 `tar -xzf` 覆盖，**会把快照里的文件还原，但不会删除快照之后新建的文件**。
如果新建的文件也要清掉，手动删或先 `git clean` 再回滚。

### ③ 收尾：验收无误后清理

任务是「跑通了 / 用户确认了 / 检查通过」，才执行：

```bash
bash scripts/snapshot.sh end <任务名>        # 删掉这次任务的快照
```

同时**手动清掉这轮产生的临时文件**：`tmp/`、`*.log`、`*.tmp`、`__pycache__/`、`*.pyc`、
`*.blend1`、下载的安装包、导出的中间产物、探针脚本和探针输出。

**验收没通过就不许删快照**，也不许删临时文件 —— 那时候它们是你的救命绳。

超过 3 天的残留快照（比如任务被中断忘了收尾）：

```bash
bash scripts/snapshot.sh prune                                    # 默认清 3 天前的
SNAPSHOT_KEEP_DAYS=7 bash scripts/snapshot.sh prune                # 临时放宽到 7 天
```

prune 会一并清掉 `begin` 重名时留下的 `.tar.gz.bak-*` 残留和对应的 `.meta.txt`。

---

## 2. 哪些东西可以删，哪些死也不能删

**可以删（都能重新获取）**

- 下载后已解压的安装包（`blender-mcp/vendor/downloads/*.zip`；该目录已于 2026-10-29 清空删除）
- 调试符号（`blender.pdb`）
- 能重装的离线包（`90-归档/DSH插件离线包/packages/*.tgz`）
- 能重下的第三方二进制 / demo（`90-归档/relay-demo/new-api.exe`）
- 各种缓存：`__pycache__`、`*.pyc`、`*.blend1`、`tmp/`、`*.log`

**死也不能删**

- `blender-mcp/vendor/blender-5.3.0/` —— 系统没装 Blender，`启动 Blender.cmd` 就是靠它
  （2026-10-30 从 4.5.10 切到 5.3.0 Beta；旧的 `vendor/blender-4.5.10/` 已归档到
  `90-归档/blender-4.5.10-vendor-backup/`，**回滚副本，同样不许删**）。
- `blender-mcp/.venv/` —— Python 环境。
- `dsh-plugins/*` —— 通过 junction 链进 DSH profile，删了插件就没了。
- `dsh-patches/*` —— 插件升级后要重打的补丁。
- `convenience_store/` 里的 `*.blend`、`build_store.py`、`night_setup.py` —— 建模成果和生成脚本。
- `90-归档/backups/`、`90-归档/nm-snapshots/` —— 配置备份，丢了只能靠记忆。
- `.snapshots/` —— 未完成任务的回滚点。
- `navalart mod/` —— 模组成品交付区（成品哈希只在交付区/工程 MANIFEST 里有记录，删了得重打 bundle）。

**不要移动的目录**（源码里硬编码了绝对路径）

- `blender-mcp/`（bundle/cordis.patch.yml、sitecustomize.py 里有 5 处以上 `E:\工作区\blender-mcp\...`）
- `convenience_store/`（`build_store.py:9`、`night_setup.py:9`）
- 上面 `blender-mcp/` 与 `convenience_store/` 这两条的真实位置已迁到 `E:\blender\`（`E:\blender\blender-mcp`、`E:\blender\convenience_store`），
  工作区里只剩 NTFS Junction 指过去。junction 本身不要删；真要搬动必须两层一起改，见 README.md。
- `dsh-plugins/*` 移动后必须重建 junction 并重绑 preset-compact 收据，见 README.md。

---

## 3. 一次性产物放哪

根目录只放**长期有用的东西**。一次性脚本、探针输出、旧备份、过期离线包 → `90-归档/`。
跑完就该删的临时文件 → 就地删，不要为了"留个记录"堆到归档区。

---

## 4. 成品交付区 `navalart mod/`

**成品只放这里，工程中间产物不放这里。**（2026-10-31 起，主人定的规矩）

```
E:\工作区\navalart mod\README.md      交付约定 + 现有成品索引
E:\工作区\navalart mod\<ModName>\     每个 mod 一个子目录，里面恰好 4 个文件：
    <modname>.namod / <modname>.namod.manifest / <ModName>config.xml / Preview.png
```

- 一个 mod 一个子目录，子目录名 = `config.xml` 的 `ModName` = 游戏 `NavalArt_Data\Mods\` 下的目录名。
- 子目录里**不放** README、MANIFEST、源码、渲染图、截图；这些留在 `unity-mcp\mods\<ModName>\`。
- 打包脚本的 `OUT_DIR` 直接指向该子目录，而脚本会 `Directory.Delete(OUT_DIR, true)` 清空它 ——
  所以文档绝不能放进子目录（`navalart mod\README.md` 放在上一级就是为了这个）。
- 交付前 `navalart-mod-building` 技能的 `tools/check-mod.mjs` 与 `tools/check-deliverable.mjs` 都要 PASS。
- 安装 = 子目录整体复制到 `<游戏根>\NavalArt_Data\Mods\<ModName>\`。
- 以后别的游戏也要交付区，就按同样结构新开目录（如 `<游戏名> mod\`），不要混放。
