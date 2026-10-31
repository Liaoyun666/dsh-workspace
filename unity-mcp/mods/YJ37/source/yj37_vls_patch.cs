using System;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

public static class DSHSnippet
{
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
        var sb = new StringBuilder();
        Type tMissile = FindType("PartMissileProxy");
        Type tTube = FindType("PartMissileProxy+LauncherTube");
        const string P = "Assets/ModBuild_99037001/99037001.prefab";

        GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(P);
        if (prefab == null) throw new Exception("prefab missing");

        ApplyTo(prefab, tMissile, tTube, sb);

        // 场景里的同名对象也同步（渲染/后续手动打包用）
        var sceneRoot = GameObject.Find("99037001");
        if (sceneRoot != null) ApplyTo(sceneRoot, tMissile, tTube, sb);

        PrefabUtility.SavePrefabAsset(prefab);
        AssetDatabase.SaveAssets();
        if (sceneRoot != null)
        {
            UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(sceneRoot.scene);
            UnityEditor.SceneManagement.EditorSceneManager.SaveScene(sceneRoot.scene, "Assets/Scenes/YJ37_VLS.unity");
            sb.AppendLine("scene saved");
        }
        return sb.ToString();
    }

    static void ApplyTo(GameObject go, Type tMissile, Type tTube, StringBuilder sb)
    {
        var msl = go.GetComponent(tMissile) as Component;
        if (msl == null) { sb.AppendLine("no PartMissileProxy on " + go.name); return; }
        tMissile.GetField("animTime").SetValue(msl, 0f);
        var tubes = (Array)tMissile.GetField("tubes").GetValue(msl);
        sb.AppendLine(go.name + ": animTime=0 tubes=" + (tubes == null ? -1 : tubes.Length));
        for (int i = 0; i < tubes.Length; i++)
        {
            object tb = tubes.GetValue(i);
            tTube.GetField("missileCount").SetValue(tb, 2);
            tTube.GetField("reloadTime").SetValue(tb, 14f);
            var cover = tTube.GetField("cover").GetValue(tb) as GameObject;
            sb.AppendLine("  tube[" + i + "] cover=" + (cover != null ? cover.name : "NULL")
                + " count=" + tTube.GetField("missileCount").GetValue(tb)
                + " reload=" + tTube.GetField("reloadTime").GetValue(tb)
                + " endRot=" + tTube.GetField("endRot").GetValue(tb));
        }
        var anim = tMissile.GetField("animTarget").GetValue(msl) as GameObject;
        sb.AppendLine("  animTarget=" + (anim != null ? anim.name : "NULL") + " (unused at animTime=0)");
    }
}
