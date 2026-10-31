
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

public static class DSHSnippet
{
    const int W = 1280, H = 800;

    static Bounds ActiveBounds(GameObject root)
    {
        bool has = false;
        Bounds b = new Bounds(root.transform.position, Vector3.zero);
        foreach (Renderer r in root.GetComponentsInChildren<Renderer>(true))
        {
            if (!r.enabled || !r.gameObject.activeInHierarchy) continue;
            if (!has) { b = r.bounds; has = true; } else b.Encapsulate(r.bounds);
        }
        return b;
    }

    static float FitDistance(Camera cam, Bounds b, float pad)
    {
        float tanV = Mathf.Tan(cam.fieldOfView * 0.5f * Mathf.Deg2Rad);
        float tanH = tanV * ((float)W / H);
        Matrix4x4 m = Matrix4x4.TRS(b.center, cam.transform.rotation, Vector3.one).inverse;
        Vector3 min = b.min, max = b.max;
        float hw = 0f, hh = 0f, hd = 0f;
        for (int i = 0; i < 8; i++)
        {
            Vector3 c = new Vector3((i & 1) == 0 ? min.x : max.x, (i & 2) == 0 ? min.y : max.y, (i & 4) == 0 ? min.z : max.z);
            Vector3 local = m.MultiplyPoint3x4(c);
            hw = Mathf.Max(hw, Mathf.Abs(local.x));
            hh = Mathf.Max(hh, Mathf.Abs(local.y));
            hd = Mathf.Max(hd, -local.z);
        }
        return Mathf.Max(hh / tanV, hw / tanH) * pad + hd;
    }

    static void Shoot(Camera cam, string path)
    {
        RenderTexture rt = RenderTexture.GetTemporary(W, H, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB, 8);
        RenderTexture prevActive = RenderTexture.active;
        RenderTexture prevTarget = cam.targetTexture;
        try
        {
            cam.targetTexture = rt;
            cam.Render();
            RenderTexture.active = rt;
            var tex = new Texture2D(W, H, TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(0, 0, W, H), 0, 0);
            tex.Apply();
            File.WriteAllBytes(path, tex.EncodeToPNG());
            UnityEngine.Object.DestroyImmediate(tex);
        }
        finally
        {
            cam.targetTexture = prevTarget;
            RenderTexture.active = prevActive;
            RenderTexture.ReleaseTemporary(rt);
        }
    }

    static void View(Camera cam, Light camLight, GameObject root, string outDir, string name, Vector3 dir, float pad, Bounds? target = null)
    {
        Bounds b = target.HasValue ? target.Value : ActiveBounds(root);
        dir = dir.normalized;
        cam.transform.rotation = Quaternion.LookRotation(-dir, Vector3.up);
        camLight.transform.rotation = cam.transform.rotation;
        float dist = FitDistance(cam, b, pad);
        cam.transform.position = b.center + dir * dist;
        cam.transform.LookAt(b.center);
        Shoot(cam, Path.Combine(outDir, "vls_" + name + ".png"));
    }

    public static object Run()
    {
        var sb = new StringBuilder();
        GameObject root = GameObject.Find("99037001");
        if (root == null) throw new Exception("99037001 not found");

        string outDir = @"E:\工作区\unity-mcp\screenshots";
        Directory.CreateDirectory(outDir);

        var camGo = new GameObject("DSH_VLS_Cam");
        Camera cam = camGo.AddComponent<Camera>();
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color(0.075f, 0.082f, 0.095f, 1f);
        cam.fieldOfView = 34f;
        cam.nearClipPlane = 0.05f;
        cam.farClipPlane = 500f;
        cam.allowHDR = true;
        cam.allowMSAA = true;

        var lightGo = new GameObject("DSH_CamLight");
        var camLight = lightGo.AddComponent<Light>();
        camLight.type = LightType.Directional;
        camLight.intensity = 0.55f;
        camLight.color = new Color(1f, 0.98f, 0.94f);

        GameObject launchedMissile = null;
        try
        {
            View(cam, camLight, root, outDir, "threequarter", new Vector3(0.95f, 0.55f, 1.0f), 1.05f);
            View(cam, camLight, root, outDir, "top", new Vector3(0.05f, 1f, 0.18f), 1.05f);
            View(cam, camLight, root, outDir, "side", new Vector3(1f, 0.14f, 0f), 1.05f);
            View(cam, camLight, root, outDir, "low", new Vector3(0.65f, 0.22f, 0.85f), 1.05f);
            sb.AppendLine("base views ok");

            // 发射状态：打开中间那格舱盖，并把一枚导弹立在 spawnPos 上（游戏发射瞬间的样子）
            Bounds moduleB = ActiveBounds(root);
            var lid3 = root.transform.Find("Lid3");
            if (lid3 != null) lid3.localEulerAngles = new Vector3(-95f, 0f, 0f);
            var sp = root.transform.Find("SpawnPos3");
            var missilePrefab = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Prefabs/YJ37_Missile.prefab");
            if (sp != null && missilePrefab != null)
            {
                launchedMissile = (GameObject)PrefabUtility.InstantiatePrefab(missilePrefab);
                launchedMissile.name = "DSH_Launched";
                launchedMissile.transform.SetParent(sp, false);
                launchedMissile.transform.localPosition = Vector3.zero;
                launchedMissile.transform.localRotation = Quaternion.identity;
                launchedMissile.SetActive(true);
                sb.AppendLine("launch pose: missile at " + launchedMissile.transform.position);

                View(cam, camLight, root, outDir, "launch", new Vector3(0.95f, 0.45f, 0.95f), 1.04f);
                View(cam, camLight, root, outDir, "open_top", new Vector3(0.25f, 1f, 0.55f), 1.02f, moduleB);
                View(cam, camLight, root, outDir, "open_low", new Vector3(0.9f, 0.20f, 0.75f), 1.02f, moduleB);
            }
            if (lid3 != null) lid3.localEulerAngles = Vector3.zero;
        }
        finally
        {
            if (launchedMissile != null) UnityEngine.Object.DestroyImmediate(launchedMissile);
            UnityEngine.Object.DestroyImmediate(camGo);
            UnityEngine.Object.DestroyImmediate(lightGo);
        }
        sb.AppendLine("bounds(active)=" + ActiveBounds(root).size.ToString("F3"));
        return sb.ToString();
    }
}
