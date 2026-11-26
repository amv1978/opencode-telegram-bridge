[English](AGENTS.md) · [Русский](docs/ru/AGENTS.md)

# AGENTS.md

Bridge between Telegram and OpenCode 2.x: tasks from chat go to real OpenCode
sessions (the same ones Desktop/TUI see), answers stream back with formatting,
permission requests arrive as inline buttons.

## Layout

| Path | What it is |
|---|---|
| `src/` | Bun/TypeScript daemon `ocbridge.exe`: OpenCode HTTP+SSE client, grammY bot, Discord adapter (`src/discord/`), web UI on `127.0.0.1:7788` |
| `desktop/` | Electron shell: window, tray, autostart, title-bar theme sync |
| `cli/` | .NET 10 CLI `ocbridge-cli.exe` over the local JSON API (no NuGet deps) |
| `installer/` | Inno Setup script + RU/EN wizard messages |
| `docs/` | Chapters; index in `docs/README.md` |
| `specs/` | Local speckit specs (gitignored); `specs/_template/` is the versioned format |
| `scripts/` | Manual dev checks (voice, render, dec) |

## Commands

```bash
bun install
bun run src/index.ts --ui    # dev run, opens the web UI
bun run typecheck            # tsc --noEmit
bun run build                # dist/ocbridge.exe
bun run src/doctor.ts        # OpenCode-side diagnostics, no Telegram
```

Desktop: `cd desktop && npm install && npm run pack` (electron-builder `--dir`).
CLI: see `docs/build-and-release.md`. Installer: `ISCC installer\ocbridge.iss`.

## Hard rules learned here

- Never commit `config.json`, `state.json`, `bridge.log`, tokens or builds. Data lives in
  `%APPDATA%\opencode-telegram-bridge\`; the token exists only there.
- OpenCode SSE is volatile. Event handling must be **serial** (`eventChain`): a mirrored
  user message has to reach Telegram before the answer. Each handler is capped at 20 s.
- Discord lives only in `src/discord/` and must not import `src/telegram/*`. Its bot
  token is secret: log/UI expose only `tokenTail`; `MESSAGE_CONTENT` is privileged.
- `session.idle` never fires. End of turn is `session.execution.succeeded|failed|interrupted`.
- Prefer Telegram rich markdown (`sendRichMessage`); fall back to HTML. Do not use MarkdownV2.
- The forum's General chat is never a reply target: sessions live in topics only.
- Stats footer must match OpenCode (`packages/util/src/session-turn.ts`): duration, tok/s,
  context = input + cache.read + output + reasoning.
- A model label is never the literal `OpenCode`: `/api/model` (`name`) →
  `providerID/id` → `unknown model`; cache per session, drop on `session.model.selected`.
- A prompt accepted without `session.execution.started` within 30 s is a stuck turn:
  log + panel warning + `/stop` hint (doctor).
- **No code without a spec.** Every feature or bug-fix batch starts as
  `specs/<version>-<slug>/` from `specs/_template/` (spec: goal + acceptance +
  out of scope; plan: approach; tasks: ordered, tests included). Specs are local
  (gitignored); only the template is committed.
- **Every feature = spec + tests + a manual check in Telegram AND Discord.**
- **Release gate:** `bunx tsc --noEmit` + `bun test` + `node scripts/check-ui.mjs`
  + installer check (`ISCC installer\ocbridge.iss`), then a manual Telegram pass
  (private chat + topic + voice + permission button) and a Discord thread/channel pass.

## Docs

Start at `docs/README.md`. Details: `architecture.md`, `opencode-integration.md`,
`telegram.md`, `discord.md`, `media.md`, `voice.md`, `ui.md`, `cli.md`,
`build-and-release.md`, `update.md`, `troubleshooting.md`.
