# SyncWatch 信令服务器启动脚本。由 启动信令服务器.bat 调起。
# 必须存成「UTF-8 带 BOM」，理由见 launch.ps1 的注释。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host ''
Write-Host '   NoxReel 信令服务器' -ForegroundColor Cyan
Write-Host '   ================================'
Write-Host ''
Write-Host '   它只转发连接地址，不接触任何视频内容。' -ForegroundColor Gray
Write-Host '   只有用「信令服务器邀请」时才需要它 —— 极简模式不需要。' -ForegroundColor Gray
Write-Host ''
Write-Host '   本机自测:  软件设置里用默认的 ws://localhost:8080 即可' -ForegroundColor Gray
Write-Host '   给别人用:  这台机器要有公网 IP，或用 ngrok 之类打通' -ForegroundColor Gray
Write-Host ''
Write-Host '   关闭窗口即停止。' -ForegroundColor DarkGray
Write-Host '   --------------------------------'
Write-Host ''

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '   [×] 没找到 Node.js，先装: https://nodejs.org' -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host '   [·] 正在安装依赖…' -ForegroundColor Yellow
  & npm install --no-audit --no-fund
  Write-Host ''
}

if (-not $env:PORT) { $env:PORT = '8080' }

& node (Join-Path $root 'signaling-server\server.js')

Write-Host ''
Write-Host '   服务器已停止' -ForegroundColor DarkGray
Read-Host '按回车退出'
