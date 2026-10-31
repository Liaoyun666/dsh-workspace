# YJ-37 垂直发射模块（NavalArt 武器模组）

> 虚构武器：六联装超声速反舰导弹垂直发射模块，舰名 `鹰击-37`。Steam appid 842780。

## 目录分工（2026-10-31 起）

成品与工程分开放，**成品只在交付区**：

| 位置 | 内容 |
|---|---|
| `E:\工作区\navalart mod\YJ37\` | **成品 4 件套**：`yj37.namod`（Unity 2019.4.15f1 AssetBundle，Uncompressed）、`yj37.namod.manifest`、`YJ37config.xml`（ModName=YJ37，1 个 Part：Path=99037001，Weapon/Missiles/China）、`Preview.png`（512×512）。交付目录里不放任何源码/图/文档 |
| `E:\工作区\unity-mcp\mods\YJ37\source\` | 生成这个包的全部 Unity 执行脚本（建模 / 图标 / 打包 / 审查） |
| `E:\工作区\unity-mcp\mods\YJ37\renders\` | 当前模型（v3）多视角审查图 |
| `E:\工作区\unity-mcp\mods\YJ37\` | `README.md`（本文件）、`MANIFEST.txt`（成品哈希与状态） |

`yj37_pack.cs` 的 `OUT_DIR` 直接指向交付目录，重打就等于刷新成品。

## 安装

```powershell
$src = 'E:\工作区\navalart mod\YJ37'   # 交付区里只有游戏要读的 4 个文件，整目录复制即可
$dst = 'E:\SteamLibrary\steamapps\common\NavalArt\NavalArt_Data\Mods\YJ37'
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item "$src\*" $dst -Force
Start-Process 'steam://rungameid/842780'
```

`<游戏根>\NavalArt_Data\Mods\<目录>` 才是本地 mod 目录（不是游戏根目录的 `Mods`）。目录内恰好一个 `.namod` + 一个 `*config.xml`。
验证：`C:/Users/user\AppData\LocalLow\RZEntertainment\NavalArt\Player.log` 里应出现

```
Imported mod from local: ...\Mods\YJ37 with AB name: yj37.namod and 1 parts
```

## 游戏内位置

造舰 → 武器 → 导弹（Missiles）→ **YJ-37 垂直发射模块[鹰击-37]**（Part id `99037001`）

## 数值

| 项 | 值 |
|---|---|
| 布局 | 3×2 六格，共 12 发（每格 2 发） |
| 换弹 | 14 s / 格 |
| 射程 / 弹速 | 220 km / 680 m/s |
| 毁伤 | 16000，爆炸半径 14，穿深 900，战头 SemiAp |
| 制导参数 | 过载 12 G，巡航高度 20，拦截率 30 |
| 零件 | 装甲 60、密度 0.5、价格 3600、体积 1.87 m³（薄甲板 collider 3.34×0.20×2.80） |
| 开盖 | 每格独立舱盖，`endRot=(-95,0,0)`，`animTime=0`（多格不能共用 animTarget） |
| 弹库 | `Magazine` 隐藏物体，BoxCollider 3.10×3.70×2.60（弹舱占位） |

## 版本状态（重要）

- 包内 `yj37.namod` 已在 **2026-10-31 00:48** 重打，内容 = **v3 外形**：全长 8.55 m、两级（白助推 + 钢色级间 + 深灰二级）、承波体平底折棱弹头、**无腹部进气整流罩**（按主人手工改动）。
- bundle 体积 1,459,190 B（比 v2 的 1,479,830 B 小，因为清掉了 21 盏残留实时灯）；内嵌导弹 prefab 11 个渲染器、**0 灯 0 相机**；垂发 prefab children=67 renderers=132。
- 已验证：`check-deliverable.mjs` PASS，装入 `NavalArt_Data\Mods\YJ37` 与交付区 4 文件哈希完全一致，启动游戏 34 s 后 Player.log 出现 `Imported mod from local: ... with AB name: yj37.namod and 1 parts`。
- 历史坑：建模阶段渲染脚本会在导弹下挂 `Studio` + Key/Fill/Rim 三盏灯，垂发里 6 个实例各带一套 → 进 bundle 共 21 盏实时灯。重打包前必须清（`tmp\navalart-mod\clean_studio.cs` 的做法：先 DestroyImmediate 所有 Light，再删名为 Studio 的 Transform，然后 `yj37_vls_build`/`yj37_pack` 重跑）。

## 重打（Unity 工程开着、桥 127.0.0.1:6401 可用时）

```powershell
$node = 'C:/Users/user\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$rc   = 'C:/Users/user\.agents\skills\navalart-mod-building\tools\run-cs.mjs'
$src  = 'E:\工作区\unity-mcp\mods\YJ37\source'
& $node $rc "$src\yj37_vls_build.cs"     # 按当前导弹场景重建六联装垂发 + 存 prefab/场景
& $node $rc "$src\yj37_vls_icons.cs"      # 图鉴 p99037001 / 导弹小图 / Preview 三张图标
& $node $rc "$src\yj37_pack.cs"           # 打 yj37.namod + config.xml 直接写进交付区，并回读自检
$tool = 'C:/Users/user\.agents\skills\navalart-mod-building\tools'
& $node "$tool\check-mod.mjs"         'E:\工作区\navalart mod\YJ37'
& $node "$tool\check-deliverable.mjs" 'E:\工作区\navalart mod\YJ37'   # 只留成品 + 与已安装副本比对
```

注意：`yj37_build.cs` 会**重建整套导弹**（含腹部进气罩，即覆盖主人在场景里手工删掉的那两个物体）。只想沿用当前场景外形时**不要跑它**，从 `yj37_vls_build.cs` 开始。

## 模型结构速查（v3 导弹）

| 子件 | 材质 | 说明 |
|---|---|---|
| Body | YJ37_Body `#E7EAEE` | 一级助推，尾锥 + 圆柱到 z=6.30 |
| Markings | YJ37_Marking `#16324F` | 两道藏青识别环（z 3.05–3.19、4.70–4.84） |
| Nozzle / NozzleInner | YJ37_Nozzle / YJ37_Dark | 喷管 z0–0.18、喷口内盘 r0.232 |
| TailFins / Strikes / Canards | YJ37_Body | 4+4+4 片，厚度根→尖渐变 |
| InterstageRing / InterstageNeck | YJ37_Nozzle / YJ37_Dark | 级间环箍 + 收颈法兰 |
| Stage1_Upper | YJ37_Upper `#49525E` | 二级首段，异形截面收窄到半宽 0.248 |
| Warhead_Waverider | YJ37_Radome `#262B31` | 承波体弹头，13 点平底折棱截面，z 7.10→8.55，根部 4.5% 裙边 |

尺寸：全长 8.550 m、翼展 1.534 m、三角面 2965，几何审计 0 退化面 / 0 NaN / 法线单位化。

## 相关

- 做法与坑：DSH 技能 `navalart-mod-building`（`C:/Users/user\.agents\skills\navalart-mod-building\`）
- 参考 mod：工坊 3020519079 `[agm-169] mk41 vls.namod`（垂发 collider / magazine 套路）
