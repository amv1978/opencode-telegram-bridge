[English](telegram.md) · [Русский](ru/telegram.md)

# Telegram

## First launch

1. Create a bot with **@BotFather**, copy the token.
2. Paste the token into the panel `http://127.0.0.1:7788` → **Save**.
3. Send `/start` to the bot in a private chat. If the allowlist is empty, the first
   user becomes **administrator**; everyone else gets “No access”.

After that, access is granted only by explicitly adding an ID to
`telegram.allowedUsers` (role `admin` or `user`).

## Modes

| Mode | Behaviour |
|---|---|
| `private` | Private chats, one active session per chat |
| `topics` | Forum supergroup, topic = session |
| `both` | Both (default) |

Groups are connected explicitly only: messages from any group except `topicsChatId`
are ignored. The exception is an administrator using `/chatid` in a new forum group.

## Forum group

1. Create a group and enable **Topics**.
2. Add the bot as administrator with the **Manage Topics** permission.
3. Send `/chatid` in the group — the bot saves `topicsChatId`.
   Manually: the “Forum group ID” field in the panel.
4. Creating a topic immediately creates an OpenCode session named after the topic
   (if the topic has no binding yet). The bot replies in the topic with a short
   quote “🆕 Session created”. The first message in an existing unbound topic also
   creates a session — titled from the message text.
5. A message in the group's **General chat** creates a separate topic named after
   the task (`autoTopics`, enabled by default). The General chat is never a reply
   target: topics only.

Closing or deleting a topic does not end the OpenCode session. If a topic is
deleted, the binding is cleared and the final answer goes to the chat root.

## Commands

| Command | Action |
|---|---|
| `/start`, `/help` | Greeting, role, command list |
| `/new [folder]` | Create a session and bind it to the chat/topic |
| `/sessions [search]` | Recent sessions as buttons; in a forum opens a topic |
| `/attach <id\|prefix>` | Attach an existing session |
| `/topic <name>` | Create a forum topic and a session |
| `/detach` | Detach the chat or topic from the session |
| `/chatid` | Chat ID, type, forum flag; an admin saves the group |
| `/status` | One text report: version, uptime, adapters, OpenCode, session, tokens, cost, session count |
| `/model [provider/id]` | Show or change the model |
| `/agent [id]` | List agents or change the agent |
| `/mode [ask\|auto\|plan]` | Show or change the session permission mode |
| `/recent` | Recent sessions with a `🔔` unread marker; a button reattaches |
| `/budget` | Cost caps, today's spend and a hint how to change them |
| `/observe [on\|off\|status]` | Mirror runs started in Desktop/TUI into this chat/topic |
| `/stop` | Interrupt the current turn |
| `/fmt` | Rich-markup check |

## Permission modes

`/mode` shows the current preset derived from `session.permissions` and switches it
with `PATCH /api/session/{id}`:

- **ask** — the OpenCode default: every sensitive action asks (inline buttons);
- **auto** — `{"action":"*","resource":"*","effect":"allow"}`: allow everything;
- **plan** — allow everything except `write`, `edit` and `bash` (deny rules):
  read-only planning, the agent cannot modify files or run commands.

The preset from `config.json` → `permissions.mode` is applied to every new session;
`/mode` changes only the current session.

## Cost budgets

`config.json`:

```json
"budget": { "perTurnUsd": 1.5, "dailyUsd": 10, "action": "stop" }
```

- the turn cost is the growth of `session.cost` from `session.execution.started` to
  the end of the turn; the daily total sums turn deltas over the current UTC day and
  is stored in `state.json` (survives restarts);
- at **80%** of either cap the bound chat gets a warning; at **100%** the chat gets
  an alert and, with `action: "stop"`, the turn is interrupted (`/interrupt`);
- `/budget` shows the caps, today's spend and active turns.

## Recent sessions

`/recent` lists the last 10 root, non-archived sessions from all projects, newest
first, with the folder, age and a `🔔` marker when `time.idle > time.viewed`
(or the session is running). A button opens a forum topic for the session or binds
it to a private chat.

## Turn status and footer

While a turn runs, a live block is shown above the answer:

```
🟢 **DeepSeek V4.1 Flash** · thinking. 42s
- ⠋ 🛠 edit bot.ts · 3s
- 🔍 grep "permission" · 1s ✓

<answer text…>
```

- The model name comes from `session.model` and `/api/model` (`name`); if the name is
  missing — `providerID/id`; if the session has no model yet — `unknown model`. The
  literal word `OpenCode` is never shown as a model.
- Every status line is a separate physical line, nothing is glued; only the model
  name is bold, other labels are stripped of `*`/`_` and cut to 60 characters. The
  word `tool` is never printed — only the name and argument. Tools and subagents
  are list items (`- 🛠 …`, `- 🧩 …`): rich markdown collapses a lone `\n`, while a
  list item always starts a new line.
- The status is refreshed by an independent 1.2 s ticker for as long as the block
  lives (not only while a tool is active), so `thinking. 1s` turns into `thinking.. 12s`
  even when Telegram deltas stop. Every tick recomputes elapsed and forces an edit
  (on 429 it waits for `retry_after`). The same tick advances the spinner before a
  running tool (`⠋ 🛠 …`) and the `thinking.` dots; line order is stable and the
  message is edited in place, never re-sent. The model label refreshes on
  `session.model.selected`.
- Tools: `session.tool.called` → icon + name + short argument,
  `session.tool.success` → `✓`, `session.tool.failed` → `✗`. The last 2 lines are
  shown; finished ones disappear after ~10 s; repeats collapse (`edit bot.ts ×3`).
  With `showTools = "off"` the tool block is hidden.
- Subagents: a child session (`parentID`) does not open a separate stream. With an
  active parent block it adds an inline line — `🧩 explore · 12s`, then `✓`/`✗`
  (`🧩 general · 1m 03s ✓`). The last 2 lines are shown, identical agents collapse
  (`×2`), finished ones hide after ~10 s, and at the end of the parent turn they go
  with the block. If the parent answer already finished, a dedicated message is
  sent instead: `🧩 <agent> · <title> · 0m 12s`, edited every ~2 s and ending as
  `✅`/`✗`; it is deleted after 10 minutes unless you reply to it. At most 3
  individual cards; extra children share one edited message with up to 3 lines.
  A `session.synthetic` child report is posted as a quote `> 🧩 <agent>: …`
  (first ~300 characters). `showSubagents` accepts `auto` (default: inline when
  the block is alive, message otherwise), `inline`, `message` and `off`;
  `true`/`false` still work as `auto`/`off`.
- When the turn ends the block disappears and one or two lines remain under the
  answer after a blank line. A successful turn keeps only the stats line:

```
DeepSeek V4.1 Flash · ⏱ 1m 23s · ⚡ 197.8 tok/s · 🧠 531k
```

### Honest stop footer

An abnormal end never looks like success: the reason is its own line, the stats
line stays last. Blocked tool calls are counted when present.

| End | Line |
|---|---|
| `/stop` | `⚠️ остановлено: /stop` |
| budget stop (`action: "stop"`) | `⛔ бюджет: $0.4210 из $1.00` |
| step/turn cap | `⚠️ лимит шагов` |
| `execution.failed` | `⚠️ ошибка: <short reason>` |

```
⚠️ остановлено: /stop · 2 инструмента заблокировано
DeepSeek V4.1 Flash · ⏱ 42s · 🧠 531k
```

The same reason string is written to `bridge.log`. Telegram and Discord render
identical text; blocked calls come from declined permissions and policy denials,
not from ordinary tool errors.

### `/observe` — foreign runs

`/observe` in a chat or topic turns on observation of sessions started outside the
bridge (Desktop/TUI). A run without a topic/chat binding is mirrored as one compact
card edited in place:

```
👀 Fix login · DeepSeek V4.1 Flash
⏱ 12s · 🛠 3
```

When it ends the card becomes the final one with `✅`/`⚠️`, duration, tok/s, context
and the cost of the run. Sessions already bound to a topic/thread are never
duplicated; a session with an active stream is skipped. The opt-in flag and the
observed session ids live in `state.json` (`observe`). `/observe status` lists them,
`/observe off` stops and clears; without an argument the command toggles.

### Title status

`ui.titleStatus` controls how the bound forum topic shows a running turn:

- `icon` (default) — the topic icon is changed with `editForumTopic`
  (`icon_custom_emoji_id`): `⏳` while the turn runs, `✅` when it ends, then the
  default icon is restored after ~10 s. Icons post no “renamed the topic” service
  messages. The ids are resolved once from `getForumTopicIconStickers`, so the bot
  needs “Manage topics” but no extra rights.
- `rename` (opt-in) — the legacy behaviour: `⏳ <title>` on start, `✅ <title>` on a
  long turn and the original title after ~10 s. Every rename posts a service
  message and Telegram rate-limits renames to one per 60 s, so a short turn skips
  the intermediate `✅` and is restored when the window opens. The General chat is
  never touched.
- `off` — no status marker.

A session rename during a turn updates the stored original title; in `icon` mode
the topic name is never changed. Chat decorations are cosmetic: the OpenCode
session title is not modified.

## Permissions

A `permission.asked` request arrives as a message with buttons:

- **✅ Allow** — `once`;
- **♾ Always** — `always`;
- **⛔️ Deny** — `reject`.

The request lives for 15 minutes; an expired button answers “Request expired”.
Multiple requests are stored independently (key in callback data).

## Forms and choices

When OpenCode asks a question with options (`form.created`, kinds `question`,
`mcp-elicitation`, `websearch.provider`), the bridge posts it to the bound chat as
one message:

- the form title, the optional description and `1/2 · Field name` when there are
  several fields;
- one inline button per option (8 per page, `◀ 2/3 ▶` for long lists);
- **multi-select** fields toggle (`🔹`) and confirm with **✅ Done**;
- **boolean** fields — `✅ Yes` / `❌ No`;
- **text/number** fields — the **✍️ Enter answer** button, then the answer is typed
  as the next message (the form remembers which field is waiting);
- **custom answer** (`custom: true`) — **✍️ Own answer**, then the text message;
- **⏭ Skip** for optional fields, **✖️ Cancel form** answers the API with
  `DELETE …/form/{id}?message=Отменено в Telegram`.

Answers are posted to `POST /api/session/{id}/form/{formID}/reply` with typed
values (`string`, `number`, `boolean`, `string[]`); the message is edited to
`✅ Answer sent` with the chosen labels and the keyboard is removed. The form
lives for 15 minutes: an expired button says “Form expired — answer in OpenCode”.
`form.replied`/`form.cancelled` (answered in Desktop/TUI) edit the message to the
same final state, so the chat never shows a stale question. Forms created before
the bridge started (or with a missed ephemeral event) are picked up by a 20 s
poll of bound sessions.

## Echo protection

The bridge mirrors a prompt typed in Desktop/TUI into the bound chat (as a quote).
To keep that message from going back into the model, the text is remembered for
10 minutes (last 20 per chat) and ignored on a match. Prompts with
`metadata.source = "telegram"` are not mirrored at all.

## Media and voice

- Photos and documents up to **20 MB** (Bot API download limit) go into the session
  as a data URI; the caption becomes the task text.
- Files produced by the agent (`message` parts `type:"file"` and `tool.state.content`
  file parts) are delivered as native media: images ≤ `maxPhotoMb` (10 MB) as
  `sendPhoto`, everything else up to 50 MB as `sendDocument`; the caption is the
  file name. Larger files become a link/path. Delivery is thread-aware and reuses
  the relay hash cache, so both transports never send the same file twice.
- Voice and audio (OGG/Opus, MPEG, WAV, MP4, WebM) are recognised locally, see
  [voice.md](voice.md). The transcript arrives as a rich message styled like
  mirrored messages: quote `> 💠 **Transcript · voice**`, text line by line and the
  processing time `⏱ … s`; if rich mode is unavailable — as plain text.
- Video, stickers and GIFs are not supported — the bot says so.

## Formatting

Replies are sent as **rich messages** with native Markdown: headings, lists, tables,
code. If Telegram rejects rich mode, the bridge permanently switches to HTML
(`parse_mode: "HTML"`): bold, italic, links, `<pre>`; tables render as `<pre>`.
MarkdownV2 is not used — its escaping is too fragile.

A long answer is split into parts: 30,000 characters for Markdown and 3800 for HTML;
code blocks are closed and reopened at part boundaries.

## Bot API limitations

- There are no read receipts or recipient-side “typing” status;
  `sendChatAction("typing")` only shows “typing…” while a turn runs. The bridge
  repeats it every ~4.5 s (Discord: `sendTyping()` every ~8 s) and stops when the
  turn, including its subagents, finishes.
- The bot cannot start a private chat: the user must press `/start`.
- The bot cannot send messages as a human or read chat history.
- In a group the bot receives messages either as an administrator or with privacy
  mode disabled (BotFather → `/setprivacy` → Disable, then re-add to the group).
- Edits are rate-limited: on 429 the bridge waits for `retry_after` and retries.
- The bot cannot download files larger than 20 MB — a Telegram limitation, not the
  bridge's.
