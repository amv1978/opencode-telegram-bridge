[English](README.md) · [Русский](docs/ru/README.md)

# OpenCode Telegram Bridge

Drive **OpenCode 2.x** sessions from Telegram: a task by text or voice, a formatted
answer with statistics, permissions as buttons. The bridge connects to the same
OpenCode background service as Desktop and TUI, so it sees **the same sessions**; no
OpenCode plugin is required.

![Control panel](docs/ui.png)

## Features

- Forum group: **topic = session**, plus private chats; modes `both`, `private`, `topics`.
- Answer streaming in one message, rich markup (tables, code, headings).
- Turn footer: `⏱` duration, `⚡` tok/s, `🧠` context — the same as the OpenCode UI.
- Permission buttons: “Allow”, “Always”, “Deny”.
- Voice: OGG/Opus → ffmpeg → HEX, locally, no cloud.
- Photos and documents up to 20 MB go into the session.
- Discord transport: public threads, the same sessions, both transports at once.
- File relay between all bound chats (Telegram topic/chat and Discord thread/channel),
  with link fallback over platform limits.
- Desktop shell: tray, autostart, OpenCode/Matrix themes, RU/EN language.
- `ocbridge-cli` for status, logs, config and diagnostics.
- Telegram blocking workaround: pin a working IP or use your own proxy.

## Quick start

### Installer (Windows 10/11)

1. Run `ocbridge-setup-0.4.1.exe`.
2. Paste the bot token from [@BotFather](https://t.me/BotFather) — you may skip this
   and set it later in the panel `http://127.0.0.1:7788`.
3. Send `/start` to the bot — the first user becomes administrator.
4. Send a task.

Autostart is enabled in the installer, tray or panel. For a forum group: enable
Topics, add the bot as an admin with “Manage Topics” and send `/chatid` — details in
[docs/telegram.md](docs/telegram.md).

### From source

```bash
bun install
bun run src/index.ts --ui     # dev mode, opens the panel
bun run typecheck
bun run build                 # dist/ocbridge.exe
bun run src/doctor.ts         # check the OpenCode connection
```

Installer and other components: [docs/build-and-release.md](docs/build-and-release.md).

## How it works

```
Telegram ⇄ grammY (long polling) ⇄ Bridge ⇄ OpenCode HTTP API
                                     ├─ /api/session/{id}/prompt, /interrupt, /permission/*
                                     ├─ SSE /api/event (text.delta, execution.*, permission.asked)
                                     └─ state.json (topic/chat ⇄ session)
```

Tested with OpenCode 2.3.2: the end of a turn is `session.execution.*`
(`session.idle` never arrives), the SSE filter accepts repeated `types`, and the
stream is volatile. Details: [docs/opencode-integration.md](docs/opencode-integration.md).

## Data and security

- The token and settings live only in
  `%APPDATA%\opencode-telegram-bridge\config.json`; they never reach the repository
  or the builds.
- The web panel listens on `127.0.0.1` and is not exposed externally.
- Outgoing connections: long polling to Telegram and localhost requests to OpenCode.
- Access is allowlist-based; the first `/start` on an empty config makes the user an
  admin.
- `config.json` contains the token — do not publish or commit it.

## Documentation

| Chapter | Contents |
|---|---|
| [docs/README.md](docs/README.md) | Index of all chapters |
| [docs/architecture.md](docs/architecture.md) | Components, ports, files |
| [docs/opencode-integration.md](docs/opencode-integration.md) | Endpoints and SSE |
| [docs/telegram.md](docs/telegram.md) | Commands, modes, permissions, media |
| [docs/media.md](docs/media.md) | File relay: limits and fallback |
| [docs/discord.md](docs/discord.md) | Discord transport and limits |
| [docs/voice.md](docs/voice.md) | Voice and HEX |
| [docs/ui.md](docs/ui.md) | Themes, language, Electron |
| [docs/cli.md](docs/cli.md) | `ocbridge-cli` |
| [docs/build-and-release.md](docs/build-and-release.md) | Build and release |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common problems |

Russian documentation: [docs/ru/README.md](docs/ru/README.md).

## License

MIT — see [LICENSE](LICENSE).
