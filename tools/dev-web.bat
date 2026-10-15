@echo off
REM 天工开发台（3080）双击入口 —— 真正的启动脚本是同目录的 dev-web.ps1
REM 2026-10-12：原来根目录的 start-dsh.bat / start-dsh.ps1 里写死了 D:\deepseek-harness 与
REM D:\dsh-home（目录搬迁后都已不存在），删除前把入口搬到这里并修好路径。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev-web.ps1"
pause
