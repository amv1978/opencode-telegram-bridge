# Архитектура

## Компоненты

| Компонент | Файл / папка | Роль |
|---|---|---|
| Демон | `src/`, `dist/ocbridge.exe` | Bun-процесс: клиент OpenCode (HTTP + SSE), бот grammY, локальный веб-API |
| Веб-панель | `src/web/` | Одна HTML-страница + JSON API на `127.0.0.1:7788` |
| Оболочка | `desktop/` | Electron: окно, трей, автозапуск, синхронизация цвета заголовка |
| CLI | `cli/` | `ocbridge-cli.exe`, .NET 10, ходит только в локальный API |
| Установщик | `installer/` | Inno Setup: простой/расширенный режим, RU/EN |
| Голос | `src/audio/` | ffmpeg → WAV 16 kHz → HEX CLI |

Демон не требует плагина OpenCode: он подключается к тому же фоновому сервису,
что и Desktop/TUI, и видит те же сессии.

## Поток данных

```
Telegram  ⇄  grammY (long polling)  ⇄  Bridge  ⇄  OpenCode HTTP API
                                        │            ├─ /api/session/{id}/prompt
                                        │            ├─ /api/session/{id}/interrupt
                                        │            ├─ /api/session/{id}/permission/*
                                        │            └─ SSE /api/event
                                        ├─ state.json  (топик/чат → сессия)
                                        └─ Streamer    (правки одного сообщения)
```

1. Сообщение из Telegram (текст, фото, документ, голос) превращается в prompt.
2. `Bridge` находит сессию по `state.json` или создаёт новую через `POST /api/session`.
3. Ответ приходит событиями SSE; `Streamer` обновляет сообщение не чаще
   `stream.editIntervalMs` (по умолчанию 1800 мс).
4. Конец хода — `session.execution.*`; в футер добавляются длительность, tok/s и контекст.
5. Запросы прав (`permission.asked`) уходят кнопками; ответ — `permission/{id}/reply`.

## Как находится OpenCode

Порядок (`src/opencode/client.ts`):

1. `opencode.baseUrl` из конфига, если задан.
2. `~/.config/opencode/service.json` (или `XDG_CONFIG_HOME`, `~/.local/state/opencode/service.json`).
3. Перебор портов `28894`, `49374`, `4096`.

Проверка — `GET /api/info` с Basic-авторизацией `opencode:<password>`.
Пароль берётся из конфига, `service.json` или `OPENCODE_PASSWORD`.

## Порты

| Порт | Назначение |
|---|---|
| `7788` | Веб-панель и JSON API; при занятости берётся следующий (до +9) |
| `28894`, `49374`, `4096` | Кандидаты, где слушает OpenCode |
| случайный localhost | Временный CONNECT-прокси для пиннинга IP Telegram |

## Файлы на диске

Установленная версия всегда хранит данные в `%APPDATA%\opencode-telegram-bridge\`:

| Файл | Содержимое |
|---|---|
| `config.json` | Токен бота, allowlist, режим, папка, сеть, тема, троттлинг |
| `state.json` | `topics` (thread → session), `chats` (chat → session), `sessions` |
| `bridge.log` | Журнал демона, UTF-8, строки с ISO-временем |

Рядом с exe лежат `ocbridge.exe`, `ffmpeg.exe`, `ocbridge-cli.exe` и папка `desktop\`.
Переменная `OCBRIDGE_CONFIG` задаёт другой путь к конфигу (state и лог — в той же папке).
При первом запуске собранной версии `config.json`/`state.json` из папки exe
переносятся в `%APPDATA%`, старые файлы получают суффикс `.migrated`.

В dev-режиме (`bun run src/index.ts`) используется `config.json` из текущей папки,
если он существует.

## Веб-API

| Метод | Путь | Действие |
|---|---|---|
| GET | `/api/state` | Снимок: state, версии, режим, конфиг, автозапуск, сессии |
| GET | `/api/sessions` | Последние 8 корневых сессий |
| GET | `/api/log?lines=N` | Хвост журнала (до 1000 строк) |
| POST | `/api/config` | Частичное обновление конфига (перезапускает бота, если работал) |
| POST | `/api/bot/start\|stop\|restart` | Управление ботом |
| POST | `/api/autostart` | `{ "enabled": true }`, HKCU Run |
| POST | `/api/shutdown` | Завершение процесса (используется оболочкой) |

Сервер слушает только `127.0.0.1`; наружу порт не публикуется.
