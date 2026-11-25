param(
  [string]$Version = "",
  [switch]$SkipDesktop,
  [switch]$SkipCli
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Version) {
  $Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
}
Write-Host "== OpenCode Bridge $Version release build =="

$dist = Join-Path $root "dist"
$stage = Join-Path $dist "bundle"
$desktop = Join-Path $root "desktop\release\win-unpacked"
New-Item -ItemType Directory -Force -Path $dist | Out-Null

# 0. Versions -------------------------------------------------------------
Write-Host "-- version sync"
& bun scripts/sync-version.mjs
if ($LASTEXITCODE -ne 0) { throw "version sync failed" }
& bun scripts/sync-version.mjs --check
if ($LASTEXITCODE -ne 0) { throw "version mismatch: root package.json is the single source" }

# 1. Daemon ---------------------------------------------------------------
Write-Host "-- daemon"
& bun run build
if ($LASTEXITCODE -ne 0) { throw "bun build failed" }

# 2. CLI ------------------------------------------------------------------
if (-not $SkipCli) {
  Write-Host "-- cli"
  Push-Location (Join-Path $root "cli")
  try {
    & dotnet publish -c Release -r win-x64 --self-contained true `
      -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
      -o (Join-Path $dist "cli")
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }
  } finally {
    Pop-Location
  }
}

# 3. Electron shell -------------------------------------------------------
if (-not $SkipDesktop) {
  Write-Host "-- desktop"
  Push-Location (Join-Path $root "desktop")
  try {
    & npm run pack
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
  } finally {
    Pop-Location
  }
}
if (-not (Test-Path (Join-Path $desktop "OpenCode Bridge.exe"))) {
  throw "desktop build is missing: $desktop"
}

# 4. Portable bundle ------------------------------------------------------
Write-Host "-- bundle"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item (Join-Path $dist "ocbridge.exe") $stage
if (Test-Path (Join-Path $dist "ffmpeg.exe")) {
  Copy-Item (Join-Path $dist "ffmpeg.exe") $stage
} else {
  Write-Warning "dist\ffmpeg.exe is missing: voice messages will not work"
}
$cli = Join-Path $dist "cli\ocbridge-cli.exe"
if (Test-Path $cli) { Copy-Item $cli $stage } else { Write-Warning "dist\cli\ocbridge-cli.exe is missing" }
Copy-Item $desktop (Join-Path $stage "desktop") -Recurse
Copy-Item (Join-Path $root "CHANGELOG.md") $stage
Copy-Item (Join-Path $root "README.md") $stage

$stageRoot = (Resolve-Path $stage).Path.TrimEnd("\")
$files = Get-ChildItem $stage -Recurse -File | ForEach-Object {
  [ordered]@{
    path = $_.FullName.Substring($stageRoot.Length + 1).Replace("\", "/")
    size = $_.Length
  }
}
$versionJson = [ordered]@{
  version = $Version
  builtAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  files = @($files)
}
$versionJson | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $stage "version.json") -Encoding utf8
Copy-Item (Join-Path $stage "version.json") (Join-Path $dist "version.json") -Force

$zip = Join-Path $dist "ocbridge-bundle-$Version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
$bundleSha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if (-not $bundleSha) { throw "bundle SHA256 is empty" }
"$bundleSha  ocbridge-bundle-$Version.zip" | Set-Content "$zip.sha256" -Encoding ascii
Write-Host "bundle: $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"

# 5. Installers -----------------------------------------------------------
$iscc = @(
  (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  "C:\Program Files\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "ISCC.exe not found. Install Inno Setup 6 (winget install JRSoftware.InnoSetup)." }

Write-Host "-- setup"
& $iscc "/DAppVersion=$Version" (Join-Path $root "installer\ocbridge.iss")
if ($LASTEXITCODE -ne 0) { throw "standalone installer failed" }

Write-Host "-- setup-lite"
& $iscc "/DAppVersion=$Version" "/DBundleSha=$bundleSha" (Join-Path $root "installer\ocbridge-lite.iss")
if ($LASTEXITCODE -ne 0) { throw "lite installer failed" }

# 6. Checksums ------------------------------------------------------------
foreach ($name in @("ocbridge-setup-standalone-$Version.exe", "ocbridge-setup-lite-$Version.exe")) {
  $path = Join-Path $dist $name
  if (-not (Test-Path $path)) { throw "missing artifact: $path" }
  $hash = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
  "$hash  $name" | Set-Content "$path.sha256" -Encoding ascii
}

Write-Host ""
Write-Host "Artifacts:"
Get-ChildItem $dist -File | Where-Object {
  $_.Name -match "^ocbridge-(setup-standalone|setup-lite|bundle)-$([regex]::Escape($Version))"
} | Sort-Object Name | ForEach-Object {
  "{0,-38} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB)
}
exit 0
