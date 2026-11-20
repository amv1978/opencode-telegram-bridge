export const PAGE = /* html */ `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenCode Telegram Bridge</title>
<style>
  :root { color-scheme: dark; --bg:#161616; --card:#242424; --line:#ffffff1f; --fg:#fafafa; --muted:#aeaeae; --acc:#49c970; --ok:#6bd586; --err:#f1484f; }
  html[data-scheme="light"][data-theme="opencode"] { color-scheme: light; --bg:#ffffff; --card:#fafafa; --line:#0000001a; --fg:#161616; --muted:#5c5c5c; --acc:#2eaf5a; --ok:#198b43; --err:#d92e3c; }
  html[data-scheme="dark"][data-theme="opencode"] { color-scheme: dark; --bg:#161616; --card:#242424; --line:#ffffff1f; --fg:#fafafa; --muted:#aeaeae; --acc:#49c970; --ok:#6bd586; --err:#f1484f; }
  html[data-scheme="light"][data-theme="matrix"] { color-scheme: light; --bg:#eef3ea; --card:#e7f4e8; --line:#20302226; --fg:#203022; --muted:#748476; --acc:#1cc24b; --ok:#1cc24b; --err:#ff4b4b; }
  html[data-scheme="dark"][data-theme="matrix"] { color-scheme: dark; --bg:#0a0e0a; --card:#101810; --line:#62ff9426; --fg:#62ff94; --muted:#8ca391; --acc:#2eff6a; --ok:#62ff94; --err:#ff4b4b; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 "Segoe UI", system-ui, sans-serif; overflow-x:hidden; }
  header { padding:20px 24px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; -webkit-app-region:drag; }
  header .pill, header a, header button { -webkit-app-region:no-drag; }
  h1 { font-size:17px; margin:0; font-weight:600; }
  .pill { padding:3px 10px; border-radius:999px; font-size:12px; background:color-mix(in srgb, var(--fg) 10%, var(--bg)); color:var(--muted); }
  .pill.running { background:rgba(61,220,132,.15); color:var(--ok); }
  .pill.error { background:rgba(255,107,107,.15); color:var(--err); }
  .pill.starting { background:rgba(76,141,255,.15); color:var(--acc); }
  .pill.version { font-variant-numeric:tabular-nums; }
  .pill[hidden] { display:none; }
  main { max-width:900px; margin:0 auto; padding:24px; display:grid; grid-template-columns:minmax(0, 1fr); gap:18px; width:100%; min-width:0; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; min-width:0; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 14px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px; }
  .grid > div { min-width:0; }
  label { display:block; font-size:12px; color:var(--muted); margin-bottom:5px; }
  input, select { width:100%; min-width:0; padding:9px 11px; background:color-mix(in srgb, var(--fg) 5%, var(--bg)); border:1px solid var(--line); border-radius:8px; color:var(--fg); font:inherit; }
  input:focus, select:focus { outline:none; border-color:var(--acc); }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:14px; }
  button { padding:9px 16px; border-radius:8px; border:1px solid var(--line); background:color-mix(in srgb, var(--fg) 8%, var(--bg)); color:var(--fg); font:inherit; cursor:pointer; }
  button:hover { border-color:#3a4252; }
  button.primary { background:var(--acc); border-color:var(--acc); color:#fff; font-weight:600; }
  button.danger { color:var(--err); }
  button:disabled { opacity:.45; cursor:default; }
  .kv { display:grid; grid-template-columns:minmax(110px, 170px) minmax(0, 1fr); gap:6px 12px; font-size:13px; }
  .kv span { min-width:0; overflow-wrap:anywhere; }
  .kv span:nth-child(odd) { color:var(--muted); }
  code { background:color-mix(in srgb, var(--fg) 5%, var(--bg)); padding:1px 6px; border-radius:5px; }
  pre { background:color-mix(in srgb, var(--fg) 5%, var(--bg)); border:1px solid var(--line); border-radius:8px; padding:12px; overflow:auto; max-height:280px; font-size:12px; margin:0; }
  details summary { cursor:pointer; color:var(--muted); font-size:12px; margin-top:12px; }
  .toast { position:fixed; right:20px; bottom:20px; background:color-mix(in srgb, var(--fg) 8%, var(--bg)); border:1px solid var(--line); padding:12px 16px; border-radius:10px; opacity:0; transition:.2s; max-width:420px; }
  .toast.show { opacity:1; }
  .toast.ok { border-color:rgba(61,220,132,.4); }
  .toast.err { border-color:rgba(255,107,107,.5); }
  .sessions { display:grid; gap:8px; }
  .session { padding:10px 12px; border:1px solid var(--line); border-radius:8px; font-size:13px; }
  .session small { color:var(--muted); display:block; }
  .hint { color:var(--muted); font-size:12px; margin-top:8px; }
  .divider { height:1px; background:var(--line); margin:16px 0; }
  @media (max-width:640px) { .grid { grid-template-columns:1fr; } .kv { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1 data-i18n="title">OpenCode · Telegram Bridge</h1>
  <span id="state" class="pill">…</span>
  <span id="who" class="pill"></span>
  <span id="ver" class="pill version" hidden></span>
</header>
<div id="updateBanner" class="card" hidden>
  <div class="row">
    <span id="updateText" style="flex:1"></span>
    <button id="updateDownload" class="primary" type="button" data-i18n="update.download">Скачать</button>
    <button id="updateInstall" type="button" data-i18n="update.install">Установить</button>
  </div>
  <progress id="updateProgress" max="100" value="0" style="width:100%;margin-top:10px" hidden></progress>
</div>
<main>
  <section class="card" id="onboarding" hidden>
    <h2 data-i18n="onb.title">Первый запуск</h2>
    <ol style="margin:0 0 14px 18px; padding:0; color:var(--muted); font-size:13px; line-height:1.9">
      <li data-i18n-html="onb.step1">Получите токен у <a href="https://t.me/BotFather" target="_blank" style="color:var(--acc)">@BotFather</a> (<code>/newbot</code>).</li>
      <li data-i18n="onb.step2">Вставьте токен ниже и нажмите «Сохранить и запустить».</li>
      <li data-i18n-html="onb.step3">Напишите боту <code>/start</code> — вы станете администратором.</li>
      <li data-i18n-html="onb.step4">Для тем: группа → «Темы» → бот админом → <code>/chatid</code> в группе.</li>
    </ol>
    <div class="grid">
      <div>
        <label data-i18n="cfg.token">Токен бота</label>
        <input id="onbToken" type="password" placeholder="123456:AA…" autocomplete="off" />
      </div>
    </div>
    <div class="row">
      <button class="primary" id="onbStart" type="button" data-i18n="onb.start">Сохранить и запустить</button>
      <span class="hint" data-i18n="onb.hint">Токен хранится только на этом компьютере.</span>
    </div>
  </section>
  <section class="card">
    <h2 data-i18n="status.title">Состояние</h2>
    <div class="kv">
      <span data-i18n="status.telegram">Telegram</span><span id="tg">—</span>
      <span data-i18n="status.opencode">OpenCode</span><span id="oc">—</span>
      <span data-i18n="status.discord">Discord</span><span id="dc">—</span>
      <span data-i18n="status.network">Сеть Telegram</span><span id="net">—</span>
      <span data-i18n="status.uptime">Аптайм</span><span id="uptime">—</span>
    </div>
    <div class="row">
      <button id="btnStart" class="primary" data-i18n="btn.start">Запустить</button>
      <button id="btnStop" class="danger" data-i18n="btn.stop">Остановить</button>
      <button id="btnRestart" data-i18n="btn.restart">Перезапустить</button>
      <label style="display:flex;gap:7px;align-items:center;margin:0;color:var(--fg)">
        <input type="checkbox" id="autostart" style="width:16px;height:16px" /> <span data-i18n="status.autostart">автозапуск</span>
      </label>
    </div>
    <div id="err" class="hint" style="color:var(--err)"></div>
  </section>

  <section class="card">
    <h2 data-i18n="cfg.title">Настройки</h2>
    <form id="form">
      <div class="grid" style="grid-template-columns:repeat(auto-fit, minmax(190px, 1fr))">
        <div>
          <label data-i18n="cfg.scheme">Цветовая схема</label>
          <select id="scheme">
            <option value="system" data-i18n="cfg.scheme.system">System</option>
            <option value="light" data-i18n="cfg.scheme.light">Light</option>
            <option value="dark" data-i18n="cfg.scheme.dark">Dark</option>
          </select>
          <div class="hint" data-i18n="cfg.scheme.hint">Следовать системе, светлая или тёмная</div>
        </div>
        <div>
          <label data-i18n="cfg.theme">Тема</label>
          <select id="theme">
            <option value="opencode">OpenCode</option>
            <option value="matrix">Matrix</option>
          </select>
          <div class="hint" data-i18n="cfg.theme.hint">Оформление интерфейса</div>
        </div>
        <div>
          <label for="lang" data-i18n="cfg.lang">Language</label>
          <select id="lang">
            <option value="system">System</option>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
          <div class="hint" data-i18n="cfg.lang.hint">Язык интерфейса</div>
        </div>
      </div>
      <div class="divider"></div>
      <div class="grid">
        <div>
          <label data-i18n="cfg.token">Токен бота</label>
          <input id="token" type="password" placeholder="оставьте пустым, чтобы не менять" autocomplete="off" />
        </div>
        <div>
          <label data-i18n="cfg.mode">Режим</label>
          <select id="mode">
            <option value="both">both — топики + личка</option>
            <option value="private">private — только личка</option>
            <option value="topics">topics — только топики</option>
          </select>
        </div>
        <div>
          <label data-i18n="cfg.topics">ID форум-группы (topicsChatId)</label>
          <input id="topicsChatId" type="number" placeholder="-100…" />
        </div>
        <div>
          <label data-i18n="cfg.dir">Папка по умолчанию</label>
          <input id="defaultDirectory" type="text" placeholder="D:\\Work\\Project" />
        </div>
        <div>
          <label data-i18n="cfg.throttle">Троттлинг правок, мс</label>
          <input id="editIntervalMs" type="number" min="500" max="10000" step="100" />
        </div>
        <div>
          <label data-i18n="cfg.tools">Инструменты в чате</label>
          <select id="showTools">
            <option value="compact">compact — одной строкой</option>
            <option value="off">off — скрыть</option>
            <option value="full">full — подробно</option>
          </select>
        </div>
        <div>
          <label data-i18n="cfg.format">Формат ответов</label>
          <select id="format">
            <option value="rich">rich — Telegram Markdown (таблицы, заголовки)</option>
            <option value="html">html — классический HTML</option>
          </select>
        </div>
        <div>
          <label style="display:flex;gap:8px;align-items:center;margin-top:24px;color:var(--fg)">
            <input type="checkbox" id="autoTopics" style="width:16px;height:16px" />
            <span data-i18n="cfg.autoTopics">Тема на каждую задачу из общего чата</span>
          </label>
        </div>
        <div>
          <label style="display:flex;gap:8px;align-items:center;margin-top:24px;color:var(--fg)">
            <input type="checkbox" id="showSubagents" style="width:16px;height:16px" />
            <span data-i18n="cfg.showSubagents">Показывать субагентов</span>
          </label>
        </div>
        <div>
          <label data-i18n="cfg.media.relay">Пересылка файлов</label>
          <select id="mediaRelay">
            <option value="all">all — пользователи + агент</option>
            <option value="user">user — только пользователи</option>
            <option value="none">none — выключено</option>
          </select>
        </div>
        <div>
          <label data-i18n="cfg.media.photo">Фото до, МБ</label>
          <input id="mediaPhotoMb" type="number" min="1" max="10" step="1" />
        </div>
        <div>
          <label style="display:flex;gap:8px;align-items:center;margin-top:24px;color:var(--fg)">
            <input type="checkbox" id="updateCheck" style="width:16px;height:16px" />
            <span data-i18n="cfg.update.check">Проверять обновления при запуске</span>
          </label>
        </div>
        <div>
          <label data-i18n="cfg.update.hours">Интервал проверки, ч</label>
          <input id="updateHours" type="number" min="1" max="168" step="1" />
        </div>
        <div>
          <label style="display:flex;gap:8px;align-items:center;margin-top:24px;color:var(--fg)">
            <input type="checkbox" id="updateAuto" style="width:16px;height:16px" />
            <span data-i18n="cfg.update.auto">Скачивать автоматически</span>
          </label>
        </div>
        <div>
          <label>&nbsp;</label>
          <button id="updateCheckBtn" type="button" data-i18n="update.check">Проверить обновления</button>
        </div>
      </div>
      <div class="divider"></div>
      <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 14px">Discord</h3>
      <div class="grid" style="grid-template-columns:repeat(auto-fit, minmax(190px, 1fr))">
        <div>
          <label style="display:flex;gap:8px;align-items:center;margin-top:24px;color:var(--fg)">
            <input type="checkbox" id="dcEnabled" style="width:16px;height:16px" />
            <span data-i18n="cfg.discord.enabled">Включить Discord</span>
          </label>
        </div>
        <div>
          <label data-i18n="cfg.discord.token">Токен бота Discord</label>
          <input id="dcToken" type="password" placeholder="оставьте пустым, чтобы не менять" autocomplete="off" />
        </div>
        <div>
          <label data-i18n="cfg.discord.guilds">ID серверов (через запятую)</label>
          <input id="dcGuilds" type="text" placeholder="123456789012345678, …" />
        </div>
        <div>
          <label data-i18n="cfg.discord.users">ID пользователей (через запятую)</label>
          <input id="dcUsers" type="text" placeholder="123456789012345678" />
        </div>
      </div>
      <div class="hint" data-i18n="cfg.discord.hint">Публичные треды, одна сессия на тред. Пустой список серверов или пользователей = доступа нет. MESSAGE_CONTENT включается в Discord Developer Portal.</div>
      <details>
        <summary data-i18n="cfg.network">Сеть (прокси / IP)</summary>
        <div class="grid" style="margin-top:10px">
          <div>
            <label data-i18n="cfg.proxy">Прокси</label>
            <input id="proxy" type="text" placeholder="socks5://127.0.0.1:1080" />
          </div>
          <div>
            <label data-i18n="cfg.apiIp">IP Bot API</label>
            <input id="apiIp" type="text" placeholder="149.154.167.220" />
          </div>
        </div>
        <div class="hint" data-i18n="cfg.network.hint">Пусто = автоопределение. Если api.telegram.org недоступен, приложение само найдёт рабочий IP.</div>
      </details>
      <div class="row">
        <button class="primary" type="submit" data-i18n="btn.save">Сохранить</button>
        <span class="hint" id="cfgPath"></span>
      </div>
    </form>
  </section>

  <section class="card">
    <h2 data-i18n="access.title">Доступ</h2>
    <div id="users" class="hint">Пользователи ещё не подключены. Напишите боту <code>/start</code> — первый станет администратором.</div>
  </section>

  <section class="card">
    <h2 data-i18n="sessions.title">Последние сессии OpenCode</h2>
    <div id="sessions" class="sessions"><div class="hint">—</div></div>
  </section>

  <section class="card">
    <h2 data-i18n="log.title">Журнал</h2>
    <pre id="log">…</pre>
  </section>
</main>
<div id="toast" class="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let lastState = null;

const I18N = {
  ru: {
    "title": "OpenCode · Telegram Bridge",
    "onb.title": "Первый запуск",
    "onb.step1": 'Получите токен у <a href="https://t.me/BotFather" target="_blank" style="color:var(--acc)">@BotFather</a> (<code>/newbot</code>).',
    "onb.step2": "Вставьте токен ниже и нажмите «Сохранить и запустить».",
    "onb.step3": "Напишите боту <code>/start</code> — вы станете администратором.",
    "onb.step4": "Для тем: группа → «Темы» → бот админом → <code>/chatid</code> в группе.",
    "onb.start": "Сохранить и запустить",
    "onb.hint": "Токен хранится только на этом компьютере.",
    "status.title": "Состояние",
    "status.telegram": "Telegram",
    "status.opencode": "OpenCode",
    "status.discord": "Discord",
    "status.off": "выключен",
    "status.network": "Сеть Telegram",
    "status.uptime": "Аптайм",
    "status.autostart": "автозапуск",
    "status.token": "токен",
    "status.notConfigured": "не настроен",
    "status.seconds": "с",
    "state.stopped": "остановлен",
    "state.starting": "запускается",
    "state.running": "работает",
    "state.error": "ошибка",
    "btn.start": "Запустить",
    "btn.stop": "Остановить",
    "btn.restart": "Перезапустить",
    "btn.save": "Сохранить",
    "cfg.title": "Настройки",
    "cfg.scheme": "Цветовая схема",
    "cfg.scheme.system": "Системная",
    "cfg.scheme.light": "Светлая",
    "cfg.scheme.dark": "Тёмная",
    "cfg.scheme.hint": "Следовать системе, светлая или тёмная",
    "cfg.theme": "Тема",
    "cfg.theme.hint": "Оформление интерфейса",
    "cfg.lang": "Язык",
    "cfg.lang.hint": "Язык интерфейса",
    "cfg.token": "Токен бота",
    "cfg.mode": "Режим",
    "cfg.topics": "ID форум-группы (topicsChatId)",
    "cfg.dir": "Папка по умолчанию",
    "cfg.throttle": "Троттлинг правок, мс",
    "cfg.tools": "Инструменты в чате",
    "cfg.format": "Формат ответов",
    "cfg.autoTopics": "Тема на каждую задачу из общего чата",
    "cfg.showSubagents": "Показывать субагентов",
    "cfg.media.relay": "Пересылка файлов",
    "cfg.media.photo": "Фото до, МБ",
    "cfg.update.check": "Проверять обновления при запуске",
    "cfg.update.hours": "Интервал проверки, ч",
    "cfg.update.auto": "Скачивать автоматически",
    "update.check": "Проверить обновления",
    "update.download": "Скачать",
    "update.install": "Установить",
    "update.available": "Доступна версия",
    "cfg.discord.enabled": "Включить Discord",
    "cfg.discord.token": "Токен бота Discord",
    "cfg.discord.guilds": "ID серверов (через запятую)",
    "cfg.discord.users": "ID пользователей (через запятую)",
    "cfg.discord.hint": "Публичные треды, одна сессия на тред. Пустой список серверов или пользователей = доступа нет. MESSAGE_CONTENT включается в Discord Developer Portal.",
    "cfg.network": "Сеть (прокси / IP)",
    "cfg.proxy": "Прокси",
    "cfg.apiIp": "IP Bot API",
    "cfg.network.hint": "Пусто = автоопределение. Если api.telegram.org недоступен, приложение само найдёт рабочий IP.",
    "access.title": "Доступ",
    "access.empty": "Пользователи ещё не подключены. Напишите боту <code>/start</code> — первый станет администратором.",
    "sessions.title": "Последние сессии OpenCode",
    "sessions.empty": "—",
    "log.title": "Журнал",
    "toast.saved": "Сохранено",
    "toast.started": "Запущено",
    "toast.stopped": "Остановлено",
    "toast.restarted": "Перезапущено",
    "toast.on": "Готово",
    "toast.token": "Вставьте токен",
    "toast.done": "Готово — напишите боту /start",
    "err.offline": "нет связи с приложением"
  },
  en: {
    "title": "OpenCode · Telegram Bridge",
    "onb.title": "First launch",
    "onb.step1": 'Get a token from <a href="https://t.me/BotFather" target="_blank" style="color:var(--acc)">@BotFather</a> (<code>/newbot</code>).',
    "onb.step2": "Paste the token below and click “Save and start”.",
    "onb.step3": "Send <code>/start</code> to the bot — you become the administrator.",
    "onb.step4": "For topics: group → “Topics” → bot as admin → <code>/chatid</code> in the group.",
    "onb.start": "Save and start",
    "onb.hint": "The token is stored only on this computer.",
    "status.title": "Status",
    "status.telegram": "Telegram",
    "status.opencode": "OpenCode",
    "status.discord": "Discord",
    "status.off": "off",
    "status.network": "Telegram network",
    "status.uptime": "Uptime",
    "status.autostart": "autostart",
    "status.token": "token",
    "status.notConfigured": "not configured",
    "status.seconds": "s",
    "state.stopped": "stopped",
    "state.starting": "starting",
    "state.running": "running",
    "state.error": "error",
    "btn.start": "Start",
    "btn.stop": "Stop",
    "btn.restart": "Restart",
    "btn.save": "Save",
    "cfg.title": "Settings",
    "cfg.scheme": "Color scheme",
    "cfg.scheme.system": "System",
    "cfg.scheme.light": "Light",
    "cfg.scheme.dark": "Dark",
    "cfg.scheme.hint": "Follow system, light or dark",
    "cfg.theme": "Theme",
    "cfg.theme.hint": "Interface appearance",
    "cfg.lang": "Language",
    "cfg.lang.hint": "Interface language",
    "cfg.token": "Bot token",
    "cfg.mode": "Mode",
    "cfg.topics": "Forum group ID (topicsChatId)",
    "cfg.dir": "Default directory",
    "cfg.throttle": "Edit throttle, ms",
    "cfg.tools": "Tools in chat",
    "cfg.format": "Reply format",
    "cfg.autoTopics": "Topic per task from the general chat",
    "cfg.showSubagents": "Show subagents",
    "cfg.media.relay": "File relay",
    "cfg.media.photo": "Photo max, MB",
    "cfg.update.check": "Check for updates on start",
    "cfg.update.hours": "Check interval, hours",
    "cfg.update.auto": "Download automatically",
    "update.check": "Check for updates",
    "update.download": "Download",
    "update.install": "Install",
    "update.available": "Version available",
    "cfg.discord.enabled": "Enable Discord",
    "cfg.discord.token": "Discord bot token",
    "cfg.discord.guilds": "Server IDs (comma separated)",
    "cfg.discord.users": "User IDs (comma separated)",
    "cfg.discord.hint": "Public threads, one session per thread. Empty server or user list = no access. MESSAGE_CONTENT must be enabled in the Discord Developer Portal.",
    "cfg.network": "Network (proxy / IP)",
    "cfg.proxy": "Proxy",
    "cfg.apiIp": "IP Bot API",
    "cfg.network.hint": "Empty = auto-detect. If api.telegram.org is unreachable, the app finds a working IP itself.",
    "access.title": "Access",
    "access.empty": "No users connected yet. Send <code>/start</code> to the bot — the first one becomes administrator.",
    "sessions.title": "Recent OpenCode sessions",
    "sessions.empty": "—",
    "log.title": "Log",
    "toast.saved": "Saved",
    "toast.started": "Started",
    "toast.stopped": "Stopped",
    "toast.restarted": "Restarted",
    "toast.on": "Done",
    "toast.token": "Paste a token",
    "toast.done": "Done — send /start to the bot",
    "err.offline": "no connection to the app"
  }
};

let currentLang = "ru";

function resolveLang(value) {
  const v = value || "system";
  if (v === "ru" || v === "en") return v;
  return (navigator.language || "en").toLowerCase().startsWith("ru") ? "ru" : "en";
}

function t(key, fallback) {
  const dict = I18N[currentLang] || I18N.en;
  if (dict && dict[key] != null) return dict[key];
  if (I18N.en[key] != null) return I18N.en[key];
  return fallback != null ? fallback : key;
}

function applyI18n() {
  currentLang = resolveLang($("lang") ? $("lang").value : localStorage.getItem("ocbridge.lang"));
  document.documentElement.lang = currentLang;
  document.title = t("title");
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.getAttribute("data-i18n")); });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => { el.innerHTML = t(el.getAttribute("data-i18n-html")); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.getAttribute("data-i18n-title")); });
}

function resolvedScheme(setting) {
  if (setting === "light" || setting === "dark") return setting;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme() {
  const theme = $("theme")?.value || localStorage.getItem("ocbridge.theme") || "opencode";
  const scheme = $("scheme")?.value || localStorage.getItem("ocbridge.scheme") || "system";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.scheme = resolvedScheme(scheme);
  localStorage.setItem("ocbridge.theme", theme);
  localStorage.setItem("ocbridge.scheme", scheme);

  const background = rgbToHex(getComputedStyle(document.body).backgroundColor);
  window.ocbridgeDesktop?.setTheme({ background, dark: document.documentElement.dataset.scheme === "dark" });
}

function rgbToHex(color) {
  const match = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(color || "");
  if (!match) return "#161616";
  const hex = (n) => Number(n).toString(16).padStart(2, "0");
  return "#" + hex(match[1]) + hex(match[2]) + hex(match[3]);
}

applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

async function saveTheme() {
  applyTheme();
  try {
    await api("/api/config", { method: "POST", body: JSON.stringify({ ui: { theme: $("theme").value, scheme: $("scheme").value } }) });
  } catch (e) { toast(e.message, "err"); }
}

async function saveLang() {
  const value = $("lang").value;
  localStorage.setItem("ocbridge.lang", value);
  if (lastState && lastState.config) lastState.config.ui = Object.assign({}, lastState.config.ui, { lang: value });
  applyI18n();
  if (lastState) fill(lastState);
  try {
    await api("/api/config", { method: "POST", body: JSON.stringify({ ui: { lang: value } }) });
  } catch (e) { toast(e.message, "err"); }
}

function toast(message, kind) {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast show " + (kind || "");
  setTimeout(() => { el.className = "toast"; }, 4000);
}

async function api(path, options) {
  const response = await fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, options));
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { error: text }; }
  if (!response.ok) throw new Error(json.error || response.statusText);
  return json;
}

function fill(s) {
  lastState = s;
  $("state").textContent = t("state." + s.state, s.state);
  $("state").className = "pill " + s.state;
  $("who").textContent = s.username ? "@" + s.username : "";
  const ver = $("ver");
  if (s.version) { ver.textContent = "v" + s.version; ver.hidden = false; }
  else { ver.textContent = ""; ver.hidden = true; }
  $("tg").textContent = s.configured ? t("status.token") + " " + s.config.tokenTail : t("status.notConfigured");
  $("oc").textContent = s.ocVersion ? "v" + s.ocVersion + " · " + s.ocUrl : "—";
  const dc = s.discord || {};
  $("dc").textContent = dc.enabled
    ? (dc.state || "off") + (dc.username ? " · @" + dc.username : "") + (dc.tokenTail ? " · " + dc.tokenTail : "")
    : t("status.off");
  $("net").textContent = s.telegramMode || "—";
  $("uptime").textContent = s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) + " " + t("status.seconds") : "—";
  $("err").textContent = s.error || "";
  $("cfgPath").textContent = s.configPath;
  $("btnStart").disabled = s.state === "running" || s.state === "starting";
  $("btnStop").disabled = s.state === "stopped";

  const f = $("form");
  if (document.activeElement !== f.querySelector("input,select")) {
    $("mode").value = s.config.mode;
    $("topicsChatId").value = s.config.topicsChatId || "";
    $("defaultDirectory").value = s.config.defaultDirectory || "";
    $("editIntervalMs").value = s.config.editIntervalMs;
    $("showTools").value = s.config.showTools;
    $("format").value = s.config.format;
    if (s.config.ui) {
      $("scheme").value = s.config.ui.scheme;
      $("theme").value = s.config.ui.theme;
      applyTheme();
    }
    $("lang").value = (s.config.ui && s.config.ui.lang) || localStorage.getItem("ocbridge.lang") || "system";
    applyI18n();
    $("autoTopics").checked = s.config.autoTopics;
    $("showSubagents").checked = s.config.showSubagents;
    $("mediaRelay").value = s.config.media.relay;
    $("mediaPhotoMb").value = s.config.media.maxPhotoMb;
    if (s.config.update) {
      $("updateCheck").checked = s.config.update.checkOnStart;
      $("updateHours").value = s.config.update.intervalHours;
      $("updateAuto").checked = s.config.update.autoDownload;
    }
    $("proxy").value = s.config.proxy || "";
    $("apiIp").value = s.config.apiIp || "";
    const dcfg = s.discord || {};
    $("dcEnabled").checked = Boolean(dcfg.enabled);
    $("dcGuilds").value = (dcfg.allowedGuilds || []).join(", ");
    $("dcUsers").value = (dcfg.allowedUsers || []).join(", ");
  }
  $("autostart").checked = s.autostart;
  $("autostart").disabled = !s.autostartSupported;
  $("onboarding").hidden = s.configured;

  const u = s.update || {};
  const banner = $("updateBanner");
  banner.hidden = !u.available && !u.downloading;
  if (!banner.hidden) {
    $("updateText").textContent = t("update.available") + " " + (u.latest || "") + (u.notes ? " — " + String(u.notes).split("\n")[0].slice(0, 120) : "");
    $("updateDownload").disabled = Boolean(u.downloading);
    $("updateInstall").disabled = !(u.progress >= 100);
    $("updateProgress").hidden = !u.downloading;
    $("updateProgress").value = u.progress || 0;
  }

  $("users").innerHTML = s.config.allowedUsers.length
    ? s.config.allowedUsers.map((u) => "<div><code>" + u.id + "</code> " + (u.name || "") + " · " + (u.role || "user") + "</div>").join("")
    : t("access.empty");

  $("sessions").innerHTML = s.sessions.length
    ? s.sessions.map((x) => '<div class="session"><b>' + escapeHtml(x.title || x.id) + "</b><small>" + escapeHtml(x.directory || "") + "</small></div>").join("")
    : '<div class="hint">' + t("sessions.empty") + "</div>";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function refresh() {
  try {
    const s = await api("/api/state");
    if (!s.sessions || !s.sessions.length) s.sessions = [];
    fill(s);
    if (!s.sessions.length) {
      const extra = await api("/api/sessions").catch(() => ({ sessions: [] }));
      s.sessions = extra.sessions;
      fill(s);
    }
  } catch (e) {
    $("state").textContent = t("err.offline");
    $("state").className = "pill error";
  }
}

async function refreshLog() {
  try {
    const r = await api("/api/log?lines=120");
    const el = $("log");
    el.textContent = r.log || "—";
    el.scrollTop = el.scrollHeight;
  } catch (e) {}
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    telegram: { token: $("token").value, proxy: $("proxy").value, apiIp: $("apiIp").value },
    mode: $("mode").value,
    topicsChatId: $("topicsChatId").value,
    defaultDirectory: $("defaultDirectory").value,
    autoTopics: $("autoTopics").checked,
    showSubagents: $("showSubagents").checked,
    media: { relay: $("mediaRelay").value, maxPhotoMb: Number($("mediaPhotoMb").value) },
    update: {
      checkOnStart: $("updateCheck").checked,
      intervalHours: Number($("updateHours").value),
      autoDownload: $("updateAuto").checked,
    },
    stream: { editIntervalMs: Number($("editIntervalMs").value), showTools: $("showTools").value, format: $("format").value },
    discord: {
      enabled: $("dcEnabled").checked,
      token: $("dcToken").value,
      allowedGuilds: $("dcGuilds").value,
      allowedUsers: $("dcUsers").value,
    },
  };
  try {
    await api("/api/config", { method: "POST", body: JSON.stringify(payload) });
    $("token").value = "";
    $("dcToken").value = "";
    toast(t("toast.saved"), "ok");
    await refresh();
  } catch (e) {
    toast(e.message, "err");
  }
});

$("updateCheckBtn").addEventListener("click", async () => {
  try { await api("/api/update/check", { method: "POST" }); toast(t("toast.saved"), "ok"); }
  catch (e) { toast(e.message, "err"); }
  refresh();
});
$("updateDownload").addEventListener("click", async () => {
  try { await api("/api/update/download", { method: "POST" }); toast(t("toast.started"), "ok"); }
  catch (e) { toast(e.message, "err"); }
  refresh();
});
$("updateInstall").addEventListener("click", async () => {
  try { await api("/api/update/install", { method: "POST" }); toast(t("toast.started"), "ok"); }
  catch (e) { toast(e.message, "err"); }
  refresh();
});

$("btnStart").addEventListener("click", async () => {  try { await api("/api/bot/start", { method: "POST" }); toast(t("toast.started"), "ok"); }
  catch (e) { toast(e.message, "err"); }
  refresh();
});
$("btnStop").addEventListener("click", async () => {
  try { await api("/api/bot/stop", { method: "POST" }); toast(t("toast.stopped"), "ok"); }
  catch (e) { toast(e.message, "err"); }
  refresh();
});
$("btnRestart").addEventListener("click", async () => {
  try { await api("/api/bot/restart", { method: "POST" }); toast(t("toast.restarted"), "ok"); }
  catch (e) { toast(e.message, "err"); }
  refresh();
});
$("onbStart").addEventListener("click", async () => {
  const token = $("onbToken").value.trim();
  if (!token) { toast(t("toast.token"), "err"); return; }
  try {
    await api("/api/config", { method: "POST", body: JSON.stringify({ telegram: { token } }) });
    await api("/api/bot/start", { method: "POST" });
    toast(t("toast.done"), "ok");
    await refresh();
  } catch (e) { toast(e.message, "err"); }
});

$("scheme").addEventListener("change", saveTheme);
$("theme").addEventListener("change", saveTheme);
$("lang").addEventListener("change", saveLang);

$("autostart").addEventListener("change", async (event) => {  try { await api("/api/autostart", { method: "POST", body: JSON.stringify({ enabled: event.target.checked }) }); toast(t("toast.on"), "ok"); }
  catch (e) { toast(e.message, "err"); event.target.checked = !event.target.checked; }
});

const storedLang = localStorage.getItem("ocbridge.lang");
if (storedLang === "system" || storedLang === "ru" || storedLang === "en") $("lang").value = storedLang;
applyI18n();

refresh();
refreshLog();
setInterval(refresh, 3000);
setInterval(refreshLog, 5000);
</script>
</body>
</html>`;
