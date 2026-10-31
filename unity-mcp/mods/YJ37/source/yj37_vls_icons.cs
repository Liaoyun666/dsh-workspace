using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

public static class DSHSnippet
{
    public static object Run()
    {
        var sb = new StringBuilder();
        GameObject root = GameObject.Find("99037001");
        if (root == null) throw new Exception("scene has no 99037001");

        var camGo = new GameObject("DSH_ICON_Cam");
        Camera cam = camGo.AddComponent<Camera>();
        cam.fieldOfView = 32f;
        cam.nearClipPlane = 0.05f;
        cam.farClipPlane = 500f;
        cam.allowHDR = true;
        cam.allowMSAA = true;

        string texDir = "Assets/DSH/Textures";
        Directory.CreateDirectory(texDir);
        Directory.CreateDirectory("Assets/Resources");

        GameObject tmp = null;
        Transform lid3 = root.transform.Find("Lid3");
        Vector3 lid3Rot = lid3 != null ? lid3.localEulerAngles : Vector3.zero;
        try
        {
            // 1) 图鉴图标 512x512 透明背景（排除 6 枚导弹）
            Bounds b = BodyBounds(root.transform, sb);
            ShootBounds(cam, b, new Vector3(0.72f, 0.66f, 0.95f), 1.05f, 512, 512, new Color(0, 0, 0, 0), "Assets/Resources/p99037001.png", sb);

            // 2) 导弹贴图 256x64 透明背景
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Prefabs/YJ37_Missile.prefab");
            if (prefab == null) throw new Exception("missile prefab missing");
            tmp = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            tmp.name = "TMP_MissileTex";
            tmp.transform.position = new Vector3(0f, 240f, 0f);
            ShootBounds(cam, MeshBounds(tmp), new Vector3(1f, 0.06f, 0f), 1.04f, 256, 64, new Color(0, 0, 0, 0), texDir + "/YJ37_missile_tex.png", sb);
            UnityEngine.Object.DestroyImmediate(tmp);
            tmp = null;

            // 3) mod 预览图 512x512：一格开盖 + 一枚导弹竖起
            if (lid3 != null) lid3.localEulerAngles = new Vector3(-95f, 0f, 0f);
            tmp = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            tmp.name = "TMP_MissilePose";
            tmp.transform.position = new Vector3(0.90f, 0.20f, 0.55f);
            tmp.transform.rotation = Quaternion.Euler(270f, 0f, 0f);
            Bounds all = BodyBounds(root.transform, sb);
            all.Encapsulate(MeshBounds(tmp));
            ShootBounds(cam, all, new Vector3(0.95f, 0.40f, 0.72f), 0.94f, 512, 512, new Color(0.075f, 0.082f, 0.095f, 1f), texDir + "/YJ37_Preview.png", sb);
            UnityEngine.Object.DestroyImmediate(tmp);
            tmp = null;
        }
        finally
        {
            if (tmp != null) UnityEngine.Object.DestroyImmediate(tmp);
            if (lid3 != null) lid3.localEulerAngles = lid3Rot;
            UnityEngine.Object.DestroyImmediate(camGo);
        }

        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
        SetSpriteImport("Assets/Resources/p99037001.png", 512, sb);
        SetSpriteImport(texDir + "/YJ37_missile_tex.png", 256, sb);
        SetSpriteImport(texDir + "/YJ37_Preview.png", 512, sb);
        foreach (var p in new[] { "Assets/Resources/p99037001.png", texDir + "/YJ37_missile_tex.png", texDir + "/YJ37_Preview.png" })
        {
            var t = AssetDatabase.LoadAssetAtPath<Texture2D>(p);
            var sp = AssetDatabase.LoadAssetAtPath<Sprite>(p);
            sb.AppendLine(p + " tex=" + (t != null ? t.width + "x" + t.height : "null") + " sprite=" + (sp != null ? sp.name : "null"));
        }
        return sb.ToString();
    }

    static Bounds MeshBounds(GameObject go)
    {
        Bounds b = new Bounds(Vector3.zero, Vector3.zero);
        bool has = false;
        foreach (var r in go.GetComponentsInChildren<Renderer>(true))
        {
            if (!has) { b = r.bounds; has = true; } else b.Encapsulate(r.bounds);
        }
        return b;
    }

    // 排除 Missile0..5（它们是未激活的导弹实例，包围盒是旧值）
    static Bounds BodyBounds(Transform root, StringBuilder sb)
    {
        Bounds b = new Bounds(Vector3.zero, Vector3.zero);
        bool has = false;
        int skipped = 0;
        foreach (var r in root.GetComponentsInChildren<Renderer>(true))
        {
            Transform t = r.transform;
            bool skip = false;
            while (t != null && t != root)
            {
                if (t.name.StartsWith("Missile")) { skip = true; break; }
                t = t.parent;
            }
            if (skip) { skipped++; continue; }
            if (!has) { b = r.bounds; has = true; } else b.Encapsulate(r.bounds);
        }
        sb.AppendLine("icon bounds skipped " + skipped + " missile renderers; bounds=" + b.size + " center=" + b.center);
        return b;
    }

    static void SetSpriteImport(string path, int maxSize, StringBuilder sb)
    {
        var ti = AssetImporter.GetAtPath(path) as TextureImporter;
        if (ti == null) { sb.AppendLine("no importer for " + path); return; }
        ti.textureType = TextureImporterType.Sprite;
        ti.spriteImportMode = SpriteImportMode.Single;
        ti.spritePixelsPerUnit = 100f;
        ti.alphaIsTransparency = true;
        ti.mipmapEnabled = false;
        ti.filterMode = FilterMode.Bilinear;
        ti.maxTextureSize = maxSize;
        ti.textureCompression = TextureImporterCompression.Uncompressed;
        ti.SaveAndReimport();
    }

    static void ShootBounds(Camera cam, Bounds b, Vector3 dir, float pad, int w, int h, Color bg, string path, StringBuilder sb)
    {
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = bg;
        cam.transform.rotation = Quaternion.LookRotation(-dir.normalized);
        Vector3 right = cam.transform.right, up = cam.transform.up, fwd = cam.transform.forward;
        float hw = 0f, hh = 0f, hd = 0f;
        for (int i = 0; i < 8; i++)
        {
            Vector3 c = b.center + new Vector3((i & 1) == 0 ? -b.extents.x : b.extents.x,
                                               (i & 2) == 0 ? -b.extents.y : b.extents.y,
                                               (i & 4) == 0 ? -b.extents.z : b.extents.z);
            Vector3 v = c - b.center;
            hw = Mathf.Max(hw, Mathf.Abs(Vector3.Dot(v, right)));
            hh = Mathf.Max(hh, Mathf.Abs(Vector3.Dot(v, up)));
            hd = Mathf.Max(hd, Mathf.Abs(Vector3.Dot(v, fwd)));
        }
        float tanV = Mathf.Tan(cam.fieldOfView * 0.5f * Mathf.Deg2Rad);
        float tanH = tanV * ((float)w / h);
        float dist = Mathf.Max(hh / tanV, hw / tanH) * pad + hd;
        cam.transform.position = b.center - fwd * dist;
        cam.transform.LookAt(b.center);

        var camLightGo = new GameObject("DSH_IconLight");
        var camLight = camLightGo.AddComponent<Light>();
        camLight.type = LightType.Directional;
        camLight.intensity = 0.55f;
        camLight.color = new Color(1f, 0.99f, 0.96f);
        camLight.transform.rotation = cam.transform.rotation;

        RenderTexture rt = RenderTexture.GetTemporary(w, h, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB, 8);
        RenderTexture prevActive = RenderTexture.active;
        RenderTexture prevTarget = cam.targetTexture;
        try
        {
            cam.targetTexture = rt;
            cam.Render();
            RenderTexture.active = rt;
            var tex = new Texture2D(w, h, TextureFormat.ARGB32, false);
            tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
            tex.Apply();
            File.WriteAllBytes(path, tex.EncodeToPNG());
            UnityEngine.Object.DestroyImmediate(tex);
        }
        finally
        {
            cam.targetTexture = prevTarget;
            RenderTexture.active = prevActive;
            RenderTexture.ReleaseTemporary(rt);
            UnityEngine.Object.DestroyImmediate(camLightGo);
        }
        sb.AppendLine("rendered " + path + " " + w + "x" + h + " bounds=" + b.size);
    }
}
