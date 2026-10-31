using System;
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
        var prefab = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Prefabs/YJ37_Missile.prefab");

        var camGo = new GameObject("DSH_PREVIEW_Cam");
        Camera cam = camGo.AddComponent<Camera>();
        cam.fieldOfView = 32f; cam.nearClipPlane = 0.05f; cam.farClipPlane = 500f;
        cam.allowHDR = true; cam.allowMSAA = true;

        GameObject tmp = null;
        Transform lidRotRestore = null;
        Vector3 lidRestoreRot = Vector3.zero;
        try
        {
            // 在一格开口中竖起一枚导弹：开该格的盖，导弹尾部落在甲板面上
            Transform lid = root.transform.Find("Lid3");
            if (lid == null) throw new Exception("Lid3 not found");
            lidRotRestore = lid;
            lidRestoreRot = lid.localEulerAngles;
            lid.localEulerAngles = new Vector3(-95f, 0f, 0f);
            Vector3 lp = lid.localPosition;
            float cellX = lp.x, cellZ = lp.z + 0.44f;

            tmp = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            tmp.name = "TMP_MissilePose";
            tmp.transform.position = new Vector3(cellX, 0.22f, cellZ);
            tmp.transform.rotation = Quaternion.Euler(270f, 0f, 0f);
            sb.AppendLine("missile pose at " + tmp.transform.position + " cell=(" + cellX + "," + cellZ + ")");

            Bounds b = BodyBounds(root.transform, sb);
            b.Encapsulate(MeshBounds(tmp));
            sb.AppendLine("bounds=" + b.size + " center=" + b.center);
            Shoot(cam, b, new Vector3(0.78f, 0.30f, 0.62f), 0.97f, 512, 512, "Assets/DSH/Textures/YJ37_Preview.png", sb);
        }
        finally
        {
            if (tmp != null) UnityEngine.Object.DestroyImmediate(tmp);
            if (lidRotRestore != null) lidRotRestore.localEulerAngles = lidRestoreRot;
            UnityEngine.Object.DestroyImmediate(camGo);
        }
        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
        var ti = AssetImporter.GetAtPath("Assets/DSH/Textures/YJ37_Preview.png") as TextureImporter;
        if (ti != null)
        {
            ti.textureType = TextureImporterType.Sprite;
            ti.spriteImportMode = SpriteImportMode.Single;
            ti.alphaIsTransparency = true;
            ti.mipmapEnabled = false;
            ti.maxTextureSize = 512;
            ti.textureCompression = TextureImporterCompression.Uncompressed;
            ti.SaveAndReimport();
        }
        var t2 = AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/DSH/Textures/YJ37_Preview.png");
        sb.AppendLine("preview tex=" + (t2 != null ? t2.width + "x" + t2.height : "null"));
        return sb.ToString();
    }

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
        sb.AppendLine("body bounds skipped " + skipped + " missile renderers; size=" + b.size);
        return b;
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

    static void Shoot(Camera cam, Bounds b, Vector3 dir, float pad, int w, int h, string path, StringBuilder sb)
    {
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color(0.075f, 0.082f, 0.095f, 1f);
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

        var lg = new GameObject("DSH_PreviewLight");
        var l = lg.AddComponent<Light>();
        l.type = LightType.Directional; l.intensity = 0.55f; l.color = new Color(1f, 0.99f, 0.96f);
        l.transform.rotation = cam.transform.rotation;

        RenderTexture rt = RenderTexture.GetTemporary(w, h, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB, 8);
        RenderTexture pa = RenderTexture.active, pt = cam.targetTexture;
        try
        {
            cam.targetTexture = rt; cam.Render(); RenderTexture.active = rt;
            var tex = new Texture2D(w, h, TextureFormat.ARGB32, false);
            tex.ReadPixels(new Rect(0, 0, w, h), 0, 0); tex.Apply();
            File.WriteAllBytes(path, tex.EncodeToPNG());
            UnityEngine.Object.DestroyImmediate(tex);
        }
        finally
        {
            cam.targetTexture = pt; RenderTexture.active = pa;
            RenderTexture.ReleaseTemporary(rt);
            UnityEngine.Object.DestroyImmediate(lg);
        }
        sb.AppendLine("rendered " + path);
    }
}
