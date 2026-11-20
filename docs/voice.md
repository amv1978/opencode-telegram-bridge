[English](voice.md) · [Русский](ru/voice.md)

# Voice messages

Recognition is local: Telegram → ffmpeg → WAV → HEX CLI → text into the session.
No cloud services are used.

## Pipeline

```
voice/audio (OGG/Opus, MP3, WAV, MP4, WebM)
        │  Bot API getFile (up to 20 MB)
        ▼
ffmpeg -ar 16000 -ac 1 → WAV      (temp folder, deleted afterwards)
        ▼
hex transcribe --json voice.wav
        ▼
"🎤 <text>\n⏱ 0.3 s"  →  prompt into OpenCode
```

WAV is written to a temp file: HEX does not accept a streaming WAV with a header.

## Where HEX is found

Order (`src/audio/transcribe.ts`):

1. `HEX_CLI` — full path to `hex.com` (environment variable).
2. `%APPDATA%\hex\current-version` → `%APPDATA%\hex\versions\<version>\hex.com`.
3. `%APPDATA%\hex\bin\hex.com`.

If nothing is found, the bot replies: “HEX not found. Install HEX or set the path in
HEX_CLI”.

## Labs flag

HEX does not transcribe files until the Labs flag `transcribe-files` is enabled.
On the first voice message the bot offers an **Enable** button (user consent); it runs:

```
hex labs on transcribe-files
```

Manual equivalent: HEX → Labs → **Transcribe files**. If the flag is off,
`hex transcribe` returns JSON with `status: "error"`, `code: "disabled"`.

## Where ffmpeg is found

1. `FFMPEG_PATH`;
2. `ffmpeg.exe` next to `ocbridge.exe`;
3. `dist\ffmpeg.exe` in the current folder (dev mode);
4. `ffmpeg` from `PATH`.

The installer puts `ffmpeg.exe` next to `ocbridge.exe`; no separate install is needed.

## Command and response parsing

```
hex transcribe --json <wav path>
```

The bridge takes text from `text`, `transcript`, `transcription`, `result` fields
(including nested `result.text`). A non-zero exit code or an empty response is an
error. HEX chooses the model and language from its own settings — the bridge does not
pass them.

## Latency

On Windows 11 with HEX 3.4.0 a typical “download → ffmpeg → transcribe” cycle takes
**200–300 ms** for a short phrase; the chat shows the rounded time (`⏱ 0.3 s`).
Longer voice messages take proportionally longer.

## Errors

| Reply | Cause |
|---|---|
| “Voice needs file transcription enabled in HEX” | Labs flag is off |
| “HEX not found” | `hex.com` not found, set `HEX_CLI` |
| “Speech not recognised” | HEX returned `no-speech` |
| “Audio processing error” | ffmpeg failed to start or the file is corrupt |
