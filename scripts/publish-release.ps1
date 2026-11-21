param(
  [string]$Version = "",
  [string]$Title = "",
  [switch]$SkipDeleteOld
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$repo = "amv1978/opencode-telegram-bridge"

if (-not $Version) {
  $Version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
}
if (-not $Title) { $Title = "OpenCode Bridge $Version" }

$token = $env:GH_TOKEN
if (-not $token) {
  $token = (reg query HKCU\Environment /v GH_TOKEN 2>$null | Select-String "GH_TOKEN" | ForEach-Object { ($_ -split "\s+")[-1] })
}
if (-not $token) { throw "GH_TOKEN is not set" }

$headers = @{
  Authorization = "token $token"
  "User-Agent"  = "ocbridge-release"
  Accept        = "application/vnd.github+json"
}

$body = @"
OpenCode Bridge $Version.

Assets:
- ocbridge-setup-standalone-$Version.exe - full offline installer
- ocbridge-setup-lite-$Version.exe - downloads the bundle (~2 MB)
- ocbridge-bundle-$Version.zip - portable layout (ocbridge.exe, ffmpeg.exe, ocbridge-cli.exe, desktop\, version.json, CHANGELOG.md)
- .sha256 for every file

See CHANGELOG.md for details. User data in %APPDATA%\opencode-telegram-bridge\ is preserved.
"@

$existing = $null
try {
  $existing = Invoke-RestMethod -Headers $headers "https://api.github.com/repos/$repo/releases/tags/v$Version"
} catch {
  $existing = $null
}

if ($existing) {
  $payload = @{ name = $Title; body = $body; draft = $false; prerelease = $false } | ConvertTo-Json
  $release = Invoke-RestMethod -Method Patch -Headers $headers -ContentType "application/json" -Body $payload "https://api.github.com/repos/$repo/releases/$($existing.id)"
} else {
  $payload = @{ tag_name = "v$Version"; target_commitish = "main"; name = $Title; body = $body; draft = $false; prerelease = $false } | ConvertTo-Json
  $release = Invoke-RestMethod -Method Post -Headers $headers -ContentType "application/json" -Body $payload "https://api.github.com/repos/$repo/releases"
}
Write-Host "release: $($release.html_url) id=$($release.id)"

$assets = @(
  "ocbridge-setup-standalone-$Version.exe",
  "ocbridge-setup-standalone-$Version.exe.sha256",
  "ocbridge-setup-lite-$Version.exe",
  "ocbridge-setup-lite-$Version.exe.sha256",
  "ocbridge-bundle-$Version.zip",
  "ocbridge-bundle-$Version.zip.sha256"
)

Push-Location $dist
try {
  foreach ($name in $assets) {
    $file = Join-Path $dist $name
    if (-not (Test-Path $file)) { throw "missing asset: $file" }
    # Replace an asset with the same name when re-running the script.
    $current = (Invoke-RestMethod -Headers $headers "https://api.github.com/repos/$repo/releases/$($release.id)/assets")
    $old = $current | Where-Object { $_.name -eq $name }
    if ($old) {
      Invoke-RestMethod -Method Delete -Headers $headers "https://api.github.com/repos/$repo/releases/assets/$($old.id)" | Out-Null
    }
    $upload = "https://uploads.github.com/repos/$repo/releases/$($release.id)/assets?name=$name"
    $out = & curl.exe -sS -X POST -H "Authorization: token $token" -H "User-Agent: ocbridge-release" -H "Content-Type: application/octet-stream" --data-binary "@$file" $upload
    $json = $out | ConvertFrom-Json
    if ($json.errors) { throw "upload failed for ${name}: $($out)" }
    Write-Host ("uploaded {0} ({1:N1} MB)" -f $name, ((Get-Item $file).Length / 1MB))
  }
} finally {
  Pop-Location
}

if (-not $SkipDeleteOld) {
  $releases = Invoke-RestMethod -Headers $headers "https://api.github.com/repos/$repo/releases"
  foreach ($old in $releases) {
    if ($old.id -eq $release.id) { continue }
    Invoke-RestMethod -Method Delete -Headers $headers "https://api.github.com/repos/$repo/releases/$($old.id)" | Out-Null
    Write-Host "deleted old release: $($old.tag_name)"
  }
}

Write-Host "done: $($release.html_url)"
