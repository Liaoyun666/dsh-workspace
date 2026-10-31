using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

public class DSHSnippet
{
    const int W = 1280, H = 800;
    const string OUT = "E:/工作区/unity-mcp/screenshots/";

    static float FitDistance(Camera cam, Bounds b, Vector3 dir, float pad)
    {
        cam.transform.rotation = Quaternion.LookRotation(-dir.normalized, Vector3.up);
        float tanV = Mathf.Tan(cam.fieldOfView * 0.5f * Mathf.Deg2Rad);
        float tanH = tanV * ((float)W / H);
        Matrix4x4 m = Matrix4x4.TRS(b.center, cam.transform.rotation, Vector3.one).inverse;
        float hw = 0f, hh = 0f, hd = 0f;
        for (int i = 0; i < 8; i++)
        {
            Vector3 c = b.center + Vector3.Scale(b.extents, new Vector3(((i & 1) == 0 ? -1f : 1f), ((i & 2) == 0 ? -1f : 1f), ((i & 4) == 0 ? -1f : 1f)));
            Vector3 l = m.MultiplyPoint3x4(c);
            hw = Mathf.Max(hw, Mathf.Abs(l.x));
            hh = Mathf.Max(hh, Mathf.Abs(l.y));
            hd = Mathf.Max(hd, l.z);
        }
        return Mathf.Max(hh / tanV, hw / tanH) * pad + hd;
    }

    static Bounds BoundsOf(GameObject root, params string[] only)
    {
        bool has = false;
        Bounds b = new Bounds(root.transform.position, Vector3.zero);
        foreach (MeshRenderer mr in root.GetComponentsInChildren<MeshRenderer>(true))
        {
            if (only != null && only.Length > 0)
            {
                bool hit = false;
                foreach (string nm in only) if (mr.gameObject.name == nm) { hit = true; break; }
                if (!hit) continue;
            }
            MeshFilter mf = mr.GetComponent<MeshFilter>();
            if (mf == null || mf.sharedMesh == null) continue;
            Bounds wb = mf.sharedMesh.bounds;
            if (!has) { b = wb; has = true; } else b.Encapsulate(wb);
        }
        return b;
    }

    static void Shoot(Camera cam, GameObject root, Bounds b, Vector3 dir, float pad, string file)
    {
        float dist = FitDistance(cam, b, dir, pad);
        cam.transform.position = b.center + dir.normalized * dist;
        cam.transform.rotation = Quaternion.LookRotation((b.center - cam.transform.position).normalized, Vector3.up);
        RenderTexture rt = RenderTexture.GetTemporary(W, H, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
        rt.antiAliasing = 8;
        cam.targetTexture = rt;
        cam.Render();
        RenderTexture.active = rt;
        Texture2D tex = new Texture2D(W, H, TextureFormat.RGB24, false);
        tex.ReadPixels(new Rect(0, 0, W, H), 0, 0);
        tex.Apply();
        RenderTexture.active = null;
        cam.targetTexture = null;
        File.WriteAllBytes(OUT + file, tex.EncodeToPNG());
        UnityEngine.Object.DestroyImmediate(tex);
        RenderTexture.ReleaseTemporary(rt);
    }

    public static object Run()
    {
        GameObject root = GameObject.Find("YJ37_Missile");
        if (root == null) return "MISSING YJ37_Missile";

        GameObject camGo = new GameObject("DSH_ShotCam");
        Camera cam = camGo.AddComponent<Camera>();
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color(0.075f, 0.082f, 0.095f, 1f);
        cam.fieldOfView = 32f;
        cam.nearClipPlane = 0.05f;
        cam.farClipPlane = 500f;
        cam.allowHDR = true;
        cam.allowMSAA = true;

        GameObject lg = new GameObject("DSH_ShotLight");
        Light camLight = lg.AddComponent<Light>();
        camLight.type = LightType.Directional;
        camLight.intensity = 0.55f;
        camLight.shadows = LightShadows.None;

        Bounds whole = BoundsOf(root);
        Shoot(cam, root, whole, new Vector3(1f, 0.10f, 0f), 1.06f, "v4_side.png");
        camLight.transform.rotation = cam.transform.rotation;
        Shoot(cam, root, whole, new Vector3(0.85f, 0.42f, 0.85f), 1.06f, "v4_threequarter.png");
        camLight.transform.rotation = cam.transform.rotation;
        Shoot(cam, root, whole, new Vector3(0.22f, 0.16f, 1f), 1.06f, "v4_front.png");
        camLight.transform.rotation = cam.transform.rotation;
        Shoot(cam, root, whole, new Vector3(0.55f, 0.28f, -1f), 1.06f, "v4_rear.png");
        camLight.transform.rotation = cam.transform.rotation;
        Shoot(cam, root, whole, new Vector3(0.02f, 1f, 0.08f), 1.06f, "v4_top.png");
        camLight.transform.rotation = cam.transform.rotation;
        Shoot(cam, root, whole, new Vector3(0.75f, -0.42f, 0.55f), 1.06f, "v4_belly.png");

        Bounds nose = BoundsOf(root, "Warhead_Waverider", "Stage1_Upper");
        camLight.transform.rotation = cam.transform.rotation;
        Shoot(cam, root, nose, new Vector3(0.45f, 0.30f, 0.85f), 1.18f, "v4_nose_tq.png");
        camLight.transform.rotation = cam.transform.rotation;
        Shoot(cam, root, nose, new Vector3(1f, 0.02f, 0.02f), 1.20f, "v4_nose_side.png");
        camLight.transform.rotation = cam.transform.rotation;
        Shoot(cam, root, nose, new Vector3(0.50f, -0.80f, 0.45f), 1.14f, "v4_nose_belly.png");

        Bounds joint = BoundsOf(root, "InterstageRing", "InterstageNeck", "Stage1_Upper", "Body");
        camLight.transform.rotation = cam.transform.rotation;
        Shoot(cam, root, joint, new Vector3(0.80f, 0.35f, 0.60f), 1.55f, "v4_joint.png");

        UnityEngine.Object.DestroyImmediate(camGo);
        UnityEngine.Object.DestroyImmediate(lg);

        return "shots ok: v4_side/threequarter/front/rear/top/belly + nose_tq/nose_side/nose_belly + joint";
    }
}