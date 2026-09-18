# 编译外部播放器桥 NoxReelPlayerBridge.exe。
#
# 产物放在 vendor/bin（不进 git），打包时随 extraResources 带走。
# 源码或清单一变就重编：只看「文件在不在」的话，改了源码之后旧产物会被照样测试、照样打包，
# 而 vendor/ 被 gitignore 忽略，这种过期很难被发现。
# 注意：本文件必须存成「UTF-8 带 BOM」。

param(
  [switch]$Force,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$projectRoot = Split-Path -Parent $PSScriptRoot
$srcDir = Join-Path (Join-Path $projectRoot 'src') 'bridge'
$source = Join-Path $srcDir 'NoxReelPlayerBridge.cs'
$manifest = Join-Path $srcDir 'NoxReelPlayerBridge.manifest'
if (-not $OutDir) { $OutDir = Join-Path (Join-Path $projectRoot 'vendor') 'bin' }
$output = Join-Path $OutDir 'NoxReelPlayerBridge.exe'
$stamp = $output + '.srchash'

$frameworks = Join-Path $env:WINDIR 'Microsoft.NET'
$compiler = Join-Path (Join-Path (Join-Path $frameworks 'Framework64') 'v4.0.30319') 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
  $compiler = Join-Path (Join-Path (Join-Path $frameworks 'Framework') 'v4.0.30319') 'csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler)) { throw '没找到 Windows 自带的 C# 编译器 csc.exe' }
foreach ($f in @($source, $manifest)) {
  if (-not (Test-Path -LiteralPath $f)) { throw "缺少桥接程序源码：$f" }
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash + ':' +
        (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash + ':' +
        (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash

if (-not $Force -and (Test-Path -LiteralPath $output) -and (Test-Path -LiteralPath $stamp)) {
  if ((Get-Content -Raw -LiteralPath $stamp).Trim() -eq $hash) {
    Write-Host '桥接程序已是最新'
    exit 0
  }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

& $compiler /nologo /target:winexe /platform:anycpu /optimize+ `
  "/win32manifest:$manifest" `
  /reference:System.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll `
  "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw "桥接程序编译失败：$LASTEXITCODE" }

Set-Content -LiteralPath $stamp -Value $hash -Encoding ascii
Get-Item -LiteralPath $output | Select-Object Name, Length, LastWriteTime
