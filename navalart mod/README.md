# navalart mod —— 模组成品交付区

这里**只放能直接装进游戏的成品**。建模脚本、审查渲染图、探针输出这些中间产物一律不放这里，
它们的家在 `E:\工作区\unity-mcp\mods\<ModName>\`。

## 目录约定（以后所有 NavalArt mod 都照这个做）

```
E:\工作区\navalart mod\
├─ README.md              本文件（约定 + 现有成品索引，放在 mod 子目录之外）
└─ <ModName>\             一个 mod 一个子目录；目录名 = config.xml 里的 ModName
   ├─ <modname>.namod            必需，恰好一个，UnityFS AssetBundle
   ├─ <modname>.namod.manifest   打包副产物（bundle 资产清单），随包保留
   ├─ <ModName>config.xml        必需，恰好一个，UTF-8 无 BOM
   └─ Preview.png                图鉴/工坊预览图，512x512
```

硬规矩：

1. **一个 mod 一个子目录**，目录里只有上表那 4 个文件。不放 README、不放 MANIFEST、不放源码、不放渲染图和截图。
2. 子目录名 = `config.xml` 的 `ModName` = 装进游戏后 `NavalArt_Data\Mods\` 下的目录名。
3. 打包脚本的 `OUT_DIR` 直接指向 `E:\工作区\navalart mod\<ModName>`。打包脚本会 `Directory.Delete(OUT_DIR, true)` **清空该目录**，所以本 README 放在上一级、绝不放进子目录。
4. 交付前两条命令都要 PASS：`check-mod.mjs`（结构/枚举/bundle/图鉴）+ `check-deliverable.mjs`（只留成品、版本、哈希、与已安装副本比对）。
5. 安装 = 子目录整体复制到 `E:\SteamLibrary\steamapps\common\NavalArt\NavalArt_Data\Mods\<ModName>\`；上创意工坊就打 zip 上传同一内容。

## 现有成品

| 子目录 | 部件 id | 名称 / 分类 | 版本 | 状态 |
|---|---|---|---|---|
| `YJ37\` | 99037001 | YJ-37 垂直发射模块[鹰击-37] · China / Missiles | 1.0 | **v3 外形已打包**（8.55 m 两级 + 承波体弹头、无进气罩）；bundle 1,459,190 B、0 灯 0 相机；`check-deliverable` PASS，已装机并在 Player.log 验证加载 |

工程目录：`E:\工作区\unity-mcp\mods\YJ37\`（`source\` 10 个脚本、`renders\` 10 张审查图、`README.md`、`MANIFEST.txt`）。
更早的脚本与渲染图归档：`E:\工作区\90-归档\navalart-yj37-old\`。

## 命令

```powershell
$node = 'C:/Users/user\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$tool = 'C:/Users/user\.agents\skills\navalart-mod-building\tools'

# 交付体检（两个都要 PASS）
& $node "$tool\check-mod.mjs"         'E:\工作区\navalart mod\YJ37'
& $node "$tool\check-deliverable.mjs" 'E:\工作区\navalart mod\YJ37'

# 安装到游戏
Copy-Item 'E:\工作区\navalart mod\YJ37\*' 'E:\SteamLibrary\steamapps\common\NavalArt\NavalArt_Data\Mods\YJ37\' -Force
```
