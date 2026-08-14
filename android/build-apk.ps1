# Build the NoxReel Android debug APK with Windows PowerShell 5.1.
# Keep this file ASCII-only so it does not depend on a UTF-8 BOM.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$jdk = Get-ChildItem 'C:\Program Files\Microsoft' -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'jdk-17*' } | Select-Object -First 1
if (-not $jdk) {
  Write-Host '[x] JDK 17 was not found. Install it with: winget install Microsoft.OpenJDK.17'
  exit 1
}
$env:JAVA_HOME = $jdk.FullName
Write-Host "JAVA_HOME = $env:JAVA_HOME"

$gradle = 'C:\Users\A\AppData\Local\Android\gradle-dist\gradle-7.6.3\bin\gradle.bat'
if (-not (Test-Path $gradle)) {
  Write-Host "[x] Gradle was not found: $gradle"
  exit 1
}

if (-not (Test-Path (Join-Path $here 'local.properties'))) {
  $sdk = 'C:\Users\A\AppData\Local\Android\Sdk'
  "sdk.dir=$($sdk -replace '\\','\\')" | Out-File (Join-Path $here 'local.properties') -Encoding ascii
}

Write-Host '[.] Building the Android debug APK...'
& $gradle assembleDebug --no-daemon --console=plain
if ($LASTEXITCODE -ne 0) {
  Write-Host "[x] Build failed with exit code $LASTEXITCODE"
  exit 1
}

$apk = Join-Path $here 'app\build\outputs\apk\debug\app-debug.apk'
if (Test-Path $apk) {
  $size = [math]::Round((Get-Item $apk).Length / 1MB, 1)
  Write-Host ''
  Write-Host "[ok] APK: $apk ($size MB)" -ForegroundColor Green
  Write-Host 'Install: adb install -r app\build\outputs\apk\debug\app-debug.apk'
} else {
  Write-Host '[x] APK output was not found.'
  exit 1
}
