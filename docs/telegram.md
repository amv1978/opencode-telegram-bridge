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
| `/status` | Title, id, folder, model, agent, busy state, cost |
| `/model [provider/id]` | Show or change the model |
| `/agent [id]` | List agents or change the agent |
| `/stop` | Interrupt the current turn |
| `/fmt` | Rich-markup check |

## Turn status and footer

While a turn runs, a live block is shown above the answer:

```
🟢 **DeepSeek V4.1 Flash** · thinking… 42s
- 🛠 edit bot.ts · 3s ✓
- 🔍 grep "permission" · 1s ✓

<answer text…>
```

- The model name comes from `session.model` and `/api/model` (`name`); if there is no
  name — `providerID/id`, otherwise `OpenCode`.
- Every status line is a separate physical line, nothing is glued; only the model
  name is bold, other labels are stripped of `*`/`_` and cut to 60 characters. The
  word `tool` is never printed — only the name and argument. Tools and subagents
  are list items (`- 🛠 …`, `- 🧩 …`): rich markdown collapses a lone `\n`, while a
  list item always starts a new line.
- The status is refreshed by an independent 1.2 s ticker while any tool or subagent
  is active; text deltas are not required. Every tick recomputes elapsed and forces
  an edit (on 429 it waits for `retry_after`).
- Tools: `session.tool.called` → icon + name + short argument,
  `session.tool.success` → `✓`, `session.tool.failed` → `✗`. The last 2 lines are
  shown; finished ones disappear after ~10 s; repeats collapse (`edit bot.ts ×3`).
  With `showTools = "off"` the tool block is hidden.
- Subagents: a child session (`parentID`) does not open a separate stream but adds
  a line to the parent's live block — `🧩 explore · 12s`, then `✓`/`✗`
  (`🧩 general · 1m 03s ✓`). The last 2 lines are shown, identical agents collapse
  (`×2`), finished ones hide after ~10 s, and at the end of the parent turn they go
  with the block. A `session.synthetic` child report is posted to the chat as a
  quote `> 🧩 <agent>: …` (first ~300 characters). Disabled by
  `showSubagents: false`.
- When the turn ends the block disappears and a single italic line remains under the
  answer after a blank line:

```
_DeepSeek V4.1 Flash · ⏱ 1m 23s · ⚡ 197.8 tok/s · 🧠 531k_
```

For `interrupted`/`failed`: `_… · ⏹ interrupted · ⏱ 42s_` /
`_… · ⚠️ error · ⏱ 42s_`. Numbers use the same OpenCode formula (duration, tok/s,
context) and do not change.

## Permissions

A `permission.asked` request arrives as a message with buttons:

- **✅ Allow** — `once`;
- **♾ Always** — `always`;
- **⛔️ Deny** — `reject`.

The request lives for 15 minutes; an expired button answers “Request expired”.
Multiple requests are stored independently (key in callback data).

## Echo protection

The bridge mirrors a prompt typed in Desktop/TUI into the bound chat (as a quote).
To keep that message from going back into the model, the text is remembered for
10 minutes (last 20 per chat) and ignored on a match. Prompts with
`metadata.source = "telegram"` are not mirrored at all.

## Media and voice

- Photos and documents up to **20 MB** (Bot API download limit) go into the session
  as a data URI; the caption becomes the task text.
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
  `sendChatAction("typing")` only shows “typing…” while a turn runs.
- The bot cannot start a private chat: the user must press `/start`.
- The bot cannot send messages as a human or read chat history.
- In a group the bot receives messages either as an administrator or with privacy
  mode disabled (BotFather → `/setprivacy` → Disable, then re-add to the group).
- Edits are rate-limited: on 429 the bridge waits for `retry_after` and retries.
- The bot cannot download files larger than 20 MB — a Telegram limitation, not the
  bridge's.
