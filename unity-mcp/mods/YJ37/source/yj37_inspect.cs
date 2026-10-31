using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

public class DSHSnippet
{
    static void Walk(Transform t, int depth, StringBuilder sb)
    {
        MeshFilter mf = t.GetComponent<MeshFilter>();
        MeshRenderer mr = t.GetComponent<MeshRenderer>();
        sb.Append(new string(' ', depth * 2)).Append(t.name);
        sb.Append(" pos=").Append(t.localPosition.ToString("F3"));
        sb.Append(" rot=").Append(t.localEulerAngles.ToString("F1"));
        sb.Append(" scale=").Append(t.localScale.ToString("F3"));
        if (mf != null && mf.sharedMesh != null)
        {
            Mesh m = mf.sharedMesh;
            string path = AssetDatabase.GetAssetPath(m);
            sb.Append(" mesh=").Append(m.name).Append("(v=").Append(m.vertexCount).Append(",b=").Append(m.bounds.size.ToString("F3"));
            sb.Append(",asset=").Append(string.IsNullOrEmpty(path) ? "<scene-mesh>" : path).Append(")");
        }
        else sb.Append(" mesh=NULL");
        if (mr != null) sb.Append(" mat=").Append(mr.sharedMaterial != null ? mr.sharedMaterial.name : "null");
        Component[] comps = t.GetComponents(typeof(Component));
        List<string> extra = new List<string>();
        foreach (Component c in comps)
        {
            string tn = c.GetType().Name;
            if (tn == "Transform" || tn == "MeshFilter" || tn == "MeshRenderer") continue;
            extra.Add(tn);
        }
        if (extra.Count > 0) sb.Append(" extra=[").Append(string.Join(",", extra.ToArray())).Append("]");
        sb.Append("\n");
        foreach (Transform ch in t) Walk(ch, depth + 1, sb);
    }

    public static object Run()
    {
        GameObject root = GameObject.Find("YJ37_Missile");
        StringBuilder sb = new StringBuilder();
        sb.Append("activeScene=").Append(EditorSceneManager.GetActiveScene().path).Append("\n");
        if (root == null)
        {
            sb.Append("MISSING YJ37_Missile; roots: ");
            foreach (GameObject g in EditorSceneManager.GetActiveScene().GetRootGameObjects()) sb.Append(g.name).Append(" ");
            return sb.ToString();
        }
        Bounds bb = new Bounds(root.transform.position, Vector3.zero);
        bool has = false;
        int tri = 0, rend = 0;
        foreach (MeshRenderer mr in root.GetComponentsInChildren<MeshRenderer>(true))
        {
            MeshFilter mf = mr.GetComponent<MeshFilter>();
            if (mf == null || mf.sharedMesh == null) continue;
            rend++;
            tri += mf.sharedMesh.triangles.Length / 3;
            if (!has) { bb = mf.sharedMesh.bounds; has = true; } else bb.Encapsulate(mf.sharedMesh.bounds);
        }
        sb.Append("children=").Append(root.transform.childCount).Append(" renderers=").Append(rend)
          .Append(" triangles=").Append(tri).Append(" bounds=").Append(bb.size.ToString("F3"))
          .Append(" center=").Append(bb.center.ToString("F3")).Append("\n");
        Walk(root.transform, 0, sb);
        return sb.ToString();
    }
}
