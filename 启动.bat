@echo off
REM ---------------------------------------------------------------
REM  This file is intentionally ASCII-only.
REM  cmd.exe parses .bat files using the OEM codepage (936 on a
REM  Chinese system), so UTF-8 text here turns into mojibake and
REM  cmd then tries to execute the garbage as commands. A leading
REM  "chcp 65001" does not help -- by then the file is already
REM  being parsed. So: keep this stub dumb, put the real logic
REM  (and the Chinese) in the PowerShell script, which reads UTF-8
REM  properly.
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1" %*
if errorlevel 1 pause
