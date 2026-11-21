[English](update.md) · [Русский](ru/update.md)

# Auto-update (Windows)

The bridge checks GitHub Releases for a newer version and can download and install
it without leaving the app.

## How it works

1. `GET https://api.github.com/repos/amv1978/opencode-telegram-bridge/releases/latest`
   (public, no token).
2. The latest `tag_name` is compared with `package.json` (`v` prefix and build
   suffixes are ignored).
3. The release asset `ocbridge-setup-*.exe` and, when present,
   `ocbridge-setup-*.exe.sha256` are located.
4. On start (and every 6 hours by default) the check runs in the background. The
   result is cached in `state.json` (`update` field), so the panel shows the last
   known version immediately after a restart.

Auto-update is **only for the packaged `ocbridge.exe`**. In a dev build
(`bun run src/index.ts`) download/install returns
“автообновление доступно только для собранной версии”. User data in
`%APPDATA%\opencode-telegram-bridge\` is never touched.

## Settings

```json
{
  "update": {
    "checkOnStart": true,
    "intervalHours": 6,
    "autoDownload": false
  }
}
```

| Field | Meaning | Default |
|---|---|---|
| `checkOnStart` | check once when the bridge starts | `true` |
| `intervalHours` | repeat check interval, 1–168 h | `6` |
| `autoDownload` | download a found update automatically (never installs it) | `false` |

The same fields are in the panel: **Settings → Проверять обновления / Интервал /
Скачивать автоматически**, plus the **Проверить обновления** button.

## Download and install

- The installer is streamed to `%TEMP%\ocbridge-update\setup.exe` with progress
  0–100 %, a 30-minute timeout and abort support.
- If the release publishes `ocbridge-setup-X.exe.sha256`, the SHA256 is verified;
  a mismatch deletes the file and reports an error.
- Install spawns the setup with
  `/VERYSILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /NORESTART=0`
  and exits the bridge after 2 seconds. If the installer cannot close an elevated
  instance, the panel/tray shows the error and the bridge keeps running.
- A banner under the header appears when an update is available:
  “Доступна версия X — Скачать / Установить”, with a progress bar while
  downloading.

## API

| Method | Path | Action |
|---|---|---|
| POST | `/api/update/check` | Check GitHub, update the cached snapshot |
| POST | `/api/update/download` | Start/continue the download (progress in `/api/state`) |
| POST | `/api/update/install` | Run the downloaded installer and exit |

`/api/state` includes:

```json
{
  "update": {
    "available": true,
    "current": "0.5.1",
    "latest": "0.5.1",
    "notes": "…",
    "progress": 0,
    "error": "",
    "downloading": false,
    "installing": false
  }
}
```

## Tray and CLI

- Tray menu: **Проверить обновления** (after a check the item becomes
  **Установить X.Y.Z**). Installing from the tray quits the shell; the installer
  restarts the app.
- CLI:

```
ocbridge-cli update --check
ocbridge-cli update --install
```

## Release pipeline

Every release must upload both files:

- `ocbridge-setup-<version>.exe`
- `ocbridge-setup-<version>.exe.sha256` — hex SHA256 of the exe, one line,
  `sha256sum` format.

```powershell
(Get-FileHash dist\ocbridge-setup-0.5.1.exe -Algorithm SHA256).Hash.ToLower() +
  "  ocbridge-setup-0.5.1.exe" | Set-Content -Encoding ascii dist\ocbridge-setup-0.5.1.exe.sha256
```
