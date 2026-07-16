@echo off
REM ASCII-only stub. See 启动.bat for why. Real logic lives in the .ps1.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-signal.ps1" %*
if errorlevel 1 pause
