const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_PORT = 7788;
const PORT_FILE_NAME = "port.json";
const DEFAULT_RELEASE_PAGE = "https://github.com/amv1978/opencode-telegram-bridge/releases/latest";
let bridgePort = Number(process.env.OCBRIDGE_PORT || 0) || DEFAULT_PORT;
let BASE = `http://127.0.0.1:${bridgePort}`;
let baseResolved = false;

let win = null;
let tray = null;
let bridge = null;
let spawnedByUs = false;
let lastState = null;
let quitting = false;
const changelogShown = new Set();

// ---------------------------------------------------------------- tray icons

function circleIcon(size, [r, g, b]) {
  const buffer = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - c;
      const dy = y - c;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const alpha = distance <= radius - 0.5 ? 255 : distance <= radius + 0.5 ? Math.round((radius + 0.5 - distance) * 255) : 0;
      const i = (y * size + x) * 4;
      buffer[i] = b;
      buffer[i + 1] = g;
      buffer[i + 2] = r;
      buffer[i + 3] = alpha;
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

const ICONS = {
  ok: circleIcon(16, [61, 220, 132]),
  warn: circleIcon(16, [240, 190, 60]),
  bad: circleIcon(16, [255, 90, 90]),
};

// ------------------------------------------------------------------- helpers

function dataDir() {
  const base = process.env.APPDATA || path.join(require("node:os").homedir(), "AppData", "Roaming");
  return path.join(base, "opencode-telegram-bridge");
}

function portFile() {
  return path.join(dataDir(), PORT_FILE_NAME);
}

/** Published by the bridge right after its web server binds (port may be 7788+N). */
function readPortInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(portFile(), "utf8"));
    const port = Number(info?.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return { ...info, port };
  } catch {
    /* no file yet */
  }
  return null;
}

/** The bridge is alive if /api/state answers; a stale port.json is ignored. */
async function probe(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Order: published port.json → OCBRIDGE_PORT → 7788 and the next 9 ports (the
 * bridge increments when the configured port is busy).
 */
async function resolveBase() {
  const info = readPortInfo();
  const candidates = [];
  const push = (value) => {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0 && port <= 65535 && !candidates.includes(port)) candidates.push(port);
  };
  if (info) push(info.port);
  push(process.env.OCBRIDGE_PORT);
  push(DEFAULT_PORT);
  for (let offset = 1; offset < 10; offset += 1) push(DEFAULT_PORT + offset);
  for (const port of candidates) {
    if (await probe(port)) {
      bridgePort = port;
      BASE = `http://127.0.0.1:${port}`;
      baseResolved = true;
      return true;
    }
  }
  baseResolved = false;
  return false;
}

/** Port to pass to `--port` when spawning; the bridge reports what it really got. */
function preferredPort() {
  const info = readPortInfo();
  const env = Number(process.env.OCBRIDGE_PORT || 0);
  return (Number.isInteger(env) && env > 0 ? env : 0) || info?.port || DEFAULT_PORT;
}

async function api(pathname, options) {
  if (!baseResolved) await resolveBase();
  const response = await fetch(BASE + pathname, {
    ...options,
    headers: { "content-type": "application/json", ...(options?.headers || {}) },
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (!response.ok) throw new Error(json.error || response.statusText);
  return json;
}

async function waitForApi(ms = 30000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await resolveBase()) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function bridgePath() {
  if (process.env.OCBRIDGE_EXE) return process.env.OCBRIDGE_EXE;
  if (app.isPackaged) {
    const beside = path.join(path.dirname(app.getPath("exe")), "..", "ocbridge.exe");
    return path.normalize(beside);
  }
  return path.join(__dirname, "..", "dist", "ocbridge.exe");
}

async function ensureBridge() {
  if (await resolveBase()) return;
  const exe = bridgePath();
  if (!fs.existsSync(exe)) {
    dialog.showErrorBox("OpenCode Bridge", `Не найден ocbridge.exe:\n${exe}`);
    return;
  }
  const port = preferredPort();
  bridge = spawn(exe, ["--no-browser", "--port", String(port)], {
    cwd: path.dirname(exe),
    windowsHide: true,
    stdio: "ignore",
  });
  spawnedByUs = true;
  // The bridge may bind `port + N`; port.json is the authoritative answer.
  if (!(await waitForApi())) {
    dialog.showErrorBox(
      "OpenCode Bridge",
      `Мост не ответил на ${BASE} за 30 с.\nПроверьте журнал: ${path.join(dataDir(), "bridge.log")}`,
    );
  }
}

// -------------------------------------------------------------------- window

function boundsFile() {
  return path.join(app.getPath("userData"), "window.json");
}

function loadBounds() {
  try {
    const raw = JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
    if (typeof raw?.width === "number" && typeof raw?.height === "number") return raw;
  } catch {
    /* first run */
  }
  return undefined;
}

ipcMain.on("theme", (_event, options) => {
  if (!win || win.isDestroyed()) return;
  const background = typeof options?.background === "string" ? options.background : "#161616";
  try {
    win.setBackgroundColor(background);
    win.setTitleBarOverlay({ color: background, symbolColor: options?.dark ? "#e6e6e6" : "#161616", height: 34 });
  } catch {
    /* title bar overlay is Windows-only */
  }
});

function saveBounds() {  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(boundsFile(), JSON.stringify(bounds), "utf8");
  } catch {
    /* ignore */
  }
}

function createWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  const saved = loadBounds();
  win = new BrowserWindow({
    width: saved?.width ?? 1120,
    height: saved?.height ?? 840,
    x: saved?.x,
    y: saved?.y,
    minWidth: 780,
    minHeight: 560,
    backgroundColor: "#161616",
    autoHideMenuBar: true,
    title: "OpenCode Bridge",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#161616", symbolColor: "#e6e6e6", height: 34 },
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.js") },
  });
  win.loadURL(`${BASE}/`).catch(async () => {
    await ensureBridge();
    win.loadURL(`${BASE}/`).catch(() => undefined);
  });
  win.on("page-title-updated", (event) => event.preventDefault());
  win.on("close", saveBounds);
  win.on("closed", () => {
    win = null;
  });
}

// ---------------------------------------------------------------------- tray

const TEXTS = {
  ru: {
    open: "Открыть панель",
    browser: "Открыть в браузере",
    start: "Запустить",
    stop: "Остановить",
    restart: "Перезапустить",
    reconnect: "Переподключить OpenCode",
    checkUpdate: "Проверить обновления",
    installUpdate: "Установить",
    downloadInstall: "Скачать и установить",
    cancelDownload: "Отменить загрузку",
    retry: "Повторить",
    releasePage: "Открыть страницу релиза",
    latest: "Установлена последняя версия.",
    updateWord: "обновление",
    updatePaused: "пауза",
    updateError: "ошибка обновления",
    rollback: "Откатиться на",
    whatsNew: "Что нового",
    settings: "Настройки",
    log: "Журнал",
    autostart: "Автозапуск",
    bot: "Открыть",
    quit: "Выход",
    none: "нет связи",
    running: "работает",
    starting: "подключение…",
    error: "ошибка",
    stopped: "остановлен",
  },
  en: {
    open: "Open panel",
    browser: "Open in browser",
    start: "Start",
    stop: "Stop",
    restart: "Restart",
    reconnect: "Reconnect OpenCode",
    checkUpdate: "Check for updates",
    installUpdate: "Install",
    downloadInstall: "Download & Install",
    cancelDownload: "Cancel download",
    retry: "Retry",
    releasePage: "Open release page",
    latest: "You have the latest version.",
    updateWord: "update",
    updatePaused: "paused",
    updateError: "update error",
    rollback: "Roll back to",
    whatsNew: "What's new",
    settings: "Settings",
    log: "Log",
    autostart: "Launch at login",
    bot: "Open",
    quit: "Quit",
    none: "offline",
    running: "running",
    starting: "connecting…",
    error: "error",
    stopped: "stopped",
  },
};

function lang() {
  const setting = lastState?.config?.ui?.lang;
  if (setting === "ru" || setting === "en") return setting;
  return String(app.getLocale()).toLowerCase().startsWith("ru") ? "ru" : "en";
}

function t(key) {
  return TEXTS[lang()][key] ?? TEXTS.en[key] ?? key;
}

function statusOf(state) {
  if (!state) return { icon: ICONS.bad, text: t("none") };
  if (state.state === "running") return { icon: ICONS.ok, text: `${t("running")} · @${state.username || "?"}` };
  if (state.state === "starting") return { icon: ICONS.warn, text: t("starting") };
  return { icon: ICONS.bad, text: state.state === "error" ? t("error") : t("stopped") };
}

// ---------------------------------------------------------------- changelog

function compareVersions(left, right) {
  const parse = (value) =>
    String(value || "")
      .replace(/^v/i, "")
      .split(/[+-]/)[0]
      .split(".")
      .map((part) => parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderMarkdown(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let inList = false;
  const closeList = () => {
    if (inList) html += "</ul>";
    inList = false;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const inline = (value) =>
      escapeHtml(value)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
    if (/^###\s+/.test(line)) {
      closeList();
      html += `<h3>${inline(line.replace(/^###\s+/, ""))}</h3>`;
    } else if (/^##\s+/.test(line)) {
      closeList();
      html += `<h2>${inline(line.replace(/^##\s+/, ""))}</h2>`;
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`;
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

async function markChangelogSeen(version) {
  if (!version) return;
  try {
    await api("/api/ui/seen-changelog", { method: "POST", body: JSON.stringify({ version }) });
  } catch {
    /* non-critical */
  }
}

async function openChangelog(from, to, markVersion) {
  let sections = [];
  try {
    const query = `?to=${encodeURIComponent(to || app.getVersion())}${from ? `&from=${encodeURIComponent(from)}` : ""}`;
    sections = (await api(`/api/changelog${query}`)).sections || [];
  } catch (error) {
    showError(error);
    return;
  }
  if (!sections.length) {
    dialog.showMessageBox({ type: "info", message: t("whatsNew"), detail: "Нет записей для этой версии." });
    return;
  }
  const title = from ? `Что нового · ${from} → ${to}` : `Что нового · ${to}`;
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #161616; color: #e6e6e6; font: 14px/1.55 "Segoe UI", system-ui, sans-serif; }
  header { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 14px 20px; background: #1d1d1d; border-bottom: 1px solid #2c2c2c; }
  header h1 { flex: 1; margin: 0; font-size: 16px; font-weight: 600; }
  main { padding: 8px 20px 24px; }
  section { border-bottom: 1px solid #262626; padding-bottom: 8px; margin-bottom: 12px; }
  h2 { font-size: 15px; margin: 18px 0 8px; color: #7ee787; }
  h3 { font-size: 13px; margin: 12px 0 6px; color: #9aa4b2; text-transform: uppercase; letter-spacing: .04em; }
  p, li { margin: 4px 0; }
  ul { padding-left: 20px; }
  code { background: #262626; border-radius: 3px; padding: 1px 4px; font-family: Consolas, monospace; }
  button { background: #238636; color: #fff; border: 0; border-radius: 6px; padding: 8px 18px; font-size: 14px; cursor: pointer; }
  button:hover { background: #2ea043; }
</style>
<header><h1>${escapeHtml(title)}</h1><button onclick="window.close()">Понятно</button></header>
<main>${sections.map((section) => `<section><h2>${escapeHtml(section.heading || section.version)}</h2>${renderMarkdown(section.body)}</section>`).join("")}</main>
</html>`;
  const modal = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 520,
    minHeight: 420,
    title,
    backgroundColor: "#161616",
    autoHideMenuBar: true,
    parent: win && !win.isDestroyed() ? win : undefined,
    modal: Boolean(win && !win.isDestroyed()),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  modal.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined);
  modal.on("closed", () => {
    if (markVersion) void markChangelogSeen(markVersion);
  });
}

function maybeShowChangelog(state) {
  const from = state?.update?.prevVersion;
  const current = state?.version;
  if (!from || !current || compareVersions(from, current) >= 0) return;
  const key = `${from}>${current}`;
  if (changelogShown.has(key)) return;
  const seen = Array.isArray(state?.config?.ui?.seenChangelog) ? state.config.ui.seenChangelog : [];
  if (seen.includes(current)) return;
  changelogShown.add(key);
  void openChangelog(from, current, current);
}

function releaseUrl(state) {
  const asset = state?.update?.assetUrl;
  return asset ? String(asset).replace(/\/download\/.*$/, "") : DEFAULT_RELEASE_PAGE;
}

/** Install succeeded → restart at once, no confirmation dialog. */
async function installUpdateNow() {
  try {
    const result = await api("/api/update/install", { method: "POST" });
    const update = result.update || {};
    if (update.error) {
      showError(update.error);
      return;
    }
    quitting = true;
    quitForUpdate();
  } catch (error) {
    showError(error);
  }
}

/** One tray action: download in the background, then install as soon as verified. */
async function downloadThenInstall() {
  try {
    await api("/api/update/download", { method: "POST" });
    const started = Date.now();
    while (Date.now() - started < 30 * 60 * 1000) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const state = await refresh();
      const update = state?.update || {};
      if (update.error) {
        showError(update.error);
        return;
      }
      if (update.verified) {
        await installUpdateNow();
        return;
      }
      if (!update.downloading && Number(update.progress || 0) < 100) return;
    }
    showError("Загрузка не завершилась за 30 минут.");
  } catch (error) {
    showError(error);
  }
}

async function checkForUpdates() {
  try {
    const result = await api("/api/update/check", { method: "POST" });
    const update = result.update || {};
    if (update.error) {
      showError(update.error);
      return;
    }
    if (!update.available) {
      await dialog.showMessageBox({ type: "info", message: t("checkUpdate"), detail: t("latest") });
      return;
    }
    // Found: the bridge starts the background download itself; the tray shows %.
  } catch (error) {
    showError(error);
  } finally {
    await refresh();
  }
}

async function cancelUpdateDownload() {
  try {
    await api("/api/update/cancel", { method: "POST" });
  } catch (error) {
    showError(error);
  }
  await refresh();
}

function buildMenu(state) {
  const running = state?.state === "running";
  const status = statusOf(state);
  const username = state?.username;

  const template = [
    { label: status.text, enabled: false },
    { type: "separator" },
    { label: t("open"), click: createWindow },
    { label: t("browser"), click: () => shell.openExternal(`${BASE}/`) },
    {
      label: running ? t("stop") : t("start"),
      click: () => {
        const action = running ? "stop" : "start";
        api(`/api/bot/${action}`, { method: "POST" }).then(refresh).catch(showError);
      },
    },
    {
      label: t("restart"),
      click: () => api("/api/bot/restart", { method: "POST" }).then(refresh).catch(showError),
    },
    {
      label: t("reconnect"),
      click: async () => {
        try {
          await api("/api/bot/restart", { method: "POST" });
          await refresh();
        } catch (error) {
          showError(error);
        }
      },
    },
    {
      label: t("checkUpdate"),
      click: () => void checkForUpdates(),
    },
    ...(state?.update?.available || state?.update?.downloading
      ? [
          {
            label: state.update.downloading
              ? `${t("updateWord")} ${state.update.latest || ""} — ${state.update.progress || 0}%${state.update.paused ? ` · ${t("updatePaused")}` : ""}`
              : `${state.update.verified ? t("installUpdate") : t("downloadInstall")} ${state.update.latest || ""}`.trim(),
            enabled: !state.update.downloading && !state.update.installing,
            click: () => {
              if (state.update.verified) void installUpdateNow();
              else void downloadThenInstall();
            },
          },
          ...(state.update.downloading
            ? [{ label: t("cancelDownload"), click: () => void cancelUpdateDownload() }]
            : []),
          ...(state.update.error
            ? [
                { label: `${t("retry")} ${state.update.latest || ""}`.trim(), click: () => void downloadThenInstall() },
                { label: t("releasePage"), click: () => shell.openExternal(releaseUrl(state)) },
              ]
            : []),
        ]
      : []),
    ...(state?.update?.prevVersion
      ? [
          {
            label: `${t("rollback")} ${state.update.prevVersion}`,
            click: async () => {
              try {
                const answer = await dialog.showMessageBox({
                  type: "question",
                  message: `${t("rollback")} ${state.update.prevVersion}?`,
                  detail: "Текущая версия будет заменена предыдущей. Настройки не изменятся.",
                  buttons: ["Откатиться", "Отмена"],
                  defaultId: 1,
                  cancelId: 1,
                });
                if (answer.response === 0) {
                  await api("/api/update/rollback", { method: "POST" });
                  quitForUpdate();
                }
              } catch (error) {
                showError(error);
              }
            },
          },
        ]
      : []),
    { label: t("whatsNew"), click: () => void openChangelog(undefined, app.getVersion()) },
    { type: "separator" },
    { label: t("settings"), click: createWindow },
    {
      label: t("log"),
      click: () => {
        createWindow();
        win?.webContents.executeJavaScript('document.getElementById("log")?.scrollIntoView({block:"start"})').catch(() => undefined);
      },
    },
    {
      label: t("autostart"),
      type: "checkbox",
      checked: Boolean(state?.autostart),
      enabled: Boolean(state?.autostartSupported),
      click: (item) => api("/api/autostart", { method: "POST", body: JSON.stringify({ enabled: item.checked }) }).then(refresh).catch(showError),
    },
    {
      label: username ? `${t("bot")} @${username}` : t("bot"),
      enabled: Boolean(username),
      click: () => shell.openExternal(`https://t.me/${username}`),
    },
    { type: "separator" },
    { label: t("quit"), click: () => quit() },
  ];
  return Menu.buildFromTemplate(template);
}

function showError(error) {
  dialog.showErrorBox("OpenCode Bridge", String(error?.message || error));
}

async function refresh() {
  let state = null;
  try {
    state = await api("/api/state");
  } catch {
    state = null;
  }
  const status = statusOf(state);
  tray?.setImage(status.icon);
  const update = state?.update || {};
  let suffix = "";
  if (update.downloading) {
    suffix = ` · ${t("updateWord")} ${update.progress || 0}%${update.paused ? ` · ${t("updatePaused")}` : ""}`;
  } else if (update.error) {
    suffix = ` · ${t("updateError")}`;
  } else if (update.verified && update.available) {
    suffix = ` · ${t("installUpdate")} ${update.latest || ""}`.trimEnd();
  }
  tray?.setToolTip(`OpenCode Bridge ${state?.version || app.getVersion()} — ${status.text}${suffix}`);
  if (state) tray?.setContextMenu(buildMenu(state));
  lastState = state;
  if (state) maybeShowChangelog(state);
  return state;
}

function createTray() {
  tray = new Tray(ICONS.warn);
  tray.setToolTip("OpenCode Bridge — запуск…");
  tray.setContextMenu(buildMenu(lastState));
  tray.on("double-click", createWindow);
  setInterval(() => void refresh(), 2500);
  void refresh();
}

// -------------------------------------------------------------------- lifecycle

async function quit() {
  quitting = true;
  try {
    if (spawnedByUs) await api("/api/shutdown", { method: "POST" });
  } catch {
    /* ignore */
  }
  bridge?.kill();
  app.quit();
}

/** The updater helper owns the restart: do not shut the bridge down ourselves. */
function quitForUpdate() {
  quitting = true;
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => createWindow());
  app.whenReady().then(async () => {
    await ensureBridge();
    if (!process.argv.includes("--hidden")) createWindow();
    createTray();
  });
  app.on("window-all-closed", (event) => {
    // Keep running in the tray.
    event.preventDefault?.();
  });
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      void quit();
    }
  });
}
