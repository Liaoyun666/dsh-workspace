using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace DSHUnityBridge
{
    /// <summary>Small status window: start/stop the bridge, change port, run a smoke test.</summary>
    public class BridgeWindow : EditorWindow
    {
        int port;
        string message = "";
        Vector2 scroll;

        [MenuItem("DSH/Unity Bridge", false, 1)]
        public static void Open()
        {
            var w = GetWindow<BridgeWindow>("DSH Unity Bridge");
            w.minSize = new Vector2(380, 260);
            w.Show();
        }

        [MenuItem("DSH/Start Bridge", false, 2)]
        public static void MenuStart() { Bridge.Start(); }

        [MenuItem("DSH/Stop Bridge", false, 3)]
        public static void MenuStop() { Bridge.Stop(); }

        [MenuItem("DSH/Create Test Cube", false, 20)]
        public static void TestCube()
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = "DSH_TestCube";
            go.transform.position = new Vector3(0, 0.5f, 0);
            Undo.RegisterCreatedObjectUndo(go, "DSH Test Cube");
            Selection.activeGameObject = go;
        }

        void OnEnable() { port = Bridge.Port; }

        void OnGUI()
        {
            EditorGUILayout.LabelField("Unity DSH 桥", EditorStyles.boldLabel);
            EditorGUILayout.Space();
            EditorGUILayout.LabelField("状态", Bridge.IsListening ? "运行中 ✔" : "未运行 ✘");
            EditorGUILayout.LabelField("地址", "127.0.0.1:" + Bridge.Port);
            EditorGUILayout.LabelField("工程", Path.GetDirectoryName(Application.dataPath));
            if (!string.IsNullOrEmpty(Bridge.LastError))
                EditorGUILayout.HelpBox(Bridge.LastError, MessageType.Warning);
            EditorGUILayout.Space();

            EditorGUILayout.BeginHorizontal();
            port = EditorGUILayout.IntField("端口", port);
            if (GUILayout.Button("应用端口", GUILayout.Width(90))) Bridge.SetPort(port);
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.BeginHorizontal();
            GUI.enabled = !Bridge.IsListening;
            if (GUILayout.Button("启动")) Bridge.Start();
            GUI.enabled = Bridge.IsListening;
            if (GUILayout.Button("停止")) Bridge.Stop();
            GUI.enabled = true;
            if (GUILayout.Button("重启")) Bridge.Restart();
            EditorGUILayout.EndHorizontal();

            bool auto = EditorPrefs.GetBool("DSHUnityBridge.AutoStart", true);
            bool newAuto = EditorGUILayout.Toggle("随编辑器自动启动", auto);
            if (newAuto != auto) EditorPrefs.SetBool("DSHUnityBridge.AutoStart", newAuto);

            EditorGUILayout.Space();
            if (GUILayout.Button("Ping 自检")) message = SelfTest();
            if (!string.IsNullOrEmpty(message))
                EditorGUILayout.HelpBox(message, MessageType.Info);

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("DSH 侧配置：config.json 的 projectPath 指向本工程，启动 DSH 后即可用 mcp__unity__* 工具。", EditorStyles.wordWrappedMiniLabel);
        }

        string SelfTest()
        {
            if (!Bridge.IsListening) return "桥未启动。";
            try
            {
                using (var c = new System.Net.Sockets.TcpClient())
                {
                    c.Connect("127.0.0.1", Bridge.Port);
                    using (var s = c.GetStream())
                    using (var w = new StreamWriter(s) { AutoFlush = true })
                    using (var r = new StreamReader(s))
                    {
                        w.WriteLine("{\"id\":\"selftest\",\"command\":\"ping\",\"params\":{}}");
                        string line = r.ReadLine();
                        return "响应: " + line;
                    }
                }
            }
            catch (Exception e) { return "自检失败: " + e.Message; }
        }
    }
}
