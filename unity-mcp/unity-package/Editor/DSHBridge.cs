using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;
using Debug = UnityEngine.Debug;

namespace DSHUnityBridge
{
    /// <summary>
    /// Local TCP bridge that lets the DSH agent drive the Unity editor: inspect the scene,
    /// create objects/materials, run C# snippets and take screenshots.
    /// Protocol: one JSON object per line on 127.0.0.1:6401, see docs/PROTOCOL.md.
    /// </summary>
    [InitializeOnLoad]
    public static class Bridge
    {
        public const int DefaultPort = 6401;
        const string PortKey = "DSHUnityBridge.Port";
        const string AutoStartKey = "DSHUnityBridge.AutoStart";
        const int MaxLogs = 500;

        static TcpListener listener;
        static Thread acceptThread;
        static volatile bool running;
        static int startAttempts;
        static readonly ConcurrentQueue<Job> queue = new ConcurrentQueue<Job>();
        static readonly List<Dictionary<string, object>> logs = new List<Dictionary<string, object>>();
        static readonly object logLock = new object();
        static string lastError = "";

        public static int Port { get { return EditorPrefs.GetInt(PortKey, DefaultPort); } }
        public static bool IsListening { get { return running; } }
        public static string LastError { get { return lastError; } }

        sealed class Job
        {
            public string Id;
            public string Command;
            public Dictionary<string, object> Params;
            public NetworkStream Stream;
            public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
        }

        static Bridge()
        {
            EditorApplication.update += Pump;
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
            Application.logMessageReceived += OnLog;
            EditorApplication.delayCall += AutoStart;
        }

        static void AutoStart()
        {
            if (!EditorPrefs.GetBool(AutoStartKey, true)) return;
            Start();
        }

        public static void Start()
        {
            if (running) return;
            try
            {
                listener = new TcpListener(IPAddress.Loopback, Port);
                listener.Start();
                running = true;
                startAttempts = 0;
                lastError = "";
                acceptThread = new Thread(AcceptLoop);
                acceptThread.IsBackground = true;
                acceptThread.Name = "DSHUnityBridge";
                acceptThread.Start();
                Debug.Log("[DSH] Unity 桥已启动: 127.0.0.1:" + Port);
            }
            catch (Exception e)
            {
                lastError = e.Message;
                running = false;
                try { if (listener != null) listener.Stop(); } catch { }
                startAttempts++;
                if (startAttempts <= 20)
                {
                    Debug.LogWarning("[DSH] 端口 " + Port + " 绑定失败（" + e.Message + "），1 秒后重试 " + startAttempts + "/20");
                    EditorApplication.delayCall += RetryStart;
                }
                else
                {
                    Debug.LogError("[DSH] Unity 桥启动失败: " + e.Message);
                }
            }
        }

        static void RetryStart()
        {
            if (!running) Start();
        }

        public static void Stop()
        {
            running = false;
            try { if (listener != null) listener.Stop(); } catch { }
            listener = null;
            var t = acceptThread;
            acceptThread = null;
            if (t != null)
            {
                try { t.Join(500); } catch { }
            }
        }

        public static void Restart()
        {
            Stop();
            startAttempts = 0;
            Start();
        }

        public static void SetPort(int port)
        {
            EditorPrefs.SetInt(PortKey, Mathf.Clamp(port, 1024, 65535));
            Restart();
        }

        static void AcceptLoop()
        {
            while (running)
            {
                TcpClient client = null;
                try
                {
                    client = listener.AcceptTcpClient();
                }
                catch
                {
                    if (!running) break;
                    Thread.Sleep(100);
                    continue;
                }
                ThreadPool.QueueUserWorkItem(delegate (object state) { HandleClient((TcpClient)state); }, client);
            }
        }

        static void HandleClient(TcpClient client)
        {
            using (client)
            {
                client.NoDelay = true;
                client.ReceiveTimeout = 600000;
                client.SendTimeout = 60000;
                NetworkStream stream = client.GetStream();
                var reader = new StreamReader(stream, new UTF8Encoding(false), false, 8192, true);
                var writer = new StreamWriter(stream, new UTF8Encoding(false), 8192, true) { AutoFlush = true };
                try
                {
                    string line;
                    while (running && (line = reader.ReadLine()) != null)
                    {
                        if (line.Trim().Length == 0) continue;
                        string id = null;
                        try
                        {
                            var parsed = DSHJson.Deserialize(line) as Dictionary<string, object>;
                            if (parsed == null) throw new Exception("请求必须是 JSON 对象");
                            object idObj;
                            parsed.TryGetValue("id", out idObj);
                            id = idObj == null ? null : Convert.ToString(idObj, CultureInfo.InvariantCulture);
                            object cmdObj;
                            parsed.TryGetValue("command", out cmdObj);
                            string command = cmdObj == null ? "" : Convert.ToString(cmdObj);
                            var ps = new Dictionary<string, object>(StringComparer.Ordinal);
                            object paramsObj;
                            if (parsed.TryGetValue("params", out paramsObj))
                            {
                                var pd = paramsObj as Dictionary<string, object>;
                                if (pd != null) ps = pd;
                            }
                            var job = new Job { Id = id, Command = command, Params = ps, Stream = stream };
                            queue.Enqueue(job);
                            if (!job.Done.Wait(600000))
                            {
                                WriteLine(writer, ErrorResponse(id, "命令执行超时（600s）"));
                            }
                        }
                        catch (Exception e)
                        {
                            WriteLine(writer, ErrorResponse(id, e.Message));
                        }
                    }
                }
                catch { }
            }
        }

        static void WriteLine(StreamWriter writer, string text)
        {
            try { writer.WriteLine(text); } catch { }
        }

        static void Pump()
        {
            Job job;
            while (queue.TryDequeue(out job))
            {
                string response;
                try
                {
                    object result = Dispatch(job.Command, job.Params ?? new Dictionary<string, object>());
                    response = DSHJson.Serialize(new Dictionary<string, object>
                    {
                        { "id", job.Id },
                        { "status", "ok" },
                        { "result", result }
                    });
                }
                catch (Exception e)
                {
                    response = ErrorResponse(job.Id, e.Message);
                    if (!(e is DSHCommandException))
                        Debug.LogWarning("[DSH] " + job.Command + " 失败: " + e.Message);
                }
                try
                {
                    byte[] bytes = Encoding.UTF8.GetBytes(response + "\n");
                    job.Stream.Write(bytes, 0, bytes.Length);
                }
                catch { }
                job.Done.Set();
            }
        }

        sealed class DSHCommandException : Exception
        {
            public DSHCommandException(string message) : base(message) { }
        }

        static string ErrorResponse(string id, string message)
        {
            return DSHJson.Serialize(new Dictionary<string, object>
            {
                { "id", id },
                { "status", "error" },
                { "error", message ?? "unknown error" }
            });
        }

        static object Dispatch(string command, Dictionary<string, object> p)
        {
            switch (command)
            {
                case "ping": return Ping();
                case "project_info": return ProjectInfo();
                case "get_scene_info": return SceneInfo(p);
                case "execute_code": return ExecuteCode(p);
                case "create_primitive": return CreatePrimitive(p);
                case "create_empty": return CreateEmpty(p);
                case "set_transform": return SetTransform(p);
                case "delete_object": return DeleteObject(p);
                case "duplicate_object": return DuplicateObject(p);
                case "add_component": return AddComponent(p);
                case "create_material": return CreateMaterial(p);
                case "assign_material": return AssignMaterial(p);
                case "import_asset": return ImportAsset(p);
                case "instantiate_prefab": return InstantiatePrefab(p);
                case "screenshot": return Screenshot(p);
                case "save_scene": return SaveScene(p);
                case "open_scene": return OpenScene(p);
                case "new_scene": return NewScene(p);
                case "menu": return Menu(p);
                case "get_logs": return GetLogs(p);
                case "clear_logs": logs.Clear(); return Dict("cleared", true);
                case "get_selection": return SelectionInfo();
                case "select": return SelectObject(p);
                case "undo": Undo.PerformUndo(); return Dict("done", true);
                case "redo": Undo.PerformRedo(); return Dict("done", true);
                case "set_play_mode": return SetPlayMode(p);
                case "asset_search": return AssetSearch(p);
                case "import_package": return ImportPackage(p);
                default: throw new DSHCommandException("未知命令: " + command);
            }
        }

        // ---------------------------------------------------------------- basics

        static Dictionary<string, object> Ping()
        {
            var scene = SceneManager.GetActiveScene();
            return new Dictionary<string, object>
            {
                { "pong", true },
                { "unityVersion", Application.unityVersion },
                { "projectPath", ProjectPath() },
                { "platform", Application.platform.ToString() },
                { "isPlaying", EditorApplication.isPlaying },
                { "isPaused", EditorApplication.isPaused },
                { "isCompiling", EditorApplication.isCompiling },
                { "scene", scene.name },
                { "port", Port },
                { "time", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") }
            };
        }

        static Dictionary<string, object> ProjectInfo()
        {
            var scene = SceneManager.GetActiveScene();
            int objects = 0;
            foreach (var go in Resources.FindObjectsOfTypeAll<GameObject>())
            {
                if (go.scene.IsValid() && !EditorUtility.IsPersistent(go)) objects++;
            }
            int assets = AssetDatabase.GetAllAssetPaths().Length;
            string pipeline = "Built-in";
            try
            {
                var rp = UnityEngine.Rendering.GraphicsSettings.renderPipelineAsset;
                if (rp != null) pipeline = rp.GetType().Name;
            }
            catch { }
            return new Dictionary<string, object>
            {
                { "projectPath", ProjectPath() },
                { "unityVersion", Application.unityVersion },
                { "productName", PlayerSettings.productName },
                { "companyName", PlayerSettings.companyName },
                { "renderPipeline", pipeline },
                { "scenePath", scene.path },
                { "sceneName", scene.name },
                { "objectCount", objects },
                { "assetCount", assets }
            };
        }

        static Dictionary<string, object> SceneInfo(Dictionary<string, object> p)
        {
            int limit = (int)Num(p, "limit", 500);
            if (limit < 1) limit = 1;
            if (limit > 5000) limit = 5000;
            bool includeInactive = Bool(p, "includeInactive", true);
            var scene = SceneManager.GetActiveScene();
            var list = new List<object>();
            int rootCount = 0;
            foreach (var root in scene.GetRootGameObjects())
            {
                rootCount++;
                Collect(root.transform, list, limit, includeInactive);
                if (list.Count >= limit) break;
            }
            return new Dictionary<string, object>
            {
                { "scene", scene.name },
                { "path", scene.path },
                { "rootCount", rootCount },
                { "truncated", list.Count >= limit },
                { "objects", list }
            };
        }

        static void Collect(Transform t, List<object> list, int limit, bool includeInactive)
        {
            if (list.Count >= limit) return;
            var go = t.gameObject;
            if (!includeInactive && !go.activeInHierarchy) return;
            list.Add(new Dictionary<string, object>
            {
                { "name", go.name },
                { "path", PathOf(t) },
                { "type", "GameObject" },
                { "instanceId", go.GetInstanceID() },
                { "active", go.activeSelf },
                { "activeInHierarchy", go.activeInHierarchy },
                { "position", Vec3(t.position) },
                { "rotation", Vec3(t.eulerAngles) },
                { "scale", Vec3(t.localScale) },
                { "children", t.childCount },
                { "tag", go.tag },
                { "layer", go.layer },
                { "components", go.GetComponents<Component>().Where(c => c != null).Select(c => c.GetType().Name).ToList() }
            });
            for (int i = 0; i < t.childCount && list.Count < limit; i++)
                Collect(t.GetChild(i), list, limit, includeInactive);
        }

        static Dictionary<string, object> ExecuteCode(Dictionary<string, object> p)
        {
            string code = Str(p, "code", null);
            if (string.IsNullOrEmpty(code)) throw new DSHCommandException("缺少 code 参数");
            var captured = new List<object>();
            Application.LogCallback handler = delegate (string condition, string stackTrace, LogType type)
            {
                lock (captured)
                {
                    if (captured.Count < 300)
                        captured.Add(Dict("type", type.ToString(), "message", condition, "stackTrace", stackTrace));
                }
            };
            var sw = Stopwatch.StartNew();
            object result;
            Application.logMessageReceived += handler;
            try { result = DSHCodeRunner.Run(code); }
            finally
            {
                Application.logMessageReceived -= handler;
                sw.Stop();
            }
            return new Dictionary<string, object>
            {
                { "compiled", true },
                { "result", Safe(result) },
                { "logs", captured },
                { "durationMs", sw.ElapsedMilliseconds }
            };
        }

        // ---------------------------------------------------------------- scene objects

        static Dictionary<string, object> CreatePrimitive(Dictionary<string, object> p)
        {
            string typeName = Str(p, "type", "Cube");
            PrimitiveType pt;
            try { pt = (PrimitiveType)Enum.Parse(typeof(PrimitiveType), typeName, true); }
            catch { throw new DSHCommandException("不支持的 primitive 类型: " + typeName + "（Cube/Sphere/Cylinder/Capsule/Plane/Quad）"); }
            var go = GameObject.CreatePrimitive(pt);
            string name = Str(p, "name", null);
            if (!string.IsNullOrEmpty(name)) go.name = name;
            ApplyParent(go.transform, Str(p, "parent", null));
            go.transform.position = Vec(p, "position", go.transform.position);
            go.transform.rotation = Quaternion.Euler(Vec(p, "rotation", Vector3.zero));
            go.transform.localScale = Vec(p, "scale", Vector3.one);
            Undo.RegisterCreatedObjectUndo(go, "DSH Create " + go.name);
            string material = Str(p, "material", null);
            if (!string.IsNullOrEmpty(material)) AssignMaterialTo(go, material, true);
            Selection.activeGameObject = go;
            return ObjectRef(go);
        }

        static Dictionary<string, object> CreateEmpty(Dictionary<string, object> p)
        {
            var go = new GameObject(Str(p, "name", "GameObject"));
            ApplyParent(go.transform, Str(p, "parent", null));
            go.transform.position = Vec(p, "position", Vector3.zero);
            Undo.RegisterCreatedObjectUndo(go, "DSH Create " + go.name);
            Selection.activeGameObject = go;
            return ObjectRef(go);
        }

        static Dictionary<string, object> SetTransform(Dictionary<string, object> p)
        {
            var go = FindGo(Str(p, "target", null));
            Undo.RecordObject(go.transform, "DSH Set Transform");
            bool world = Bool(p, "worldSpace", true);
            if (p.ContainsKey("position"))
            {
                if (world) go.transform.position = Vec(p, "position", go.transform.position);
                else go.transform.localPosition = Vec(p, "position", go.transform.localPosition);
            }
            if (p.ContainsKey("rotation"))
            {
                var q = Quaternion.Euler(Vec(p, "rotation", Vector3.zero));
                if (world) go.transform.rotation = q; else go.transform.localRotation = q;
            }
            if (p.ContainsKey("scale")) go.transform.localScale = Vec(p, "scale", go.transform.localScale);
            EditorUtility.SetDirty(go);
            return new Dictionary<string, object>
            {
                { "path", PathOf(go.transform) },
                { "position", Vec3(go.transform.position) },
                { "rotation", Vec3(go.transform.eulerAngles) },
                { "scale", Vec3(go.transform.localScale) }
            };
        }

        static Dictionary<string, object> DeleteObject(Dictionary<string, object> p)
        {
            var go = FindGo(Str(p, "target", null));
            string path = PathOf(go.transform);
            Undo.DestroyObjectImmediate(go);
            return Dict("deleted", true, "path", path);
        }

        static Dictionary<string, object> DuplicateObject(Dictionary<string, object> p)
        {
            var go = FindGo(Str(p, "target", null));
            var copy = Object.Instantiate(go);
            copy.name = Str(p, "name", go.name + " (Copy)");
            copy.transform.SetParent(go.transform.parent, true);
            Undo.RegisterCreatedObjectUndo(copy, "DSH Duplicate " + copy.name);
            Selection.activeGameObject = copy;
            return ObjectRef(copy);
        }

        static Dictionary<string, object> AddComponent(Dictionary<string, object> p)
        {
            var go = FindGo(Str(p, "target", null));
            string name = Str(p, "component", null);
            if (string.IsNullOrEmpty(name)) throw new DSHCommandException("缺少 component 参数");
            Type type = ResolveComponentType(name);
            var comp = Undo.AddComponent(go, type);
            object propsObj;
            if (p.TryGetValue("properties", out propsObj))
            {
                var props = propsObj as Dictionary<string, object>;
                if (props != null) SetProperties(comp, props);
            }
            EditorUtility.SetDirty(comp);
            return Dict("path", PathOf(go.transform), "component", type.Name, "typeName", type.FullName);
        }

        static Type ResolveComponentType(string name)
        {
            Type type = Type.GetType(name, false);
            if (type == null) type = Type.GetType("UnityEngine." + name + ", UnityEngine", false);
            if (type == null)
            {
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    type = asm.GetType(name, false) ?? asm.GetType("UnityEngine." + name, false);
                    if (type != null) break;
                }
            }
            if (type == null || !typeof(Component).IsAssignableFrom(type))
                throw new DSHCommandException("找不到组件类型: " + name);
            return type;
        }

        static void SetProperties(Component comp, Dictionary<string, object> props)
        {
            Type t = comp.GetType();
            foreach (var kv in props)
            {
                var prop = t.GetProperty(kv.Key, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                if (prop != null && prop.CanWrite)
                {
                    prop.SetValue(comp, ConvertTo(kv.Value, prop.PropertyType), null);
                    continue;
                }
                var field = t.GetField(kv.Key, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                if (field != null)
                {
                    field.SetValue(comp, ConvertTo(kv.Value, field.FieldType));
                    continue;
                }
                throw new DSHCommandException("组件 " + t.Name + " 没有属性/字段 " + kv.Key);
            }
        }

        // ---------------------------------------------------------------- materials

        static Dictionary<string, object> CreateMaterial(Dictionary<string, object> p)
        {
            string name = Str(p, "name", "DSH Material");
            string savePath = Str(p, "savePath", null);
            if (string.IsNullOrEmpty(savePath)) savePath = "Assets/DSH/Materials/" + Sanitize(name) + ".mat";
            savePath = ToAssetPath(savePath);
            if (!savePath.EndsWith(".mat", StringComparison.OrdinalIgnoreCase)) savePath += ".mat";
            EnsureAssetFolder(Path.GetDirectoryName(savePath).Replace('\\', '/'));

            var mat = AssetDatabase.LoadAssetAtPath<Material>(savePath);
            if (mat == null)
            {
                Shader shader = FindShader();
                if (shader == null) throw new DSHCommandException("找不到可用 shader（Standard / URP / HDRP）");
                mat = new Material(shader);
                mat.name = Path.GetFileNameWithoutExtension(savePath);
                AssetDatabase.CreateAsset(mat, savePath);
            }
            Color color = Col(p, "color", Color.white);
            SetColorIf(mat, "_Color", color);
            SetColorIf(mat, "_BaseColor", color);
            if (p.ContainsKey("metallic")) SetFloatIf(mat, "_Metallic", (float)Num(p, "metallic", 0));
            if (p.ContainsKey("smoothness"))
            {
                SetFloatIf(mat, "_Glossiness", (float)Num(p, "smoothness", 0.5));
                SetFloatIf(mat, "_Smoothness", (float)Num(p, "smoothness", 0.5));
            }
            Color emission = Col(p, "emission", Color.black);
            if (emission.maxColorComponent > 0.001f)
            {
                mat.EnableKeyword("_EMISSION");
                SetColorIf(mat, "_EmissionColor", emission);
            }
            EditorUtility.SetDirty(mat);
            AssetDatabase.SaveAssets();
            return Dict("assetPath", savePath, "shader", mat.shader != null ? mat.shader.name : "unknown");
        }

        static Dictionary<string, object> AssignMaterial(Dictionary<string, object> p)
        {
            var go = FindGo(Str(p, "target", null));
            string matPath = Str(p, "material", null);
            if (string.IsNullOrEmpty(matPath)) throw new DSHCommandException("缺少 material 参数");
            int count = AssignMaterialTo(go, matPath, Bool(p, "includeChildren", true));
            return Dict("path", PathOf(go.transform), "material", ToAssetPath(matPath), "renderers", count);
        }

        static int AssignMaterialTo(GameObject go, string matPath, bool includeChildren)
        {
            matPath = ToAssetPath(matPath);
            var mat = AssetDatabase.LoadAssetAtPath<Material>(matPath);
            if (mat == null) throw new DSHCommandException("找不到材质: " + matPath);
            var renderers = includeChildren ? go.GetComponentsInChildren<Renderer>(true) : go.GetComponents<Renderer>();
            foreach (var r in renderers)
            {
                Undo.RecordObject(r, "DSH Assign Material");
                var mats = r.sharedMaterials;
                if (mats.Length == 0) mats = new Material[1];
                for (int i = 0; i < mats.Length; i++) mats[i] = mat;
                r.sharedMaterials = mats;
                EditorUtility.SetDirty(r);
            }
            return renderers.Length;
        }

        static Shader FindShader()
        {
            string[] names = { "Standard", "Universal Render Pipeline/Lit", "HDRP/Lit", "Legacy Shaders/Diffuse" };
            foreach (string n in names)
            {
                var s = Shader.Find(n);
                if (s != null) return s;
            }
            return null;
        }

        static void SetColorIf(Material m, string prop, Color c)
        {
            if (m.HasProperty(prop)) m.SetColor(prop, c);
        }

        static void SetFloatIf(Material m, string prop, float v)
        {
            if (m.HasProperty(prop)) m.SetFloat(prop, v);
        }

        // ---------------------------------------------------------------- assets

        static Dictionary<string, object> ImportAsset(Dictionary<string, object> p)
        {
            string source = Str(p, "sourcePath", null);
            if (string.IsNullOrEmpty(source)) throw new DSHCommandException("缺少 sourcePath");
            if (!File.Exists(source)) throw new DSHCommandException("源文件不存在: " + source);
            string folder = ToAssetPath(Str(p, "destinationFolder", "Assets/DSH/Imports"));
            EnsureAssetFolder(folder);
            string fileName = Path.GetFileName(source);
            string destAsset = folder + "/" + fileName;
            string destAbs = AssetPathToAbsolute(destAsset);
            Directory.CreateDirectory(Path.GetDirectoryName(destAbs));
            File.Copy(source, destAbs, true);
            AssetDatabase.ImportAsset(destAsset, ImportAssetOptions.ForceUpdate);
            var result = Dict("assetPath", destAsset, "instantiated", false);
            if (Bool(p, "instantiate", true))
            {
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(destAsset);
                if (prefab != null)
                {
                    var inst = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
                    if (inst == null) inst = (GameObject)Object.Instantiate(prefab);
                    inst.name = Str(p, "name", Path.GetFileNameWithoutExtension(fileName));
                    inst.transform.position = Vec(p, "position", Vector3.zero);
                    Undo.RegisterCreatedObjectUndo(inst, "DSH Import " + inst.name);
                    Selection.activeGameObject = inst;
                    result["instantiated"] = true;
                    result["name"] = inst.name;
                    result["path"] = PathOf(inst.transform);
                    result["instanceId"] = inst.GetInstanceID();
                }
            }
            return result;
        }

        static Dictionary<string, object> InstantiatePrefab(Dictionary<string, object> p)
        {
            string assetPath = ToAssetPath(Str(p, "assetPath", null));
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (prefab == null) throw new DSHCommandException("找不到模型/预制体: " + assetPath);
            var inst = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            if (inst == null) inst = (GameObject)Object.Instantiate(prefab);
            inst.name = Str(p, "name", prefab.name);
            inst.transform.position = Vec(p, "position", Vector3.zero);
            Undo.RegisterCreatedObjectUndo(inst, "DSH Instantiate " + inst.name);
            Selection.activeGameObject = inst;
            return ObjectRef(inst);
        }

        static Dictionary<string, object> AssetSearch(Dictionary<string, object> p)
        {
            string query = Str(p, "query", "");
            string type = Str(p, "type", null);
            int limit = (int)Num(p, "limit", 50);
            var filter = new StringBuilder(query);
            if (!string.IsNullOrEmpty(type))
            {
                string t = type.ToLowerInvariant();
                if (t == "model" || t == "mesh") filter.Append(" t:Model");
                else if (t == "prefab") filter.Append(" t:Prefab");
                else if (t == "material" || t == "mat") filter.Append(" t:Material");
                else if (t == "texture" || t == "image") filter.Append(" t:Texture");
                else if (t == "scene") filter.Append(" t:Scene");
                else filter.Append(" t:" + type);
            }
            string[] guids = AssetDatabase.FindAssets(filter.ToString());
            var list = new List<object>();
            foreach (string g in guids)
            {
                if (list.Count >= limit) break;
                string path = AssetDatabase.GUIDToAssetPath(g);
                if (string.IsNullOrEmpty(path)) continue;
                var main = AssetDatabase.GetMainAssetTypeAtPath(path);
                list.Add(Dict("path", path, "name", Path.GetFileNameWithoutExtension(path), "type", main == null ? "Unknown" : main.Name));
            }
            return Dict("assets", list, "count", list.Count);
        }

        static Dictionary<string, object> ImportPackage(Dictionary<string, object> p)
        {
            string path = Str(p, "path", null);
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) throw new DSHCommandException("unitypackage 不存在: " + path);
            AssetDatabase.ImportPackage(path, false);
            return Dict("imported", true);
        }

        // ---------------------------------------------------------------- screenshots

        static Dictionary<string, object> Screenshot(Dictionary<string, object> p)
        {
            int width = Mathf.Clamp((int)Num(p, "width", 1280), 16, 8192);
            int height = Mathf.Clamp((int)Num(p, "height", 720), 16, 8192);
            string view = Str(p, "view", "auto");
            string targetName = Str(p, "target", null);
            GameObject target = null;
            if (!string.IsNullOrEmpty(targetName)) target = FindGo(targetName);

            string path = Str(p, "path", null);
            if (string.IsNullOrEmpty(path))
            {
                string dir = Path.Combine(ProjectPath(), "DSH_Screenshots");
                Directory.CreateDirectory(dir);
                path = Path.Combine(dir, "shot_" + DateTime.Now.ToString("yyyyMMdd_HHmmss_fff") + ".png");
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path));

            Camera cam = null;
            GameObject temp = null;
            string cameraName = "";
            try
            {
                if (view == "scene" && SceneView.lastActiveSceneView != null && SceneView.lastActiveSceneView.camera != null)
                {
                    cam = SceneView.lastActiveSceneView.camera;
                    cameraName = "SceneView";
                }
                else if (view != "scene")
                {
                    cam = Camera.main;
                    if (cam == null)
                    {
                        var cams = Object.FindObjectsOfType<Camera>();
                        cam = cams.FirstOrDefault(c => c.isActiveAndEnabled);
                    }
                    if (cam != null) cameraName = cam.name;
                }

                if (target != null || cam == null)
                {
                    Bounds bounds = ComputeBounds(target);
                    temp = new GameObject("DSH_ScreenshotCamera");
                    cam = temp.AddComponent<Camera>();
                    cam.clearFlags = CameraClearFlags.SolidColor;
                    cam.backgroundColor = new Color(0.11f, 0.12f, 0.14f, 1f);
                    cam.fieldOfView = 45f;
                    cam.nearClipPlane = 0.01f;
                    cam.farClipPlane = 20000f;
                    float radius = Mathf.Max(bounds.extents.magnitude, 0.5f);
                    float dist = radius / Mathf.Sin(45f * Mathf.Deg2Rad) * 1.15f;
                    Vector3 dir = new Vector3(0.65f, 0.5f, -1f).normalized;
                    cam.transform.position = bounds.center + dir * dist;
                    cam.transform.LookAt(bounds.center);
                    cameraName = "DSH_ScreenshotCamera";
                }

                RenderTexture rt = RenderTexture.GetTemporary(width, height, 24, RenderTextureFormat.ARGB32);
                RenderTexture prevActive = RenderTexture.active;
                RenderTexture prevTarget = cam.targetTexture;
                try
                {
                    cam.targetTexture = rt;
                    cam.Render();
                    RenderTexture.active = rt;
                    var tex = new Texture2D(width, height, TextureFormat.RGB24, false);
                    tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                    tex.Apply();
                    File.WriteAllBytes(path, tex.EncodeToPNG());
                    Object.DestroyImmediate(tex);
                }
                finally
                {
                    cam.targetTexture = prevTarget;
                    RenderTexture.active = prevActive;
                    RenderTexture.ReleaseTemporary(rt);
                }
            }
            finally
            {
                if (temp != null) Object.DestroyImmediate(temp);
            }
            return Dict("path", path, "width", width, "height", height, "camera", cameraName);
        }

        static Bounds ComputeBounds(GameObject target)
        {
            Renderer[] renderers;
            if (target != null) renderers = target.GetComponentsInChildren<Renderer>();
            else renderers = Object.FindObjectsOfType<Renderer>();
            bool has = false;
            Bounds b = new Bounds(Vector3.zero, Vector3.one * 2f);
            foreach (var r in renderers)
            {
                if (r == null || !r.enabled || !r.gameObject.activeInHierarchy) continue;
                if (!has) { b = r.bounds; has = true; }
                else b.Encapsulate(r.bounds);
            }
            return b;
        }

        // ---------------------------------------------------------------- scenes / misc

        static Dictionary<string, object> SaveScene(Dictionary<string, object> p)
        {
            string path = Str(p, "path", null);
            if (string.IsNullOrEmpty(path))
            {
                EditorSceneManager.SaveOpenScenes();
                var s = SceneManager.GetActiveScene();
                return Dict("path", s.path, "saved", true);
            }
            path = ToAssetPath(path);
            if (!path.EndsWith(".unity", StringComparison.OrdinalIgnoreCase)) path += ".unity";
            EnsureAssetFolder(Path.GetDirectoryName(path).Replace('\\', '/'));
            bool ok = EditorSceneManager.SaveScene(SceneManager.GetActiveScene(), path);
            return Dict("path", path, "saved", ok);
        }

        static Dictionary<string, object> OpenScene(Dictionary<string, object> p)
        {
            string path = ToAssetPath(Str(p, "path", null));
            if (!File.Exists(AssetPathToAbsolute(path))) throw new DSHCommandException("场景不存在: " + path);
            var scene = EditorSceneManager.OpenScene(path, OpenSceneMode.Single);
            return Dict("path", scene.path, "opened", true);
        }

        static Dictionary<string, object> NewScene(Dictionary<string, object> p)
        {
            bool setup = Bool(p, "setup", true);
            var scene = EditorSceneManager.NewScene(setup ? NewSceneSetup.DefaultGameObjects : NewSceneSetup.EmptyScene, NewSceneMode.Single);
            return Dict("scene", scene.name, "path", scene.path);
        }

        static Dictionary<string, object> Menu(Dictionary<string, object> p)
        {
            string path = Str(p, "path", null);
            if (string.IsNullOrEmpty(path)) throw new DSHCommandException("缺少 menu path");
            bool ok = EditorApplication.ExecuteMenuItem(path);
            if (!ok) throw new DSHCommandException("菜单执行失败（路径不存在或不可用）: " + path);
            return Dict("executed", true);
        }

        static Dictionary<string, object> GetLogs(Dictionary<string, object> p)
        {
            int count = Mathf.Clamp((int)Num(p, "count", 50), 1, MaxLogs);
            List<object> entries = new List<object>();
            lock (logLock)
            {
                int start = Math.Max(0, logs.Count - count);
                for (int i = start; i < logs.Count; i++) entries.Add(logs[i]);
            }
            return Dict("entries", entries);
        }

        static Dictionary<string, object> SelectionInfo()
        {
            var list = new List<object>();
            foreach (var go in Selection.gameObjects)
                list.Add(Dict("name", go.name, "path", PathOf(go.transform), "instanceId", go.GetInstanceID()));
            return Dict("objects", list);
        }

        static Dictionary<string, object> SelectObject(Dictionary<string, object> p)
        {
            var go = FindGo(Str(p, "target", null));
            Selection.activeGameObject = go;
            EditorGUIUtility.PingObject(go);
            return Dict("path", PathOf(go.transform), "instanceId", go.GetInstanceID());
        }

        static Dictionary<string, object> SetPlayMode(Dictionary<string, object> p)
        {
            string action = Str(p, "action", null);
            if (!string.IsNullOrEmpty(action))
            {
                if (action == "play") EditorApplication.isPlaying = true;
                else if (action == "stop") EditorApplication.isPlaying = false;
                else if (action == "pause") EditorApplication.isPaused = !EditorApplication.isPaused;
                else throw new DSHCommandException("action 只能是 play/stop/pause");
            }
            if (p.ContainsKey("playing")) EditorApplication.isPlaying = Bool(p, "playing", false);
            return Dict("isPlaying", EditorApplication.isPlaying, "isPaused", EditorApplication.isPaused);
        }

        // ---------------------------------------------------------------- helpers

        static void OnLog(string condition, string stackTrace, LogType type)
        {
            lock (logLock)
            {
                if (logs.Count >= MaxLogs) logs.RemoveAt(0);
                logs.Add(Dict(
                    "type", type.ToString(),
                    "message", condition,
                    "stackTrace", stackTrace,
                    "time", DateTime.Now.ToString("HH:mm:ss")));
            }
        }

        static string ProjectPath()
        {
            return Path.GetDirectoryName(Application.dataPath).Replace('\\', '/');
        }

        static string ToAssetPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return path;
            string p = path.Replace('\\', '/');
            string project = ProjectPath();
            if (p.StartsWith(project + "/", StringComparison.OrdinalIgnoreCase)) return p.Substring(project.Length + 1);
            if (p.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase) || p == "Assets") return p;
            if (Path.IsPathRooted(p)) throw new DSHCommandException("路径必须在工程内（Assets/...）: " + path);
            return "Assets/" + p;
        }

        static string AssetPathToAbsolute(string assetPath)
        {
            return Path.Combine(ProjectPath(), assetPath.Replace('/', Path.DirectorySeparatorChar));
        }

        static void EnsureAssetFolder(string folder)
        {
            if (string.IsNullOrEmpty(folder)) return;
            folder = folder.Replace('\\', '/');
            if (AssetDatabase.IsValidFolder(folder)) return;
            string[] parts = folder.Split('/');
            string cur = parts[0];
            for (int i = 1; i < parts.Length; i++)
            {
                string next = cur + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(cur, parts[i]);
                cur = next;
            }
        }

        static string Sanitize(string name)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return string.IsNullOrEmpty(name) ? "Material" : name;
        }

        static void ApplyParent(Transform t, string parent)
        {
            if (string.IsNullOrEmpty(parent)) return;
            var p = FindGo(parent);
            t.SetParent(p.transform, true);
        }

        static GameObject FindGo(string target)
        {
            if (string.IsNullOrEmpty(target)) throw new DSHCommandException("缺少 target 参数");
            int id;
            if (int.TryParse(target, NumberStyles.Integer, CultureInfo.InvariantCulture, out id))
            {
                var o = EditorUtility.InstanceIDToObject(id) as GameObject;
                if (o != null) return o;
            }
            var direct = GameObject.Find(target);
            if (direct != null) return direct;
            foreach (var root in SceneManager.GetActiveScene().GetRootGameObjects())
            {
                var t = FindInHierarchy(root.transform, target);
                if (t != null) return t.gameObject;
            }
            throw new DSHCommandException("找不到对象: " + target);
        }

        static Transform FindInHierarchy(Transform t, string target)
        {
            if (PathOf(t) == target || t.name == target) return t;
            for (int i = 0; i < t.childCount; i++)
            {
                var found = FindInHierarchy(t.GetChild(i), target);
                if (found != null) return found;
            }
            return null;
        }

        static string PathOf(Transform t)
        {
            var stack = new Stack<string>();
            var cur = t;
            while (cur != null) { stack.Push(cur.name); cur = cur.parent; }
            return string.Join("/", stack.ToArray());
        }

        static Dictionary<string, object> ObjectRef(GameObject go)
        {
            return Dict(
                "name", go.name,
                "path", PathOf(go.transform),
                "instanceId", go.GetInstanceID());
        }

        static object Safe(object value)
        {
            if (value == null) return null;
            if (value is string || value is bool || value is long || value is int || value is short || value is byte ||
                value is uint || value is ulong || value is ushort || value is sbyte) return value;
            if (value is float || value is double || value is decimal) return Convert.ToDouble(value, CultureInfo.InvariantCulture);
            var vec3 = value as Vector3?;
            if (vec3.HasValue) return Vec3(vec3.Value);
            var vec2 = value as Vector2?;
            if (vec2.HasValue) return new List<object> { vec2.Value.x, vec2.Value.y };
            var quat = value as Quaternion?;
            if (quat.HasValue) return Vec3(quat.Value.eulerAngles);
            var col = value as Color?;
            if (col.HasValue) return "#" + ColorUtility.ToHtmlStringRGBA(col.Value);
            var obj = value as Object;
            if (obj != null)
            {
                var go = obj as GameObject;
                var d = Dict("name", obj.name, "type", obj.GetType().Name, "instanceId", obj.GetInstanceID());
                if (go != null) d["path"] = PathOf(go.transform);
                else
                {
                    var comp = obj as Component;
                    if (comp != null && comp.gameObject != null) d["path"] = PathOf(comp.gameObject.transform);
                }
                return d;
            }
            var dict = value as IDictionary;
            if (dict != null)
            {
                var d = new Dictionary<string, object>(StringComparer.Ordinal);
                foreach (DictionaryEntry e in dict) d[Convert.ToString(e.Key, CultureInfo.InvariantCulture)] = Safe(e.Value);
                return d;
            }
            var en = value as IEnumerable;
            if (en != null)
            {
                var list = new List<object>();
                foreach (object item in en)
                {
                    if (list.Count >= 5000) break;
                    list.Add(Safe(item));
                }
                return list;
            }
            return value.ToString();
        }

        static Dictionary<string, object> Dict(params object[] kv)
        {
            var d = new Dictionary<string, object>(StringComparer.Ordinal);
            for (int i = 0; i + 1 < kv.Length; i += 2) d[Convert.ToString(kv[i], CultureInfo.InvariantCulture)] = kv[i + 1];
            return d;
        }

        static List<object> Vec3(Vector3 v)
        {
            return new List<object> { v.x, v.y, v.z };
        }

        static string Str(Dictionary<string, object> p, string key, string def)
        {
            object v;
            if (p != null && p.TryGetValue(key, out v) && v != null) return Convert.ToString(v, CultureInfo.InvariantCulture);
            return def;
        }

        static double Num(Dictionary<string, object> p, string key, double def)
        {
            object v;
            if (p == null || !p.TryGetValue(key, out v) || v == null) return def;
            if (v is double) return (double)v;
            if (v is long) return (long)v;
            return Convert.ToDouble(v, CultureInfo.InvariantCulture);
        }

        static bool Bool(Dictionary<string, object> p, string key, bool def)
        {
            object v;
            if (p == null || !p.TryGetValue(key, out v) || v == null) return def;
            if (v is bool) return (bool)v;
            return Convert.ToBoolean(v, CultureInfo.InvariantCulture);
        }

        static Vector3 Vec(Dictionary<string, object> p, string key, Vector3 def)
        {
            object v;
            if (p == null || !p.TryGetValue(key, out v) || v == null) return def;
            return Vec3From(v);
        }

        static Vector3 Vec3From(object v)
        {
            var list = v as List<object>;
            if (list != null && list.Count >= 3)
                return new Vector3(
                    (float)Convert.ToDouble(list[0], CultureInfo.InvariantCulture),
                    (float)Convert.ToDouble(list[1], CultureInfo.InvariantCulture),
                    (float)Convert.ToDouble(list[2], CultureInfo.InvariantCulture));
            var d = v as Dictionary<string, object>;
            if (d != null && d.ContainsKey("x"))
                return new Vector3(
                    (float)Convert.ToDouble(d["x"], CultureInfo.InvariantCulture),
                    (float)Convert.ToDouble(d["y"], CultureInfo.InvariantCulture),
                    (float)Convert.ToDouble(d["z"], CultureInfo.InvariantCulture));
            throw new DSHCommandException("无法解析 Vector3: " + v);
        }

        static Color Col(Dictionary<string, object> p, string key, Color def)
        {
            object v;
            if (p == null || !p.TryGetValue(key, out v) || v == null) return def;
            return ColorFrom(v);
        }

        static Color ColorFrom(object v)
        {
            var s = v as string;
            if (s != null)
            {
                Color c;
                if (ColorUtility.TryParseHtmlString(s.StartsWith("#") ? s : "#" + s, out c)) return c;
                throw new DSHCommandException("无法解析颜色: " + s);
            }
            var list = v as List<object>;
            if (list != null && list.Count >= 3)
            {
                float a = list.Count >= 4 ? (float)Convert.ToDouble(list[3], CultureInfo.InvariantCulture) : 1f;
                return new Color(
                    (float)Convert.ToDouble(list[0], CultureInfo.InvariantCulture),
                    (float)Convert.ToDouble(list[1], CultureInfo.InvariantCulture),
                    (float)Convert.ToDouble(list[2], CultureInfo.InvariantCulture), a);
            }
            throw new DSHCommandException("无法解析颜色: " + v);
        }

        static object ConvertTo(object v, Type target)
        {
            if (v == null) return null;
            if (target == typeof(float)) return (float)Convert.ToDouble(v, CultureInfo.InvariantCulture);
            if (target == typeof(double)) return Convert.ToDouble(v, CultureInfo.InvariantCulture);
            if (target == typeof(int)) return (int)Convert.ToDouble(v, CultureInfo.InvariantCulture);
            if (target == typeof(long)) return (long)Convert.ToDouble(v, CultureInfo.InvariantCulture);
            if (target == typeof(bool)) return Convert.ToBoolean(v, CultureInfo.InvariantCulture);
            if (target == typeof(string)) return Convert.ToString(v, CultureInfo.InvariantCulture);
            if (target == typeof(Vector2)) { var vec = Vec3From(v); return new Vector2(vec.x, vec.y); }
            if (target == typeof(Vector3)) return Vec3From(v);
            if (target == typeof(Color)) return ColorFrom(v);
            if (target.IsEnum) return Enum.Parse(target, Convert.ToString(v, CultureInfo.InvariantCulture), true);
            return Convert.ChangeType(v, target, CultureInfo.InvariantCulture);
        }
    }
}
