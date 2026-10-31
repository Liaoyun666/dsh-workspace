using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

public static class DSHSnippet
{
    const string PREFAB = "Assets/ModBuild_99037001/99037001.prefab";
    const string MISSILE = "Assets/Prefabs/YJ37_Missile.prefab";
    const string ICON = "Assets/Resources/p99037001.png";
    const string MISSILE_TEX = "Assets/DSH/Textures/YJ37_missile_tex.png";
    const string PREVIEW = "Assets/DSH/Textures/YJ37_Preview.png";
    const string MOD_NAME = "YJ37";
    // 交付目录：只放成品。本脚本会 Directory.Delete(OUT_DIR, true) 清空它，所以绝不能指向源码/渲染图目录。
    const string OUT_DIR = @"E:\工作区\navalart mod\YJ37";

    static StringBuilder sb = new StringBuilder();
    static Type tAttr, tMissile, tTube;

    static Type FindType(string name)
    {
        foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (a.GetName().Name != "NAModToolCore") continue;
            var t = a.GetType(name);
            if (t != null) return t;
        }
        throw new Exception("type not found: " + name);
    }

    public static object Run()
    {
        tAttr = FindType("PartAttributeProxy");
        tMissile = FindType("PartMissileProxy");
        tTube = FindType("PartMissileProxy+LauncherTube");

        // ---------- 1) 给发射装置 prefab 补 missileTex / volume ----------
        GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(PREFAB);
        if (prefab == null) throw new Exception("prefab missing: " + PREFAB);
        var msl = prefab.GetComponent(tMissile) as Component;
        if (msl == null) throw new Exception("prefab has no PartMissileProxy");
        var attr = prefab.GetComponent(tAttr) as Component;
        if (attr == null) throw new Exception("prefab has no PartAttributeProxy");

        Texture2D tex = AssetDatabase.LoadAssetAtPath<Texture2D>(MISSILE_TEX);
        if (tex == null) throw new Exception("missile tex missing: " + MISSILE_TEX);
        tMissile.GetField("missileTex").SetValue(msl, tex);

        var mslPrefab = AssetDatabase.LoadAssetAtPath<GameObject>(MISSILE);
        var mslResField = tMissile.GetField("missileRes");
        if (mslResField.GetValue(msl) == null) mslResField.SetValue(msl, mslPrefab);

        var col = prefab.GetComponent<BoxCollider>();
        if (col != null)
        {
            float vol = col.size.x * col.size.y * col.size.z;
            tAttr.GetField("volume").SetValue(attr, vol);
            tAttr.GetField("density").SetValue(attr, 0.5f);
            tAttr.GetField("armor").SetValue(attr, 60);
            tAttr.GetField("price").SetValue(attr, 3600);
        }
        tAttr.GetField("modName").SetValue(attr, MOD_NAME.ToLower() + ".namod");
        PrefabUtility.SavePrefabAsset(prefab);
        AssetDatabase.SaveAssets();
        sb.AppendLine("prefab updated: missileTex=" + tex.width + "x" + tex.height
            + " volume=" + tAttr.GetField("volume").GetValue(attr)
            + " modName=" + tAttr.GetField("modName").GetValue(attr));

        // ---------- 2) 打 AssetBundle（复刻 ModTool: Uncompressed + StandaloneWindows） ----------
        if (Directory.Exists(OUT_DIR)) Directory.Delete(OUT_DIR, true);
        Directory.CreateDirectory(OUT_DIR);

        var builds = new AssetBundleBuild[1];
        builds[0].assetBundleName = MOD_NAME + ".namod";
        builds[0].assetNames = new[] { PREFAB, ICON };

        AssetBundleManifest manifest = BuildPipeline.BuildAssetBundles(
            OUT_DIR, builds, BuildAssetBundleOptions.UncompressedAssetBundle, BuildTarget.StandaloneWindows);
        if (manifest == null) throw new Exception("BuildAssetBundles failed (see console)");
        sb.AppendLine("bundle built: " + string.Join(",", manifest.GetAllAssetBundles()));

        string bundlePath = Path.Combine(OUT_DIR, MOD_NAME + ".namod");
        if (!File.Exists(bundlePath)) throw new Exception("bundle not written: " + bundlePath);
        sb.AppendLine("bundle size=" + new FileInfo(bundlePath).Length + " bytes");

        // ---------- 3) config.xml（UTF-8 无 BOM，字段与官方 BuildAllAssetBundles 一致） ----------
        string cfgPath = Path.Combine(OUT_DIR, MOD_NAME + "config.xml");
        DateTime now = DateTime.Now;
        string createTime = string.Format("{0}_{1}_{2} {3}_{4}_{5} {6}",
            now.Month, now.Day, now.Year, now.Hour % 12 == 0 ? 12 : now.Hour % 12, now.Minute, now.Second,
            now.Hour < 12 ? "AM" : "PM");
        var cfg = new StringBuilder();
        cfg.Append("<root><config ModName=\"" + MOD_NAME + "\" ModType=\"0\" Author=\"殘雲\"");
        cfg.Append(" Description=\"YJ-37 六联装超声速反舰导弹垂直发射模块\"");
        cfg.Append(" CreateTime=\"" + createTime + "\" Version=\"1.0\" />\r\n");
        cfg.Append("<Part Path=\"99037001\" PartClass=\"Weapon\"");
        cfg.Append(" PartName=\"YJ-37 垂直发射模块[鹰击-37]\"");
        cfg.Append(" PartDescription=\"六联装通用垂直发射模块，超声速反舰导弹，射程 220 km，半穿甲战斗部。\"");
        cfg.Append(" PartNation=\"China\" PartWeaponType=\"Missiles\" />\r\n");
        cfg.Append("</root>");
        File.WriteAllText(cfgPath, cfg.ToString(), new UTF8Encoding(false));
        sb.AppendLine("config: " + cfgPath);

        // ---------- 4) 预览图 ----------
        string prevDst = Path.Combine(OUT_DIR, "Preview.png");
        File.Copy(PREVIEW, prevDst, true);
        sb.AppendLine("preview: " + prevDst + " " + new FileInfo(prevDst).Length + " bytes");

        // ---------- 5) 清掉 build 产生的 manifest 冗余文件 ----------
        foreach (var f in Directory.GetFiles(OUT_DIR))
        {
            string n = Path.GetFileName(f);
            if (n == MOD_NAME || n == MOD_NAME + ".manifest")
            {
                File.Delete(f);
                sb.AppendLine("removed build artifact: " + n);
            }
        }
        sb.AppendLine("--- dir listing ---");
        foreach (var f in Directory.GetFiles(OUT_DIR))
            sb.AppendLine("  " + Path.GetFileName(f) + "  " + new FileInfo(f).Length);

        // ---------- 6) 回读校验 ----------
        AssetBundle ab = AssetBundle.LoadFromFile(bundlePath);
        if (ab == null) throw new Exception("cannot load built bundle");
        sb.AppendLine("--- bundle assets ---");
        foreach (var n in ab.GetAllAssetNames()) sb.AppendLine("  " + n);

        GameObject go = ab.LoadAsset<GameObject>("99037001");
        if (go == null) go = ab.LoadAsset<GameObject>(PREFAB);
        if (go == null) throw new Exception("99037001 not in bundle");
        sb.AppendLine("prefab in bundle: " + go.name + " children=" + go.transform.childCount
            + " renderers=" + go.GetComponentsInChildren<Renderer>(true).Length);

        var bAttr = go.GetComponent(tAttr) as Component;
        var bMsl = go.GetComponent(tMissile) as Component;
        var bCol = go.GetComponent<BoxCollider>();
        sb.AppendLine("attr: id=" + tAttr.GetField("id").GetValue(bAttr)
            + " name=" + tAttr.GetField("partName").GetValue(bAttr)
            + " class=" + tAttr.GetField("builderClass").GetValue(bAttr)
            + " weapon=" + tAttr.GetField("weaponType").GetValue(bAttr)
            + " nation=" + tAttr.GetField("nation").GetValue(bAttr)
            + " armor=" + tAttr.GetField("armor").GetValue(bAttr)
            + " density=" + tAttr.GetField("density").GetValue(bAttr)
            + " volume=" + tAttr.GetField("volume").GetValue(bAttr)
            + " price=" + tAttr.GetField("price").GetValue(bAttr)
            + " modName=" + tAttr.GetField("modName").GetValue(bAttr));
        sb.AppendLine("collider: center=" + bCol.center + " size=" + bCol.size);

        var tubes = (Array)tMissile.GetField("tubes").GetValue(bMsl);
        var mres = tMissile.GetField("missileRes").GetValue(bMsl) as GameObject;
        var mtex = tMissile.GetField("missileTex").GetValue(bMsl) as Texture2D;
        sb.AppendLine("missile: tubes=" + (tubes == null ? -1 : tubes.Length)
            + " missileRes=" + (mres != null ? mres.name : "NULL")
            + " missileTex=" + (mtex != null ? mtex.width + "x" + mtex.height : "NULL")
            + " maxRange=" + tMissile.GetField("missileMaxRange").GetValue(bMsl)
            + " damage=" + tMissile.GetField("damage").GetValue(bMsl)
            + " warhead=" + tMissile.GetField("warheadType").GetValue(bMsl)
            + " animTarget=" + (tMissile.GetField("animTarget").GetValue(bMsl) as GameObject == null ? "NULL" : (tMissile.GetField("animTarget").GetValue(bMsl) as GameObject).name)
            + " animTime=" + tMissile.GetField("animTime").GetValue(bMsl)
            + " magazine=" + (tMissile.GetField("magazine").GetValue(bMsl) as GameObject == null ? "NULL" : (tMissile.GetField("magazine").GetValue(bMsl) as GameObject).name));
        var bMag = tMissile.GetField("magazine").GetValue(bMsl) as GameObject;
        if (bMag != null)
        {
            var mc = bMag.GetComponent<BoxCollider>();
            sb.AppendLine("magazine collider: center=" + (mc != null ? mc.center.ToString() : "none") + " size=" + (mc != null ? mc.size.ToString() : "none") + " activeSelf=" + bMag.activeSelf);
        }
        if (tubes != null)
        {
            for (int i = 0; i < tubes.Length; i++)
            {
                object tb = tubes.GetValue(i);
                var cover = tTube.GetField("cover").GetValue(tb) as GameObject;
                var spawn = tTube.GetField("spawnPos").GetValue(tb) as GameObject;
                sb.AppendLine("  tube[" + i + "] cover=" + (cover != null ? cover.name : "NULL")
                    + " spawn=" + (spawn != null ? spawn.name + spawn.transform.localPosition.ToString() : "NULL")
                    + " count=" + tTube.GetField("missileCount").GetValue(tb)
                    + " reload=" + tTube.GetField("reloadTime").GetValue(tb)
                    + " endRot=" + tTube.GetField("endRot").GetValue(tb));
            }
        }

        if (mres != null)
        {
            Transform b = mres.transform.Find("Booster");
            Transform th = b != null ? b.Find("Thruster") : null;
            sb.AppendLine("missile prefab: Booster=" + (b != null) + " Thruster=" + (th != null)
                + " renderers=" + mres.GetComponentsInChildren<Renderer>(true).Length
                + " bounds=" + BoundsOf(mres).size);
        }

        Sprite icon = ab.LoadAsset<Sprite>("p99037001");
        sb.AppendLine("icon in bundle: " + (icon != null ? icon.name + " " + icon.rect.width + "x" + icon.rect.height : "NULL"));

        int nullMat = 0;
        foreach (var r in go.GetComponentsInChildren<Renderer>(true))
            foreach (var m in r.sharedMaterials) if (m == null) nullMat++;
        sb.AppendLine("null materials: " + nullMat);

        ab.Unload(true);
        return sb.ToString();
    }

    static Bounds BoundsOf(GameObject go)
    {
        Bounds b = new Bounds(Vector3.zero, Vector3.zero);
        bool has = false;
        foreach (var r in go.GetComponentsInChildren<Renderer>(true))
        {
            if (!has) { b = r.bounds; has = true; } else b.Encapsulate(r.bounds);
        }
        return b;
    }
}
