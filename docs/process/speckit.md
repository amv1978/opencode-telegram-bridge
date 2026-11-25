[English](speckit.md) · [Русский](../ru/process/speckit.md)

# Speckit: spec-driven changes

Every change starts with a short spec. The process is deliberately small: three
files, no ceremony.

## Rule

**No code without a spec.** A feature or a bug-fix batch is:

1. **spec** — goal, acceptance criteria, out of scope;
2. **plan** — technical approach, files, risks;
3. **tasks** — ordered steps, including tests;
4. code + tests (pure helpers first, adapter wiring second);
5. manual check in **Telegram and Discord**;
6. release gate: `bunx tsc --noEmit` + `bun test` + installer check.

## Where specs live

```
specs/
  _template/{spec.md,plan.md,tasks.md}   # versioned template
  <version>-<slug>/{spec.md,plan.md,tasks.md}  # local, gitignored
```

`specs/*` is in `.gitignore`: working specs stay on the machine. Only the
template is tracked, so the format is shared. Copy it with:

```powershell
Copy-Item specs\_template specs\0.9.0-my-feature -Recurse
```

## Minimal spec

- **Goal** — what changes for the user, one or two sentences.
- **Acceptance criteria** — observable behaviour, checkbox per item.
- **Out of scope** — what must not be touched.

Keep the plan to modules and data flow; keep tasks small enough to check off in
one sitting. Tests belong in the task list, not after it.

## Manual check matrix

| Surface | Minimum |
|---|---|
| Telegram | private chat, forum topic, `/status`, typing during a long turn |
| Discord | thread or channel, `/status`, typing during a long turn |
| Ordering | a Desktop/TUI prompt with an attachment appears before the answer |

## Release gate

```bash
bunx tsc --noEmit
bun test
# installer: ISCC installer\ocbridge.iss (and ocbridge-lite.iss)
```

Then a silent local install and `GET http://127.0.0.1:7788/api/state` must show
the new version with Telegram running. Only after that: CHANGELOG, version bump,
commit/tag (publication is a separate, explicit decision).
