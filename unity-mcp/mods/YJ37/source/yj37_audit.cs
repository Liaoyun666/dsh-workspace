using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEngine;

public class DSHSnippet
{
    public static object Run()
    {
        GameObject root = GameObject.Find("YJ37_Missile");
        if (root == null) return "MISSING";
        StringBuilder sb = new StringBuilder();
        float totalArea = 0f;
        int bad = 0, nan = 0, nullMesh = 0, noUV = 0, degenAll = 0;
        foreach (MeshRenderer mr in root.GetComponentsInChildren<MeshRenderer>(true))
        {
            MeshFilter mf = mr.GetComponent<MeshFilter>();
            if (mf == null || mf.sharedMesh == null) { nullMesh++; sb.Append("NULLMESH " + mr.name + "\n"); continue; }
            Mesh m = mf.sharedMesh;
            Vector3[] vs = m.vertices;
            Vector3[] ns = m.normals;
            Vector2[] uvs = m.uv;
            int[] ts = m.triangles;
            if (uvs == null || uvs.Length == 0) noUV++;
            for (int i = 0; i < vs.Length; i++)
            {
                if (float.IsNaN(vs[i].x) || float.IsNaN(vs[i].y) || float.IsNaN(vs[i].z)) nan++;
                if (ns.Length > i && Mathf.Abs(ns[i].magnitude - 1f) > 0.02f) bad++;
            }
            float area = 0f;
            int degenerate = 0;
            for (int i = 0; i < ts.Length; i += 3)
            {
                Vector3 a = vs[ts[i]], b = vs[ts[i + 1]], c = vs[ts[i + 2]];
                float ar = Vector3.Cross(b - a, c - a).magnitude * 0.5f;
                if (ar < 1e-7f) degenerate++;
                area += ar;
            }
            degenAll += degenerate;
            totalArea += area;
            sb.Append(m.name).Append(" v=").Append(vs.Length).Append(" t=").Append(ts.Length / 3)
              .Append(" area=").Append(area.ToString("F3")).Append("m2 deg=").Append(degenerate)
              .Append(" sub=").Append(m.subMeshCount)
              .Append(" b=").Append(m.bounds.size.ToString("F3")).Append("\n");
        }
        sb.Append("TOTAL area=").Append(totalArea.ToString("F3")).Append("m2 nanVerts=").Append(nan)
          .Append(" badNormals=").Append(bad).Append(" nullMesh=").Append(nullMesh)
          .Append(" noUV=").Append(noUV).Append(" degenerate=").Append(degenAll).Append("\n");
        return sb.ToString();
    }
}
