# SyncWatch 启动脚本。由 启动.bat 调起。
#
# 逻辑放这儿而不是放 .bat 里，是因为 cmd.exe 按 OEM 代码页解析批处理文件，
# UTF-8 的中文会变成乱码并被当成命令执行。PowerShell 没这个问题。
# 注意：本文件必须存成「UTF-8 带 BOM」—— Windows PowerShell 5.1 没有 BOM 时
# 会按 ANSI 读，中文照样乱码。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Say($msg, $color = 'Gray') { Write-Host "   $msg" -ForegroundColor $color }

Write-Host ''
Write-Host '   NoxReel  —  P2P 同步观影' -ForegroundColor Cyan
Write-Host '   ================================'
Write-Host ''

# --- Node ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say '[×] 没找到 Node.js' 'Red'
  Say '    下载安装后重试: https://nodejs.org'
  Write-Host ''
  Read-Host '按回车退出'
  exit 1
}

# --- 依赖 ---
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Say '[·] 首次运行，正在安装依赖，请稍候…' 'Yellow'
  Write-Host ''
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Say '[×] 依赖安装失败，看看上面的报错' 'Red'
    Read-Host '按回车退出'
    exit 1
  }
  Write-Host ''
}

# --- Electron 本体 ---
# npm install 有时会漏掉那个 180MB 的本体且不报错，运行时才莫名其妙地失败
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electronExe)) {
  Say '[·] Electron 本体缺失，正在修复…' 'Yellow'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'repair-electron.ps1')
  if (-not (Test-Path $electronExe)) {
    Write-Host ''
    Say '[×] 自动修复失败。手动重装依赖试试:' 'Red'
    Say '    rmdir /s /q node_modules'
    Say '    npm install'
    Write-Host ''
    Read-Host '按回车退出'
    exit 1
  }
  Write-Host ''
}

# --- mpv（软件里也有引导，这里先提个醒）---
$mpvFound = (Get-Command mpv -ErrorAction SilentlyContinue) -or
            (Test-Path 'C:\Program Files\MPV Player\mpv.exe') -or
            (Test-Path 'C:\Program Files\mpv\mpv.exe')
if (-not $mpvFound) {
  Say '[!] 没找到 mpv —— 它是播放所必需的' 'Yellow'
  Say '    安装: winget install shinchiro.mpv Gyan.FFmpeg'
  Say '    装完不用重启，软件会自动找到它'
  Write-Host ''
}

Say '[·] 启动中…' 'Green'
Write-Host ''

& $electronExe . @args

if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
  Write-Host ''
  Say "[×] 异常退出（代码 $LASTEXITCODE），报错在上面" 'Red'
  Write-Host ''
  Read-Host '按回车退出'
  exit 1
}
