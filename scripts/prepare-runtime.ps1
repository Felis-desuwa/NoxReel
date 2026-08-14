# Prepare portable Windows runtimes for electron-builder.
# vendor/ is ignored by Git and copied to resources/bin in the installer.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $root 'vendor\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

function Resolve-ToolPath($envName, $commandName, $candidates) {
  $fromEnv = [Environment]::GetEnvironmentVariable($envName)
  if ($fromEnv -and (Test-Path -LiteralPath $fromEnv)) {
    return (Resolve-Path -LiteralPath $fromEnv).Path
  }

  $command = Get-Command $commandName -ErrorAction SilentlyContinue
  if ($command -and $command.Source) { return $command.Source }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

$mpvTarget = Join-Path $binDir 'mpv.exe'
if (-not (Test-Path -LiteralPath $mpvTarget)) {
  $mpvSource = Resolve-ToolPath 'SYNCWATCH_MPV_PATH' 'mpv' @(
    'C:\Program Files\MPV Player\mpv.exe',
    'C:\Program Files\mpv\mpv.exe',
    'C:\Program Files (x86)\MPV Player\mpv.exe',
    'C:\mpv\mpv.exe'
  )
  if (-not $mpvSource) {
    throw 'mpv.exe was not found. Install shinchiro.mpv or set SYNCWATCH_MPV_PATH.'
  }
  Write-Host "Bundling mpv: $mpvSource"
  Copy-Item -LiteralPath $mpvSource -Destination $mpvTarget -Force
}

$ytDlpTarget = Join-Path $binDir 'yt-dlp.exe'
if (-not (Test-Path -LiteralPath $ytDlpTarget)) {
  $ytDlpSource = Resolve-ToolPath 'SYNCWATCH_YTDLP_PATH' 'yt-dlp' @(
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\yt-dlp.exe",
    'C:\Program Files\yt-dlp\yt-dlp.exe'
  )
  if ($ytDlpSource) {
    Write-Host "Bundling yt-dlp: $ytDlpSource"
    Copy-Item -LiteralPath $ytDlpSource -Destination $ytDlpTarget -Force
  } else {
    Write-Host 'Downloading yt-dlp.exe from the official GitHub release...'
    Invoke-WebRequest -UseBasicParsing `
      -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' `
      -OutFile $ytDlpTarget
  }
}

if ((Get-Item -LiteralPath $mpvTarget).Length -lt 1MB) { throw 'mpv.exe is unexpectedly small.' }
if ((Get-Item -LiteralPath $ytDlpTarget).Length -lt 1MB) { throw 'yt-dlp.exe is unexpectedly small.' }

Write-Host 'Portable runtimes are ready:'
Get-Item -LiteralPath $mpvTarget, $ytDlpTarget | Select-Object Name, Length, LastWriteTime
