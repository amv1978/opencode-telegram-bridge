[English](ui.md) · [Русский](ru/ui.md)

# Interface

## Web panel

A single page served by the daemon: `http://127.0.0.1:7788`. It listens on loopback
only; if the port is busy the next one is used (up to +9).

Sections live behind a left navigation: **Status** (Telegram/OpenCode/Discord state,
start/stop/restart, autostart, current sessions), **Settings** (theme, language,
default folder, throttling, tools, formatting, media relay, subagents), **Telegram**
(enabled toggle, token, mode, forum group ID, topic status, access list, proxy/IP),
**Discord** (enabled toggle, token, allowed servers/users, thread renames),
**Updates** and **Log**. Below 900 px the navigation collapses into an icon rail;
the ☰ button expands it over the content. The selected section is kept in
`localStorage` (`ocbridge.page`).

Telegram and Discord each have an `enabled` toggle (`telegram.enabled`,
`discord.enabled`); the adapters start and stop independently, so one transport can
be turned off without restarting the other.

If `/api/state` fails (daemon restarting, port busy) the page keeps the last data
and shows a red banner with the failure reason instead of empty dashes. Discord
shows `connected`, `retrying N · in Xs · error`, or the error text.

### Current sessions

The Status page lists active and recent root sessions (active first, newest next).
“Hide” removes a row from the panel only — the session keeps running and stays in
OpenCode; the ids are stored in `state.json` (`ui.hiddenSessions`) and can be
restored with “Show hidden”. “Refresh” reloads the list; with no sessions the card
shows an empty state.

### Log panel

`bridge.log` is tailed with a line-count selector (100 / 500 / 2000), a level filter
(all / info / warn / error), a free-text search, and an auto-scroll pause. “Download
bridge.log” streams the whole file from `/api/log/download`. There is no “open
folder” link: the panel is a web page and cannot open Explorer.


## Themes

Two themes × three schemes:

| Theme | Scheme | Character |
|---|---|---|
| `opencode` | `system` / `light` / `dark` | Neutral, like the OpenCode UI |
| `matrix` | `system` / `light` / `dark` | Green monochrome on dark/light |

Implementation: attributes on `<html>` (`data-theme`, `data-scheme`); CSS variable
values (`--bg`, `--card`, `--line`, `--fg`, `--muted`, `--acc`, `--ok`, `--err`) live
in `src/web/ui.ts`. `system` resolves via `prefers-color-scheme` and listens for
changes.

The choice is stored in `ui.theme`/`ui.scheme` and duplicated in `localStorage`
(`ocbridge.theme`, `ocbridge.scheme`). On change the page sends the background and
dark-scheme flag to Electron via `window.ocbridgeDesktop.setTheme`.

## Language

`ui.lang`: `system`, `ru`, `en`. `system` is detected from `navigator.language`.
Strings live in two dictionaries in `src/web/ui.ts`; markup uses `data-i18n`,
`data-i18n-html`, `data-i18n-title`. A new key must be added to both dictionaries.
During a simple install the installer writes only `ui.lang` and leaves the rest of
the config untouched.

## Electron shell

`desktop/main.js` + `desktop/preload.js`, package `desktop/package.json`
(electron-builder, target `dir`).

**Window.** 1120×840 by default, minimum 780×560. Size and position are saved to
`window.json` in Electron `userData` and restored on the next launch. The title bar
is hidden (`titleBarStyle: "hidden"`); a 34 px overlay takes its place, and its
colour and symbol colour update over the `theme` IPC when the theme changes.

**Drag region.** The page header has `-webkit-app-region: drag`; buttons, links and
indicators inside use `no-drag`, otherwise they cannot be clicked.

**Tray.** A 16 px dot: green — running, yellow — connecting, red — error or stopped.
Menu: status, “Open panel”, “Open in browser”, start/stop, restart, “Reconnect
OpenCode”, settings, log, autostart, bot link, quit. State is polled every 2.5 s;
double-click opens the window. Closing the window does not quit the app — it stays in
the tray.

**Daemon launch.** The shell starts `ocbridge.exe --no-browser` itself if the API does
not respond; it looks for the exe next to itself (`..\ocbridge.exe`) or in `dist\`
(dev). Variables: `OCBRIDGE_EXE` — daemon path, `OCBRIDGE_PORT` — API port (7788).
`--hidden` starts without a window (used by installer autostart). A second window
instance is blocked by a single-instance lock.

## Autostart

Two independent paths, both write to
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`:

- tray/panel checkbox → value `OpenCodeTelegramBridge` = `"<ocbridge.exe>" --no-browser`
  (daemon without a window; the panel is available in a browser);
- installer → `"<app>\desktop\OpenCode Bridge.exe" --hidden` (shell and tray).

Autostart is supported only by the compiled Windows build; in dev mode the menu item
is disabled. Check with: `ocbridge-cli autostart status`.
