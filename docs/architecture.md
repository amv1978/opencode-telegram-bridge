[English](architecture.md) · [Русский](ru/architecture.md)

# Architecture

## Components

| Component | File / folder | Role |
|---|---|---|
| Daemon | `src/`, `dist/ocbridge.exe` | Bun process: OpenCode client (HTTP + SSE), grammY bot, local web API |
| Web panel | `src/web/` | One HTML page + JSON API on `127.0.0.1:7788` |
| Shell | `desktop/` | Electron: window, tray, autostart, title-bar colour sync |
| CLI | `cli/` | `ocbridge-cli.exe`, .NET 10, talks only to the local API |
| Installer | `installer/` | Inno Setup: simple/advanced mode, RU/EN |
| Voice | `src/audio/` | ffmpeg → 16 kHz WAV → HEX CLI |

The daemon needs no OpenCode plugin: it connects to the same background service as
Desktop/TUI and sees the same sessions.

## Data flow

```
Telegram  ⇄  grammY (long polling)  ⇄  Bridge  ⇄  OpenCode HTTP API
                                        │            ├─ /api/session/{id}/prompt
                                        │            ├─ /api/session/{id}/interrupt
                                        │            ├─ /api/session/{id}/permission/*
                                        │            └─ SSE /api/event
                                        ├─ state.json  (topic/chat → session)
                                        └─ Streamer    (edits one message)
```

1. A Telegram message (text, photo, document, voice) becomes a prompt.
2. `Bridge` finds the session in `state.json` or creates one via `POST /api/session`.
3. The answer arrives as SSE events; `Streamer` edits the message no more often than
   `stream.editIntervalMs` (1800 ms by default).
4. End of turn is `session.execution.*`; duration, tok/s and context go into the footer.
5. Permission requests (`permission.asked`) become buttons; the reply is
   `permission/{id}/reply`.

## How OpenCode is discovered

Order (`src/opencode/client.ts`):

1. `opencode.baseUrl` from the config, if set.
2. `~/.config/opencode/service.json` (or `XDG_CONFIG_HOME`, `~/.local/state/opencode/service.json`).
3. Port scan: `28894`, `49374`, `4096`.

Verification is `GET /api/info` with Basic auth `opencode:<password>`.
The password comes from the config, `service.json` or `OPENCODE_PASSWORD`.

## Ports

| Port | Purpose |
|---|---|
| `7788` | Web panel and JSON API; the next free port is used if busy (up to +9) |
| `28894`, `49374`, `4096` | Candidates where OpenCode listens |
| random localhost | Temporary CONNECT proxy for pinning the Telegram IP |

## Files on disk

The installed build always keeps data in `%APPDATA%\opencode-telegram-bridge\`:

| File | Contents |
|---|---|
| `config.json` | Bot token, allowlist, mode, folder, network, theme, throttling |
| `state.json` | `topics` (thread → session), `chats` (chat → session), `sessions` |
| `bridge.log` | Daemon log, UTF-8, ISO timestamps |

`ocbridge.exe`, `ffmpeg.exe`, `ocbridge-cli.exe` and the `desktop\` folder sit next to
the exe. `OCBRIDGE_CONFIG` points to a different config path (state and log use the
same folder). On the first run of a compiled build, `config.json`/`state.json` from
the exe folder are migrated to `%APPDATA%`; old files get a `.migrated` suffix.

In dev mode (`bun run src/index.ts`), `config.json` from the current folder is used
if it exists.

## Web API

| Method | Path | Action |
|---|---|---|
| GET | `/api/state` | Snapshot: state, versions, mode, config, autostart, sessions |
| GET | `/api/sessions` | Last 8 root sessions |
| GET | `/api/log?lines=N` | Log tail (up to 1000 lines) |
| POST | `/api/config` | Partial config update (restarts the bot if it was running) |
| POST | `/api/bot/start\|stop\|restart` | Bot control |
| POST | `/api/autostart` | `{ "enabled": true }`, HKCU Run |
| POST | `/api/shutdown` | Terminate the process (used by the shell) |

The server listens on `127.0.0.1` only; the port is not exposed externally.
