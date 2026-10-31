# 激活 Unity 2019.4.15f1

**本机已激活完成（2026-10-29 18:05，Unity Personal）**，`C:\ProgramData\Unity\Unity_lic.ulf` 存在，
Unity 以 `Personal` 正常启动、batchmode 也能跑。除非换机器或许可证掉了，不用再看这篇。

## 为什么只能用 Unity Hub

Unity 官方文档写得很清楚：**Manual license activation 不支持 Personal 计划**；
命令行 `-serial` / `-username` / `-password` 也只对 Pro 有效。
2019.4 用的是 Licensing v2，编辑器启动时直接弹「Install Unity Hub」——
所以 Personal 只能：装 Hub → 登录 Unity ID → Hub 发许可证。

参考：
- <https://docs.unity3d.com/6000.4/Documentation/Manual/LicenseActivationMethods.html>
- <https://docs.unity3d.com/6000.4/Documentation/Manual/ManagingYourUnityLicense.html>

## 步骤（换机器时照做）

1. 下载安装 Hub：<https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.exe>
   （静默安装：`UnityHubSetup.exe /S`，默认装到 `C:\Program Files\Unity Hub`）
2. **从干净环境启动 Hub**：`tools\start-hub.cmd`
   > 坑：从 DSH 的 shell 里直接启动时，进程会继承 `ELECTRON_RUN_AS_NODE=1`，
   > Electron 外壳退化成 node——Hub 秒退、`--help` 打出 node 的 usage。脚本会先清掉这个变量。
3. Hub 里登录 Unity ID（会跳浏览器，验证码/短信必须人来点）。
4. 登录成功后 Hub 自动给 2019.4 分配 Personal 许可证，几秒内写出
   `C:\ProgramData\Unity\Unity_lic.ulf`。
5. 关掉 Hub（许可证已落盘，之后不依赖 Hub 常驻）。

## 验证

```powershell
powershell -ExecutionPolicy Bypass -File E:\工作区\unity-mcp\tools\check-license.ps1
```

或直接看编辑器标题栏是否带 `Personal`：

```powershell
(Get-Process Unity).MainWindowTitle
```
