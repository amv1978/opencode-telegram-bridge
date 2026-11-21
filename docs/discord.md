[English](discord.md) · [Русский](ru/discord.md)

# Discord

A second transport next to Telegram: the same OpenCode sessions, but in public
Discord threads. Telegram code is unchanged; both transports can run at once.

## 1. Application in Discord Developer Portal

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** → **Add Bot** → copy the **Token** (shown once).
3. **Bot → Privileged Gateway Intents** → enable **MESSAGE_CONTENT**.
   Without it the bot does not see regular message text (slash commands still work).
4. **Installation** (or OAuth2 → URL Generator):
   - scopes: `bot`, `applications.commands`;
   - permissions: `View Channels`, `Send Messages`, `Create Public Threads`,
     `Send Messages in Threads`, `Read Message History`, `Attach Files`;
   - `Manage Threads` — optional (renaming threads on `session.renamed`).

Ready invite link (substitute `CLIENT_ID`):

```
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=309237746688&scope=bot%20applications.commands
```

(`309237746688` — view channels, send messages, create public threads, messages in
threads, history, attachments. With `Manage Threads`: `326417615872`.)

## 2. Bridge configuration

In the web panel `http://127.0.0.1:7788` → **Settings → Discord**:

| Field | Value |
|---|---|
| Enable Discord | checkbox |
| Discord bot token | token from Dev Portal; blank = keep the stored one |
| Server IDs | snowflakes separated by commas; empty = the bot ignores everything |
| User IDs | who may drive the bot; empty = nobody |

The token is stored only in `%APPDATA%\opencode-telegram-bridge\config.json` and is
never written to the log. The panel shows only the last 4 characters (`…abcd`).

The same fields can be set in `config.json`:

```json
{
  "discord": {
    "enabled": true,
    "token": "…",
    "allowedGuilds": ["123456789012345678"],
    "allowedUsers": ["123456789012345678"],
    "mode": "threads"
  }
}
```

User ID: Discord → Settings → Advanced → Developer Mode, then right-click yourself →
“Copy ID”.

## 3. Commands

Commands are registered per allowed server on connect.

| Command | What it does |
|---|---|
| `/help` | help |
| `/new [title]` | new session + public thread, name = title or `Discord session` |
| `/sessions` | last 10 sessions |
| `/attach <sessionID\|prefix>` | attach an existing session to the current thread |
| `/detach` | detach the thread/channel (the OpenCode session remains) |
| `/stop` | interrupt the turn |
| `/status` | model, agent, directory, cost, bridge version |
| `/model [provider/id]` | show/change the model |
| `/agent [id]` | list/change the agent |
| `/fmt` | formatting check |

## 4. Thread model

- One OpenCode session = one **public thread**.
- `/new` creates a session with `defaultDirectory` and a thread in the current channel.
- A message in a thread bound to a session goes to `oc.prompt(..., {source:"discord"})`.
- A message in an unbound thread binds it to a new session; the title is the first
  60 characters of the text.
- A message in a regular channel creates a thread from that message and binds to it.
- Deleting/closing a thread does not end the session; the binding is cleared and the
  next message creates a new session.

## 5. Behaviour

- **Tables**: narrow ones (≤4 columns and ≤72 characters wide) become a code block
  with cells wrapped by words (each column ≤32 characters). Wide tables become a
  list `**Headers**` + rows `- Column: value · …`, so there is no horizontal
  scrolling.
- **Slash commands**: the acknowledgement (`deferReply`) is sent immediately, the
  answer uses `editReply`. An expired interaction (10062) is logged instead of
  throwing. On a gateway disconnect login/reconnect retries with 5 s → 5 min
  backoff; the bridge does not need a restart.
- **Live status**: in the same message above the answer — physical lines
  `🟢 **<Model>** · thinking… 42s`, then up to two recent tools like
  `🛠 edit bot.ts · 3s ✓`. Only the model is bold; labels have no `*`/`_` and are at
  most 60 characters, the word `tool` is never printed. The status is refreshed by
  an independent 2.5 s ticker (without text deltas). Repeats collapse (`×3`),
  finished lines hide after ~10 s, and at the end of the turn the block is removed.
- **Subagents**: a child session (`parentID`) does not open a separate thread; it
  adds a line to the parent block — `🧩 explore · 12s`, then `✓`/`✗`
  (`🧩 general · 1m 03s ✓`). At most 2 lines, repeats collapse (`×2`), finished ones
  hide after ~10 s (same 2.5 s edit limit). The child report
  (`session.synthetic`) is posted to the parent thread as a quote
  `> 🧩 <agent>: …` (first ~300 characters). Everything is disabled by
  `showSubagents: false`.
- **Streaming**: one placeholder message, edits no more often than every 2.5 s
  (Discord limit); before chunking the text passes through `toDiscordMarkdown`:
  narrow tables — an aligned code block, wide ones — a list, `####`–`######` —
  bold (`#`–`###` stay headings). Other markup is unchanged, code inside ```
  is untouched. Text is cut into 1900-character chunks, extra chunks go as new
  messages; a code block is never split — at the boundary it is closed and
  reopened with the same language.
- **Final**: one italic line
  `_<Model> · ⏱ <duration> · ⚡ <tok/s> · 🧠 <context>_`. The model comes from the
  last assistant message, the name from `/api/model` (same map as Telegram). The
  duration/tok/s/context formula matches Telegram (`turnStats`). For
  `interrupted`/`failed`: `_<Model> · ⏹ interrupted · ⏱ …_` / `⚠️ error` (no tok/s).
  If the line contains `_`, `*` or `` ` ``, italics are disabled — the text goes
  without asterisks so the markup does not break.
- **Permissions**: `permission.asked` → a message with “Allow / Always / Deny”
  buttons, TTL 15 minutes.
- **Attachments** (images and documents ≤ 20 MB) are downloaded and sent into the
  session as `files: [{uri: "data:…", name}]`.
- **Voice/audio**: downloaded and recognised via HEX (`transcribeAudio`); the thread
  receives one quote `> 💠 **Transcript · voice**` with the text and
  `> ⏱ <secs> s`; the header goes straight into the text, there are no empty `>`
  lines (Discord renders them literally). Existing `>` in the text are stripped, so
  there is never a double `> >`. The text then goes into the prompt.
- **Mirror**: prompts from TUI/Desktop (`session.inbox.enqueued` without
  `metadata.source === "discord"`) are posted in the thread as a quote with `👤`.
- **Subagents** are shown as `🧩` lines in the parent block and as a quoted report;
  there is no separate thread for a child session.

## 6. Discord limitations

- 2000 characters per message; the bridge cuts at 1900.
- No native tables: before sending, narrow ones become an aligned code block (cells
  are padded, the `---` separator is kept); wide ones become a list.
- 15 minutes — permission button TTL; after that the request must be repeated in
  OpenCode.
- Attachments larger than 20 MB are skipped (bot upload limit); relayed files over
  the platform limit are sent as a link/path.
- `mode` in v1 is `threads` only.
- The privileged **MESSAGE_CONTENT** intent must be enabled.

## 7. Diagnostics

- `discord: allowedGuilds is empty` — fill in server IDs.
- `discord: allowedUsers is empty` — fill in user IDs.
- `Used disallowed intents` — enable MESSAGE_CONTENT in Dev Portal.
- `Unknown Guild` during command registration — the bot is not invited to that server.
- Log messages: `%APPDATA%\opencode-telegram-bridge\bridge.log`.
