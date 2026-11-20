[English](../AGENTS.md) · [Русский](AGENTS.md)

# AGENTS.md

Мост между Telegram и OpenCode 2.x: задачи из чата уходят в реальные сессии
OpenCode (те же, что видят Desktop/TUI), ответы стримятся обратно с разметкой,
запросы разрешений приходят кнопками.

## Структура

| Путь | Что это |
|---|---|
| `src/` | Демон Bun/TypeScript `ocbridge.exe`: клиент OpenCode HTTP+SSE, бот grammY, Discord-адаптер (`src/discord/`), веб-UI на `127.0.0.1:7788` |
| `desktop/` | Electron-оболочка: окно, трей, автозапуск, синхронизация темы заголовка |
| `cli/` | .NET 10 CLI `ocbridge-cli.exe` поверх локального JSON API (без NuGet-зависимостей) |
| `installer/` | Скрипт Inno Setup + сообщения мастера RU/EN |
| `docs/` | Главы; индекс в `docs/README.md` |
| `scripts/` | Ручные проверки (voice, render, dec) |

## Команды

```bash
bun install
bun run src/index.ts --ui    # dev-запуск, открывает веб-UI
bun run typecheck            # tsc --noEmit
bun run build                # dist/ocbridge.exe
bun run src/doctor.ts        # диагностика со стороны OpenCode, без Telegram
```

Desktop: `cd desktop && npm install && npm run pack` (electron-builder `--dir`).
CLI: см. `docs/build-and-release.md`. Установщик: `ISCC installer\ocbridge.iss`.

## Жёсткие правила

- Никогда не коммитить `config.json`, `state.json`, `bridge.log`, токены и сборки.
  Данные живут в `%APPDATA%\opencode-telegram-bridge\`; токен есть только там.
- SSE OpenCode волатильный. Обработка событий должна быть **последовательной**
  (`eventChain`): зеркалированное сообщение пользователя должно дойти до Telegram
  раньше ответа. Каждый обработчик ограничен 20 с.
- Discord живёт только в `src/discord/` и не должен импортировать `src/telegram/*`.
  Его токен — секрет: лог/UI показывают только `tokenTail`; `MESSAGE_CONTENT`
  привилегированный.
- `session.idle` не приходит. Конец хода — `session.execution.succeeded|failed|interrupted`.
- Предпочитать Telegram rich markdown (`sendRichMessage`); fallback — HTML.
  MarkdownV2 не использовать.
- Общий чат форума никогда не является адресом для ответов: сессии живут только в темах.
- Футер статистики должен совпадать с OpenCode (`packages/util/src/session-turn.ts`):
  duration, tok/s, context = input + cache.read + output + reasoning.
- Тестового набора нет. Проверка = `bun run typecheck`, `bun run src/doctor.ts`,
  затем ручной проход по Telegram (личный чат + тема + голос + кнопка разрешения).

## Документация

Начните с `docs/ru/README.md`. Детали: `architecture.md`, `opencode-integration.md`,
`telegram.md`, `discord.md`, `media.md`, `voice.md`, `ui.md`, `cli.md`,
`build-and-release.md`, `troubleshooting.md`.
