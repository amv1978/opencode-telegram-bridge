[English](build-and-release.md) · [Русский](ru/build-and-release.md)

# Build and release

## Prerequisites

- Bun 1.3+ (daemon build and exe compilation);
- Node.js 20+ and npm (Electron shell);
- .NET SDK 10 (CLI);
- Inno Setup 6 (installer);
- `ffmpeg.exe` — not in the repository, put it into `dist\`.

## 1. Daemon

```bash
bun install
bun run typecheck
bun run build                 # dist\ocbridge.exe
```

`bun run build` = `bun build src/index.ts --compile --outfile dist/ocbridge.exe`.
Cross-builds: `bun run build:linux`, `bun run build:mac` (artifacts without `.exe`).

Copy `ffmpeg.exe` to `dist\ffmpeg.exe` — the installer takes it from there, and the
daemon looks for it next to itself.

## 2. CLI

```powershell
cd cli
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -o ..\dist\cli
```

Result: `dist\cli\ocbridge-cli.exe`, single-file, ~74 MB.

## 3. Electron shell

```powershell
cd desktop
npm install
npm run pack                  # electron-builder --win --dir
```

Result: `desktop\release\win-unpacked\` (~357 MB) with `OpenCode Bridge.exe` inside.
Target `dir` only — no separate portable Electron exe is built.

## 4. Installer

```powershell
winget install JRSoftware.InnoSetup
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\ocbridge.iss
```

Output: `dist\ocbridge-setup-<version>.exe`, lzma2 compression, ~180 MB.

Contents:

| What | From | Size |
|---|---|---|
| `ocbridge.exe` | `dist\` | ~115 MB |
| `ffmpeg.exe` | `dist\` | ~83 MB |
| `ocbridge-cli.exe` | `dist\cli\` (if present) | ~74 MB |
| `desktop\*` | `desktop\release\win-unpacked\` | ~357 MB |
| `README.md`, `INSTALL.txt` | root / `docs\` | small |

Installer: simple mode writes only `ui.lang` (an existing config is untouched);
advanced mode writes token, mode and folder. Before installing, processes with
`*OpenCodeTelegramBridge*` in their path are terminated. Shortcuts: app, CLI,
uninstall, optionally desktop. Autostart is an installer task.
On uninstall `%APPDATA%\opencode-telegram-bridge\` is preserved.

## 5. Versions: four places

| File | Field |
|---|---|
| `package.json` | `"version"` |
| `desktop/package.json` | `"version"` |
| `installer/ocbridge.iss` | `#define AppVersion "0.4.1"` |
| `cli/cli.csproj` | `Version`, `FileVersion`, `AssemblyVersion`, `InformationalVersion` |

Additionally: `cli/Program.cs`, the `Program.Version` constant — it is printed by
`ocbridge-cli version`; keep it equal to the csproj version. The API version is taken
from `package.json` automatically.

The installer name is derived from `AppVersion`: `ocbridge-setup-0.4.1.exe`.
After a version change rebuild **all** artifacts — otherwise the old exe inside the
new installer will still report the previous version.

## Release checklist

1. Bump the version in four places (+ `Program.cs`).
2. `bun run typecheck` and `bun run src/doctor.ts`.
3. Rebuild daemon, CLI, shell, installer.
4. Run the installer on a clean machine: window, tray, `/start`, theme, voice.
5. Check that git has no `config.json`, `state.json`, `*.log`, `dist/`, `*.exe`.
6. Tag `v0.4.1`, attach `ocbridge-setup-0.4.1.exe` and the sources to the release.

## Code signing

Binaries are currently unsigned: SmartScreen shows the “Unknown publisher” warning.
With a certificate, sign `ocbridge.exe`, `ocbridge-cli.exe` and `OpenCode Bridge.exe`
first, then the installer itself:

```powershell
signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a <file>
```

Signing the installer after the build does not change its contents but changes the
hash — recompute checksums after signing. There is no CI or workflows in the
repository: the build is manual, on Windows.
