[English](../cli.md) · [Русский](cli.md)

# CLI: ocbridge-cli

Консольный клиент локального API демона. .NET 10, без внешних зависимостей.

```powershell
ocbridge-cli.exe [--url URL] <команда> [параметры]
```

`--url` или переменная `OCBRIDGE_URL`; по умолчанию `http://127.0.0.1:7788`.
HTTP-таймаут — 10 с.

## status

```
> ocbridge-cli status
Состояние     running
Версия        0.6.3
Пользователь  @my_bot
OpenCode      2.3.2 (http://127.0.0.1:28894)
Telegram      pinned 149.154.167.220
Uptime        2ч 14м
Сессий        4
```

При ошибке добавляется строка `Ошибка: …`. Uptime: `12с`, `5м 3с`, `2ч 14м`, `1д 3ч 8м`.

## start / stop / restart

```
> ocbridge-cli restart
Бот перезапускается.
Состояние: running
```

Состояние печатается после паузы 300 мс, если API успел ответить.

## sessions

```
> ocbridge-cli sessions
ID                             TITLE                          DIRECTORY
------------------------------ ------------------------------ ------------------------------
ses_01JABCDEF0123456789ABCDEF   Refactor API                   D:\work\api
ses_01JABCDEF9876543210FEDCBA   Telegram session               D:\work\api
```

`--json` (или `-j`) — сырой массив из `/api/sessions`. Пусто — «Сессий нет.»

## logs

```
> ocbridge-cli logs -n 3
2026-11-19T09:12:04.115Z INFO  OpenCode 2.3.2 at http://127.0.0.1:28894
2026-11-19T09:12:04.280Z INFO  telegram: pinned 149.154.167.220
2026-11-19T09:12:04.301Z INFO  bot @my_bot started (mode=both)
```

`-n N` — строки, по умолчанию 100, максимум 1000. `--follow` / `-f` — печатать новое
каждые 2 с (Ctrl+C — выход; служебная строка идёт в stderr).

## config

```
> ocbridge-cli config get mode
both

> ocbridge-cli config get telegram.proxy
(не задано)

> ocbridge-cli config set stream.editIntervalMs=1800
Готово: stream.editIntervalMs = 1800

> ocbridge-cli config set ui.theme=matrix
Готово: ui.theme = matrix
```

`config get` без ключа печатает pretty-JSON снимка конфига:

```json
{
  "mode": "both",
  "topicsChatId": -1001234567890,
  "defaultDirectory": "D:\\work",
  "editIntervalMs": 1800,
  "showTools": "compact",
  "format": "rich",
  "autoTopics": true,
  "ui": { "theme": "opencode", "scheme": "system", "lang": "system" },
  "allowedUsers": [{ "id": 123456789, "role": "admin", "name": "Mike" }],
  "hasToken": true,
  "tokenTail": "…AbCd"
}
```

Допустимые ключи `config set`: `mode` (`topics|private|both`), `topicsChatId`,
`defaultDirectory`, `autoTopics` (`true|false`), `stream.editIntervalMs`
(500…10000), `stream.showTools` (`off|compact|full`), `stream.format` (`rich|html`),
`telegram.proxy`, `telegram.apiIp`, `ui.theme` (`opencode|matrix`),
`ui.scheme` (`system|light|dark`). Короткие формы (`editIntervalMs`, `showTools`,
`format`, `proxy`, `apiIp`) тоже принимаются.

Токен через CLI **не задаётся** — только в панели.

## autostart

```
> ocbridge-cli autostart status
Автозапуск     включён
Поддержка      да

> ocbridge-cli autostart on
Автозапуск включён.
```

## doctor

```
> ocbridge-cli doctor
✔ API: http://127.0.0.1:7788 доступен
✔ Состояние: running
✔ OpenCode: 2.3.2 (http://127.0.0.1:28894)
✔ Telegram: @my_bot
✔ Конфиг: C:\Users\me\AppData\Roaming\opencode-telegram-bridge\config.json
✔ Автозапуск: включён, поддерживается
✔ Токен Telegram: задан (…AbCd)

Все проверки пройдены.
```

Если демон не запущен, doctor сразу завершается с кодом 3 и подсказкой.

## version / help

```
> ocbridge-cli version
ocbridge-cli 0.6.3
API: 0.6.3
OpenCode: 2.3.2

> ocbridge-cli help logs
logs [-n N] [--follow] — хвост лога демона.
-n N      сколько строк показать (по умолчанию 100, максимум 1000).
--follow  опрашивать API каждые 2 с и печатать только новые строки (Ctrl+C — выход).
```

## Коды выхода

| Код | Значение |
|---|---|
| 0 | Успех |
| 1 | Ошибка API/HTTP или провайдера |
| 2 | Ошибка аргументов |
| 3 | Демон не запущен (`connection refused`) |
