@echo off
rem 启动 Unity Hub（清掉从 DSH 继承的 ELECTRON_RUN_AS_NODE，否则 Electron 外壳会退化成 node 秒退）
setlocal
set "ELECTRON_RUN_AS_NODE="
start "" "C:\Program Files\Unity Hub\Unity Hub.exe"
endlocal
