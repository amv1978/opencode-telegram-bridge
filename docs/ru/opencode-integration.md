[English](../opencode-integration.md) · [Русский](opencode-integration.md)

# Интеграция с OpenCode

Проверено на OpenCode 2.3.2. Используется общий фоновый сервис (`opencode service start`
или Desktop), поэтому мост видит те же сессии, что TUI и приложение.

## Эндпоинты

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/info` | Версия и проверка доступности |
| GET | `/api/session?limit=&search=` | Список сессий (`{ data: [...] }`) |
| POST | `/api/session` | Создать: `title`, `location.directory`, `permissions` |
| GET | `/api/session/{id}` | Одна сессия |
| PATCH | `/api/session/{id}` | Переименование (`title`) |
| GET | `/api/session/{id}/message?limit=&order=` | История сообщений |
| POST | `/api/session/{id}/prompt` | `{ text, metadata, files }` |
| POST | `/api/session/{id}/interrupt` | Прервать ход |
| GET | `/api/session/{id}/permission` | Ожидающие разрешения |
| POST | `/api/session/{id}/permission/{requestID}/reply` | `{ decision, message }` |
| POST | `/api/session/{id}/model` | `{ model: { providerID, id, variant? } }` |
| POST | `/api/session/{id}/agent` | `{ agent }` |
| GET | `/api/agent` | Список агентов |
| GET | `/api/model` | Настроенные модели: `providerID`, `id`, `modelID`, `name` |
| GET | `/api/session/active` | Сессии, которые сейчас выполняются |
| GET | `/api/session/{id}/inbox` | Принятые, но не начатые prompt'ы |
| GET | `/api/session/{id}/form` | Ожидающие формы (`Form.Info[]`) |
| POST | `/api/session/{id}/form/{formID}/reply` | `{ answer: { key: value } }` |
| DELETE | `/api/session/{id}/form/{formID}?message=` | Отменить ожидающую форму |
| GET | `/api/event?types=…` | SSE-поток |

Авторизация — Basic `opencode:<password>`; пароль из `service.json`, конфига или
`OPENCODE_PASSWORD`.

## События SSE

Подписка (`src/opencode/client.ts`) запрашивает только нужные типы:

```
/api/event?types=session.text.delta&types=session.execution.succeeded&...
```

Повторяющийся параметр `types` обязателен: список через запятую OpenCode не понимает.

| Событие | Обработка |
|---|---|
| `session.inbox.enqueued` | Зеркалит prompt из Desktop/TUI в Telegram |
| `session.execution.started` | Начинает стрим, если его ещё нет |
| `session.text.started` / `delta` | Добавляет текст к сообщению |
| `session.text.ended` | Заменяет текст финальным |
| `session.tool.called` | Строка инструментов (последние 2, режим `showTools`) |
| `session.execution.succeeded/failed/interrupted` | Завершает ход, пишет футер |
| `permission.asked` | Отправляет сообщение с кнопками |
| `session.renamed` | Переименовывает тему форума |
| `session.created` | Кэширует `parentID`/`agent`/`title` новой сессии |
| `session.model.selected` | Обновляет имя модели в живом блоке |
| `session.synthetic` | Отчёт субагента (`<subagent>`) в чат родителя |
| `form.created` | Публикует форму выбора (payload `{form}`, sessionID внутри) |
| `form.replied` | Закрывает форму в чате с выбранными подписями |
| `form.cancelled` | Помечает форму в чате как отменённую |

`session.idle` не приходит вообще — конец хода определяется только `session.execution.*`.

**Формы.** `Form.Info` — это `{ id: "frm_…", sessionID, title, metadata, fields[] }`;
`metadata.kind` — `question`, `mcp-elicitation` или `websearch.provider`. Типы полей:
`string` (с `options[]` — один вариант, `custom` — свой текст), `multiselect`
(`minItems`/`maxItems`), `boolean`, `number`, `integer` (`minimum`/`maximum`),
`external` (ссылка, в чате не отвечается). Общие флаги: `required`, `hidden`,
`when[{key,op,value}]`, `default`. Тело ответа —
`{ answer: { [key]: string | number | boolean | string[] } }`; неверный ответ —
`400 FormInvalidAnswerError`, уже отвеченная форма — `409 FormAlreadySettledError`.
`form.created` эфемерно и может потеряться, поэтому адаптеры дополнительно опрашивают
`GET …/form` привязанных сессий раз в 20 с.

**Имя модели.** `session.model` сопоставляется с `/api/model` (`providerID/id` →
`name`, а также `modelID`); без имени — `providerID/id`, без модели — `unknown model`.
Литерал `OpenCode` не выводится никогда. Имя кэшируется на сессию и сбрасывается
по `session.model.selected`.

**Doctor.** Принятый `/prompt` запоминается; если за 30 с не пришёл
`session.execution.started`, мост пишет предупреждение в журнал, подсказку `/stop`
в чат и показывает её в панели (`warnings` в `/api/state`).

## Особенности

**Строгая очередь.** Все события обрабатываются последовательно (`eventChain`), иначе
зеркалированный вопрос мог бы прийти в чат после ответа. Каждый обработчик ограничен
20 секундами; зависший обработчик пропускается с записью в журнал.

**Поток волатильный.** SSE не хранит историю и не переигрывает пропущенное. При обрыве
клиент переподключается с экспоненциальной паузой (1–30 с) и заново получает `session.text.*`.
Текст, потерянный посреди хода, может остаться неполным до `session.text.ended`.

**Удалённая тема.** Если Telegram отвечает `message thread not found`, `Streamer` очищает
привязку (`store.clearThread`) и отправляет финальный текст в корень чата, чтобы ответ
не потерялся.

**Переименование в две стороны.** Переименование темы в Telegram обновляет `title`
сессии. `session.renamed` переименовывает тему. Защита от цикла — `appliedTitles`:
событие, вызванное собственным переименованием, игнорируется.

**Субагенты.** Сессии с `parentID` не зеркалятся и не принимают сообщения: тема,
привязанная к внутренней сессии, отвечает просьбой выбрать другую. При
`showSubagents` (по умолчанию) дочерний ход добавляет строку `🧩 <agent>` в
живой блок родителя, а отчёт `session.synthetic` уходит цитатой в чат родителя.

**Футер статистики.** Считается как `SessionTurn` в `packages/util/src/session-turn.ts`:

- `duration` = `time.completed` последнего assistant − `time.created` prompt;
- `tok/s` = сумма `output + reasoning` шагов хода / сумма (`streamed − firstToken`);
  показывается, только если окно генерации больше 200 мс;
- `context` = `input + cache.read + output + reasoning` последнего assistant.

Если история недоступна, длительность берётся из локального таймера стрима.

**Лимиты и пагинация.** Список сессий запрашивается с `limit` 8 (панель), 10 (`/sessions`)
и 50 (`/attach`); история — `limit=60&order=desc`, затем разворачивается в хронологию.
Глубокой пагинации нет: более старые сессии ищутся через `search`.

**Файлы.** Вложение уходит в `prompt` как `files: [{ uri: "data:<mime>;base64,…", name }]`.
Метаданные `{ source: "telegram" }` позволяют не зеркалить собственные сообщения обратно.
