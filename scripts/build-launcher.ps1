$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'src\launcher\NoxReelLauncher.cs'
$icon = Join-Path $projectRoot 'assets\branding\noxreel-icon.ico'
$frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $frameworkRoot 'csc.exe'

if (-not (Test-Path -LiteralPath $compiler)) {
  $frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319'
  $compiler = Join-Path $frameworkRoot 'csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler)) {
  throw 'Windows C# compiler csc.exe was not found.'
}
if (-not (Test-Path -LiteralPath $source)) { throw "Launcher source was not found: $source" }
if (-not (Test-Path -LiteralPath $icon)) { throw "NoxReel icon was not found: $icon" }

$common = @(
  '/nologo',
  '/target:winexe',
  '/platform:anycpu',
  '/optimize+',
  "/win32icon:$icon",
  '/reference:System.dll',
  '/reference:System.Windows.Forms.dll'
)

& $compiler @common "/out:$projectRoot\NoxReel.exe" $source
if ($LASTEXITCODE -ne 0) { throw "NoxReel.exe compilation failed: $LASTEXITCODE" }

& $compiler @common '/define:SIGNAL_SERVER' "/out:$projectRoot\NoxReel-Signal.exe" $source
if ($LASTEXITCODE -ne 0) { throw "NoxReel-Signal.exe compilation failed: $LASTEXITCODE" }

Get-Item -LiteralPath (Join-Path $projectRoot 'NoxReel.exe'), (Join-Path $projectRoot 'NoxReel-Signal.exe') |
  Select-Object Name, Length, LastWriteTime
