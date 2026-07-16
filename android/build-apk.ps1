# 构建 SyncWatch 安卓调试包（APK）。
#
# 用 JDK 17（sdkmanager 和 AGP 7.4 都要它）+ 本机下载好的 Gradle 7.6.3 直接构建，
# 不依赖 gradle wrapper。产物在 android/app/build/outputs/apk/debug/app-debug.apk。
#
# 用法：在 android 目录下  powershell -ExecutionPolicy Bypass -File build-apk.ps1

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# --- 定位 JDK 17 ---
$jdk = Get-ChildItem 'C:\Program Files\Microsoft' -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'jdk-17*' } | Select-Object -First 1
if (-not $jdk) { Write-Host '[×] 没找到 JDK 17，请先 winget install Microsoft.OpenJDK.17'; exit 1 }
$env:JAVA_HOME = $jdk.FullName
Write-Host "JAVA_HOME = $env:JAVA_HOME"

# --- 定位 Gradle ---
$gradle = 'C:\Users\A\AppData\Local\Android\gradle-dist\gradle-7.6.3\bin\gradle.bat'
if (-not (Test-Path $gradle)) { Write-Host "[×] 没找到 Gradle：$gradle"; exit 1 }

# --- 定位 SDK ---
if (-not (Test-Path (Join-Path $here 'local.properties'))) {
  $sdk = 'C:\Users\A\AppData\Local\Android\Sdk'
  "sdk.dir=$($sdk -replace '\\','\\')" | Out-File (Join-Path $here 'local.properties') -Encoding ascii
}

Write-Host '[·] 开始构建（首次会下载 AGP / 依赖，耐心等）…'
& $gradle assembleDebug --no-daemon --console=plain
if ($LASTEXITCODE -ne 0) { Write-Host "[×] 构建失败（代码 $LASTEXITCODE）"; exit 1 }

$apk = Join-Path $here 'app\build\outputs\apk\debug\app-debug.apk'
if (Test-Path $apk) {
  $size = [math]::Round((Get-Item $apk).Length / 1MB, 1)
  Write-Host ''
  Write-Host "[√] 构建成功：$apk（$size MB）" -ForegroundColor Green
  Write-Host '    安装到手机：adb install -r app\build\outputs\apk\debug\app-debug.apk'
} else {
  Write-Host '[×] 没找到产物 APK'; exit 1
}
