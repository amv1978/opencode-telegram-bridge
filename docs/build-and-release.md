[English](build-and-release.md) · [Русский](ru/build-and-release.md)

# Build and release

## Prerequisites

- Bun 1.3+ (daemon build and exe compilation);
- Node.js 20+ and npm (Electron shell);
- .NET SDK 10 (CLI);
- Inno Setup 6 (`winget install JRSoftware.InnoSetup`; `ISCC.exe` ends up in
  `%LOCALAPPDATA%\Programs\Inno Setup 6\`);
- `ffmpeg.exe` — not in the repository, put it into `dist\`.

`scripts/build-release.ps1` runs every step below and produces all release assets.

## 1. Daemon

```bash
bun install
bun run typecheck
bun run build                 # dist\ocbridge.exe
```

`bun run build` = `bun build src/index.ts --compile --outfile dist/ocbridge.exe`.
Cross-builds: `bun run build:linux`, `bun run build:mac` (artifacts without `.exe`).

Copy `ffmpeg.exe` to `dist\ffmpeg.exe` — the bundle and both installers take it
from there, and the daemon looks for it next to itself.

## 2. CLI

```powershell
cd cli
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -o ..\dist\cli
```

Result: `dist\cli\ocbridge-cli.exe`, single-file, ~74 MB. The bundle puts it at
the root as `ocbridge-cli.exe`.

## 3. Electron shell

```powershell
cd desktop
npm install
npm run pack                  # electron-builder --win --dir
```

Result: `desktop\release\win-unpacked\` (~357 MB) with `OpenCode Bridge.exe`.
Target `dir` only — no separate portable Electron exe is built.

## 4. Portable bundle

`scripts/build-release.ps1` stages `dist\bundle\` and zips it:

```
ocbridge-bundle-0.6.0.zip
  ocbridge.exe
  ffmpeg.exe
  ocbridge-cli.exe
  desktop\            (entire win-unpacked)
  version.json        version, builtAt, files[{path,size}]
  CHANGELOG.md
  README.md
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
```

The script writes `dist\ocbridge-bundle-<ver>.zip.sha256`. `version.json` is also
copied to `dist\version.json` for the standalone installer.

## 5. Installers

Two Inno Setup scripts share `messages.iss` and `wizard.iss`:

| Script | Output | Size | Contents |
|---|---|---|---|
| `installer\ocbridge.iss` | `dist\ocbridge-setup-standalone-<ver>.exe` | ~180 MB | full offline install |
| `installer\ocbridge-lite.iss` | `dist\ocbridge-setup-lite-<ver>.exe` | ~3–5 MB | downloads the bundle |

```powershell
$iscc = "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
& $iscc "/DAppVersion=0.6.0" installer\ocbridge.iss
$sha = (Get-FileHash dist\ocbridge-bundle-0.6.0.zip -Algorithm SHA256).Hash.ToLower()
& $iscc "/DAppVersion=0.6.0" "/DBundleSha=$sha" installer\ocbridge-lite.iss
```

The lite installer shows a download page with % progress, verifies SHA256
(`DownloadPage.Add(..., BundleSha)`), extracts the zip into `{app}`, creates
shortcuts/autostart and launches the app. On network/404/hash failure it offers to
open the release page for the standalone installer.

Both installers:

- never rewrite `config.json`; they leave `installer.json` with the install kind,
  directory, autostart flag and optional one-shot config overrides, which the
  app merges on the next start;
- prefill the wizard from `%APPDATA%\opencode-telegram-bridge\config.json`
  (mode, projects folder, `topicsChatId`; the token is masked, empty = keep) and
  from the previous `installer.json`;
- terminate processes with `*OpenCodeTelegramBridge*` in their path before
  installing; on uninstall `%APPDATA%\opencode-telegram-bridge\` is preserved.

## 6. Checksums and artifacts

```powershell
Get-ChildItem dist\ocbridge-*0.6.0* | Select-Object Name,Length
```

The release uploads three binaries and three sums:

```
ocbridge-setup-standalone-0.6.0.exe
ocbridge-setup-standalone-0.6.0.exe.sha256
ocbridge-setup-lite-0.6.0.exe
ocbridge-setup-lite-0.6.0.exe.sha256
ocbridge-bundle-0.6.0.zip
ocbridge-bundle-0.6.0.zip.sha256
```

`sha256sum` format: lowercase hex, two spaces, file name.

## 7. Versions: five places

| File | Field |
|---|---|
| `package.json` | `"version"` |
| `desktop/package.json` | `"version"` |
| `installer/ocbridge.iss` | `#define AppVersion "0.6.0"` |
| `installer/ocbridge-lite.iss` | `#define AppVersion "0.6.0"` |
| `cli/cli.csproj` | `Version`, `FileVersion`, `AssemblyVersion`, `InformationalVersion` |

Additionally: `cli/Program.cs`, the `Program.Version` constant — it is printed by
`ocbridge-cli version`; keep it equal to the csproj version. The API version is
taken from `package.json` automatically.

After a version change rebuild **all** artifacts — otherwise the old exe inside
the new bundle/installer still reports the previous version.

## Release checklist

1. Bump the version in five places (+ `Program.cs`).
2. `bunx tsc --noEmit` and `bun run src/doctor.ts`.
3. `powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1`.
4. Verify the bundle layout (`version.json` file list, `desktop\OpenCode Bridge.exe`).
5. Install the standalone and the lite setup on a clean machine: window, tray,
   `/start`, theme, voice.
6. Check that git has no `config.json`, `state.json`, `installer.json`, `*.log`,
   `dist/`, `*.exe`.
7. Tag `v0.6.0` and upload all six assets.
8. Delete older releases if they are superseded.

## Code signing

Binaries are currently unsigned: SmartScreen shows the “Unknown publisher” warning.
With a certificate, sign `ocbridge.exe`, `ocbridge-cli.exe` and `OpenCode Bridge.exe`
first, then the installers:

```powershell
signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a <file>
```

Signing an installer after the build does not change its contents but changes the
hash — recompute checksums after signing. There is no CI: the build is manual, on
Windows.
