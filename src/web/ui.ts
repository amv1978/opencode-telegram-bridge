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
  [hidden] { display:none !important; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 "Segoe UI", system-ui, sans-serif; overflow-x:hidden; }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; -webkit-app-region:drag; min-height:56px; }
  header .pill, header a, header button { -webkit-app-region:no-drag; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  .pill { padding:3px 10px; border-radius:999px; font-size:12px; background:color-mix(in srgb, var(--fg) 10%, var(--bg)); color:var(--muted); }
  .pill.running { background:rgba(61,220,132,.15); color:var(--ok); }
  .pill.error { background:rgba(255,107,107,.15); color:var(--err); }
  .pill.starting { background:rgba(76,141,255,.15); color:var(--acc); }
  .pill.version { font-variant-numeric:tabular-nums; }
  .pill[hidden] { display:none; }
  .shell { display:grid; grid-template-columns:220px minmax(0, 1fr); min-height:calc(100vh - 56px); }
  aside { border-right:1px solid var(--line); padding:14px 10px; display:flex; flex-direction:column; gap:4px; }
  .nav-toggle { display:none; margin-bottom:8px; padding:8px; }
  .nav-item { display:flex; align-items:center; gap:10px; width:100%; padding:9px 10px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--muted); text-align:left; }
  .nav-item:hover { background:color-mix(in srgb, var(--fg) 6%, var(--bg)); color:var(--fg); }
  .nav-item.active { background:color-mix(in srgb, var(--acc) 14%, var(--bg)); color:var(--fg); border-color:color-mix(in srgb, var(--acc) 35%, transparent); }
  .nav-item .ico { width:22px; text-align:center; font-size:15px; flex:none; }
  .nav-item .lbl { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  main { padding:22px 24px 40px; min-width:0; max-width:980px; width:100%; }
  .page { display:none; }
  .page.active { display:grid; gap:18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; min-width:0; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 14px; }
  .card h3 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; }
  .grid > div { min-width:0; }
  label { display:block; font-size:12px; color:var(--muted); margin-bottom:5px; }
  input, select { width:100%; min-width:0; padding:9px 11px; background:color-mix(in srgb, var(--fg) 5%, var(--bg)); border:1px solid var(--line); border-radius:8px; color:var(--fg); font:inherit; }
  input:focus, select:focus { outline:none; border-color:var(--acc); }
  .check { display:flex; gap:8px; align-items:center; margin:0; color:var(--fg); cursor:pointer; }
  .check input { width:16px; height:16px; flex:none; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:14px; }
  button, a.btn { display:inline-flex; align-items:center; gap:6px; padding:9px 16px; border-radius:8px; border:1px solid var(--line); background:color-mix(in srgb, var(--fg) 8%, var(--bg)); color:var(--fg); font:inherit; cursor:pointer; text-decoration:none; }
  button:hover, a.btn:hover { border-color:#3a4252; }
  button.primary { background:var(--acc); border-color:var(--acc); color:#fff; font-weight:600; }
  button.danger { color:var(--err); }
  button.small { padding:4px 10px; font-size:12px; }
  button:disabled { opacity:.45; cursor:default; }
  .kv { display:grid; grid-template-columns:minmax(110px, 170px) minmax(0, 1fr); gap:6px 12px; font-size:13px; }
  .kv span { min-width:0; overflow-wrap:anywhere; }
  .kv span:nth-child(odd) { color:var(--muted); }
  code { background:color-mix(in srgb, var(--fg) 5%, var(--bg)); padding:1px 6px; border-radius:5px; }
  pre { background:color-mix(in srgb, var(--fg) 5%, var(--bg)); border:1px solid var(--line); border-radius:8px; padding:12px; overflow:auto; height:52vh; min-height:240px; font-size:12px; margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
  details summary { cursor:pointer; color:var(--muted); font-size:12px; }
  .toast { position:fixed; right:20px; bottom:20px; background:color-mix(in srgb, var(--fg) 8%, var(--bg)); border:1px solid var(--line); padding:12px 16px; border-radius:10px; opacity:0; transition:.2s; max-width:420px; z-index:50; }
  .toast.show { opacity:1; }
  .toast.ok { border-color:rgba(61,220,132,.4); }
  .toast.err { border-color:rgba(255,107,107,.5); }
  .sessions { display:grid; gap:8px; }
  .session { display:flex; gap:10px; align-items:center; padding:10px 12px; border:1px solid var(--line); border-radius:8px; font-size:13px; }
  .session-main { flex:1; min-width:0; }
  .session b { display:block; overflow-wrap:anywhere; }
  .session small { color:var(--muted); display:block; }
  .badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; background:color-mix(in srgb, var(--fg) 8%, var(--bg)); color:var(--muted); margin-left:6px; }
  .badge.active { color:var(--ok); background:rgba(61,220,132,.15); }
  .hint { color:var(--muted); font-size:12px; margin-top:8px; }
  .divider { height:1px; background:var(--line); margin:16px 0; }
  .log-controls { display:flex; flex-wrap:wrap; gap:10px; align-items:end; margin-bottom:12px; }
  .log-controls > div { min-width:120px; }
  .log-controls .grow { flex:1; min-width:180px; }
  #updateBanner { margin:0; }
  @media (max-width:900px) {
    .shell { grid-template-columns:56px minmax(0, 1fr); }
    aside { padding:8px 5px; }
    .nav-toggle { display:block; }
    .nav-item { justify-content:center; padding:10px 4px; }
    .nav-item .lbl { display:none; }
    body.nav-open .shell { grid-template-columns:224px minmax(0, 1fr); }
    body.nav-open .nav-item { justify-content:flex-start; padding:9px 10px; }
    body.nav-open .nav-item .lbl { display:inline; }
    main { padding:16px 14px 32px; }
  }
  @media (max-width:640px) { .kv { grid-template-columns:1fr; } .grid { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1 data-i18n="title">OpenCode · Telegram Bridge</h1>
  <span id="state" class="pill">…</span>
  <span id="who" class="pill"></span>
  <span id="ver" class="pill version" hidden></span>
</header>
<div id="apiError" class="card" hidden style="margin:16px 20px 0;border-color:var(--err)">
  <b data-i18n="err.apiTitle">Панель не может получить состояние</b>
  <div id="apiErrorText" class="hint" style="color:var(--err)"></div>
</div>
<div class="shell">
  <aside id="nav">
    <button id="navToggle" class="nav-toggle" type="button" aria-label="Menu">☰</button>
    <button class="nav-item active" type="button" data-page="status"><span class="ico">◉</span><span class="lbl" data-i18n="nav.status">Статус</span></button>
    <button class="nav-item" type="button" data-page="settings"><span class="ico">⚙</span><span class="lbl" data-i18n="nav.settings">Настройки</span></button>
    <button class="nav-item" type="button" data-page="telegram"><span class="ico">✈</span><span class="lbl" data-i18n="nav.telegram">Telegram</span></button>
    <button class="nav-item" type="button" data-page="discord"><span class="ico">💬</span><span class="lbl" data-i18n="nav.discord">Discord</span></button>
    <button class="nav-item" type="button" data-page="updates"><span class="ico">⭳</span><span class="lbl" data-i18n="nav.updates">Обновления</span></button>
    <button class="nav-item" type="button" data-page="log"><span class="ico">▤</span><span class="lbl" data-i18n="nav.log">Журнал</span></button>
  </aside>
  <main>
    <section class="page active" id="page-status">
      <section class="card" id="onboarding" hidden>
        <h2 data-i18n="onb.title">Первый запуск</h2>
        <ol style="margin:0 0 14px 18px; padding:0; color:var(--muted); font-size:13px; line-height:1.9">
          <li data-i18n-html="onb.step1">Получите токен у <a href="https://t.me/BotFather" target="_blank" style="color:var(--acc)">@BotFather</a> (<code>/newbot</code>).</li>
          <li data-i18n="onb.step2">Вставьте токен на вкладке Telegram и нажмите «Сохранить и запустить».</li>
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
          <label class="check">
            <input type="checkbox" id="autostart" /> <span data-i18n="status.autostart">автозапуск</span>
          </label>
        </div>
        <div id="warn" class="hint" style="color:#d69e2e"></div>
        <div id="err" class="hint" style="color:var(--err)"></div>
      </section>

      <section class="card">
        <h2 data-i18n="sessions.title">Текущие сессии</h2>
        <div class="row" style="margin-top:0">
          <button id="sessionsRefresh" type="button" data-i18n="sessions.refresh">Обновить</button>
          <button id="sessionsShowHidden" class="small" type="button" hidden data-i18n="sessions.showHidden">Показать скрытые</button>
          <span id="sessionsHidden" class="hint" style="margin:0" hidden></span>
        </div>
        <div id="sessions" class="sessions" style="margin-top:12px"><div class="hint">—</div></div>
        <div class="hint" data-i18n="sessions.hint">«Скрыть» убирает сессию только из панели — в OpenCode она остаётся.</div>
      </section>
    </section>

    <section class="page" id="page-settings">
      <section class="card">
        <h2 data-i18n="cfg.title">Настройки</h2>
        <form id="form" onsubmit="return false">
          <div class="grid">
            <div>
              <label data-i18n="cfg.scheme">Цветовая схема</label>
              <select id="scheme">
                <option value="system" data-i18n="cfg.scheme.system">Системная</option>
                <option value="light" data-i18n="cfg.scheme.light">Светлая</option>
                <option value="dark" data-i18n="cfg.scheme.dark">Тёмная</option>
              </select>
            </div>
            <div>
              <label data-i18n="cfg.theme">Тема</label>
              <select id="theme">
                <option value="opencode">OpenCode</option>
                <option value="matrix">Matrix</option>
              </select>
            </div>
            <div>
              <label for="lang" data-i18n="cfg.lang">Язык</label>
              <select id="lang">
                <option value="system">System</option>
                <option value="ru">Русский</option>
                <option value="en">English</option>
              </select>
            </div>
          </div>
          <div class="divider"></div>
          <div class="grid">
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
                <option value="compact" data-i18n="cfg.tools.compact">compact — одной строкой</option>
                <option value="off" data-i18n="cfg.tools.off">off — скрыть</option>
                <option value="full" data-i18n="cfg.tools.full">full — подробно</option>
              </select>
            </div>
            <div>
              <label data-i18n="cfg.format">Формат ответов</label>
              <select id="format">
                <option value="rich" data-i18n="cfg.format.rich">rich — Telegram Markdown</option>
                <option value="html" data-i18n="cfg.format.html">html — классический HTML</option>
              </select>
            </div>
            <div>
              <label data-i18n="cfg.media.relay">Пересылка файлов</label>
              <select id="mediaRelay">
                <option value="all" data-i18n="cfg.media.all">all — пользователи + агент</option>
                <option value="user" data-i18n="cfg.media.user">user — только пользователи</option>
                <option value="none" data-i18n="cfg.media.none">none — выключено</option>
              </select>
            </div>
            <div>
              <label data-i18n="cfg.media.photo">Фото до, МБ</label>
              <input id="mediaPhotoMb" type="number" min="1" max="10" step="1" />
            </div>
            <div>
              <label class="check" style="margin-top:22px">
                <input type="checkbox" id="autoTopics" />
                <span data-i18n="cfg.autoTopics">Тема на каждую задачу из общего чата</span>
              </label>
            </div>
            <div>
              <label class="check" style="margin-top:22px">
                <input type="checkbox" id="showSubagents" />
                <span data-i18n="cfg.showSubagents">Показывать субагентов</span>
              </label>
            </div>
          </div>
          <div class="row">
            <button class="primary" type="submit" data-i18n="btn.save">Сохранить</button>
            <span class="hint" id="cfgPath" style="margin:0"></span>
          </div>
        </form>
      </section>
    </section>

    <section class="page" id="page-telegram">
      <section class="card">
        <h2 data-i18n="tg.title">Telegram</h2>
        <form id="formTelegram" onsubmit="return false">
          <label class="check" style="margin-bottom:14px">
            <input type="checkbox" id="tgEnabled" />
            <span data-i18n="cfg.telegram.enabled">Включить Telegram</span>
          </label>
          <div class="grid">
            <div>
              <label data-i18n="cfg.token">Токен бота</label>
              <input id="token" type="password" placeholder="оставьте пустым, чтобы не менять" autocomplete="off" />
            </div>
            <div>
              <label data-i18n="cfg.mode">Режим</label>
              <select id="mode">
                <option value="both" data-i18n="cfg.mode.both">both — топики + личка</option>
                <option value="private" data-i18n="cfg.mode.private">private — только личка</option>
                <option value="topics" data-i18n="cfg.mode.topics">topics — только топики</option>
              </select>
            </div>
            <div>
              <label data-i18n="cfg.topics">ID форум-группы (topicsChatId)</label>
              <input id="topicsChatId" type="number" placeholder="-100…" />
            </div>
            <div>
              <label data-i18n="cfg.titleStatus">Статус темы</label>
              <select id="titleStatus">
                <option value="icon" data-i18n="cfg.titleStatus.icon">icon — иконка темы (без служебных сообщений)</option>
                <option value="rename" data-i18n="cfg.titleStatus.rename">rename — переименование темы (служебные сообщения)</option>
                <option value="off" data-i18n="cfg.titleStatus.off">off — выключено</option>
              </select>
              <div class="hint" data-i18n="cfg.titleStatus.hint">Иконка: ⏳ во время хода, ✅ в конце, через ~10 с возвращается обычная. Rename включён только по желанию: каждое переименование оставляет служебное сообщение.</div>
            </div>
          </div>
          <div class="row">
            <button class="primary" type="submit" data-i18n="btn.save">Сохранить</button>
          </div>
        </form>
        <details style="margin-top:16px">
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
      </section>

      <section class="card">
        <h2 data-i18n="access.title">Доступ</h2>
        <div id="users" class="hint">Пользователи ещё не подключены. Напишите боту <code>/start</code> — первый станет администратором.</div>
      </section>
    </section>

    <section class="page" id="page-discord">
      <section class="card">
        <h2 data-i18n="dc.title">Discord</h2>
        <form id="formDiscord" onsubmit="return false">
          <label class="check" style="margin-bottom:14px">
            <input type="checkbox" id="dcEnabled" />
            <span data-i18n="cfg.discord.enabled">Включить Discord</span>
          </label>
          <div class="grid">
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
          <div class="divider"></div>
          <label class="check">
            <input type="checkbox" id="dcTitleStatus" />
            <span data-i18n="cfg.discord.titleStatus">Переименовывать треды на время хода (служебные сообщения)</span>
          </label>
          <div class="hint" data-i18n="cfg.discord.hint">Публичные треды, одна сессия на тред. Пустой список серверов или пользователей = доступа нет. MESSAGE_CONTENT включается в Discord Developer Portal.</div>
          <div class="row">
            <button class="primary" type="submit" data-i18n="btn.save">Сохранить</button>
          </div>
        </form>
      </section>
    </section>

    <section class="page" id="page-updates">
      <section class="card">
        <h2 data-i18n="update.title">Обновления</h2>
        <div id="updateBanner" class="card" hidden style="border-color:color-mix(in srgb, var(--acc) 35%, transparent)">
          <div class="row" style="margin-top:0">
            <span id="updateText" style="flex:1"></span>
            <button id="updateDownload" class="primary" type="button" data-i18n="update.download">Скачать</button>
            <button id="updateInstall" type="button" data-i18n="update.install">Установить</button>
          </div>
          <progress id="updateProgress" max="100" value="0" style="width:100%;margin-top:10px" hidden></progress>
        </div>
        <form id="formUpdates" onsubmit="return false">
          <div class="grid">
            <div>
              <label class="check" style="margin-top:6px">
                <input type="checkbox" id="updateCheck" />
                <span data-i18n="cfg.update.check">Проверять обновления при запуске</span>
              </label>
            </div>
            <div>
              <label data-i18n="cfg.update.hours">Интервал проверки, ч</label>
              <input id="updateHours" type="number" min="1" max="168" step="1" />
            </div>
            <div>
              <label class="check" style="margin-top:6px">
                <input type="checkbox" id="updateAuto" />
                <span data-i18n="cfg.update.auto">Скачивать автоматически</span>
              </label>
            </div>
          </div>
          <div class="row">
            <button class="primary" type="submit" data-i18n="btn.save">Сохранить</button>
            <button id="updateCheckBtn" type="button" data-i18n="update.check">Проверить обновления</button>
            <span id="updateVersion" class="hint" style="margin:0"></span>
          </div>
        </form>
      </section>
    </section>

    <section class="page" id="page-log">
      <section class="card">
        <h2 data-i18n="log.title">Журнал</h2>
        <div class="log-controls">
          <div>
            <label data-i18n="log.lines">Строк</label>
            <select id="logLines">
              <option value="100">100</option>
              <option value="500" selected>500</option>
              <option value="2000">2000</option>
            </select>
          </div>
          <div>
            <label data-i18n="log.level">Уровень</label>
            <select id="logLevel">
              <option value="all" data-i18n="log.level.all">Все</option>
              <option value="info" data-i18n="log.level.info">Info</option>
              <option value="warn" data-i18n="log.level.warn">Warn</option>
              <option value="error" data-i18n="log.level.error">Error</option>
            </select>
          </div>
          <div class="grow">
            <label data-i18n="log.search">Поиск</label>
            <input id="logSearch" type="search" placeholder="…" />
          </div>
          <div>
            <label>&nbsp;</label>
            <button id="logPause" type="button" data-i18n="log.pause">Пауза</button>
          </div>
          <div>
            <label>&nbsp;</label>
            <a class="btn" id="logDownload" href="/api/log/download" download="bridge.log" data-i18n="log.download">Скачать bridge.log</a>
          </div>
        </div>
        <pre id="log">…</pre>
        <div id="logMeta" class="hint"></div>
      </section>
    </section>
  </main>
</div>
<div id="toast" class="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let lastState = null;
let logPaused = false;
let logTimer = null;
let lastLogText = "";

const I18N = {
  ru: {
    "title": "OpenCode · Telegram Bridge",
    "nav.status": "Статус",
    "nav.settings": "Настройки",
    "nav.telegram": "Telegram",
    "nav.discord": "Discord",
    "nav.updates": "Обновления",
    "nav.log": "Журнал",
    "onb.title": "Первый запуск",
    "onb.step1": 'Получите токен у <a href="https://t.me/BotFather" target="_blank" style="color:var(--acc)">@BotFather</a> (<code>/newbot</code>).',
    "onb.step2": "Вставьте токен на вкладке Telegram и нажмите «Сохранить и запустить».",
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
    "cfg.theme": "Тема",
    "cfg.lang": "Язык",
    "cfg.token": "Токен бота",
    "cfg.mode": "Режим",
    "cfg.mode.both": "both — топики + личка",
    "cfg.mode.private": "private — только личка",
    "cfg.mode.topics": "topics — только топики",
    "cfg.topics": "ID форум-группы (topicsChatId)",
    "cfg.titleStatus": "Статус темы",
    "cfg.titleStatus.icon": "icon — иконка темы (без служебных сообщений)",
    "cfg.titleStatus.rename": "rename — переименование темы (служебные сообщения)",
    "cfg.titleStatus.off": "off — выключено",
    "cfg.titleStatus.hint": "Иконка: ⏳ во время хода, ✅ в конце, через ~10 с возвращается обычная. Rename включён только по желанию: каждое переименование оставляет служебное сообщение.",
    "cfg.telegram.enabled": "Включить Telegram",
    "cfg.dir": "Папка по умолчанию",
    "cfg.throttle": "Троттлинг правок, мс",
    "cfg.tools": "Инструменты в чате",
    "cfg.tools.compact": "compact — одной строкой",
    "cfg.tools.off": "off — скрыть",
    "cfg.tools.full": "full — подробно",
    "cfg.format": "Формат ответов",
    "cfg.format.rich": "rich — Telegram Markdown",
    "cfg.format.html": "html — классический HTML",
    "cfg.autoTopics": "Тема на каждую задачу из общего чата",
    "cfg.showSubagents": "Показывать субагентов",
    "cfg.media.relay": "Пересылка файлов",
    "cfg.media.all": "all — пользователи + агент",
    "cfg.media.user": "user — только пользователи",
    "cfg.media.none": "none — выключено",
    "cfg.media.photo": "Фото до, МБ",
    "cfg.update.check": "Проверять обновления при запуске",
    "cfg.update.hours": "Интервал проверки, ч",
    "cfg.update.auto": "Скачивать автоматически",
    "update.title": "Обновления",
    "update.check": "Проверить обновления",
    "update.download": "Скачать",
    "update.install": "Установить",
    "update.available": "Доступна версия",
    "tg.title": "Telegram",
    "dc.title": "Discord",
    "cfg.discord.enabled": "Включить Discord",
    "cfg.discord.token": "Токен бота Discord",
    "cfg.discord.guilds": "ID серверов (через запятую)",
    "cfg.discord.users": "ID пользователей (через запятую)",
    "cfg.discord.titleStatus": "Переименовывать треды на время хода (служебные сообщения)",
    "cfg.discord.hint": "Публичные треды, одна сессия на тред. Пустой список серверов или пользователей = доступа нет. MESSAGE_CONTENT включается в Discord Developer Portal.",
    "cfg.network": "Сеть (прокси / IP)",
    "cfg.proxy": "Прокси",
    "cfg.apiIp": "IP Bot API",
    "cfg.network.hint": "Пусто = автоопределение. Если api.telegram.org недоступен, приложение само найдёт рабочий IP.",
    "access.title": "Доступ",
    "access.empty": "Пользователи ещё не подключены. Напишите боту <code>/start</code> — первый станет администратором.",
    "sessions.title": "Текущие сессии",
    "sessions.empty": "Нет активных или недавних сессий.",
    "sessions.refresh": "Обновить",
    "sessions.hide": "Скрыть",
    "sessions.showHidden": "Показать скрытые",
    "sessions.hint": "«Скрыть» убирает сессию только из панели — в OpenCode она остаётся.",
    "sessions.active": "активна",
    "sessions.recent": "недавняя",
    "sessions.hiddenCount": "скрыто: ",
    "log.title": "Журнал",
    "log.lines": "Строк",
    "log.level": "Уровень",
    "log.level.all": "Все",
    "log.level.info": "Info",
    "log.level.warn": "Warn",
    "log.level.error": "Error",
    "log.search": "Поиск",
    "log.pause": "Пауза",
    "log.resume": "Продолжить",
    "log.download": "Скачать bridge.log",
    "log.paused": "автопрокрутка на паузе",
    "log.filtered": "показано строк: ",
    "log.none": "Нет строк, подходящих под фильтр.",
    "toast.saved": "Сохранено",
    "toast.started": "Запущено",
    "toast.stopped": "Остановлено",
    "toast.restarted": "Перезапущено",
    "toast.on": "Готово",
    "toast.token": "Вставьте токен",
    "toast.done": "Готово — напишите боту /start",
    "err.offline": "нет связи с приложением",
    "err.apiTitle": "Панель не может получить состояние",
    "status.connected": "подключён",
    "status.retrying": "переподключение",
    "status.retryIn": "через"
  },
  en: {
    "title": "OpenCode · Telegram Bridge",
    "nav.status": "Status",
    "nav.settings": "Settings",
    "nav.telegram": "Telegram",
    "nav.discord": "Discord",
    "nav.updates": "Updates",
    "nav.log": "Log",
    "onb.title": "First launch",
    "onb.step1": 'Get a token from <a href="https://t.me/BotFather" target="_blank" style="color:var(--acc)">@BotFather</a> (<code>/newbot</code>).',
    "onb.step2": "Paste the token on the Telegram tab and click “Save and start”.",
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
    "cfg.theme": "Theme",
    "cfg.lang": "Language",
    "cfg.token": "Bot token",
    "cfg.mode": "Mode",
    "cfg.mode.both": "both — topics and private chats",
    "cfg.mode.private": "private — private chats only",
    "cfg.mode.topics": "topics — group topics only",
    "cfg.topics": "Forum group ID (topicsChatId)",
    "cfg.titleStatus": "Topic status",
    "cfg.titleStatus.icon": "icon — topic icon (no service messages)",
    "cfg.titleStatus.rename": "rename — rename the topic (service messages)",
    "cfg.titleStatus.off": "off — disabled",
    "cfg.titleStatus.hint": "Icon: ⏳ while a turn runs, ✅ when it ends, the default icon returns after ~10 s. Rename is opt-in: every rename posts a service message.",
    "cfg.telegram.enabled": "Enable Telegram",
    "cfg.dir": "Default directory",
    "cfg.throttle": "Edit throttle, ms",
    "cfg.tools": "Tools in chat",
    "cfg.tools.compact": "compact — one line",
    "cfg.tools.off": "off — hidden",
    "cfg.tools.full": "full — detailed",
    "cfg.format": "Reply format",
    "cfg.format.rich": "rich — Telegram Markdown",
    "cfg.format.html": "html — classic HTML",
    "cfg.autoTopics": "Topic per task from the general chat",
    "cfg.showSubagents": "Show subagents",
    "cfg.media.relay": "File relay",
    "cfg.media.all": "all — users and agent",
    "cfg.media.user": "user — users only",
    "cfg.media.none": "none — disabled",
    "cfg.media.photo": "Photo max, MB",
    "cfg.update.check": "Check for updates on start",
    "cfg.update.hours": "Check interval, hours",
    "cfg.update.auto": "Download automatically",
    "update.title": "Updates",
    "update.check": "Check for updates",
    "update.download": "Download",
    "update.install": "Install",
    "update.available": "Version available",
    "tg.title": "Telegram",
    "dc.title": "Discord",
    "cfg.discord.enabled": "Enable Discord",
    "cfg.discord.token": "Discord bot token",
    "cfg.discord.guilds": "Server IDs (comma separated)",
    "cfg.discord.users": "User IDs (comma separated)",
    "cfg.discord.titleStatus": "Rename threads while a turn runs (service messages)",
    "cfg.discord.hint": "Public threads, one session per thread. Empty server or user list = no access. MESSAGE_CONTENT must be enabled in the Discord Developer Portal.",
    "cfg.network": "Network (proxy / IP)",
    "cfg.proxy": "Proxy",
    "cfg.apiIp": "IP Bot API",
    "cfg.network.hint": "Empty = auto-detect. If api.telegram.org is unreachable, the app finds a working IP itself.",
    "access.title": "Access",
    "access.empty": "No users connected yet. Send <code>/start</code> to the bot — the first one becomes administrator.",
    "sessions.title": "Current sessions",
    "sessions.empty": "No active or recent sessions.",
    "sessions.refresh": "Refresh",
    "sessions.hide": "Hide",
    "sessions.showHidden": "Show hidden",
    "sessions.hint": "“Hide” removes a session from this panel only — it stays in OpenCode.",
    "sessions.active": "active",
    "sessions.recent": "recent",
    "sessions.hiddenCount": "hidden: ",
    "log.title": "Log",
    "log.lines": "Lines",
    "log.level": "Level",
    "log.level.all": "All",
    "log.level.info": "Info",
    "log.level.warn": "Warn",
    "log.level.error": "Error",
    "log.search": "Search",
    "log.pause": "Pause",
    "log.resume": "Resume",
    "log.download": "Download bridge.log",
    "log.paused": "auto-scroll paused",
    "log.filtered": "lines shown: ",
    "log.none": "No lines match the filter.",
    "toast.saved": "Saved",
    "toast.started": "Started",
    "toast.stopped": "Stopped",
    "toast.restarted": "Restarted",
    "toast.on": "Done",
    "toast.token": "Paste a token",
    "toast.done": "Done — send /start to the bot",
    "err.offline": "no connection to the app",
    "err.apiTitle": "Panel cannot read the bridge state",
    "status.connected": "connected",
    "status.retrying": "retrying",
    "status.retryIn": "in"
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
  $("logPause").textContent = t(logPaused ? "log.resume" : "log.pause");
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

function discordLine(dc) {
  if (!dc.enabled) return t("status.off");
  const tail = dc.tokenTail ? " · " + dc.tokenTail : "";
  if (dc.state === "running") return t("status.connected") + (dc.username ? " · @" + dc.username : "") + tail;
  if (dc.state === "retrying") {
    const sec = dc.retryAt ? Math.max(0, Math.ceil((dc.retryAt - Date.now()) / 1000)) : 0;
    const when = sec ? " · " + t("status.retryIn") + " " + sec + " " + t("status.seconds") : "";
    return t("status.retrying") + (dc.attempt ? " " + dc.attempt : "") + when + (dc.error ? " · " + dc.error : "") + tail;
  }
  if (dc.state === "error") return t("state.error") + (dc.error ? " · " + dc.error : "") + tail;
  return (dc.state || t("status.off")) + tail;
}

function setApiError(message) {
  const box = $("apiError");
  if (!box) return;
  box.hidden = !message;
  if (message) $("apiErrorText").textContent = message;
}

function sessionRow(item) {
  const state = item.active ? '<span class="badge active">' + escapeHtml(t("sessions.active")) + "</span>" : '<span class="badge">' + escapeHtml(t("sessions.recent")) + "</span>";
  const meta = [escapeHtml(item.directory || ""), item.updatedAt ? new Date(item.updatedAt).toLocaleString() : ""].filter(Boolean).join(" · ");
  return '<div class="session"><div class="session-main"><b>' + escapeHtml(item.title || item.id) + state + "</b><small>" + meta + '</small></div>' +
    '<button class="small session-hide" type="button" data-id="' + escapeHtml(item.id) + '">' + escapeHtml(t("sessions.hide")) + "</button></div>";
}

function renderSessions(list) {
  const items = list || [];
  $("sessions").innerHTML = items.length
    ? items.map(sessionRow).join("")
    : '<div class="hint">' + escapeHtml(t("sessions.empty")) + "</div>";
  $("sessions").querySelectorAll(".session-hide").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.getAttribute("data-id");
      try {
        await api("/api/sessions/hide", { method: "POST", body: JSON.stringify({ id }) });
        toast(t("toast.saved"), "ok");
        await refreshSessions();
      } catch (e) { toast(e.message, "err"); }
    });
  });
}

async function refreshSessions() {
  try {
    const result = await api("/api/sessions");
    renderSessions(result.sessions || []);
    const hidden = (lastState && lastState.hiddenSessions) || [];
    $("sessionsShowHidden").hidden = !hidden.length;
    $("sessionsHidden").hidden = !hidden.length;
    $("sessionsHidden").textContent = hidden.length ? t("sessions.hiddenCount") + hidden.length : "";
  } catch (e) { /* the main refresh reports connection errors */ }
}

function fill(s) {
  lastState = s;
  $("state").textContent = t("state." + s.state, s.state);
  $("state").className = "pill " + s.state;
  $("who").textContent = s.username ? "@" + s.username : "";
  const ver = $("ver");
  if (s.version) { ver.textContent = "v" + s.version; ver.hidden = false; }
  else { ver.textContent = ""; ver.hidden = true; }
  const tgOn = s.telegramEnabled !== false;
  $("tg").textContent = !tgOn
    ? t("status.off")
    : s.configured ? t("status.token") + " " + s.config.tokenTail : t("status.notConfigured");
  $("oc").textContent = s.ocVersion ? "v" + s.ocVersion + " · " + s.ocUrl : "—";
  const dc = s.discord || {};
  $("dc").textContent = discordLine(dc);
  $("net").textContent = s.telegramMode || "—";
  $("uptime").textContent = s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) + " " + t("status.seconds") : "—";
  $("err").textContent = s.error || "";
  $("warn").textContent = (s.warnings || []).length ? "⚠️ " + s.warnings.join("\\n⚠️ ") : "";
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
      $("titleStatus").value = s.config.ui.titleStatus || "icon";
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
    $("tgEnabled").checked = s.telegramEnabled !== false;
    const dcfg = s.discord || {};
    $("dcEnabled").checked = Boolean(dcfg.enabled);
    $("dcGuilds").value = (dcfg.allowedGuilds || []).join(", ");
    $("dcUsers").value = (dcfg.allowedUsers || []).join(", ");
    $("dcTitleStatus").checked = dcfg.titleStatus === "rename";
  }
  $("autostart").checked = s.autostart;
  $("autostart").disabled = !s.autostartSupported;
  $("onboarding").hidden = s.configured;

  $("updateVersion").textContent = "v" + (s.version || "");
  const u = s.update || {};
  const banner = $("updateBanner");
  banner.hidden = !u.available && !u.downloading;
  if (!banner.hidden) {
    $("updateText").textContent = t("update.available") + " " + (u.latest || "") + (u.notes ? " — " + String(u.notes).split("\\n")[0].slice(0, 120) : "");
    $("updateDownload").disabled = Boolean(u.downloading);
    $("updateInstall").disabled = !(u.progress >= 100);
    $("updateProgress").hidden = !u.downloading;
    $("updateProgress").value = u.progress || 0;
  }

  $("users").innerHTML = s.config.allowedUsers.length
    ? s.config.allowedUsers.map((u) => "<div><code>" + u.id + "</code> " + escapeHtml(u.name || "") + " · " + escapeHtml(u.role || "user") + "</div>").join("")
    : t("access.empty");

  renderSessions(s.sessions || []);
  const hidden = s.hiddenSessions || [];
  $("sessionsShowHidden").hidden = !hidden.length;
  $("sessionsHidden").hidden = !hidden.length;
  $("sessionsHidden").textContent = hidden.length ? t("sessions.hiddenCount") + hidden.length : "";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function refresh() {
  try {
    const s = await api("/api/state");
    if (!s.sessions || !s.sessions.length) s.sessions = [];
    fill(s);
    setApiError("");
    if (!s.sessions.length) {
      const extra = await api("/api/sessions").catch(() => ({ sessions: [] }));
      s.sessions = extra.sessions;
      fill(s);
    }
  } catch (e) {
    $("state").textContent = t("err.offline");
    $("state").className = "pill error";
    setApiError((e && e.message ? e.message : String(e)) || t("err.offline"));
  }
}

function logLinesEnabled(line, level) {
  if (level === "all") return true;
  if (level === "error") return / ERROR /.test(" " + line);
  if (level === "warn") return / (WARN|ERROR) /.test(" " + line);
  return / INFO /.test(" " + line);
}

function renderLog() {
  const text = lastLogText || "";
  const level = $("logLevel").value;
  const query = ($("logSearch").value || "").trim().toLowerCase();
  const lines = text.split("\\n").filter((line) => {
    if (!line) return false;
    if (!logLinesEnabled(line, level)) return false;
    return query ? line.toLowerCase().includes(query) : true;
  });
  const el = $("log");
  el.textContent = lines.length ? lines.join("\\n") : t("log.none");
  $("logMeta").textContent = logPaused ? t("log.paused") + " · " + t("log.filtered") + lines.length : t("log.filtered") + lines.length;
  if (!logPaused) el.scrollTop = el.scrollHeight;
}

async function refreshLog() {
  try {
    const lines = Number($("logLines").value) || 500;
    const result = await api("/api/log?lines=" + lines);
    lastLogText = result.log || "";
    renderLog();
  } catch (e) { /* keep the previous log */ }
}

function scheduleLog() {
  if (logTimer) clearInterval(logTimer);
  logTimer = setInterval(refreshLog, logPaused ? 15000 : 5000);
}

function currentPayload() {
  return {
    telegram: { token: $("token").value, enabled: $("tgEnabled").checked, proxy: $("proxy").value, apiIp: $("apiIp").value },
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
    ui: { titleStatus: $("titleStatus").value },
    discord: {
      enabled: $("dcEnabled").checked,
      token: $("dcToken").value,
      allowedGuilds: $("dcGuilds").value,
      allowedUsers: $("dcUsers").value,
      titleStatus: $("dcTitleStatus").checked ? "rename" : "off",
    },
  };
}

async function saveForm(event) {
  event.preventDefault();
  try {
    await api("/api/config", { method: "POST", body: JSON.stringify(currentPayload()) });
    $("token").value = "";
    $("dcToken").value = "";
    toast(t("toast.saved"), "ok");
    await refresh();
  } catch (e) {
    toast(e.message, "err");
  }
}

["form", "formTelegram", "formDiscord", "formUpdates"].forEach((id) => {
  $(id).addEventListener("submit", saveForm);
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

$("btnStart").addEventListener("click", async () => {
  try { await api("/api/bot/start", { method: "POST" }); toast(t("toast.started"), "ok"); }
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

$("sessionsRefresh").addEventListener("click", () => { refreshSessions(); refresh(); });
$("sessionsShowHidden").addEventListener("click", async () => {
  const hidden = (lastState && lastState.hiddenSessions) || [];
  try {
    for (const id of hidden) await api("/api/sessions/show", { method: "POST", body: JSON.stringify({ id }) });
    toast(t("toast.saved"), "ok");
  } catch (e) { toast(e.message, "err"); }
  await refresh();
  await refreshSessions();
});

$("scheme").addEventListener("change", saveTheme);
$("theme").addEventListener("change", saveTheme);
$("lang").addEventListener("change", saveLang);

$("logLines").addEventListener("change", refreshLog);
$("logLevel").addEventListener("change", renderLog);
$("logSearch").addEventListener("input", renderLog);
$("logPause").addEventListener("click", () => {
  logPaused = !logPaused;
  $("logPause").textContent = t(logPaused ? "log.resume" : "log.pause");
  scheduleLog();
  renderLog();
});

$("autostart").addEventListener("change", async (event) => {
  try { await api("/api/autostart", { method: "POST", body: JSON.stringify({ enabled: event.target.checked }) }); toast(t("toast.on"), "ok"); }
  catch (e) { toast(e.message, "err"); event.target.checked = !event.target.checked; }
});

function showPage(name) {
  const pages = ["status", "settings", "telegram", "discord", "updates", "log"];
  const target = pages.includes(name) ? name : "status";
  document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === "page-" + target));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.getAttribute("data-page") === target));
  localStorage.setItem("ocbridge.page", target);
  document.body.classList.remove("nav-open");
}

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => showPage(item.getAttribute("data-page")));
});
$("navToggle").addEventListener("click", () => document.body.classList.toggle("nav-open"));
showPage(localStorage.getItem("ocbridge.page") || "status");

const storedLang = localStorage.getItem("ocbridge.lang");
if (storedLang === "system" || storedLang === "ru" || storedLang === "en") $("lang").value = storedLang;
applyI18n();

refresh();
refreshSessions();
refreshLog();
scheduleLog();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
