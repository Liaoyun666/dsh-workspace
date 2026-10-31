using System;
using System.CodeDom.Compiler;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace DSHUnityBridge
{
    /// <summary>Compiles a C# snippet into an in-memory assembly and runs DSHSnippet.Run().</summary>
    public static class DSHCodeRunner
    {
        const int CompileTimeoutMs = 60000;

        public static object Run(string code)
        {
            if (string.IsNullOrEmpty(code)) throw new ArgumentException("code 为空");
            string source = BuildSource(code);
            string tempDir = Path.Combine(Path.GetTempPath(), "DSHUnityBridge");
            Directory.CreateDirectory(tempDir);
            string dllPath = Path.Combine(tempDir, "DSHSnippet_" + DateTime.Now.Ticks + ".dll");
            string srcPath = Path.Combine(tempDir, "DSHSnippet_" + DateTime.Now.Ticks + ".cs");
            File.WriteAllText(srcPath, source, new UTF8Encoding(false));
            try
            {
                Exception domError = null;
                try { CompileWithCodeDom(source, dllPath); }
                catch (Exception e) { domError = e; }

                if (!File.Exists(dllPath))
                {
                    try { CompileWithCsc(srcPath, dllPath); }
                    catch (Exception cscError)
                    {
                        throw new Exception("C# 编译失败。\n[CodeDom] " + (domError == null ? "n/a" : domError.Message) +
                                            "\n[csc] " + cscError.Message);
                    }
                }

                byte[] bytes = File.ReadAllBytes(dllPath);
                Assembly asm = Assembly.Load(bytes);
                Type t = asm.GetType("DSHSnippet");
                if (t == null) throw new Exception("编译产物里找不到 DSHSnippet 类型");
                MethodInfo mi = t.GetMethod("Run", BindingFlags.Public | BindingFlags.Static);
                if (mi == null) throw new Exception("编译产物里找不到 Run() 方法");
                try { return mi.Invoke(null, null); }
                catch (TargetInvocationException tie)
                {
                    if (tie.InnerException != null)
                        throw new Exception(tie.InnerException.GetType().Name + ": " + tie.InnerException.Message, tie.InnerException);
                    throw;
                }
            }
            finally
            {
                TryDelete(srcPath);
                TryDelete(dllPath);
                CleanupOld(tempDir);
            }
        }

        static string BuildSource(string code)
        {
            // 允许直接提交完整源文件（含 using 与 class DSHSnippet），便于写带辅助方法的复杂脚本。
            if (System.Text.RegularExpressions.Regex.IsMatch(code, @"\bclass\s+DSHSnippet\b"))
                return code;
            return "using System;\n" +
                   "using System.Collections;\n" +
                   "using System.Collections.Generic;\n" +
                   "using System.Linq;\n" +
                   "using UnityEngine;\n" +
                   "using UnityEditor;\n" +
                   "using UnityEngine.SceneManagement;\n" +
                   "public static class DSHSnippet {\n" +
                   "  public static object Run() {\n" +
                   "#line 1\n" + code + "\n#line default\n" +
                   "    return null;\n" +
                   "  }\n" +
                   "}\n";
        }

        static void CompileWithCodeDom(string source, string dllPath)
        {
            // Unity ships Microsoft.CSharp; on some platforms CodeDom is unavailable, so the caller falls back to csc.
            using (var provider = new Microsoft.CSharp.CSharpCodeProvider())
            {
                var cp = new CompilerParameters();
                cp.GenerateInMemory = false;
                cp.GenerateExecutable = false;
                cp.OutputAssembly = dllPath;
                cp.TreatWarningsAsErrors = false;
                cp.WarningLevel = 0;
                cp.CompilerOptions = "/langversion:latest /nowarn:0162,0168,0219,0414";
                foreach (string r in CollectReferences()) cp.ReferencedAssemblies.Add(r);
                CompilerResults results = provider.CompileAssemblyFromSource(cp, source);
                if (results.Errors != null && results.Errors.HasErrors)
                {
                    var sb = new StringBuilder();
                    foreach (CompilerError err in results.Errors)
                    {
                        if (err.IsWarning) continue;
                        sb.AppendLine(err.FileName + "(" + err.Line + "," + err.Column + "): " + err.ErrorText);
                    }
                    throw new Exception(sb.ToString().Trim());
                }
                if (!File.Exists(dllPath)) throw new Exception("CodeDom 未生成程序集");
            }
        }

        static void CompileWithCsc(string srcPath, string dllPath)
        {
            string csc = FindCsc();
            if (csc == null) throw new Exception("找不到 csc.exe（Unity 安装可能不完整）");
            var args = new StringBuilder();
            args.Append("/nologo /target:library /utf8output /langversion:latest /nowarn:0162,0168,0219,0414 ");
            args.Append("/out:\"").Append(dllPath).Append("\" ");
            foreach (string r in CollectReferences()) args.Append("/r:\"").Append(r).Append("\" ");
            args.Append('"').Append(srcPath).Append('"');

            var psi = new ProcessStartInfo(csc, args.ToString())
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false),
                WorkingDirectory = Path.GetDirectoryName(srcPath)
            };
            using (var p = Process.Start(psi))
            {
                string stdout = p.StandardOutput.ReadToEnd();
                string stderr = p.StandardError.ReadToEnd();
                if (!p.WaitForExit(CompileTimeoutMs))
                {
                    try { p.Kill(); } catch { }
                    throw new Exception("csc 编译超时（" + (CompileTimeoutMs / 1000) + "s）");
                }
                if (p.ExitCode != 0)
                {
                    string text = (stdout + "\n" + stderr).Trim();
                    throw new Exception(string.IsNullOrEmpty(text) ? ("csc 退出码 " + p.ExitCode) : text);
                }
            }
            if (!File.Exists(dllPath)) throw new Exception("csc 未生成程序集");
        }

        static string FindCsc()
        {
            string contents = EditorApplication.applicationContentsPath; // <Editor>/Data on Windows
            string[] candidates =
            {
                Path.Combine(contents, "Tools", "Roslyn", "csc.exe"),
                Path.Combine(contents, "Tools", "Roslyn", "csc"),
                Path.Combine(contents, "Tools", "csc.exe"),
                Path.Combine(contents, "MonoBleedingEdge", "bin", "mcs.exe"),
                Path.Combine(contents, "MonoBleedingEdge", "bin", "mcs")
            };
            foreach (string c in candidates) if (File.Exists(c)) return c;
            return null;
        }

        static List<string> CollectReferences()
        {
            // 实测确定的引用集合（见 unity-mcp/docs/code-runner-refs.md）：
            //   Managed\UnityEngine\ 目录下的全部 dll（含 92 KB 的 UnityEngine.dll 门面 + 各 *Module）足以编译
            //   Object / Scene / SceneManager / AssetDatabase 等签名；Managed 根目录的 UnityEngine.dll(3.4 MB) /
            //   UnityEditor.dll 与 Module 重复定义类型，混引会报 CS0433，必须避开。
            var list = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Action<string> add = p =>
            {
                if (string.IsNullOrEmpty(p) || !File.Exists(p)) return;
                if (seen.Add(Path.GetFileName(p))) list.Add(p);
            };

            // 1) 核心框架程序集：用当前运行时的真实路径，避免版本错配
            foreach (string n in new[] { "mscorlib.dll", "System.dll", "System.Core.dll", "System.Xml.dll", "System.Data.dll", "Microsoft.CSharp.dll" })
            {
                try
                {
                    var a = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(x => string.Equals(x.GetName().Name + ".dll", n, StringComparison.OrdinalIgnoreCase));
                    if (a != null) add(a.Location);
                }
                catch { }
            }

            // 2) Unity 引擎/编辑器程序集：Managed\UnityEngine 完整集合
            string managed = Path.Combine(EditorApplication.applicationContentsPath, "Managed");
            string engineDir = Path.Combine(managed, "UnityEngine");
            if (Directory.Exists(engineDir))
            {
                foreach (string f in Directory.GetFiles(engineDir, "*.dll")) add(f);
            }

            // 3) 兜底：老版本布局（没有 Managed\UnityEngine 子目录）时退回根目录
            if (list.Count <= 6 && Directory.Exists(managed))
            {
                foreach (string f in Directory.GetFiles(managed, "Unity*.dll")) add(f);
            }
            return list;
        }

        static void TryDelete(string p)
        {
            try { if (File.Exists(p)) File.Delete(p); } catch { }
        }

        static void CleanupOld(string dir)
        {
            try
            {
                foreach (string f in Directory.GetFiles(dir, "DSHSnippet_*"))
                {
                    if (DateTime.UtcNow - File.GetLastWriteTimeUtc(f) > TimeSpan.FromMinutes(10)) TryDelete(f);
                }
            }
            catch { }
        }
    }
}
