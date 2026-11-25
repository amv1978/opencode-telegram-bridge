[English](update.md) · [Русский](ru/update.md)

# Auto-update (Windows)

The bridge checks GitHub Releases and updates itself from the portable **bundle**
without the installer wizard. User data in `%APPDATA%\opencode-telegram-bridge\`
(`config.json`, `state.json`, bindings, tokens) is never touched.

## How it works

1. `GET https://api.github.com/repos/amv1978/opencode-telegram-bridge/releases/latest`
   (public, no token).
2. `tag_name` is compared with `package.json` (`v` prefixes and build suffixes are
   ignored).
3. The release assets `ocbridge-bundle-*.zip` and
   `ocbridge-bundle-*.zip.sha256` are located.
4. On start (and every 6 hours by default) the check runs in the background. The
   result is cached in `state.json` (`update` field), so the panel shows the last
   known version after a restart.

Auto-update is **only for the packaged `ocbridge.exe`**. A dev run
(`bun run src/index.ts`) reports that updates are available only for compiled
builds.

## Download

- Target: `%TEMP%\ocbridge-update\bundle.zip` (`.part` is kept between runs).
- Progress 0–100 % is shown in `/api/state` and the panel.
- Download order: **BITS** (`Start-BitsTransfer`) → **curl.exe** with `-C -`
  resume → built-in `fetch` with a `Range` request. Any transport resumes a
  `.part` file instead of downloading from zero.
- The published `.sha256` is required; a missing or mismatching hash aborts the
  update and keeps the current version.

## Install and rollback

1. The zip is unpacked to `{app}\new` (the directory that contains
   `ocbridge.exe`, usually `%LOCALAPPDATA%\Programs\OpenCodeTelegramBridge`).
2. `prevVersion` is written to `state.json` and the chat receives
   `🔄 обновлено с X до Y — перезапускаюсь`.
3. A detached PowerShell helper waits for the bridge to exit, moves the current
   layout to `{app}\prev` (only one previous version), moves `new` into `{app}`
   and starts the desktop shell (or `ocbridge.exe --no-browser`).
4. Health check: `GET http://127.0.0.1:<bound-web-port>/api/state` every second for
   up to 60 seconds. The port is the one the web server actually bound (it may
   differ from the configured port when that port was busy). On failure the
   helper stops the new build, restores `prev` and starts it again. The rollback
   run performs the same health check and writes `rollback-health.txt` on failure.
   The broken layout is removed.
5. A normal start notification is posted after a successful restart.

`ocbridge-cli update --rollback` (or the tray item «Откатиться на X») swaps
`{app}\prev` back immediately; settings stay untouched.

## Settings

```json
{
  "update": {
    "checkOnStart": true,
    "intervalHours": 6,
    "autoDownload": false
  },
  "notify": {
    "enabled": true,
    "targets": "admin"
  }
}
```

| Field | Meaning | Default |
|---|---|---|
| `update.checkOnStart` | check once when the bridge starts | `true` |
| `update.intervalHours` | repeat interval, 1–168 h | `6` |
| `update.autoDownload` | download a found bundle automatically (never installs it) | `false` |
| `notify.enabled` | lifecycle messages in chat | `true` |
| `notify.targets` | `"admin"` (first admin), `"all"` (every allowed user) or an array of chat ids | `"admin"` |

## API

| Method | Path | Action |
|---|---|---|
| POST | `/api/update/check` | Check GitHub and update the cached snapshot |
| POST | `/api/update/download` | Start/continue the bundle download |
| POST | `/api/update/install` | Unpack, swap and restart |
| POST | `/api/update/rollback` | Restore `{app}\prev` and restart |
| GET | `/api/changelog?from=X&to=Y` | CHANGELOG sections in `(X, Y]` |

`/api/state` includes `update.prevVersion` (the version in `{app}\prev`) and
`update.bundled`.

## Changelog modal (Electron)

After an update, when `prevVersion < current`, the shell opens a modal window with
all CHANGELOG sections in `(prev, current]`, scrollable, with a «Понятно» button.
It is shown once per version: the acknowledged version is stored in
`ui.seenChangelog`. The tray item «Что нового» opens the current version manually.

## Tray and CLI

- Tray: «Проверить обновления», «Установить X», «Откатиться на X», «Что нового».
- CLI:

```
ocbridge-cli update --check
ocbridge-cli update --install
ocbridge-cli update --rollback
```

## Release pipeline

Every release must upload:

- `ocbridge-bundle-<version>.zip` + `.sha256`
- `ocbridge-setup-standalone-<version>.exe` + `.sha256` (standalone, includes everything)
- `ocbridge-setup-lite-<version>.exe` + `.sha256` (downloads the bundle)

`scripts/build-release.ps1` produces all of them; see
[build-and-release.md](build-and-release.md).
