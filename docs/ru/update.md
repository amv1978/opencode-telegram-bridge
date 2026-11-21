[English](../update.md) · [Русский](update.md)

# Автообновление (Windows)

Мост проверяет GitHub Releases на новую версию и может скачать и установить её,
не выходя из приложения.

## Как это работает

1. `GET https://api.github.com/repos/amv1978/opencode-telegram-bridge/releases/latest`
   (публичный, без токена).
2. Последний `tag_name` сравнивается с версией из `package.json` (префикс `v` и
   суффиксы сборки игнорируются).
3. Находится ассет `ocbridge-setup-*.exe` и, если есть,
   `ocbridge-setup-*.exe.sha256`.
4. При старте (и каждые 6 часов по умолчанию) проверка идёт в фоне. Результат
   кэшируется в `state.json` (поле `update`), поэтому панель сразу после
   перезапуска показывает известную версию.

Автообновление работает **только для собранного `ocbridge.exe`**. В dev-режиме
(`bun run src/index.ts`) загрузка/установка возвращает
«автообновление доступно только для собранной версии». Данные в
`%APPDATA%\opencode-telegram-bridge\` не трогаются.

## Настройки

```json
{
  "update": {
    "checkOnStart": true,
    "intervalHours": 6,
    "autoDownload": false
  }
}
```

| Поле | Значение | По умолчанию |
|---|---|---|
| `checkOnStart` | проверить один раз при запуске | `true` |
| `intervalHours` | интервал повторной проверки, 1–168 ч | `6` |
| `autoDownload` | скачивать найденное обновление автоматически (но не устанавливать) | `false` |

Те же поля в панели: **Настройки → Проверять обновления / Интервал / Скачивать
автоматически**, плюс кнопка **Проверить обновления**.

## Загрузка и установка

- Установщик скачивается в `%TEMP%\ocbridge-update\setup.exe` с прогрессом
  0–100 %, таймаутом 30 минут и возможностью прервать.
- Если в релизе есть `ocbridge-setup-X.exe.sha256`, SHA256 проверяется;
  при несовпадении файл удаляется и показывается ошибка.
- Установка запускает setup с
  `/VERYSILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /NORESTART=0`
  и завершает мост через 2 секунды. Если установщик не может закрыть
  приложение, запущенное с повышенными правами, панель/трей показывают ошибку,
  а мост продолжает работать.
- При доступном обновлении под шапкой появляется баннер
  «Доступна версия X — Скачать / Установить» с полосой прогресса при загрузке.

## API

| Метод | Путь | Действие |
|---|---|---|
| POST | `/api/update/check` | Проверить GitHub, обновить кэш |
| POST | `/api/update/download` | Начать/продолжить загрузку (прогресс в `/api/state`) |
| POST | `/api/update/install` | Запустить скачанный установщик и выйти |

`/api/state` содержит:

```json
{
  "update": {
    "available": true,
    "current": "0.5.1",
    "latest": "0.5.1",
    "notes": "…",
    "progress": 0,
    "error": "",
    "downloading": false,
    "installing": false
  }
}
```

## Трей и CLI

- Меню трея: **Проверить обновления** (после проверки пункт становится
  **Установить X.Y.Z**). Установка из трея закрывает оболочку; установщик
  перезапускает приложение.
- CLI:

```
ocbridge-cli update --check
ocbridge-cli update --install
```

## Пайплайн релиза

Каждый релиз обязан содержать оба файла:

- `ocbridge-setup-<version>.exe`
- `ocbridge-setup-<version>.exe.sha256` — hex SHA256 экзешника, одна строка в
  формате `sha256sum`.

```powershell
(Get-FileHash dist\ocbridge-setup-0.5.1.exe -Algorithm SHA256).Hash.ToLower() +
  "  ocbridge-setup-0.5.1.exe" | Set-Content -Encoding ascii dist\ocbridge-setup-0.5.1.exe.sha256
```
