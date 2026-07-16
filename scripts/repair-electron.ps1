# 修复 Electron 二进制。
#
# npm install 有时候把 electron 包装好了，但那个 180MB 的本体没解压出来 ——
# postinstall 静默失败，退出码还是 0，于是 npm 觉得一切正常，
# 直到你运行时才报 "Electron failed to install correctly"。
# 这脚本直接从 npm 的下载缓存里把 zip 解出来，不用重新下。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$electronDir = Join-Path $root 'node_modules\electron'
$dist = Join-Path $electronDir 'dist'

if (-not (Test-Path $electronDir)) {
  Write-Host '  electron 包本身就不在，请先 npm install'
  exit 1
}

$ver = (Get-Content (Join-Path $electronDir 'package.json') -Raw | ConvertFrom-Json).version
$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'ia32' }
$zipName = "electron-v$ver-win32-$arch.zip"
$cache = Join-Path $env:LOCALAPPDATA 'electron\Cache'

Write-Host "  目标版本: $ver ($arch)"

function Find-Zip {
  if (-not (Test-Path $cache)) { return $null }
  Get-ChildItem -Path $cache -Recurse -Filter $zipName -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

$zip = Find-Zip
if (-not $zip) {
  Write-Host '  缓存里没有，正在下载...'
  Push-Location $root
  try { & node (Join-Path $electronDir 'install.js') } catch {}
  Pop-Location
  $zip = Find-Zip
}

if (-not $zip) {
  Write-Host '  下载失败。检查网络，或手动执行: npm rebuild electron'
  exit 1
}

Write-Host "  正在解压 $([math]::Round($zip.Length/1MB)) MB ..."
if (Test-Path $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dist | Out-Null

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip.FullName, $dist)

$exe = Join-Path $dist 'electron.exe'
if (-not (Test-Path $exe)) {
  Write-Host '  解压后仍然没有 electron.exe，缓存的压缩包可能损坏了'
  Write-Host "  删掉它再试一次: $($zip.FullName)"
  exit 1
}

# electron 靠这个文件定位自己的本体
Set-Content -Path (Join-Path $electronDir 'path.txt') -Value 'electron.exe' -NoNewline -Encoding ascii

Write-Host '  修复完成'
exit 0
