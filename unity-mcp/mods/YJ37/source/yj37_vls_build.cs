
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Collections.Generic;

class DSHSnippet {
    const string MOD_ID = "99037001";
    static Assembly asm;
    static Type TAttr, TMsl, TTube;
    static Dictionary<string, Material> mats = new Dictionary<string, Material>();
    static StringBuilder log = new StringBuilder();

    static void L(string s) { log.AppendLine(s); Debug.Log("[YJ37VLS] " + s); }

    static Material Mat(string name, string hex, float metal, float gloss) {
        string path = "Assets/DSH/Materials/YJ37_Mod_" + name + ".mat";
        var m = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (m == null) {
            m = new Material(Shader.Find("Standard"));
            AssetDatabase.CreateAsset(m, path);
            L("created material " + path);
        }
        Color c;
        ColorUtility.TryParseHtmlString(hex, out c);
        m.color = c;
        m.SetFloat("_Metallic", metal);
        m.SetFloat("_Glossiness", gloss);
        EditorUtility.SetDirty(m);
        return m;
    }

    static Material M(string path) {
        var m = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (m == null) throw new Exception("material missing: " + path);
        return m;
    }

    static void SetF(object o, string name, object val) {
        var f = o.GetType().GetField(name, BindingFlags.Public | BindingFlags.Instance);
        if (f == null) throw new Exception("no field " + name + " on " + o.GetType().Name);
        if (val == null) { f.SetValue(o, null); return; }
        var t = f.FieldType;
        if (t.IsEnum) f.SetValue(o, Enum.ToObject(t, val));
        else if (t == typeof(float)) f.SetValue(o, Convert.ToSingle(val));
        else if (t == typeof(int)) f.SetValue(o, Convert.ToInt32(val));
        else if (t == typeof(bool)) f.SetValue(o, Convert.ToBoolean(val));
        else f.SetValue(o, val);
    }

    static GameObject Empty(string name, Transform parent, Vector3 pos) {
        var go = new GameObject(name);
        go.transform.SetParent(parent, false);
        go.transform.localPosition = pos;
        return go;
    }

    static GameObject Box(string name, Transform parent, Vector3 pos, Vector3 size, string mat) {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.name = name;
        var c = go.GetComponent<Collider>(); if (c != null) UnityEngine.Object.DestroyImmediate(c);
        go.transform.SetParent(parent, false);
        go.transform.localPosition = pos;
        go.transform.localScale = size;
        go.GetComponent<Renderer>().sharedMaterial = mats[mat];
        return go;
    }

    static GameObject CylY(string name, Transform parent, Vector3 pos, float radius, float length, string mat) {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
        go.name = name;
        var c = go.GetComponent<Collider>(); if (c != null) UnityEngine.Object.DestroyImmediate(c);
        go.transform.SetParent(parent, false);
        go.transform.localPosition = pos;
        go.transform.localScale = new Vector3(radius * 2f, length * 0.5f, radius * 2f);
        go.GetComponent<Renderer>().sharedMaterial = mats[mat];
        return go;
    }

    static GameObject CylX(string name, Transform parent, Vector3 pos, float radius, float length, string mat) {
        var go = CylY(name, parent, pos, radius, length, mat);
        go.transform.localEulerAngles = new Vector3(0f, 0f, 90f);
        return go;
    }

    static void EnsureMeshAssets(GameObject root, string dir) {
        Directory.CreateDirectory(dir);
        var used = new HashSet<string>();
        foreach (var mf in root.GetComponentsInChildren<MeshFilter>(true)) {
            var mesh = mf.sharedMesh;
            if (mesh == null) continue;
            if (!string.IsNullOrEmpty(AssetDatabase.GetAssetPath(mesh))) continue;
            string baseName = mf.gameObject.name.Replace("/", "_");
            string fileName = baseName;
            int i = 1;
            while (used.Contains(fileName)) fileName = baseName + "_" + (i++);
            used.Add(fileName);
            string path = AssetDatabase.GenerateUniqueAssetPath(dir + "/" + fileName + ".asset");
            AssetDatabase.CreateAsset(mesh, path);
            mf.sharedMesh = AssetDatabase.LoadAssetAtPath<Mesh>(path);
        }
        AssetDatabase.SaveAssets();
    }

    // 单元格布局：X 三列，Z 两排
    static readonly float[] CELL_X = new float[] { -0.90f, 0f, 0.90f };
    static readonly float[] CELL_Z = new float[] { -0.55f, 0.55f };
    const float CELL_W = 0.80f;      // 舱口开口
    const float LID_OPEN = -95f;     // 舱盖翻开角（绕 X 负角=向上翻）

    public static object Run() {
        // ---- 0. 导弹预制体（含 Booster / Thruster） ----
        var openScene = EditorSceneManager.GetActiveScene();
        if (openScene.path != "Assets/Scenes/YJ37_Model.unity") {
            EditorSceneManager.OpenScene("Assets/Scenes/YJ37_Model.unity", OpenSceneMode.Single);
        }
        var src = GameObject.Find("YJ37_Missile");
        if (src == null) throw new Exception("YJ37_Missile not found in YJ37_Model scene");
        Directory.CreateDirectory("Assets/DSH/Meshes");
        EnsureMeshAssets(src, "Assets/DSH/Meshes");

        string missilePrefabPath = "Assets/Prefabs/YJ37_Missile.prefab";
        Directory.CreateDirectory("Assets/Prefabs");
        PrefabUtility.SaveAsPrefabAsset(src, missilePrefabPath);
        var contents = PrefabUtility.LoadPrefabContents(missilePrefabPath);
        if (contents.transform.Find("Booster") == null) {
            var booster = Empty("Booster", contents.transform, new Vector3(0f, 0f, 0.10f));
            Empty("Thruster", booster.transform, new Vector3(0f, 0f, 0.02f));
            L("added Booster/Thruster");
        }
        PrefabUtility.SaveAsPrefabAsset(contents, missilePrefabPath);
        PrefabUtility.UnloadPrefabContents(contents);
        var missilePrefab = AssetDatabase.LoadAssetAtPath<GameObject>(missilePrefabPath);
        L("missile prefab: " + missilePrefabPath + " bounds=" + missilePrefab.transform.Find("Body") .name);

        // ---- 1. 新场景 ----
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
        RenderSettings.ambientLight = new Color(0.33f, 0.35f, 0.39f);
        RenderSettings.fog = false;
        RenderSettings.skybox = null;

        mats["Hull"] = M("Assets/DSH/Materials/YJ37_Mod_Hull.mat");
        mats["HullDark"] = M("Assets/DSH/Materials/YJ37_Mod_HullDark.mat");
        mats["Steel"] = M("Assets/DSH/Materials/YJ37_Mod_Steel.mat");
        mats["Marking"] = M("Assets/DSH/Materials/YJ37_Mod_Marking.mat");
        mats["Silo"] = Mat("Silo", "#12161A", 0.12f, 0.22f);

        // ---- 2. VLS 模块几何 ----
        var root = new GameObject(MOD_ID);
        var rt = root.transform;

        Box("DeckPlate", rt, new Vector3(0f, 0.10f, 0f), new Vector3(3.34f, 0.20f, 2.80f), "Hull");
        Box("RimFwd", rt, new Vector3(0f, 0.31f, 1.32f), new Vector3(2.86f, 0.22f, 0.16f), "HullDark");
        Box("RimAft", rt, new Vector3(0f, 0.31f, -1.32f), new Vector3(2.86f, 0.22f, 0.16f), "HullDark");
        Box("RimPort", rt, new Vector3(-1.59f, 0.31f, 0f), new Vector3(0.16f, 0.22f, 2.80f), "HullDark");
        Box("RimStbd", rt, new Vector3(1.59f, 0.31f, 0f), new Vector3(0.16f, 0.22f, 2.80f), "HullDark");
        Box("CornerFwdPort", rt, new Vector3(-1.51f, 0.31f, 1.32f), new Vector3(0.24f, 0.22f, 0.16f), "HullDark");
        Box("CornerFwdStbd", rt, new Vector3(1.51f, 0.31f, 1.32f), new Vector3(0.24f, 0.22f, 0.16f), "HullDark");
        Box("CornerAftPort", rt, new Vector3(-1.51f, 0.31f, -1.32f), new Vector3(0.24f, 0.22f, 0.16f), "HullDark");
        Box("CornerAftStbd", rt, new Vector3(1.51f, 0.31f, -1.32f), new Vector3(0.24f, 0.22f, 0.16f), "HullDark");
        Box("CenterRib", rt, new Vector3(0f, 0.23f, 0f), new Vector3(2.86f, 0.06f, 0.30f), "Steel");
        Box("AccessPanel", rt, new Vector3(0f, 0.215f, 1.08f), new Vector3(0.90f, 0.03f, 0.24f), "Steel");
        Box("Conduit", rt, new Vector3(1.45f, 0.245f, 0f), new Vector3(0.09f, 0.07f, 2.50f), "Steel");

        var lids = new List<GameObject>();
        var spawns = new List<GameObject>();
        var missiles = new List<GameObject>();
        int idx = 0;
        foreach (float cz in CELL_Z) {
            foreach (float cx in CELL_X) {
                Box("Silo" + idx, rt, new Vector3(cx, 0.06f, cz), new Vector3(CELL_W, 0.34f, CELL_W), "Silo");
                Box("CollarF" + idx, rt, new Vector3(cx, 0.25f, cz + 0.43f), new Vector3(CELL_W + 0.12f, 0.10f, 0.06f), "Steel");
                Box("CollarA" + idx, rt, new Vector3(cx, 0.25f, cz - 0.43f), new Vector3(CELL_W + 0.12f, 0.10f, 0.06f), "Steel");
                Box("CollarP" + idx, rt, new Vector3(cx - 0.43f, 0.25f, cz), new Vector3(0.06f, 0.10f, CELL_W), "Steel");
                Box("CollarS" + idx, rt, new Vector3(cx + 0.43f, 0.25f, cz), new Vector3(0.06f, 0.10f, CELL_W), "Steel");

                var lid = Empty("Lid" + idx, rt, new Vector3(cx, 0.335f, cz - 0.44f));
                Box("LidPlate", lid.transform, new Vector3(0f, 0f, 0.44f), new Vector3(CELL_W, 0.06f, 0.86f), "HullDark");
                Box("LidEdge", lid.transform, new Vector3(0f, 0f, 0.85f), new Vector3(CELL_W, 0.075f, 0.10f), "Steel");
                Box("LidMark", lid.transform, new Vector3(0f, 0.034f, 0.52f), new Vector3(0.20f, 0.012f, 0.62f), "Marking");
                lids.Add(lid);
                CylX("HingeRod" + idx, rt, new Vector3(cx, 0.335f, cz - 0.44f), 0.038f, 0.78f, "Steel");

                var sp = Empty("SpawnPos" + idx, rt, new Vector3(cx, 0.24f, cz));
                sp.transform.localEulerAngles = new Vector3(270f, 0f, 0f);
                spawns.Add(sp);

                var msl = (GameObject)PrefabUtility.InstantiatePrefab(missilePrefab);
                msl.name = "Missile" + idx;
                msl.transform.SetParent(rt, false);
                msl.transform.localPosition = new Vector3(cx, 0.24f - 8.515f, cz);
                msl.transform.localEulerAngles = new Vector3(270f, 0f, 0f);
                msl.SetActive(false);
                missiles.Add(msl);
                idx++;
            }
        }
        L("cells=" + idx);

        // ---- 3. 弹库（运行时游戏会用它的 collider 尺寸覆盖本体的 collider）----
        var mag = new GameObject("Magazine");
        mag.transform.SetParent(rt, false);
        var mbc = mag.AddComponent<BoxCollider>();
        mbc.center = new Vector3(0f, -1.90f, 0f);
        mbc.size = new Vector3(3.10f, 3.70f, 2.60f);
        mag.SetActive(false);

        // ---- 4. Proxy ----
        asm = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(x => x.GetName().Name == "NAModToolCore");
        if (asm == null) throw new Exception("NAModToolCore assembly not loaded");
        TAttr = asm.GetType("PartAttributeProxy");
        TMsl = asm.GetType("PartMissileProxy");
        TTube = asm.GetType("PartMissileProxy+LauncherTube");

        var attr = root.AddComponent(TAttr);
        SetF(attr, "id", int.Parse(MOD_ID));
        SetF(attr, "basePartId", -1);
        SetF(attr, "basePartModName", "");
        SetF(attr, "armor", 60);
        SetF(attr, "density", 0.5f);
        SetF(attr, "price", 3600);
        SetF(attr, "partName", "YJ-37 垂直发射模块[鹰击-37]");
        SetF(attr, "partDescription", "六联装通用垂直发射模块，超声速反舰导弹，射程 220 km，半穿甲战斗部。");
        SetF(attr, "builderClass", (object)1);
        SetF(attr, "weaponType", (object)4);
        SetF(attr, "nation", (object)1);
        SetF(attr, "modName", "yj37.namod");

        var mslProxy = root.AddComponent(TMsl);
        SetF(mslProxy, "animTarget", lids[0]);
        SetF(mslProxy, "targetFinalRotation", new Vector3(LID_OPEN, 0f, 0f));
        SetF(mslProxy, "animTime", 0f);
        SetF(mslProxy, "magazine", mag);
        SetF(mslProxy, "missileRes", missiles[0]);
        SetF(mslProxy, "missleJetSpeed", 45f);
        SetF(mslProxy, "boosterSpiltTime", 3.0f);
        SetF(mslProxy, "startManeuverTime", 2.0f);
        SetF(mslProxy, "missileMaxSpeed", 680f);
        SetF(mslProxy, "missileAcceleration", 80f);
        SetF(mslProxy, "missileMaxRange", 220f);
        SetF(mslProxy, "maxGForce", 12f);
        SetF(mslProxy, "cruiseHeight", 20f);
        SetF(mslProxy, "damage", 16000f);
        SetF(mslProxy, "explosionRadius", 14f);
        SetF(mslProxy, "equivalentPenetrationDepth", 900f);
        SetF(mslProxy, "warheadType", (object)1);
        SetF(mslProxy, "interceptionRate", 30f);

        var tubeArr = Array.CreateInstance(TTube, idx);
        for (int i = 0; i < idx; i++) {
            var t = Activator.CreateInstance(TTube);
            SetF(t, "cover", lids[i]);
            SetF(t, "spawnPos", spawns[i]);
            SetF(t, "prewarmed", false);
            SetF(t, "prewarmedMissile", null);
            SetF(t, "missileCount", 2);
            SetF(t, "reloadTime", 14f);
            SetF(t, "detectCollisionDelay", 0.6f);
            SetF(t, "endRot", new Vector3(LID_OPEN, 0f, 0f));
            tubeArr.SetValue(t, i);
        }
        SetF(mslProxy, "tubes", tubeArr);
        L("tubes=" + idx);

        // ---- 5. Collider（薄甲板板，与工坊 MK41 VLS 一致）----
        var bc = root.AddComponent<BoxCollider>();
        bc.isTrigger = false;
        bc.center = new Vector3(0f, 0.10f, 0f);
        bc.size = new Vector3(3.34f, 0.20f, 2.80f);
        SetF(attr, "volume", bc.size.x * bc.size.y * bc.size.z);
        L("collider center=" + bc.center + " size=" + bc.size + " volume=" + (bc.size.x * bc.size.y * bc.size.z));

        // ---- 6. 灯光 ----
        var studio = new GameObject("Studio");
        MakeLight("Key", studio.transform, new Vector3(48f, 38f, 0f), 1.25f);
        MakeLight("Fill", studio.transform, new Vector3(22f, 205f, 0f), 0.45f);
        MakeLight("Rim", studio.transform, new Vector3(12f, 118f, 0f), 0.7f);

        // ---- 7. 保存 ----
        Directory.CreateDirectory("Assets/Scenes");
        EditorSceneManager.SaveScene(scene, "Assets/Scenes/YJ37_VLS.unity");
        string prefabPath = "Assets/ModBuild_" + MOD_ID + "/" + MOD_ID + ".prefab";
        Directory.CreateDirectory("Assets/ModBuild_" + MOD_ID);
        var prefab = PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
        AssetDatabase.SaveAssets();
        L("prefab=" + prefabPath + " saved=" + (prefab != null));

        // ---- 8. 复核 ----
        var check = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
        int nullMesh = 0;
        foreach (var mf in check.GetComponentsInChildren<MeshFilter>(true)) if (mf.sharedMesh == null) nullMesh++;
        var allR = check.GetComponentsInChildren<Renderer>(true);
        L("check children=" + check.transform.childCount + " renderers=" + allR.Length + " nullMesh=" + nullMesh);
        L("components=" + string.Join(",", check.GetComponents<Component>().Select(c => c.GetType().Name)));
        var cm = check.GetComponent(TMsl);
        var res = (GameObject)cm.GetType().GetField("missileRes").GetValue(cm);
        var tarr = (Array)cm.GetType().GetField("tubes").GetValue(cm);
        L("missileRes=" + res.name + " tubes=" + tarr.Length);
        for (int i = 0; i < tarr.Length; i++) {
            var t = tarr.GetValue(i);
            var cov = (GameObject)t.GetType().GetField("cover").GetValue(t);
            var sp = (GameObject)t.GetType().GetField("spawnPos").GetValue(t);
            L("  tube" + i + " cover=" + cov.name + " spawn=" + sp.name + " pos=" + sp.transform.localPosition + " rot=" + sp.transform.localEulerAngles);
        }
        var bounds = new Bounds(check.transform.position, Vector3.zero);
        bool firstR = true;
        foreach (var r in allR) { if (firstR) { bounds = r.bounds; firstR = false; } else bounds.Encapsulate(r.bounds); }
        L("render bounds size=" + bounds.size.ToString("F3") + " center=" + bounds.center.ToString("F3"));
        return log.ToString();
    }

    static void MakeLight(string name, Transform parent, Vector3 euler, float intensity) {
        var go = new GameObject(name);
        go.transform.SetParent(parent, false);
        go.transform.localEulerAngles = euler;
        var l = go.AddComponent<Light>();
        l.type = LightType.Directional;
        l.intensity = intensity;
        l.color = new Color(1f, 0.98f, 0.94f);
    }
}
