[English](README.md) · [Русский](docs/ru/README.md)

# OpenCode Telegram Bridge

Drive **OpenCode 2.x** sessions from Telegram and Discord: a task by text or voice,
a formatted answer with statistics, permissions as buttons. The bridge connects to
the same OpenCode background service as Desktop and TUI, so it sees **the same
sessions**; no OpenCode plugin is required.

![Control panel](docs/ui.png)

## Features

- **Telegram adapter**: forum topics (**topic = session**) and private chats, modes
  `both`, `private`, `topics`.
- **Discord adapter**: public threads (**thread = session**), the same sessions,
  both transports can run at once.
- **Slash commands** on both transports: `/help`, `/new`, `/sessions`, `/attach`,
  `/detach`, `/stop`, `/status`, `/model`, `/agent`, `/fmt`.
- **Permission buttons**: Allow / Always / Deny (Telegram and Discord).
- **Voice input**: OGG/Opus → ffmpeg → HEX, fully local, no cloud.
- **Media relay** between all bound chats (Telegram topic/chat ↔ Discord
  thread/channel), including files produced by the agent; over platform limits the
  file is replaced by a link or absolute path.
- **Rich Markdown**: tables, code, headings; on Discord wide tables become readable
  lists and narrow ones aligned code blocks.
- **Live status**: tools and subagents with elapsed time, `✓`/`✗`, repeats
  collapsed; subagent activity lines in the parent turn.
- **Stats line**: `⏱` duration, `⚡` tok/s, `🧠` context and the model name, matching
  the OpenCode UI.
- **Themes**: OpenCode and Matrix, each with System / Light / Dark.
- **UI language**: RU / EN (panel, installer wizard, tray).
- **Tray app**: status dot, start/stop/restart, log, autostart, quick links.
- **CLI** `ocbridge-cli` (.NET): status, sessions, logs, config, doctor, update.
- **Installer**: simple/advanced modes, RU/EN wizard, autostart, data preserved in
  `%APPDATA%`.
- **GitHub auto-update**: background checks, panel banner, tray and CLI, SHA256
  verification.

## Quick start

### Installer (Windows 10/11)

1. Run `ocbridge-setup-0.6.0.exe` (offline) or `ocbridge-setup-lite-0.6.0.exe`
   (downloads the portable bundle, ~2 MB). The portable layout is also available
   as `ocbridge-bundle-0.6.0.zip`.
2. Paste the bot token from [@BotFather](https://t.me/BotFather) - you may skip this
   and set it later in the panel `http://127.0.0.1:7788`.
3. Send `/start` to the bot — the first user becomes administrator.
4. Send a task.

Autostart is enabled in the installer, tray or panel. For a forum group: enable
Topics, add the bot as an admin with “Manage Topics” and send `/chatid` — details in
[docs/telegram.md](docs/telegram.md). Discord setup:
[docs/discord.md](docs/discord.md).

### From source

```bash
bun install
bun run src/index.ts --ui     # dev mode, opens the panel
bun run typecheck
bun run build                 # dist/ocbridge.exe
bun run src/doctor.ts         # check the OpenCode connection
```

Installer and other components: [docs/build-and-release.md](docs/build-and-release.md).

## Auto-update

The bridge checks GitHub Releases on start and every 6 hours (interval is
configurable). If a newer version exists, a banner appears in the panel with
**Download / Install** and progress; the same actions are available in the tray
(“Check for updates” / “Install X.Y.Z”) and in the CLI:

```
ocbridge-cli update --check
ocbridge-cli update --install
```

The installer is downloaded to `%TEMP%\ocbridge-update\setup.exe`, verified against
the release's `.sha256` asset, then run silently. User data in
`%APPDATA%\opencode-telegram-bridge\` is never touched. Auto-update works only for
the packaged Windows build, not for `bun` dev runs. See [docs/update.md](docs/update.md).

## How it works

```
Telegram ⇄ grammY (long polling) ⇄ Bridge ⇄ OpenCode HTTP API
Discord  ⇄ discord.js (gateway)  ⇄┘         ├─ /api/session/{id}/prompt, /interrupt, /permission/*
                                             ├─ SSE /api/event (text.delta, execution.*, permission.asked)
                                             └─ state.json (topic/chat/thread ⇄ session)
```

Tested with OpenCode 2.3.2: the end of a turn is `session.execution.*`
(`session.idle` never arrives), the SSE filter accepts repeated `types`, and the
stream is volatile. Details: [docs/opencode-integration.md](docs/opencode-integration.md).

## Data and security

- The token and settings live only in
  `%APPDATA%\opencode-telegram-bridge\config.json`; they never reach the repository
  or the builds.
- The web panel listens on `127.0.0.1` and is not exposed externally.
- Outgoing connections: Telegram long polling, Discord gateway, GitHub release
  checks, and localhost requests to OpenCode.
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
| [docs/update.md](docs/update.md) | GitHub auto-update |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common problems |

Russian documentation: [docs/ru/README.md](docs/ru/README.md).

## License

MIT — see [LICENSE](LICENSE).
