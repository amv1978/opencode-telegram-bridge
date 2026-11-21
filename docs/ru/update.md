[English](../update.md) · [Русский](update.md)

# Автообновление (Windows)

Мост проверяет GitHub Releases и обновляется из portable-**bundle** без мастера
установки. Данные в `%APPDATA%\opencode-telegram-bridge\` (`config.json`,
`state.json`, привязки, токены) не трогаются.

## Как это работает

1. `GET https://api.github.com/repos/amv1978/opencode-telegram-bridge/releases/latest`
   (публично, без токена).
2. `tag_name` сравнивается с `package.json` (префикс `v` и суффиксы сборки
   игнорируются).
3. Находятся файлы релиза `ocbridge-bundle-*.zip` и
   `ocbridge-bundle-*.zip.sha256`.
4. При старте (и по умолчанию каждые 6 часов) проверка идёт в фоне. Результат
   кэшируется в `state.json` (поле `update`), панель сразу показывает последнюю
   известную версию после перезапуска.

Автообновление работает **только для собранного `ocbridge.exe`**. В dev-режиме
(`bun run src/index.ts`) обновление недоступно.

## Загрузка

- Куда: `%TEMP%\ocbridge-update\bundle.zip` (файл `.part` сохраняется между
  запусками).
- Прогресс 0–100 % виден в `/api/state` и панели.
- Порядок загрузки: **BITS** (`Start-BitsTransfer`) → **curl.exe** с `-C -` →
  встроенный `fetch` с `Range`. Любой транспорт докачивает `.part`, а не
  начинает заново.
- Опубликованный `.sha256` обязателен: отсутствие или несовпадение хеша
  отменяет обновление и оставляет текущую версию.

## Установка и откат

1. Zip распаковывается в `{app}\new` (каталог с `ocbridge.exe`, обычно
   `%LOCALAPPDATA%\Programs\OpenCodeTelegramBridge`).
2. `prevVersion` записывается в `state.json`, в чат уходит
   `🔄 обновлено с X до Y — перезапускаюсь`.
3. Отдельный PowerShell-помощник ждёт выхода моста, переносит текущий layout в
   `{app}\prev` (хранится только одна предыдущая версия), перемещает `new` в
   `{app}` и запускает desktop-оболочку (или `ocbridge.exe --no-browser`).
4. Health-check: `GET http://127.0.0.1:7788/api/state` каждую секунду до 60 с.
   При ошибке помощник останавливает новую версию, возвращает `prev` и
   запускает её. Сломанный layout удаляется.
5. После успешного перезапуска приходит обычное уведомление о старте.

`ocbridge-cli update --rollback` (или пункт трея «Откатиться на X») сразу
возвращает `{app}\prev`; настройки не меняются.

## Настройки

```json
{
  "update": {
    "checkOnStart": true,
    "intervalHours": 6,
    "autoDownload": false
  },
  "notify": {
    "enabled": true,
    "targets": "admin"
  }
}
```

| Поле | Значение | По умолчанию |
|---|---|---|
| `update.checkOnStart` | проверять при старте | `true` |
| `update.intervalHours` | интервал, 1–168 ч | `6` |
| `update.autoDownload` | скачивать найденный bundle автоматически (не устанавливает) | `false` |
| `notify.enabled` | уведомления о жизненном цикле в чат | `true` |
| `notify.targets` | `"admin"` (первый админ), `"all"` (все допущенные) или массив chat id | `"admin"` |

## API

| Метод | Путь | Действие |
|---|---|---|
| POST | `/api/update/check` | Проверить GitHub и обновить кэш |
| POST | `/api/update/download` | Начать/продолжить загрузку bundle |
| POST | `/api/update/install` | Распаковать, заменить и перезапустить |
| POST | `/api/update/rollback` | Вернуть `{app}\prev` и перезапустить |
| GET | `/api/changelog?from=X&to=Y` | Разделы CHANGELOG в `(X, Y]` |

`/api/state` содержит `update.prevVersion` (версия в `{app}\prev`) и
`update.bundled`.

## Окно CHANGELOG (Electron)

После обновления, если `prevVersion < current`, оболочка открывает модальное окно
со всеми разделами CHANGELOG в `(prev, current]`, с прокруткой и кнопкой
«Понятно». Показ один раз на версию: подтверждённая версия хранится в
`ui.seenChangelog`. Пункт трея «Что нового» открывает текущую версию вручную.

## Трей и CLI

- Трей: «Проверить обновления», «Установить X», «Откатиться на X», «Что нового».
- CLI:

```
ocbridge-cli update --check
ocbridge-cli update --install
ocbridge-cli update --rollback
```

## Релизный пайплайн

Каждый релиз должен содержать:

- `ocbridge-bundle-<version>.zip` + `.sha256`
- `ocbridge-setup-<version>.exe` + `.sha256` (полный, всё внутри)
- `ocbridge-setup-lite-<version>.exe` + `.sha256` (скачивает bundle)

`scripts/build-release.ps1` собирает всё; см.
[build-and-release.md](build-and-release.md).
