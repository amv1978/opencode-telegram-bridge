# Plan: <feature>

## Technical approach

Short design: modules, data flow, events, config keys. Prefer pure helpers in
`src/` and thin adapter wiring.

## Files

- `src/…` — what changes
- `tests/…` — new/updated tests
- `docs/…` — EN + RU chapters

## Risks

- Ordering / rate limits / SSE volatility:
- Platform limits (Telegram 4096, Discord 2000):

## Verification

- `bunx tsc --noEmit`
- `bun test`
- Manual: Telegram (private + topic), Discord (thread/channel)
