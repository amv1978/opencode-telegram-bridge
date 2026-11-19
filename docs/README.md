# OpenCode Telegram Bridge: документация

Мост между Telegram (и Discord) и OpenCode 2.x. Демон на Bun, оболочка Electron, CLI на .NET 10
и установщик Inno Setup.

## Разделы

| Документ | О чём |
|---|---|
| [architecture.md](architecture.md) | Компоненты, поток данных, порты, файлы на диске |
| [opencode-integration.md](opencode-integration.md) | Эндпоинты OpenCode, события SSE, особенности |
| [telegram.md](telegram.md) | Команды, режимы, темы, права, медиа и голос |
| [media.md](media.md) | Пересылка файлов: лимиты, ссылки, режимы relay |
| [discord.md](discord.md) | Discord: Dev Portal, интенты, треды, команды, лимиты |
| [voice.md](voice.md) | Голосовые: ffmpeg, HEX, Labs, задержки |
| [ui.md](ui.md) | Темы, язык, Electron-оболочка, трей |
| [cli.md](cli.md) | Все команды `ocbridge-cli` с примерами вывода |
| [build-and-release.md](build-and-release.md) | Сборка, версии, установщик, подпись |
| [troubleshooting.md](troubleshooting.md) | 409, блокировка Telegram, удалённая тема, таймауты |

## Быстрые ссылки

- Установка: `dist\ocbridge-setup-0.3.0.exe` или сборка из исходников
  (см. [build-and-release.md](build-and-release.md)).
- Панель управления: `http://127.0.0.1:7788` (только localhost).
- Данные: `%APPDATA%\opencode-telegram-bridge\` — там же `bridge.log`.
- Скриншот интерфейса: [ui.png](ui.png), тёмная тема Matrix: [ui-matrix.png](ui-matrix.png).
