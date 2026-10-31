
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

// YJ-37 导弹 v3：两级构型 + 承波体弹头（弹头单独建模）
// 全长 8.55 m；0-6.30 一级助推器（白），6.30-7.10 级间段 + 二级首段（深灰），7.10-8.55 承波体弹头（石墨）
public class DSHSnippet
{
    // ===================== mesh container =====================
    class MB
    {
        public List<Vector3> v = new List<Vector3>();
        public List<Vector3> n = new List<Vector3>();
        public List<Vector2> uv = new List<Vector2>();
        public List<int> t = new List<int>();

        public int Add(Vector3 p, Vector3 nn, Vector2 u)
        {
            v.Add(p); n.Add(nn); uv.Add(u); return v.Count - 1;
        }
        public void Tri(int a, int b, int c) { t.Add(a); t.Add(b); t.Add(c); }

        public Mesh ToMesh(string name)
        {
            for (int i = 0; i < t.Count; i += 3)
            {
                Vector3 g = Vector3.Cross(v[t[i + 1]] - v[t[i]], v[t[i + 2]] - v[t[i]]);
                if (g.sqrMagnitude < 1e-12f) continue;
                Vector3 refN = (n[t[i]] + n[t[i + 1]] + n[t[i + 2]]);
                if (refN.sqrMagnitude < 1e-12f) continue;
                if (Vector3.Dot(g, refN) < 0f) { int tmp = t[i + 1]; t[i + 1] = t[i + 2]; t[i + 2] = tmp; }
            }
            Mesh m = new Mesh();
            m.name = name;
            m.SetVertices(v); m.SetNormals(n); m.SetUVs(0, uv); m.SetTriangles(t, 0);
            m.RecalculateBounds();
            return m;
        }
    }

    static Mesh Lathe(List<Vector2> prof, int seg, string name)
    {
        MB mb = new MB();
        AppendLathe(mb, prof, seg);
        return mb.ToMesh(name);
    }

    // 按 (z, r) 剖面旋转成型；剖面 r=0 的退化环会被跳过
    static void AppendLathe(MB mb, List<Vector2> prof, int seg)
    {
        int rings = prof.Count;
        int baseIdx = mb.v.Count;
        for (int i = 0; i < rings; i++)
        {
            Vector2 cur = prof[i];
            Vector2 prev = prof[Mathf.Max(0, i - 1)];
            Vector2 next = prof[Mathf.Min(rings - 1, i + 1)];
            Vector2 d = next - prev;
            if (d.sqrMagnitude < 1e-9f) d = new Vector2(1f, 0f);
            d.Normalize();
            Vector2 n2 = new Vector2(-d.y, d.x);
            if (n2.sqrMagnitude < 1e-9f) n2 = new Vector2(0f, 1f);
            n2.Normalize();
            for (int s = 0; s <= seg; s++)
            {
                float a = (float)s / seg * Mathf.PI * 2f;
                float cs = Mathf.Cos(a), sn = Mathf.Sin(a);
                mb.Add(new Vector3(cs * cur.y, sn * cur.y, cur.x),
                       new Vector3(cs * n2.y, sn * n2.y, n2.x).normalized,
                       new Vector2((float)s / seg, (float)i / (rings - 1)));
            }
        }
        for (int i = 0; i < rings - 1; i++)
            for (int s = 0; s < seg; s++)
            {
                int a0 = baseIdx + i * (seg + 1) + s, b0 = a0 + 1;
                int a1 = baseIdx + (i + 1) * (seg + 1) + s, b1 = a1 + 1;
                mb.Tri(a0, a1, b1); mb.Tri(a0, b1, b0);
            }
    }

    // 承波体截面：宽 > 高、底面接近平面、侧面带折线棱线，共 12 点闭合
    static Vector3[] WSection(float z, float w, float hT, float hB)
    {
        return new Vector3[] {
            new Vector3(-0.30f * w, -hB, z),
            new Vector3(-0.62f * w, -hB, z),
            new Vector3(-w, -0.15f * hB, z),
            new Vector3(-0.90f * w, 0.30f * hT, z),
            new Vector3(-0.55f * w, 0.78f * hT, z),
            new Vector3(-0.22f * w, 0.98f * hT, z),
            new Vector3(0f, hT, z),
            new Vector3(0.22f * w, 0.98f * hT, z),
            new Vector3(0.55f * w, 0.78f * hT, z),
            new Vector3(0.90f * w, 0.30f * hT, z),
            new Vector3(w, -0.15f * hB, z),
            new Vector3(0.62f * w, -hB, z),
            new Vector3(0.30f * w, -hB, z)
        };
    }

    // 放样：法线由环向切线 x 纵向切线算出，再用「是否朝外」修正
    static Mesh Loft(List<Vector3[]> rings, bool capBase, Vector3 tip, bool useTip, string name)
    {
        MB mb = new MB();
        int nr = rings.Count;
        int nn = rings[0].Length;
        int[,] ids = new int[nr, nn];
        for (int i = 0; i < nr; i++)
        {
            Vector3 c = Vector3.zero;
            for (int j = 0; j < nn; j++) c += rings[i][j];
            c /= nn;
            for (int j = 0; j < nn; j++)
            {
                Vector3 tg = rings[i][(j + 1) % nn] - rings[i][(j - 1 + nn) % nn];
                Vector3 lg;
                if (i == 0) lg = rings[i + 1][j] - rings[i][j];
                else if (i == nr - 1) lg = rings[i][j] - rings[i - 1][j];
                else lg = rings[i + 1][j] - rings[i - 1][j];
                Vector3 nrm = Vector3.Cross(lg, tg).normalized;
                if (nrm.sqrMagnitude < 1e-9f) nrm = Vector3.Cross(tg, Vector3.forward).normalized;
                Vector3 rad = rings[i][j] - c;
                if (rad.sqrMagnitude > 1e-12f && Vector3.Dot(nrm, rad) < 0f) nrm = -nrm;
                ids[i, j] = mb.Add(rings[i][j], nrm, new Vector2((float)j / nn, (float)i / (nr - 1)));
            }
        }
        for (int i = 0; i < nr - 1; i++)
            for (int j = 0; j < nn; j++)
            {
                int j2 = (j + 1) % nn;
                mb.Tri(ids[i, j], ids[i + 1, j], ids[i + 1, j2]);
                mb.Tri(ids[i, j], ids[i + 1, j2], ids[i, j2]);
            }
        if (useTip)
        {
            int tv = mb.Add(tip, Vector3.forward, new Vector2(0.5f, 1f));
            for (int j = 0; j < nn; j++)
            {
                int j2 = (j + 1) % nn;
                mb.Tri(ids[nr - 1, j], tv, ids[nr - 1, j2]);
            }
        }
        if (capBase)
        {
            Vector3 c0 = Vector3.zero;
            for (int j = 0; j < nn; j++) c0 += rings[0][j];
            c0 /= nn;
            int cv = mb.Add(c0, Vector3.back, new Vector2(0.5f, 0.5f));
            for (int j = 0; j < nn; j++)
            {
                int j2 = (j + 1) % nn;
                mb.Tri(cv, ids[0, j], ids[0, j2]);
            }
        }
        return mb.ToMesh(name);
    }
    // (z, r) 平面内的多边形沿 X 挤出，绕 Z 旋转 angDeg；厚度从根部 halfT 渐变到翼尖 halfTip
    static void ExtrudePoly(MB mb, List<Vector2> outline, float halfT, float halfTip, float angDeg, bool capFront, bool capBack,
                            Vector2? centerHint = null)
    {
        float ang = angDeg * Mathf.Deg2Rad;
        float ca = Mathf.Cos(ang), sa = Mathf.Sin(ang);
        Vector2 c = centerHint.HasValue ? centerHint.Value : Centroid(outline);

        float rMin = float.MaxValue, rMax = float.MinValue;
        foreach (Vector2 p in outline) { rMin = Mathf.Min(rMin, p.y); rMax = Mathf.Max(rMax, p.y); }
        float span = Mathf.Max(1e-5f, rMax - rMin);
        float[] ht = new float[outline.Count];
        for (int i = 0; i < outline.Count; i++)
            ht[i] = Mathf.Lerp(halfT, halfTip, Mathf.Clamp01((outline[i].y - rMin) / span));

        if (capFront)
        {
            List<int> idx = new List<int>();
            for (int i = 0; i < outline.Count; i++)
            {
                Vector3 p = RotZ(new Vector3(ht[i], outline[i].y, outline[i].x), ca, sa);
                idx.Add(mb.Add(p, RotZ(new Vector3(1f, 0f, 0f), ca, sa), new Vector2((float)i / outline.Count, 0.5f)));
            }
            for (int i = 1; i < outline.Count - 1; i++) mb.Tri(idx[0], idx[i], idx[i + 1]);
        }
        if (capBack)
        {
            List<int> idx = new List<int>();
            for (int i = 0; i < outline.Count; i++)
            {
                Vector3 p = RotZ(new Vector3(-ht[i], outline[i].y, outline[i].x), ca, sa);
                idx.Add(mb.Add(p, RotZ(new Vector3(-1f, 0f, 0f), ca, sa), new Vector2((float)i / outline.Count, 0.5f)));
            }
            for (int i = 1; i < outline.Count - 1; i++) mb.Tri(idx[0], idx[i], idx[i + 1]);
        }
        for (int i = 0; i < outline.Count; i++)
        {
            int j = (i + 1) % outline.Count;
            Vector2 mid = (outline[i] + outline[j]) * 0.5f;
            Vector2 dir = mid - c;
            if (dir.sqrMagnitude < 1e-8f) dir = new Vector2(0f, 1f);
            dir.Normalize();
            Vector3 nrm = RotZ(new Vector3(0f, dir.x, dir.y), ca, sa);
            Vector3 pA = RotZ(new Vector3(ht[i], outline[i].y, outline[i].x), ca, sa);
            Vector3 pB = RotZ(new Vector3(ht[j], outline[j].y, outline[j].x), ca, sa);
            Vector3 pC = RotZ(new Vector3(-ht[j], outline[j].y, outline[j].x), ca, sa);
            Vector3 pD = RotZ(new Vector3(-ht[i], outline[i].y, outline[i].x), ca, sa);
            int a = mb.Add(pA, nrm, new Vector2(0f, 0f));
            int b = mb.Add(pB, nrm, new Vector2(1f, 0f));
            int cc = mb.Add(pC, nrm, new Vector2(1f, 1f));
            int d = mb.Add(pD, nrm, new Vector2(0f, 1f));
            mb.Tri(a, b, cc); mb.Tri(a, cc, d);
        }
    }

    static Vector2 Centroid(List<Vector2> pts)
    {
        Vector2 s = Vector2.zero;
        for (int i = 0; i < pts.Count; i++) s += pts[i];
        return s / pts.Count;
    }

    static Vector3 RotZ(Vector3 p, float ca, float sa)
    {
        return new Vector3(p.x * ca - p.y * sa, p.x * sa + p.y * ca, p.z);
    }

    static void PlateZ(MB mb, float z, float x0, float x1, float y0, float y1, float sign)
    {
        Vector3 nrm = new Vector3(0f, 0f, sign);
        int a = mb.Add(new Vector3(x0, y0, z), nrm, new Vector2(0f, 0f));
        int b = mb.Add(new Vector3(x1, y0, z), nrm, new Vector2(1f, 0f));
        int c = mb.Add(new Vector3(x1, y1, z), nrm, new Vector2(1f, 1f));
        int d = mb.Add(new Vector3(x0, y1, z), nrm, new Vector2(0f, 1f));
        mb.Tri(a, b, c); mb.Tri(a, c, d);
    }

    static void DiscZ(MB mb, float z, float r, int seg, float sign)
    {
        Vector3 nrm = new Vector3(0f, 0f, sign);
        int c = mb.Add(new Vector3(0f, 0f, z), nrm, new Vector2(0.5f, 0.5f));
        int first = -1, prev = -1;
        for (int i = 0; i < seg; i++)
        {
            float a = (float)i / seg * Mathf.PI * 2f;
            int id = mb.Add(new Vector3(Mathf.Cos(a) * r, Mathf.Sin(a) * r, z), nrm,
                                new Vector2(Mathf.Cos(a) * 0.5f + 0.5f, Mathf.Sin(a) * 0.5f + 0.5f));
            if (first < 0) first = id;
            if (prev >= 0) mb.Tri(c, prev, id);
            prev = id;
        }
        mb.Tri(c, prev, first);
    }

    // ===================== materials =====================
    static Material Mat(string name, string hex, float metallic, float gloss)
    {
        string path = "Assets/DSH/Materials/" + name + ".mat";
        Directory.CreateDirectory(Path.Combine(ProjectRoot(), "Assets/DSH/Materials"));
        Material m = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (m == null)
        {
            m = new Material(Shader.Find("Standard"));
            AssetDatabase.CreateAsset(m, path);
        }
        Color col;
        ColorUtility.TryParseHtmlString(hex, out col);
        m.color = col;
        m.SetFloat("_Metallic", metallic);
        m.SetFloat("_Glossiness", gloss);
        m.enableInstancing = true;
        EditorUtility.SetDirty(m);
        return m;
    }

    static string ProjectRoot()
    {
        string p = Application.dataPath;
        return p.Substring(0, p.Length - "/Assets".Length);
    }

    static GameObject Part(string name, Mesh mesh, Material mat, Transform parent)
    {
        GameObject go = new GameObject(name);
        go.transform.SetParent(parent, false);
        MeshFilter mf = go.AddComponent<MeshFilter>();
        mf.sharedMesh = mesh;
        MeshRenderer mr = go.AddComponent<MeshRenderer>();
        mr.sharedMaterial = mat;
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        mr.receiveShadows = false;
        return go;
    }

    // ===================== build =====================
    const float R = 0.325f;      // 一级弹体半径
    const float CYL0 = 0.60f;    // 圆柱段起点
    const float ZS2 = 6.30f;     // 一级圆柱段终点（级间段起点）
    const float LEN = 8.55f;     // 全弹长

    public static object Run()
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
        RenderSettings.ambientLight = new Color(0.33f, 0.35f, 0.39f);
        RenderSettings.fog = false;
        RenderSettings.skybox = null;

        Material bodyMat    = Mat("YJ37_Body",    "#E7EAEE", 0.06f, 0.32f);
        Material radomeMat  = Mat("YJ37_Radome",  "#262B31", 0.18f, 0.50f);
        Material markingMat = Mat("YJ37_Marking", "#16324F", 0.05f, 0.35f);
        Material nozzleMat  = Mat("YJ37_Nozzle",  "#4C5158", 0.85f, 0.62f);
        Material darkMat    = Mat("YJ37_Dark",    "#0D1013", 0.10f, 0.18f);
        Material upperMat   = Mat("YJ37_Upper",   "#49525E", 0.30f, 0.44f);

        GameObject root = new GameObject("YJ37_Missile");

        Func<Mesh, string, Mesh> SaveMesh = (m, nm) =>
        {
            string dir = "Assets/DSH/Meshes";
            Directory.CreateDirectory(Path.Combine(ProjectRoot(), dir));
            string path = dir + "/YJ37_" + nm + ".asset";
            if (AssetDatabase.LoadAssetAtPath<Mesh>(path) != null) AssetDatabase.DeleteAsset(path);
            AssetDatabase.CreateAsset(m, path);
            return AssetDatabase.LoadAssetAtPath<Mesh>(path);
        };
        Func<string, Mesh, Material, GameObject> Add = (nm, mesh, mat) =>
            Part(nm, SaveMesh(mesh, nm), mat, root.transform);

        // ---- 1. 一级弹体（尾锥 + 圆柱）----
        List<Vector2> bodyProf = new List<Vector2>();
        bodyProf.Add(new Vector2(0.18f, 0.288f));
        bodyProf.Add(new Vector2(0.26f, 0.312f));
        bodyProf.Add(new Vector2(CYL0, R));
        bodyProf.Add(new Vector2(ZS2, R));
        Add("Body", Lathe(bodyProf, 64, "Body"), bodyMat);

        // ---- 2. 识别环带（两道藏青，微凸）----
        MB mbMark = new MB();
        AppendLathe(mbMark, new List<Vector2> { new Vector2(3.05f, 0.3295f), new Vector2(3.05f, 0.3325f),
                                                new Vector2(3.19f, 0.3325f), new Vector2(3.19f, 0.3295f) }, 64);
        AppendLathe(mbMark, new List<Vector2> { new Vector2(4.70f, 0.3295f), new Vector2(4.70f, 0.3325f),
                                                new Vector2(4.84f, 0.3325f), new Vector2(4.84f, 0.3295f) }, 64);
        Add("Markings", mbMark.ToMesh("Markings"), markingMat);

        // ---- 3. 尾喷管 ----
        Add("Nozzle", Lathe(new List<Vector2> { new Vector2(0f, 0.240f), new Vector2(0.09f, 0.268f), new Vector2(0.18f, 0.290f) }, 48, "Nozzle"), nozzleMat);
        MB mbInner = new MB();
        DiscZ(mbInner, 0.010f, 0.232f, 48, -1f);
        Add("NozzleInner", mbInner.ToMesh("NozzleInner"), darkMat);

        // ---- 4. 尾翼（4 片 @45°，大后掠）----
        MB mbFin = new MB();
        List<Vector2> finProf = new List<Vector2> { new Vector2(0.55f, R), new Vector2(1.66f, R),
                                                    new Vector2(1.29f, 1.080f), new Vector2(1.02f, 1.080f) };
        for (int i = 0; i < 4; i++)
            ExtrudePoly(mbFin, finProf, 0.018f, 0.005f, 45f + 90f * i, true, true);
        Add("TailFins", mbFin.ToMesh("TailFins"), bodyMat);

        // ---- 5. 中段条翼（4 片 @45°，小展弦比）----
        MB mbStrike = new MB();
        List<Vector2> strikeProf = new List<Vector2> { new Vector2(4.30f, R), new Vector2(5.02f, R),
                                                       new Vector2(4.85f, 0.600f), new Vector2(4.60f, 0.600f) };
        for (int i = 0; i < 4; i++)
            ExtrudePoly(mbStrike, strikeProf, 0.010f, 0.003f, 45f + 90f * i, true, true);
        Add("Strikes", mbStrike.ToMesh("Strikes"), bodyMat);

        // ---- 6. 头段鸭翼（4 片 @0°，与条翼错开 45°）----
        MB mbCanard = new MB();
        List<Vector2> canardProf = new List<Vector2> { new Vector2(5.45f, R), new Vector2(5.90f, R),
                                                       new Vector2(5.78f, 0.575f), new Vector2(5.60f, 0.575f) };
        for (int i = 0; i < 4; i++)
            ExtrudePoly(mbCanard, canardProf, 0.009f, 0.003f, 0f + 90f * i, true, true);
        Add("Canards", mbCanard.ToMesh("Canards"), bodyMat);

        // ---- 7. 腹部进气整流罩（@180° = -Y 方向）+ 进气口暗板 ----
        MB mbIntake = new MB();
        List<Vector2> intakeProf = new List<Vector2> { new Vector2(3.765f, 0.300f), new Vector2(5.035f, 0.300f),
                                                       new Vector2(5.035f, 0.545f), new Vector2(4.095f, 0.545f) };
        ExtrudePoly(mbIntake, intakeProf, 0.165f, 0.150f, 180f, true, true);
        Add("Intake", mbIntake.ToMesh("Intake"), bodyMat);
        MB mbMouth = new MB();
        PlateZ(mbMouth, 5.033f, -0.150f, 0.150f, -0.515f, -0.325f, 1f);
        Add("IntakeMouth", mbMouth.ToMesh("IntakeMouth"), darkMat);

        // ---- 8. 级间段：环形箍 + 收缩颈 + 封口法兰 ----
        Add("InterstageRing", Lathe(new List<Vector2> { new Vector2(6.16f, R), new Vector2(6.18f, 0.346f),
                                                        new Vector2(6.32f, 0.346f), new Vector2(6.34f, R) }, 64, "InterstageRing"), nozzleMat);
        Add("InterstageNeck", Lathe(new List<Vector2> { new Vector2(6.30f, R), new Vector2(6.36f, 0.308f),
                                                        new Vector2(6.44f, 0.215f), new Vector2(6.442f, 0.215f),
                                                        new Vector2(6.442f, 0.060f) }, 64, "InterstageNeck"), darkMat);

        // ---- 9. 二级首段（深灰异形截面，宽略大于高）----
        float[] sw  = { 0.252f, 0.251f, 0.250f, 0.249f, 0.248f };
        float[] shT = { 0.184f, 0.183f, 0.182f, 0.181f, 0.180f };
        float[] shB = { 0.160f, 0.159f, 0.158f, 0.157f, 0.156f };
        float[] sz  = { 6.445f, 6.58f, 6.74f, 6.92f, 7.10f };
        List<Vector3[]> stage1 = new List<Vector3[]>();
        for (int i = 0; i < 5; i++) stage1.Add(WSection(sz[i], sw[i], shT[i], shB[i]));
        Add("Stage1_Upper", Loft(stage1, true, Vector3.zero, false, "Stage1_Upper"), upperMat);

        // ---- 10. 承波体弹头（单独物体，锥形收敛到尖点）----
        float[] ts = { 0f, 0.04f, 0.09f, 0.15f, 0.22f, 0.30f, 0.39f, 0.48f, 0.57f, 0.66f, 0.75f, 0.83f, 0.90f, 0.95f, 0.985f };
        List<Vector3[]> war = new List<Vector3[]>();
        float zW0 = 7.10f, zW1 = 8.55f;
        war.Add(WSection(7.086f, 0.248f * 1.045f, 0.180f * 1.05f, 0.156f * 1.05f));
        for (int i = 0; i < ts.Length; i++)
        {
            float t = ts[i];
            float zz = Mathf.Lerp(zW0, zW1, t);
            float ww = 0.248f * Mathf.Pow(1f - t, 0.55f);
            float hhT = 0.180f * Mathf.Pow(1f - t, 1.10f);
            float hhB = 0.156f * Mathf.Pow(1f - t, 0.85f);
            war.Add(WSection(zz, ww, hhT, hhB));
        }
        Add("Warhead_Waverider", Loft(war, true, new Vector3(0f, -0.006f, zW1), true, "Warhead_Waverider"), radomeMat);

        // ---- 灯光 ----
        Func<string, float, float, float, float, Light> MkLight = (nm, lx, ly, lz, it) =>
        {
            GameObject lgo = new GameObject(nm);
            lgo.transform.SetParent(root.transform, false);
            lgo.transform.rotation = Quaternion.Euler(lx, ly, lz);
            Light li = lgo.AddComponent<Light>();
            li.type = LightType.Directional;
            li.intensity = it;
            return li;
        };
        GameObject studio = new GameObject("Studio");
        studio.transform.SetParent(root.transform, false);
        GameObject kl = new GameObject("Key");  kl.transform.SetParent(studio.transform, false);  kl.transform.rotation = Quaternion.Euler(48f, 38f, 0f);
        Light kli = kl.AddComponent<Light>(); kli.type = LightType.Directional; kli.intensity = 1.25f;
        GameObject fl = new GameObject("Fill"); fl.transform.SetParent(studio.transform, false); fl.transform.rotation = Quaternion.Euler(22f, 205f, 0f);
        Light ffi = fl.AddComponent<Light>(); ffi.type = LightType.Directional; ffi.intensity = 0.45f;
        GameObject rl = new GameObject("Rim");  rl.transform.SetParent(studio.transform, false);  rl.transform.rotation = Quaternion.Euler(12f, 118f, 0f);
        Light rli = rl.AddComponent<Light>(); rli.type = LightType.Directional; rli.intensity = 0.70f;

        // ---- 保存场景 ----
        Directory.CreateDirectory(Path.Combine(ProjectRoot(), "Assets/Scenes"));
        AssetDatabase.SaveAssets();
        EditorSceneManager.SaveScene(scene, "Assets/Scenes/YJ37_Model.unity");

        // ---- 自检 ----
        Bounds bb = new Bounds(root.transform.position, Vector3.zero);
        int tri = 0, rend = 0;
        StringBuilder sb = new StringBuilder();
        foreach (MeshRenderer mr in root.GetComponentsInChildren<MeshRenderer>(true))
        {
            rend++;
            MeshFilter mf = mr.GetComponent<MeshFilter>();
            if (mf == null || mf.sharedMesh == null) { sb.Append("NULLMESH " + mr.name + "\n"); continue; }
            bb.Encapsulate(mf.sharedMesh.bounds);
            tri += mf.sharedMesh.triangles.Length / 3;
            sb.Append(mr.name + " v=" + mf.sharedMesh.vertexCount + " t=" + (mf.sharedMesh.triangles.Length / 3)
                      + " mat=" + (mr.sharedMaterial != null ? mr.sharedMaterial.name : "null") + "\n");
        }
        return "root=YJ37_Missile children=" + root.transform.childCount + " renderers=" + rend
               + " triangles=" + tri + " size=" + bb.size.ToString("F3") + " center=" + bb.center.ToString("F3")
               + "\n" + sb.ToString();
    }
}
