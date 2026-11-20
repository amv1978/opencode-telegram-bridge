[English](README.md) · [Русский](ru/README.md)

# OpenCode Telegram Bridge: documentation

A bridge between Telegram (and Discord) and OpenCode 2.x. A Bun daemon, an Electron
shell, a .NET 10 CLI and an Inno Setup installer.

## Chapters

| Document | Contents |
|---|---|
| [architecture.md](architecture.md) | Components, data flow, ports, files on disk |
| [opencode-integration.md](opencode-integration.md) | OpenCode endpoints, SSE events, specifics |
| [telegram.md](telegram.md) | Commands, modes, topics, permissions, media and voice |
| [media.md](media.md) | File relay: limits, links, relay modes |
| [discord.md](discord.md) | Discord: Dev Portal, intents, threads, commands, limits |
| [voice.md](voice.md) | Voice: ffmpeg, HEX, Labs, latency |
| [ui.md](ui.md) | Themes, language, Electron shell, tray |
| [cli.md](cli.md) | All `ocbridge-cli` commands with output examples |
| [build-and-release.md](build-and-release.md) | Build, versions, installer, signing |
| [troubleshooting.md](troubleshooting.md) | 409, Telegram blocking, deleted topic, timeouts |

Russian mirrors: [docs/ru/](ru/README.md).

## Quick links

- Install: `dist\ocbridge-setup-0.4.1.exe` or build from source
  (see [build-and-release.md](build-and-release.md)).
- Control panel: `http://127.0.0.1:7788` (localhost only).
- Data: `%APPDATA%\opencode-telegram-bridge\` — `bridge.log` lives there too.
- UI screenshots: [ui.png](ui.png), Matrix dark theme: [ui-matrix.png](ui-matrix.png).
