[English](opencode-integration.md) · [Русский](ru/opencode-integration.md)

# OpenCode integration

Tested with OpenCode 2.3.2. The shared background service is used (`opencode service
start` or Desktop), so the bridge sees the same sessions as TUI and the desktop app.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/info` | Version and availability check |
| GET | `/api/session?limit=&search=` | Session list (`{ data: [...] }`) |
| POST | `/api/session` | Create: `title`, `location.directory`, `permissions` |
| GET | `/api/session/{id}` | One session |
| PATCH | `/api/session/{id}` | Rename (`title`) |
| GET | `/api/session/{id}/message?limit=&order=` | Message history |
| POST | `/api/session/{id}/prompt` | `{ text, metadata, files }` |
| POST | `/api/session/{id}/interrupt` | Interrupt the turn |
| GET | `/api/session/{id}/permission` | Pending permissions |
| POST | `/api/session/{id}/permission/{requestID}/reply` | `{ decision, message }` |
| POST | `/api/session/{id}/model` | `{ model: { providerID, id, variant? } }` |
| POST | `/api/session/{id}/agent` | `{ agent }` |
| GET | `/api/agent` | Agent list |
| GET | `/api/event?types=…` | SSE stream |

Auth is Basic `opencode:<password>`; the password comes from `service.json`, the
config or `OPENCODE_PASSWORD`.

## SSE events

The subscription (`src/opencode/client.ts`) asks only for the needed types:

```
/api/event?types=session.text.delta&types=session.execution.succeeded&...
```

The repeated `types` parameter is mandatory: OpenCode does not accept a comma list.

| Event | Handling |
|---|---|
| `session.inbox.enqueued` | Mirrors a Desktop/TUI prompt into Telegram |
| `session.execution.started` | Starts the stream if it does not exist yet |
| `session.text.started` / `delta` | Appends text to the message |
| `session.text.ended` | Replaces text with the final version |
| `session.tool.called` | Tool line (up to 6, `showTools` mode) |
| `session.execution.succeeded/failed/interrupted` | Ends the turn, writes the footer |
| `permission.asked` | Sends a message with buttons |
| `session.renamed` | Renames the forum topic |
| `session.created` | Caches `parentID`/`agent`/`title` of a new session |
| `session.synthetic` | Subagent report (`<subagent>`) into the parent chat |

`session.idle` never arrives — the end of a turn is defined only by `session.execution.*`.

## Specifics

**Strict queue.** All events are processed serially (`eventChain`), otherwise a
mirrored question could reach the chat after the answer. Every handler is capped at
20 seconds; a stuck handler is skipped and logged.

**Volatile stream.** SSE keeps no history and does not replay missed events. On a
disconnect the client reconnects with exponential backoff (1–30 s) and receives
`session.text.*` again. Text lost mid-turn may stay incomplete until
`session.text.ended`.

**Deleted topic.** If Telegram answers `message thread not found`, `Streamer` clears
the binding (`store.clearThread`) and sends the final text to the chat root so the
answer is not lost.

**Two-way renaming.** Renaming a topic in Telegram updates the session `title`.
`session.renamed` renames the topic. Loop protection is `appliedTitles`: an event
caused by our own rename is ignored.

**Subagents.** Sessions with `parentID` are not mirrored and do not accept messages:
a topic bound to a child session asks the user to pick another one. With
`showSubagents` (default) a child turn adds a `🧩 <agent>` line to the parent live
block, and the `session.synthetic` report is posted as a quote in the parent chat.

**Stats footer.** Computed like `SessionTurn` in `packages/util/src/session-turn.ts`:

- `duration` = `time.completed` of the last assistant − `time.created` of the prompt;
- `tok/s` = sum of `output + reasoning` over the turn / sum of (`streamed − firstToken`);
  shown only when the generation window is longer than 200 ms;
- `context` = `input + cache.read + output + reasoning` of the last assistant.

If history is unavailable, duration comes from the local stream timer.

**Limits and pagination.** Session lists use `limit` 8 (panel), 10 (`/sessions`) and
50 (`/attach`); history uses `limit=60&order=desc`, then is reversed into
chronological order. There is no deep pagination: older sessions are found via
`search`.

**Files.** An attachment goes into `prompt` as
`files: [{ uri: "data:<mime>;base64,…", name }]`. Metadata `{ source: "telegram" }`
prevents mirroring our own messages back.
