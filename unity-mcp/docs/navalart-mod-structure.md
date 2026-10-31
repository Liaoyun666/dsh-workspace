# NavalArt 模组结构解析（以武器模组为例）

> 实测环境：NavalArt 1.6.1（Steam appid 842780，2026-10-22 更新）、Unity 2021.3.34f1 构建的游戏本体、官方 ModTool 0.20.4（要求 Unity 2019.4.15f1）。
> 数据来源：本机 345 个工坊条目 / 327 个 `.namod`（共 2.10 GB）全量扫描、16 个自造船存档、ModTool SDK 的 `NAModToolCore.dll` 反编译、官方《NavalArt Modding Tutorial (095)》32 页 PDF，以及把真实 `.namod` 载入 Unity 2019.4.15f1 编辑器后的反射 dump。

---

## 1. 一个 mod 文件夹长什么样

工坊条目 `2779911929`（GER30X12，一门 30 mm 双联副炮）的真实内容：

```
2779911929/
├─ GER30X12config.xml        251 B    ← 零件登记表（游戏读它才知道 bundle 里有什么）
├─ ger30x12.namod            716 KB   ← AssetBundle，真正的模型/材质/脚本数据
├─ ger30x12.namod.manifest   1.1 KB   ← Unity 构建产物（资产清单：路径、classID、脚本引用）
├─ GER30X12                  4.4 KB   ← 同名 AssetBundleManifest 包（也是构建副产品）
├─ GER30X12.manifest         142 B
└─ Preview.png               211 KB   ← 仓库里的 mod 预览图
```

要点：

- **`.namod` 就是一个 UnityFS AssetBundle**，只是改了扩展名。文件头 128 字节里能读到构建版本（`2019.4.15f1c1` 之类）。
- `*\.manifest` 是 Unity 打包时自动生成的文本清单，随包一起被作者扔进 mod 文件夹；游戏并不依赖它，但它对逆向非常有用（列出了每个资产路径与 MonoBehaviour 的脚本 GUID）。
- kind 为 `0` 的 `ModType` 表示"零件包"；语言包 / 天空盒 / 望远镜 mod 是另外的文件夹结构（见官方教程第 15–19 页）。
- **安装位置两种**：工坊订阅 → `<Steam库>\steamapps\workshop\content\842780\<工坊ID>\`；本地自装 → `<游戏>\NavalArt_Data\Mods\<任意文件夹>\`（本机目前没有 `Mods` 目录，说明只装过工坊 mod）。

## 2. config.xml：零件登记表

命名规则是 `<ModName>config.xml`（GER30X12 → `GER30X12config.xml`），**编码是 UTF-8（无 BOM）**。

```xml
<root>
  <config ModName="GER30X12" Author="A NOOB" Description="GER30X12"
          CreateTime="3_16_2022 10_22_32 PM" Version="1.0" />
  <Part Path="13432966" PartClass="Weapon" PartName="GER30X12"
        PartDescription="GER30X12" PartNation="Germany" />
</root>
```

`<config>` 属性：`ModName` `Author` `Description` `CreateTime` `Version` `ModType`（0 = 零件包，新版工具才写）。

`<Part>` 属性：

| 属性 | 含义 | 备注 |
|---|---|---|
| `Path` | bundle 内 prefab 的资产名 | 等于 prefab 名，也等于 `PartAttributeProxy.id` |
| `PartClass` | Hull / Weapon / Engine / Decoration / Module / Aircraft | 决定它进哪个仓库分类 |
| `PartName` / `PartDescription` | 仓库里显示的标题/描述 | 可含空格、中文 |
| `PartNation` | 国家标记 | USA / China / Others / Germany / USSR / Britian（官方拼错）/ France / Italy / Japan / Russia / Sweden |
| `PartWeaponType` | 0.9 起新增的武器子类 | Turrets / Torpedos / AAGuns / DPGuns / Missiles / CIWS / ASW / Others |
| `BasePartId` + `BasePartModName` | 派生件：继承原版/其它 mod 的零件 | 全库出现 82 次 |

全工坊 1022 条 `<Part>` 的类别分布：Weapon 656、Decoration 232、Engine 81、Hull 20、Aircraft 19、Module 14。

## 3. `.namod` 内部：资产与脚本

以 GER30X12 为例，包内只有两样东西：

- `assets/…/13432966.prefab`：整门炮的 GameObject 层级；
- `assets/resources/icon.png`：一张 200×200 的图鉴图（多部件包里则是 `p<id>` 一堆）。

`.namod.manifest` 里列出的 ClassTypes 覆盖了所有可能用到的类型：GameObject 1、Transform 4、Material 21、MeshRenderer 23、Texture2D 28、MeshFilter 33、Mesh 43、Shader 48、BoxCollider 65、AnimationClip 74、AnimatorController 91、Animator 95、MonoBehaviour 114、MonoScript 115、Sprite 213。

最关键的一条：**所有行为的 MonoBehaviour 脚本 GUID 都是 `0741ad192fcd8df4bb480ec0caaa4c28`**，也就是 `NAModToolCore.dll`（ModTool 0.20.4 里 17,920 字节）。反编译这个 DLL 就拿到了"游戏读懂 mod"的全部契约。玩法代码本身（弹道、命中、AI）在游戏主程序的 `Assembly-CSharp.dll` 里，mod 只提供数据。

## 4. 组件与字段（`NAModToolCore` 全量）

### 4.1 每个零件都必须有：`PartAttributeProxy`

| 字段 | 默认 | 说明 |
|---|---|---|
| `id` | 1000 | 零件唯一 id，必须等于 prefab 资产名；重名会触发 "references a missing script" |
| `basePartId` / `basePartModName` | -1 / "" | 派生自哪个零件 |
| `armor` | 50 | 装甲，单位 mm |
| `density` | 0.5 | 密度（重量 = volume × density） |
| `volume` | 30 | 体积（吨位来源） |
| `price` | 100 | 价格（游戏里尚未实现） |
| `partName` / `partDescription` | — | 仓库显示名 |
| `builderClass` | — | `PartClass`：Hull0 / Weapon1 / Engine2 / Decoration3 / Module4 / Aircraft5 |
| `weaponType` | Others | `WeaponType`：Turrets0 / Torpedos1 / AAGuns2 / DPGuns3 / Missiles4 / CIWS5 / ASW6 / Others7 |
| `nation` | — | `Nation`：Others0 / China1 / Britian2 / France3 / Germany4 / Italy5 / Japan6 / Russia7 / Sweden8 / USA9 / USSR10 |
| `modName` | — | 所属 `.namod` 文件名 |

### 4.2 舰炮：`PartTurretProxy`

`deckGun`(是否甲板炮) `caliber`(120) `rotateSpeed`(20) `range`(4000 m) `bulletSpeed`(700) `loadTime`(7 s) `maxShootAngle`(40) `minElevation`(-10) `shellWeight`(120) `horizontalSpread`/`verticalSpread`(10) `muzzles[]` `barrel` `turret` `pedestal` `extraBarrels[]` `localDeadZones[]`(`TurretDeadZoneProxy{startAngle,endAngle}`) `heMaxDamage`(1000) `apMaxDamage`(1500) `apPenetrationDepthModifier`(0.9) `isDpGun` `aaDamage`(400) `explosionRadius`(15) `aaSpread`(2) `maxAaAngle`(80) `maxAaRange`(8000) `aaDamageType` `overrideGlobalSFXConfig` `customSFXConfig` `useModdedSound` `moddedSound` `moddedAudioPitch`(1) `moddedAudioVolume`(0.1)。

另有 `TurretMechanicalLinkageProxy`（联动：`LinkageType` None/ElevateToLinearPosition/ElevateToLinearEulerAngles）与 `TurretSFXConfigProxy`（多套开火音效 + 距离衰减曲线）。

### 4.3 防空炮 / CIWS：`PartAAGunProxy`

`caliber`(35) `rotateSpeed`(50) `range`(4000) `muzzleVelocity`(700) `maxAngle`(80) `muzzle`（**只允许一个**，放多炮口中间） `extraMuzzles[]` `barrel` `turret` `pedestal` `rotateObjects[]`(`{rotateObject, speed}`，用于旋转弹链/雷达) `extraBarrels[]` `localDeadZones[]` `rpm`(400) `dps`(8) `isCIWS` `aaDamageType`(`ShortRangeSpecialist`/`MediumRangeSpecialist`/`LongRangeSpecialist`/`CIWS`) + 音效三件套。

### 4.4 导弹发射器：`PartMissileProxy`

`animTarget` `targetFinalRotation` `animTime`（开盖/抬架动画目标） `magazine`（VLS 的备用碰撞体，非空则游戏切换碰撞体） `missileRes`（实际发射的导弹 prefab，导出前须 disable） `missileTex`（图鉴 256×64） `tubes[]` `missleJetSpeed`(20) `boosterSpiltTime`(2，官方拼写如此) `startManeuverTime`(1) `missileMaxSpeed`(340) `missileAcceleration`(20) `missileMaxRange`(20 km) `maxGForce`(10) `cruiseHeight`(20 m) `damage`(15000) `explosionRadius`(10) `equivalentPenetrationDepth`(100 mm) `warheadType`(`HE`/`SemiAp`/`AA`) `interceptionRate`(80) + 音效三件套。

`LauncherTube` 结构：`cover`(盖/门) `spawnPos`(空物体) `prewarmed`(外挂导弹才 true) `prewarmedMissile`(必须是单独的 prefab，否则贴图丢失) `missileCount`(1) `reloadTime`(5) `detectCollisionDelay`(VLS 用) `endRot`(盖不隐藏而转到该角度)。

导弹物体内部两个名字是硬编码契约：`Booster`（助推器，会在设定的时间分离）与 `Thruster`（尾焰挂点，**必须是 Booster 的子物体**）。发射器名字必须带 `[...]`，方括号内即游戏导弹面板里显示的名字。

### 4.5 其余零件

- 鱼雷：`PartTorpedoLauncherProxy` —— `caliber`(600) `rotateSpeed`(20) `range`(4000) `torpedoSpeed`(80) `loadTime`(7) `canLaunchUnderwater` `muzzles[]` `turret` `pedestal` `cruiseHeight`(-2) `maxDamage`(8000) `penetrationIndex`(1)。
- 引擎：`PartEngineProxy.power`(1000)，子物体 `smoke` 决定烟的位置（复制多个 = 多路烟）。
- 雷达：`PartRadarProxy{rotateSpeed=5, detectionRange=10000}`；舵：`PartRudderProxy{maxAngle=45, area=10}`；螺旋桨：`PartThrusterProxy{diameter=1, pitch=0.2, bladeCount=3, bladeWidth=0.4, maxRpm=200}`；烟：`PartSmokeProxy{smokeSize=30}`。
- 纯贴图件：`PartColorMask`（空标记脚本）——加了它的物体游戏**不替换材质**，可保留自己的贴图/玻璃/高模；`RendererColorMaskProxy{Color color}` 用于参与涂装染色。

## 5. 四个真实武器 mod 的体检结果

### 5.1 舰炮 GER30X12（2779911929，`2019.4.15f1c1`，包内 1 个 prefab）

- `PartAttributeProxy`：id 13432966、armor 50、density 0.5、volume 20.72、Weapon/Germany/Others。
- `PartTurretProxy`：caliber 30、rotateSpeed 55、range 11000、bulletSpeed 950、loadTime 0.03、maxShootAngle 89、minElevation -3、shellWeight 40、spread 0.5/0.5、HE 1500 / AP 1800、`isDpGun` true、aaDamage 1850、maxAaRange 11000、2 个 muzzle（±1.700, 0.046, 4.960）。
- 层级：root → `pedestal` / `turret` → `barrel`（z −1.289）→ `muzzle` ×2；几何挂在 `30-2`(3432 顶点，带 Animator)、`30-5`(3332)、`30-3`(5921)、`30-1`(1036) 等子件上。
- 材质只有 `defaultMat`（Standard，#CCCCCC）与内置 `Default` 白色 —— **没有贴图**。这是社区惯例：靠纯色 + 游戏运行时染色，保证性能和风格统一。

### 5.2 导弹 Starstreak（3153902395，`2019.3.1f1`，11.7 MB，包内 10 个 prefab + 10 张 512×512 图鉴）

- prefab 10004002：`PartMissileProxy` 参数见上表（jet 125 / max 625 / accel 85 / range 7 km / damage 1050 / pen 650 / warhead AA / interception 75）。
- 层级：root → `Launcher` → `Turret`(ASRAD_R_Turret 7730 顶点) → `Barrel`(10612) → `Tube`×4（`MSL_Tube` 3096 顶点 + `Rot` + `SpawnPos`，用 `scale.x = -1` 镜像出对称管）；root → `Projectile`（Animator）→ `Booster`(MSL_Booster) → `Thruster` + `MSL`×3（三枚子弹头，Z 转 5/125/245°）。
- 材质名带语义：`Default` #151910、`Dark Grey` #111111、`Light Green` #224C17、`Metal` #475261、`Rainbow`（唯一带贴图的，走染色遮罩）、`Red` #CC0000、`Glass` #00F8F5。

### 5.3 防空炮 chn57x2（2870889464，`2019.4.15f1c1`，单 prefab 13433475）

`PartAAGunProxy`：caliber 57、rotateSpeed 50、range 7000、muzzleVelocity 1000、maxAngle 80、rpm 300、dps 102、`isCIWS` false、muzzle (0,0,4.423) 唯一。turret/pedestal 自身 MeshFilter 为空，几何挂在 `柱体_柱体.002` / `立方体.004_立方体.002` 子件 —— **空节点当旋转轴，网格挂子件**是标准做法。

### 5.4 鱼雷 324x3（2873011131，单 prefab 13433496）

`PartTorpedoLauncherProxy`：caliber 324、rotateSpeed 35、range 6000、torpedoSpeed 49、loadTime 15、`canLaunchUnderwater` true、3 个 muzzle、cruiseHeight −3、maxDamage 11500。

## 6. 和船蓝图 `.na` 的关系

船存档（`C:\Users\…\AppData\LocalLow\RZEntertainment\NavalArt\ShipSaves\*.na`）是纯 XML，一个 mod 零件的引用长这样：

```xml
<part id="451130" modname="hpj系列舰炮Vol2.namod" instanceId="2026">
  <position x="12.4" y="6.1" z="-30.2" />
  <rotation x="0" y="90" z="0" />
  <scale x="1" y="1" z="1" />
  <color hex="3C3C3C" />
  <armor value="50" />
</part>
```

- `id` = bundle 内的 prefab 资产名，`modname` = `.namod` 文件名（带扩展名）。游戏启动时把`(modname, id)` 映射到已加载的 bundle。
- 舰体本体是 `<part id="0">` + `<data length height frontWidth backWidth frontSpread backSpread upCurve downCurve heightScale heightOffset/>`（程序化生成的船壳），其它零件都挂在这套坐标系里（米，X 右 / Y 上 / Z 前）。
- 本机 16 艘船里重 mod 依赖很常见：055 Pro 2122 个部件里只 6 个来自 mod（1 个 mod），天津号 392 个部件里 346 个来自 25 个 mod —— **一个 mod 挂掉，整船缺件**。所以 mod 文件名一改，老存档就找不到零件了。

## 7. 制作流程

### 7.1 官方 GUI 路线（推荐给人类）

1. Unity Hub 装 **2019.4.15f1**，新建 3D 工程；
2. 导入 `<游戏>\NavalArt_Data\ModTool\NAModTool 0.20.4.unitypackage`；
3. 顶部菜单 `NavalArt → Mod Builder` 打开 NA Mod 窗口，填 Mod Name / Author / Version / Description；
4. Part Type 选类型点 Create → 调 Proxy → 选中物体点 **Load All Objects**（物体会被改名成它的 id）→ 手动贴合 BoxCollider；
5. 图鉴图：PNG 放 `Resources`，命名 `p<id>`（p 小写），Texture Type 必须设成 **Sprite (2D and UI)**；
6. **Save Mod** 导出 → 得到文件夹（.namod + config.xml + 备份目录），丢进 `NavalArt_Data\Mods\` 或工坊。

### 7.2 脚本化路线（我现在能做的）

本机已有 Unity 2019.4.15f1 编辑器 + DSH 桥（`127.0.0.1:6401`，可执行任意 C#），并且拿到了 `NAModToolCore.dll` 的完整字段。因此可以绕开 GUI：

1. 用桥的 `execute_code` 在工程里程序化生成 GameObject 层级 + `PartAttributeProxy`/`PartTurretProxy` 等组件（字段就是上表）；
2. `BuildPipeline.BuildAssetBundle` 打出 `<name>.namod`（2019.4 编出的版本串即游戏可读）；
3. 拼 `config.xml` + `Preview.png` + `Resources/p<id>.png`；
4. 放进 `NavalArt_Data\Mods\` 实测。

这条路能让 Agent 直接从"一句话需求"产出可加载的 mod；尚未做端到端实机验证（唯一没试过的是第 4 步在游戏里加载）。

## 8. 踩坑清单

| 现象 | 原因 | 修法 |
|---|---|---|
| 图鉴/仓库显示鸽子 + No Preview | `p<id>` 名字不对，或 Texture Type 不是 Sprite | 改名、改类型、确认在 `Resources` |
| 物体名总是变回 1000 | 没改 `PartAttributeProxy.id` | 每个部件唯一 id |
| prefab 保存报 "references a missing script" | id 重复 / 信息没填全 | 唯一 id + 填满 Mod 信息 |
| 炮口对着别处开火 | 模型朝向不是 +Z | 建模时把炮口指向蓝轴 |
| 装 mod 后游戏相机不聚焦船 | 模型导入没勾 `Read Write Enabled` | 勾上 |
| 导弹动画一直循环 | 动画 Loop Time 开着 | 关掉 |
| 炮座和供弹机之间有缝 | pedestal 旋转不是 (0,0,0) | 归零 |
| 外挂导弹贴图丢失 | Prewarmed 复用了 `missileRes` | 另建实例 |
| 吸附/放置异常 | collider 精度 < 0.1 或体积不合 | 最小 0.1，手动贴合 |
| 掉帧 | 每个部件自带大贴图 | 用默认材质，高模件加 `PartColorMask` |

## 9. 版本兼容性（重要）

本机 327 个 `.namod` 的构建版本分布：

| 构建版本 | 数量 | 能否在 2019.4.15f1 编辑器打开 |
|---|---|---|
| 2019.4.15f1c1 | 187 | 能 |
| 2019.4.39f1c1 | 33 | 能（实测） |
| 2019.4.40f1c1 | 31 | 能 |
| 2019.4.19f1c1 | 15 | 能 |
| 2019.3.1f1 | 13 | 能（实测 starstreak） |
| 2019.4.15f1 / 2019.3.7f1 / 2019.4.35f1c1 / 2019.4.40f1 / 2019.4.31f1 | 7 / 4 / 2 / 1 / 1 | 能 |
| **2021.3.15f1c1** | 30 | **不能** |
| 2021.3.45f1 / 2021.3.45f2c1 | 1 / 1 | **不能** |
| **2020.3.48f1c1** | 1 | **不能** |

- 失败时的原文：`Unable to read header from archive file: <path>`（AssetBundle archive format 版本高于 2019 的上限 7）。
- 即约 **33 个（10%）** 工坊 mod 是用 Unity 2020/2021 打的，游戏能读（游戏本体是 2021.3.34f1），但官方 ModTool 2019.4.15f1 **打不开**。想改它们只能用 2021 版 Unity + 新版 ModTool，或解包后重建。
- 体积提醒：`hpj系列舰炮vol2.namod` 492 MB（2020 构建）、`老中雷霆舰载机史诗级大包.namod` 535 MB（2021 构建）、`coastal fleet weapon pack.namod` 260 MB（2019，可读）。

## 10. 逆向与检查工具（本仓库）

- `E:\工作区\tmp\navalart-mod\bridge-send.mjs`：向 Unity 桥发任意命令（`node bridge-send.mjs <command> <params.json>`）。
- `inspect-txt.cs.txt` + `inspect-args.txt`：载入任意 `.namod`，导出全部资产清单 + prefab 层级/组件字段/网格统计到文本报告。
- `preview.cs.txt` + `preview-args.txt`：把 prefab 实例化到场景里摆拍（配合桥的 `screenshot` 出图）。
- 前提：Unity 工程 `E:\Unity\DSHProject` 里已放好 `Assets\ModInspect\NAModToolCore.dll`（guid 必须是 0741ad192fcd8df4bb480ec0caaa4c28，否则组件里全是 missing script）。

## 11. 渲染样张

- 舰炮：`E:\工作区\unity-mcp\screenshots\mod_ger30x12.png`
- 导弹：`E:\工作区\unity-mcp\screenshots\mod_starstreak.png`
