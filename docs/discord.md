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
| `/mode [ask\|auto\|plan]` | show/change the session permission mode |
| `/recent` | recent sessions with a `🔔` unread marker; a button creates a thread |
| `/observe [action]` | mirror Desktop/TUI runs into this channel/thread (`on`, `off`, `status`; no action = toggle) |
| `/budget` | cost caps and today's spend |
| `/fmt` | formatting check |

Permission modes (`ask` / `auto` / `plan`) work exactly as in Telegram: the preset
comes from `config.json` → `permissions.mode` for new sessions, `/mode` changes the
current one through `PATCH /api/session/{id}` (auto allows everything, plan denies
`write`/`edit`/`bash`). Budget caps are configured in `config.json`
(`budget: { perTurnUsd, dailyUsd, action }`); warnings go to the bound thread and
`/budget` in Telegram shows the same numbers.

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
  `🟢 **<Model>** · thinking. 42s`, then up to two recent tools like
  `⠋ 🛠 edit bot.ts · 3s` → `🛠 edit bot.ts · 3s ✓`. Only the model is bold; labels
  have no `*`/`_` and are at most 60 characters, the word `tool` is never printed.
  The status is refreshed by an independent 2.5 s ticker (without text deltas); the
  same tick moves the spinner and the `thinking.` dots, the line order is stable and
  the message is edited in place. Repeats collapse (`×3`), finished lines hide
  after ~10 s, and at the end of the turn the block is removed.
- **Title status**: Discord threads have no icons, so status markers are **off by
  default**. Set `discord.titleStatus: "rename"` to opt in: the thread is renamed to
  `⏳ <title>` on turn start and `✅ <title>` on success, then restored after ~10 s.
  `session.renamed` always syncs the thread name to the new session title (a plain
  channel, e.g. the server's General, is never renamed): an unchanged name is
  skipped and Discord allows about two renames per 10 minutes, so a rename inside
  the 5-minute window is attempted when it opens. `ui.titleStatus` applies only to
  Telegram.
- **One message per turn**: streams are keyed by `(sessionID, turnId)`, where
  `turnId` is the assistant message id of the turn. A new prompt always opens a new
  message — a finished answer is never edited by the next turn, even while its block
  is still alive for subagents — and a deferred mirror/retry never reuses an old
  message. With `ui.diagnostics: true` the stats line ends with `#t<turnId>` and the
  log records `turn start`/`turn end` with the turn and message id (off by default).
- **Subagents**: a child session (`parentID`) does not open a separate thread. With
  an active parent block it adds an inline line — `🧩 explore · 12s`, then `✓`/`✗`
  (`🧩 general · 1m 03s ✓`). At most 2 lines, repeats collapse (`×2`), finished ones
  hide after ~10 s (same 2.5 s edit limit). If the parent answer already finished,
  a dedicated message is sent instead: `🧩 <agent> · <title> · 0m 12s`, edited
  every ~2.5 s and ending as `✅`/`✗`; it is deleted after 10 minutes unless you
  reply to it. At most 3 individual cards; extra children share one edited message
  with up to 3 lines. The child report (`session.synthetic`) is posted as a quote
  `> 🧩 <agent>: …` (first ~300 characters). `showSubagents` accepts `auto`
  (default), `inline`, `message`, `off`; booleans map to `auto`/`off`.
- **Streaming**: one placeholder message, edits no more often than every 2.5 s
  (Discord limit); before chunking the text passes through `toDiscordMarkdown`:
  narrow tables — an aligned code block, wide ones — a list, `####`–`######` —
  bold (`#`–`###` stay headings). Other markup is unchanged, code inside ```
  is untouched. Text is cut into 1900-character chunks, extra chunks go as new
  messages; a code block is never split — at the boundary it is closed and
  reopened with the same language.
- **Final**: the stats line uses
  `<Model> · ⏱ <duration> · ⚡ <tok/s> · 🧠 <context>`. The model comes from the
  last assistant message, the name from `/api/model` (same map as Telegram). The
  duration/tok/s/context formula matches Telegram (`turnStats`).
  An abnormal end puts the reason on a line above the stats, so the stats line
  stays last: `⚠️ остановлено: /stop`, `⛔ бюджет: $X из $Y`,
  `⚠️ лимит шагов`, `⚠️ ошибка: <short reason>`; blocked tool calls are counted
  (`· 2 инструмента заблокировано`). The same reason is logged.
- **`/observe`**: mirrors runs started in Desktop/TUI into the current thread or
  channel. A live card (`👀 title · model`, `⏱ … · 🛠 N`) is edited every 2.5 s;
  the final card adds `✅`/`⚠️`, duration, tok/s, context and the run cost.
  Sessions already bound to a thread/channel or having an active stream are
  skipped. The flag and observed sessions are persisted in `state.json`
  (`observe`); `/observe off` clears, `/observe status` lists.
- **Agent artifacts**: file parts (`type:"file"`, `tool.state.content`) are posted
  as Discord attachments up to 10 MB, with the file name; larger files become a
  link. The relay hash cache deduplicates across transports.
- **Permissions**: `permission.asked` → a message with “Allow / Always / Deny”
  buttons, TTL 15 minutes.
- **Forms**: `form.created` (`question`, `mcp-elicitation`, `websearch.provider`)
  is posted as one message: title, `1/2 · Field`, then
  - buttons for up to 5 options, a `StringSelectMenu` for 6–25, paged buttons
    (15 per page) when there are more than 25;
  - multi-select uses a select menu (`min`/`max` values) or toggles, confirmed by
    **✅ Done**;
  - boolean → `✅ Yes` / `❌ No`; text and number fields and **✍️ Own answer** open
    a **modal** (free text, no message-based pending state);
  - **⏭ Skip** for optional fields, **✖️ Cancel** calls
    `DELETE …/form/{id}?message=Отменено в Discord`.
  Answers go to `POST /api/session/{id}/form/{formID}/reply` with typed values;
  the message becomes `✅ Answer sent` with the chosen labels and loses its
  components. TTL 15 minutes (“Form expired — answer in OpenCode”);
  `form.replied`/`form.cancelled` from Desktop/TUI close the message, and a 20 s
  poll of bound sessions catches forms whose ephemeral event was missed.
- **Attachments** (images and documents ≤ 20 MB) are downloaded and sent into the
  session as `files: [{uri: "data:…", name}]`.
- **Voice/audio**: downloaded and recognised via HEX (`transcribeAudio`); the thread
  receives one quote `> 💠 **Transcript · voice**` with the text and
  `> ⏱ <secs> s`; the header goes straight into the text, there are no empty `>`
  lines (Discord renders them literally). Existing `>` in the text are stripped, so
  there is never a double `> >`. The text then goes into the prompt.
- **Mirror**: prompts from TUI/Desktop (`session.inbox.enqueued` without
  `metadata.source === "discord"`) are posted in the thread as a quote with `👤`.
- **Subagents** are shown as `🧩` lines in the parent block, as background cards
  when the parent answer already finished, and as a quoted report; there is no
  separate thread for a child session.

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
