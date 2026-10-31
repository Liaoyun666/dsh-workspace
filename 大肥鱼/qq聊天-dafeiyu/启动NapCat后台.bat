@echo off
chcp 65001 >nul
set "APP=E:\工作区\other-apps\dafeiyu-qq\napcat\NapCat.52230.Shell\versions\9.9.33-52230\resources\app\napcat"
set "QQEXE=E:\工作区\other-apps\dafeiyu-qq\napcat\NapCat.52230.Shell\QQ.exe"
cd /d "%APP%"
set "NAPCAT_PATCH_PACKAGE=%APP%\qqnt.json"
set "NAPCAT_LOAD_PATH=%APP%\loadNapCat.js"
set "NAPCAT_INJECT_PATH=%APP%\NapCatWinBootHook.dll"
set "NAPCAT_LAUNCHER_PATH=%APP%\NapCatWinBootMain.exe"
set "NAPCAT_MAIN_PATH=%APP%\napcat.mjs"
echo 以管理员身份启动 NapCat（UAC 弹窗请点是）...
powershell -NoProfile -Command "Start-Process -FilePath '%APP%\NapCatWinBootMain.exe' -ArgumentList '%QQEXE%','%APP%\NapCatWinBootHook.dll' -WorkingDirectory '%APP%' -Verb RunAs"
echo 已请求启动，请看 QQ/NapCat 窗口扫码登录。
timeout /t 5 >nul