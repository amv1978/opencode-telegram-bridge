[English](cli.md) · [Русский](ru/cli.md)

# CLI: ocbridge-cli

A console client for the daemon's local API. .NET 10, no external dependencies.

```powershell
ocbridge-cli.exe [--url URL] <command> [options]
```

`--url` or the `OCBRIDGE_URL` variable; default `http://127.0.0.1:7788`.
HTTP timeout — 10 s.

## status

```
> ocbridge-cli status
State         running
Version       0.7.1
User          @my_bot
OpenCode      2.3.2 (http://127.0.0.1:28894)
Telegram      pinned 149.154.167.220
Uptime        2h 14m
Sessions      4
```

On error an `Error: …` line is added. Uptime: `12s`, `5m 3s`, `2h 14m`, `1d 3h 8m`.

## start / stop / restart

```
> ocbridge-cli restart
Bot is restarting.
State: running
```

The state is printed after a 300 ms pause if the API has answered by then.

## sessions

```
> ocbridge-cli sessions
ID                             TITLE                          DIRECTORY
------------------------------ ------------------------------ ------------------------------
ses_01JABCDEF0123456789ABCDEF   Refactor API                   D:\work\api
ses_01JABCDEF9876543210FEDCBA   Telegram session               D:\work\api
```

`--json` (or `-j`) — the raw array from `/api/sessions`. Empty — “No sessions.”

## logs

```
> ocbridge-cli logs -n 3
2026-11-19T09:12:04.115Z INFO  OpenCode 2.3.2 at http://127.0.0.1:28894
2026-11-19T09:12:04.280Z INFO  telegram: pinned 149.154.167.220
2026-11-19T09:12:04.301Z INFO  bot @my_bot started (mode=both)
```

`-n N` — lines, default 100, maximum 1000. `--follow` / `-f` — print new lines every
2 s (Ctrl+C to exit; the service line goes to stderr).

## config

```
> ocbridge-cli config get mode
both

> ocbridge-cli config get telegram.proxy
(not set)

> ocbridge-cli config set stream.editIntervalMs=1800
Done: stream.editIntervalMs = 1800

> ocbridge-cli config set ui.theme=matrix
Done: ui.theme = matrix
```

`config get` without a key prints the pretty-JSON config snapshot:

```json
{
  "mode": "both",
  "topicsChatId": -1001234567890,
  "defaultDirectory": "D:\\work",
  "editIntervalMs": 1800,
  "showTools": "compact",
  "format": "rich",
  "autoTopics": true,
  "showSubagents": true,
  "media": { "relay": "all", "maxPhotoMb": 10 },
  "ui": { "theme": "opencode", "scheme": "system", "lang": "system" },
  "allowedUsers": [{ "id": 123456789, "role": "admin", "name": "Mike" }],
  "hasToken": true,
  "tokenTail": "…AbCd"
}
```

Accepted `config set` keys: `mode` (`topics|private|both`), `topicsChatId`,
`defaultDirectory`, `autoTopics` (`true|false`), `stream.editIntervalMs`
(500…10000), `stream.showTools` (`off|compact|full`), `stream.format` (`rich|html`),
`telegram.proxy`, `telegram.apiIp`, `ui.theme` (`opencode|matrix`),
`ui.scheme` (`system|light|dark`). Short forms (`editIntervalMs`, `showTools`,
`format`, `proxy`, `apiIp`) are accepted too.

The token is **not** set via the CLI — only in the panel.

## autostart

```
> ocbridge-cli autostart status
Autostart      enabled
Supported      yes

> ocbridge-cli autostart on
Autostart enabled.
```

## budget

```
> ocbridge-cli budget
Лимит хода     $1.50
Лимит дня      $10.00
Действие       остановить ход
День (UTC)     2026-11-22
Потрачено      $0.42
Активных ходов 1
  ses_e10c85685ffe…  $0.07

> ocbridge-cli budget set per-turn=2 daily=15 action=stop
Бюджет сохранён.

> ocbridge-cli budget off
Лимиты бюджета сняты.
```

`--json` prints the raw snapshot from `GET /api/budget`. Spend is the sum of turn
cost deltas for the current UTC day; at 80% the chat gets a warning and at 100%
the turn is stopped when `action = "stop"`.

## doctor

```
> ocbridge-cli doctor
✔ API: http://127.0.0.1:7788 reachable
✔ State: running
✔ OpenCode: 2.3.2 (http://127.0.0.1:28894)
✔ Telegram: @my_bot
✔ Config: C:\Users\me\AppData\Roaming\opencode-telegram-bridge\config.json
✔ Autostart: enabled, supported
✔ Telegram token: set (…AbCd)

All checks passed.
```

If the daemon is not running, doctor exits immediately with code 3 and a hint.

## version / help

```
> ocbridge-cli version
ocbridge-cli 0.7.1
API: 0.7.1
OpenCode: 2.3.2

> ocbridge-cli help logs
logs [-n N] [--follow] — daemon log tail.
-n N      number of lines (default 100, maximum 1000).
--follow  poll the API every 2 s and print only new lines (Ctrl+C to exit).
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | API/HTTP or provider error |
| 2 | Argument error |
| 3 | Daemon is not running (`connection refused`) |
