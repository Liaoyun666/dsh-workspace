@echo off
rem 双击运行：把补丁重新覆盖到 DSH profile 的 dsh-persona-dafeiyu 里。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply.ps1" %*
pause
