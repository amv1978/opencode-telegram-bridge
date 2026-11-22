[English](media.md) · [Русский](ru/media.md)

# Media and file relay

The bridge relays files between every chat a session is bound to:

- Telegram: a forum topic (`topicsChatId` + `threadId`) or a private chat;
- Discord: a public thread or channel.

The origin chat is excluded: a file sent in Telegram is not returned to Telegram but
goes to Discord (and vice versa). Files produced by the agent go to all bound chats.

## Configuration

```json
{
  "media": {
    "relay": "all",
    "maxPhotoMb": 10
  }
}
```

| Field | Values | Default |
|---|---|---|
| `relay` | `all` — users + agent output; `user` — only user-sent media; `none` — off | `all` |
| `maxPhotoMb` | images up to this size are sent as photos (1–10) | `10` |

Both fields are in the UI: **Settings → File relay** and **Photo max, MB**; values
are visible in the `/api/state` snapshot (`config.media`).

## Limits and fallback

| Platform | Photo | Document |
|---|---|---|
| Telegram | 10 MB (`maxPhotoMb` ≤ 10) | 50 MB |
| Discord | — | 10 MB |

- An image within `maxPhotoMb` goes as a photo, larger — as a document.
- Telegram captions are the file name; photo/document messages are posted into the
  bound topic (`message_thread_id`). Discord attachments keep the file name.
- Agent files (`message` parts `type:"file"`, `tool.state.content[]` file entries)
  go to every bound chat as native media. A file already relayed from another
  transport is skipped by the content-hash cache, so it is never uploaded twice.
- If a file exceeds the platform limit (Telegram 50 MB, Discord 10 MB), a text link
  is sent instead: for `https://…` — the URL as is, for a local file — the absolute
  path.
- User attachments are deduplicated per inbound message id, so sending the same
  image again later is relayed again. Content-hash dedupe (10 minutes) applies
  only to agent-produced files, to avoid echo loops.
- Upload/download errors are only logged: the event loop never crashes.
- Delivery is retried: 3 attempts per platform with 2 s / 5 s backoff, 30 s
  overall deadline. The first attempt is awaited for at most 5 s before the prompt
  (order: text → media → answer); further attempts run in the background and do
  not block the turn. If all attempts fail, the origin chat gets
  `⚠️ failed to relay file to Telegram/Discord: <reason>`.

## What counts as an agent attachment

On `session.execution.succeeded` and `session.tool.success` the bridge reads the
latest messages (`limit=5,order=desc`) and looks at:

- `content[]` parts of type `file`;
- `tool` parts whose `state.content[]` contains `file` entries.

The format observed in OpenCode 2.3.2:

```json
{ "type": "file", "uri": "data:image/png;base64,…" }
```

`url`/`path` are also supported; a local path is read from disk, and if the file
exceeds the limit it is sent as text. The first encountered format variant is logged
as `agent file part: …`.

## Voice

Audio is recognised and the transcript goes to the chat (see [voice.md](voice.md));
the audio file itself is not relayed.
