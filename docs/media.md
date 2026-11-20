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
- If a file exceeds the platform limit (Telegram 50 MB, Discord 10 MB), a text link
  is sent instead: for `https://…` — the URL as is, for a local file — the absolute
  path.
- Repeated relay of the same bytes (sha256) into the same session is suppressed for
  10 minutes so the mirror cannot loop.
- Upload/download errors are only logged: the event loop never crashes.

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
