[English](update.md) · [Русский](ru/update.md)

# Auto-update (Windows)

The bridge checks GitHub Releases and updates itself from the portable **bundle**
without the installer wizard. User data in `%APPDATA%\opencode-telegram-bridge\`
(`config.json`, `state.json`, bindings, tokens) is never touched.

## Port discovery

The web UI may bind `7788+N` when the configured port is busy, so the bridge writes
`%APPDATA%\opencode-telegram-bridge\port.json` (`port`, `pid`, `version`,
`startedAt`) right after binding. The Electron shell probes that port first, then
`OCBRIDGE_PORT`, then 7788..7797, and spawns the bridge with `--port <n>`. The file
is removed on a clean exit; a stale file is ignored because the shell always probes
`/api/state`. `--port 7790` (`--port=7790`) overrides the config for one run.

## How it works

1. `GET https://api.github.com/repos/amv1978/opencode-telegram-bridge/releases/latest`
   (public, no token). Requests go through the same proxy/pinned transport as
   Telegram when one is configured, otherwise `HTTPS_PROXY`, otherwise direct.
2. `tag_name` is compared with `package.json` (`v` prefixes and build suffixes are
   ignored).
3. The release assets `ocbridge-bundle-*.zip` and
   `ocbridge-bundle-*.zip.sha256` are located. A `.sha256` that contains only the
   hash is accepted (also `<hash>  <name>`).
4. On start (and every 6 hours by default) the check runs in the background. The
   result is cached in `state.json` (`update` field), so the panel shows the last
   known version after a restart. A check has a 20 s timeout; network errors and
   5xx answers are retried after 5 s, 30 s and 5 min.

Auto-update is **only for the packaged `ocbridge.exe`**. A dev run
(`bun run src/index.ts`) reports that updates are available only for compiled
builds.

## Download

- Target: `%TEMP%\ocbridge-update\bundle.zip` (`.part` is kept between runs).
- Progress 0–100 % is shown in `/api/state`, the panel and the tray tooltip.
- With `update.autoDownload` (default **true**) a found update downloads in the
  background: on start, on discovery and on the 6-hour timer. The transfer pauses
  between chunks while a turn is active and resumes when it ends.
- Download order: **BITS** (`Start-BitsTransfer`) → **curl.exe** with `-C -`
  resume → built-in `fetch` with a `Range` request. Any transport resumes a
  `.part` file instead of downloading from zero. The whole download is capped at
  30 minutes and can be canceled (the `.part` stays for Retry).
- The published `.sha256` is required; a missing or mismatching hash aborts the
  update and keeps the current version.

## Errors

Every failure keeps a machine code, optional HTTP status and human text:

| Code | Meaning | What the user sees |
|---|---|---|
| `network` | no route to GitHub | «Нет сети или GitHub недоступен» + proxy hint |
| `rate-limit` | HTTP 403/429 | «GitHub ограничил частоту запросов» + reset time |
| `hash` | SHA256 mismatch | «SHA256 не совпал — обновление отменено» |
| `write` | no write access | «Нет прав на запись в папку установки» |
| `asset` | release lacks bundle/sha | «Обновитесь через установщик» |

`/api/update/*` returns `200` only on success; otherwise `429`, `502`, `409`,
`404`, `400` or `500`. The panel shows `update.error` in the banner and a toast;
«Проверить обновления» never claims success when the check failed. Download and
install errors are also posted to the admin chat (same target as lifecycle
messages), at most one per 10 minutes.

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

The update never rewrites `config.json`: only `ocbridge.exe`, `ffmpeg.exe`,
`ocbridge-cli.exe`, `desktop\`, `version.json`, `CHANGELOG.md` and `README.md` are
replaced, so `telegram.*` and `discord.*` (tokens, proxy, guild lists) survive.

`ocbridge-cli update --rollback` (or the tray item «Откатиться на X») swaps
`{app}\prev` back immediately; settings stay untouched.

## Settings

```json
{
  "update": {
    "checkOnStart": true,
    "intervalHours": 6,
    "autoDownload": true
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
| `update.autoDownload` | download a found bundle in the background (never installs it) | `true` |
| `notify.enabled` | lifecycle messages in chat | `true` |
| `notify.targets` | `"admin"` (first admin), `"all"` (every allowed user) or an array of chat ids | `"admin"` |

## API

| Method | Path | Action |
|---|---|---|
| POST | `/api/update/check` | Check GitHub and update the cached snapshot |
| POST | `/api/update/download` | Start the background download and return at once |
| POST | `/api/update/cancel` | Cancel the download (keeps `.part` for resume) |
| POST | `/api/update/install` | Unpack, swap and restart |
| POST | `/api/update/rollback` | Restore `{app}\prev` and restart |
| GET | `/api/changelog?from=X&to=Y` | CHANGELOG sections in `(X, Y]` |

`/api/state` includes `update.prevVersion`, `update.bundled`, `update.verified`,
`update.paused`, `update.progress`, `update.error`, `update.errorCode` and
`update.errorStatus`.

## Panel and tray

One action button in the panel: «Скачать и установить» while no bundle is present,
«Скачивание… N %» + «Отмена» while downloading, «Установить» when the bundle is
downloaded and SHA256 verified, «Установка…» while the helper starts. After an
error it becomes «Повторить», the reason is under the banner, and
«Страница релиза» opens the matching GitHub release.

The tray mirrors this: «Скачать и установить X» (download then install without
dialogs), «Отменить загрузку» while running, «Повторить» / «Открыть страницу
релиза» on failure, and the tooltip shows the download percentage. A successful
install restarts immediately; there is no «restart now?» dialog.

## Changelog modal (Electron)

After an update, when `prevVersion < current`, the shell opens a modal window with
all CHANGELOG sections in `(prev, current]`, scrollable, with a «Понятно» button.
It is shown once per version: the acknowledged version is stored in
`ui.seenChangelog`. The tray item «Что нового» opens the current version manually.

## Tray and CLI

- Tray: «Проверить обновления», «Скачать и установить X», «Откатиться на X», «Что нового».
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
