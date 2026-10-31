# Unity DSH 桥协议 v1

DSH 的 Node MCP server 与 Unity 编辑器里的 C# 桥通过本机 TCP 通信。

- 地址：`127.0.0.1:6401`（可在 Unity 菜单 DSH/Unity Bridge 改端口；默认 6401）
- 编码：UTF-8，一行一个 JSON 对象，以 `\n` 分隔（不允许跨行 JSON）
- 客户端（Node）每次请求新建连接，写完请求后读一行响应再关闭。服务端（Unity）也支持同一连接上连续多行请求。
- 请求：`{"id":"<string>","command":"<name>","params":{...}}`
- 成功：`{"id":"<string>","status":"ok","result":<any>}`
- 失败：`{"id":"<string>","status":"error","error":"<message>","stack":"<optional>"}`
- `id` 原样回传；没有 id 也允许，回传 null。

## 坐标与序列化约定

- Vector3 / 四元数旋转一律用长度 3 的数组 `[x,y,z]`；**rotation 是欧拉角（度）**，不是四元数。
- 颜色用 `"#RRGGBB"` 或 `[r,g,b,a]`（0-1）。
- GameObject 的 `target` 参数接受三种写法：层级路径 `"Parent/Child"`、唯一名称 `"Cube"`、instanceId 数字。路径从场景根开始，用 `/` 连接。
- 所有命令在 Unity 主线程执行；执行期间编辑器会卡住，属正常。

## 命令

### ping
params: 无
result: `{"pong":true,"unityVersion":"2019.4.15f1","projectPath":"E:/Unity/DSHProject","platform":"WindowsEditor","isPlaying":false,"isCompiling":false,"scene":"SampleScene","time":"..."}`

### project_info
result: `{"projectPath","unityVersion","productName","companyName","renderPipeline","scenePath","sceneName","objectCount","assetCount"}`

### get_scene_info
params: `{"limit":500,"includeInactive":true}`
result: `{"scene","path","rootCount","truncated":false,"objects":[{"name","path","type":"GameObject","instanceId":123,"active":true,"position":[..],"rotation":[..],"scale":[..],"children":2,"tag":"Untagged","layer":0,"components":["Transform","MeshFilter","MeshRenderer","BoxCollider"]}]}`
objects 是深度优先扁平列表，`children` 为该对象的直接子对象数。

### execute_code
params: `{"code":"var go = GameObject.CreatePrimitive(PrimitiveType.Cube);\nreturn go.name;"}`
result: `{"compiled":true,"result":<JSON 安全值>,"logs":[{"type":"Log","message":"...","stackTrace":""}],"durationMs":12}`
`code` 是 C# 方法体，等价于 `object Run() { <code>; return null; }`；要返回值就写 `return ...;`。可用命名空间：System、System.Collections.Generic、System.Linq、UnityEngine、UnityEditor、UnityEngine.SceneManagement。返回值会转成 JSON 安全值（UnityEngine.Object → 名称/路径，Vector3 → 数组，集合 → 数组，其余 ToString）。
编译失败时 status=error，error 里是编译器诊断原文。

### create_primitive
params: `{"type":"Cube|Sphere|Cylinder|Capsule|Plane|Quad","name":"Cube","position":[0,0.5,0],"rotation":[0,0,0],"scale":[1,1,1],"parent":"Root/Child","material":"Assets/DSH/Materials/Red.mat"}`（除 type 外都可选）
result: `{"name","path","instanceId"}`

### create_empty
params: `{"name":"Group","position":[0,0,0],"parent":"..."}`
result: 同上

### set_transform
params: `{"target":"Cube","position":[..],"rotation":[..],"scale":[..],"worldSpace":true}`（后三个至少给一个）
result: `{"path","position","rotation","scale"}`

### delete_object
params: `{"target":"Cube"}`
result: `{"deleted":true,"path":"Cube"}`

### duplicate_object
params: `{"target":"Cube","name":"Cube (2)"}`
result: `{"name","path","instanceId"}`

### add_component
params: `{"target":"Cube","component":"Rigidbody","properties":{"mass":2,"useGravity":false}}`
result: `{"path","component":"Rigidbody","typeName":"UnityEngine.Rigidbody"}`
properties 支持 float/int/bool/string/数组(Vector3 或 Color)；枚举用字符串名。

### create_material
params: `{"name":"Red","color":"#CC2222","metallic":0.1,"smoothness":0.6,"emission":"#000000","savePath":"Assets/DSH/Materials/Red.mat"}`
result: `{"assetPath":"Assets/DSH/Materials/Red.mat","shader":"Standard"}`
savePath 省略时自动放 `Assets/DSH/Materials/<name>.mat`；同名覆盖。

### assign_material
params: `{"target":"Cube","material":"Assets/DSH/Materials/Red.mat"}`
result: `{"path":"Cube","material":"Assets/DSH/Materials/Red.mat","renderers":1}`

### import_asset
params: `{"sourcePath":"E:/models/ship.fbx","destinationFolder":"Assets/DSH/Models","instantiate":true,"name":"Ship"}`
result: `{"assetPath":"Assets/DSH/Models/ship.fbx","instantiated":true,"name":"Ship","path":"Ship"}`
把外部文件复制进工程并 AssetDatabase.ImportAsset；instantiate=true 时若是模型/预制体则实例化到场景。

### instantiate_prefab
params: `{"assetPath":"Assets/DSH/Models/ship.fbx","position":[0,0,0],"name":"Ship"}`
result: `{"name","path","instanceId"}`

### screenshot
params: `{"path":"E:/.../shot.png","width":1280,"height":720,"view":"auto|game|scene","target":"Cube"}`
result: `{"path","width","height,"camera":"Main Camera"}`
auto：优先 Camera.main / 场景里启用的相机；没有相机或给了 target 时，临时相机对准目标/场景包围盒。view=scene 用 SceneView 相机。

### save_scene
params: `{"path":"Assets/Scenes/Demo.unity"}`（省略则保存当前场景）
result: `{"path","saved":true}`

### open_scene
params: `{"path":"Assets/Scenes/Demo.unity"}`
result: `{"path","opened":true}`

### new_scene
params: `{"setup":true}`（setup=true 自动加 Directional Light + Main Camera）
result: `{"scene":"Untitled","path":""}`

### menu
params: `{"path":"GameObject/3D Object/Cube"}`
result: `{"executed":true}`

### get_logs
params: `{"count":50}`
result: `{"entries":[{"type","message","stackTrace","time"}]}`

### clear_logs
result: `{"cleared":true}`

### get_selection
result: `{"objects":[{"name","path","instanceId"}]}`

### select
params: `{"target":"Cube"}`
result: `{"path","instanceId"}`

### undo / redo
params: 无
result: `{"done":true}`

### set_play_mode
params: `{"playing":true}` 或 `{"action":"play|stop|pause"}`
result: `{"isPlaying":true,"isPaused":false}`

### asset_search
params: `{"query":"ship","type":"Model|Prefab|Material|Texture|Scene","limit":50}`
result: `{"assets":[{"path","name","type"}]}`

### import_package
params: `{"path":"E:/x.unitypackage"}`
result: `{"imported":true}`
