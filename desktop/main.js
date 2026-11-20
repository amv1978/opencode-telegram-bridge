const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const PORT = Number(process.env.OCBRIDGE_PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;

let win = null;
let tray = null;
let bridge = null;
let spawnedByUs = false;
let lastState = null;
let quitting = false;

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

async function api(pathname, options) {
  const response = await fetch(BASE + pathname, {
    ...options,
    headers: { "content-type": "application/json", ...(options?.headers || {}) },
    signal: AbortSignal.timeout(4000),
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
    try {
      await api("/api/state");
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
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
  try {
    await api("/api/state");
    return;
  } catch {
    /* not running */
  }
  const exe = bridgePath();
  if (!fs.existsSync(exe)) {
    dialog.showErrorBox("OpenCode Bridge", `Не найден ocbridge.exe:\n${exe}`);
    return;
  }
  bridge = spawn(exe, ["--no-browser"], { cwd: path.dirname(exe), windowsHide: true, stdio: "ignore" });
  spawnedByUs = true;
  await waitForApi();
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
      label: state?.update?.available ? `${t("installUpdate")} ${state.update.latest}` : t("checkUpdate"),
      click: async () => {
        try {
          if (state?.update?.available) {
            const answer = await dialog.showMessageBox({
              type: "question",
              message: `Установить ${state.update.latest}?`,
              buttons: [t("installUpdate"), "Отмена"],
              defaultId: 0,
              cancelId: 1,
            });
            if (answer.response === 0) {
              await api("/api/update/install", { method: "POST" });
              quit();
            }
            return;
          }
          const result = await api("/api/update/check", { method: "POST" });
          await refresh();
          if (result.update?.available) {
            const answer = await dialog.showMessageBox({
              type: "question",
              message: `Доступна версия ${result.update.latest}`,
              detail: "Установить сейчас?",
              buttons: [t("installUpdate"), "Позже"],
              defaultId: 0,
              cancelId: 1,
            });
            if (answer.response === 0) {
              await api("/api/update/install", { method: "POST" });
              quit();
            }
          } else {
            await dialog.showMessageBox({ type: "info", message: t("checkUpdate"), detail: "Установлена последняя версия." });
          }
        } catch (error) {
          showError(error);
        }
      },
    },
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
  tray?.setToolTip(`OpenCode Bridge ${app.getVersion()} — ${status.text}`);
  if (state) tray?.setContextMenu(buildMenu(state));
  lastState = state;
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
