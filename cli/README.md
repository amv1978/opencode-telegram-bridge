# ocbridge-cli

Консольный клиент локального JSON API демона OpenCode Bridge (`ocbridge.exe`).
Без внешних NuGet-зависимостей, .NET 10, один исполняемый файл.

## Сборка и публикация

Из каталога `cli/`:

```
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o ..\dist\cli
```

Результат: `..\dist\cli\ocbridge-cli.exe` (single-file, self-contained, ~70 МБ).

Обычная сборка без публикации: `dotnet build -c Release` → `cli\bin\Release\net10.0\ocbridge-cli.dll`.

## Запуск

```
ocbridge-cli.exe [--url URL] <команда> [параметры]
```

Адрес API: `--url` или переменная окружения `OCBRIDGE_URL`, по умолчанию `http://127.0.0.1:7788`.
Таймаут HTTP — 10 с.

## Команды

| Команда | Что делает |
| --- | --- |
| `status` | state, @username, версия и адрес OpenCode, режим Telegram, uptime, число сессий |
| `start` / `stop` / `restart` | управление ботом (`/api/bot/*`) |
| `sessions [--json]` | список сессий; `--json` — сырой массив |
| `logs [-n N] [--follow]` | последние N строк (по умолчанию 100); `--follow` — новые строки каждые 2 с |
| `config get [key]` | pretty JSON снапшота или одно значение по dot-path |
| `config set key=value` | изменить параметр (`mode`, `defaultDirectory`, `stream.format`, `ui.theme`, …) |
| `autostart on\|off\|status` | автозапуск приложения |
| `doctor` | проверки: API, state, OpenCode, Telegram, конфиг, автозапуск (✔/✖) |
| `version` | версия CLI и версия API |
| `help [команда]` | справка |

Ключи `config set`: `mode`, `topicsChatId`, `defaultDirectory`, `autoTopics`,
`stream.editIntervalMs`, `stream.showTools`, `stream.format`,
`telegram.proxy`, `telegram.apiIp`, `ui.theme`, `ui.scheme`
(короткие формы `editIntervalMs`, `showTools`, `format`, `proxy`, `apiIp` тоже принимаются).

Примеры:

```
ocbridge-cli.exe config get stream.format
ocbridge-cli.exe config set stream.editIntervalMs=1800
ocbridge-cli.exe config set ui.theme=matrix
ocbridge-cli.exe logs -n 50 --follow
```

## Коды выхода

| Код | Значение |
| --- | --- |
| 0 | успех |
| 1 | ошибка API/HTTP |
| 2 | ошибка аргументов |
| 3 | демон не запущен (connection refused) |

## Замечания по API

- В `/api/state` нет поля `version`, поэтому `version` показывает `API: неизвестна` (есть только `ocVersion` OpenCode).
- `config get telegram.proxy` читает плоский ключ `proxy` из снапшота; если он не задан, печатается `(не задано)`.
- `config set telegram.token=…` намеренно не поддерживается: секреты через CLI не передаются и не печатаются.
