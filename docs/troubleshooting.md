[English](troubleshooting.md) · [Русский](ru/troubleshooting.md)

# Troubleshooting

Start with the log: panel → **Log**, or
`%APPDATA%\opencode-telegram-bridge\bridge.log`. Quick check:
`ocbridge-cli doctor`.

## 409 Conflict

```
TelegramError: 409 Conflict: terminated by other getUpdates request
```

Two instances are running with the same token. What happens and what to do:

- on start the daemon probes neighbouring ports (`7788…7795`) and asks the instance
  it finds to exit via `POST /api/shutdown`;
- if that instance runs as administrator it cannot be stopped: Task Manager →
  `ocbridge.exe` / “OpenCode Bridge” → **End task**;
- check autostart: two different keys (`ocbridge.exe --no-browser` and
  `OpenCode Bridge.exe --hidden`) must not point at different copies;
- after stopping, press **Restart** in the panel or run `ocbridge-cli restart`.

## Telegram unreachable (IP blocking)

Symptom: “Could not reach Telegram Bot API”, with repeated
`telegram: pinned … — no answer` and `direct — …` in the log.

The bridge probes known Telegram IPs through a local CONNECT proxy and writes the
working one into the config (`telegram.apiIp`). If that does not help:

```jsonc
"telegram": {
  "proxy": "socks5://127.0.0.1:1080",  // or http://127.0.0.1:8080
  "apiIp": "149.154.167.220"
}
```

The same fields are in the panel, “Network” block. With `telegram.proxy` set it is
tried first; with `apiIp` that IP is tried first. After a change the config restarts
the bot. Manual check: `curl https://api.telegram.org` (or through the same proxy).

## Deleted topic

If a topic was deleted in Telegram, sending answers `message thread not found`.
The bridge clears the `thread → session` binding, the final answer goes to the chat
root, and the next message in a new topic creates a new session. The OpenCode session
is still alive — bring it back with `/attach` or `/sessions`.

## Stuck “thinking…” or no answer

Symptom: the status line freezes at `thinking… 1s`, or the reply never arrives
although the session finished in Desktop/TUI.

1. Look at the panel **Log**. `doctor: prompt admitted 30s ago … no
   session.execution.started` means OpenCode accepted the prompt but never started
   it — usually the session is busy with a stuck turn. Send `/stop`, then repeat the
   task. The same check is in `ocbridge-cli doctor` and `bun run src/doctor.ts`.
2. `prompt failed … 409` means the session was busy when the prompt arrived. In
   0.5.1+ the placeholder is replaced with this error instead of staying forever.
3. If the log shows `status tick flush failed: … 502` / `Telegram 429` /
   `telegram proxy connect failed`, Telegram itself is unreachable. Wait for the
   proxy to recover or change **Network** settings; the final answer is retried and,
   as a last resort, sent as a new message.
4. `/status` shows `busy`/`idle` and the model. A pending permission request is a
   message with buttons — press one; otherwise it cannot proceed.

## Timeouts

| What | Limit |
|---|---|
| One SSE event handler | 20 s (a stuck one is skipped) |
| Doctor: prompt → `execution.started` | 30 s (warning + panel hint) |
| `/api/info` check during OpenCode discovery | 2.5 s per address |
| Telegram file download | 60 s |
| CLI request to the API | 10 s (connect 5 s) |
| Shell wait for the API on start | 30 s |

If a turn is “stuck”: `/stop`, then `/status`. If the panel does not respond, check
`bridge.log`; the process may have crashed.

## No read receipts

There will not be any: the Bot API does not expose read statuses and does not let a
bot write as a user. “Typing…” is `sendChatAction("typing")`, which the bridge repeats
every 5 s while a turn runs. Missing checkmarks are normal, not an error.

## Garbled log

`bridge.log` is written in UTF-8 without BOM. Windows PowerShell 5.1 reads the file
as ANSI (cp1251), so Cyrillic looks like garbage. Open it correctly:

```powershell
Get-Content "$env:APPDATA\opencode-telegram-bridge\bridge.log" -Encoding UTF8 -Tail 50
```

or run `chcp 65001` before `type`. In PowerShell 7 `-Encoding utf8` is the default.
The app itself reads the log through the API and displays it correctly.

## Other

| Symptom | Solution |
|---|---|
| “Bot token is invalid” | Check the token with @BotFather; 401/404 means a wrong token |
| “OpenCode server not found” | Start OpenCode (`opencode service start` or Desktop) and check `~/.config/opencode/service.json` |
| Panel does not open | Port is busy: the daemon takes the next one; the exact address is in `bridge.log` (`web ui: http://…`) |
| Bot is silent in a group | The bot is not an admin or privacy mode is on: make it an admin or BotFather → `/setprivacy` → Disable |
| Bot does not create topics | Missing “Manage Topics” permission |
| Autostart unavailable | Dev mode or not Windows; only the compiled Windows build supports it |
| Voice is not recognised | No HEX or Labs flag — see [voice.md](voice.md) |
