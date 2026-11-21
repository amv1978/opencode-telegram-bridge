namespace OcbridgeCli;

/// <summary>Справка (на русском, по одной строке на команду).</summary>
internal static class Help
{
    public static void PrintGeneral()
    {
        Console.WriteLine("ocbridge-cli — консольный клиент локального API OpenCode Bridge");
        Console.WriteLine();
        Console.WriteLine("Использование:");
        Console.WriteLine("  ocbridge-cli [--url URL] <команда> [параметры]");
        Console.WriteLine();
        Console.WriteLine("Команды:");
        Console.WriteLine("  status                    состояние демона: state, @username, версия и адрес OpenCode, режим Telegram, uptime, число сессий");
        Console.WriteLine("  start                     запустить бота");
        Console.WriteLine("  stop                      остановить бота");
        Console.WriteLine("  restart                   перезапустить бота");
        Console.WriteLine("  sessions [--json]         список сессий (id, title, directory); --json — сырой JSON");
        Console.WriteLine("  logs [-n N] [--follow]    последние N строк лога (по умолчанию 100); --follow — досматривать новые каждые 2 с");
        Console.WriteLine("  config get [key]          снапшот конфигурации или одно значение по dot-path");
        Console.WriteLine("  config set key=value      изменить параметр конфигурации");
        Console.WriteLine("  autostart on|off|status   автозапуск приложения");
        Console.WriteLine("  doctor                    диагностика API, демона, OpenCode, Telegram, конфига и автозапуска");
        Console.WriteLine("  update [--check|--install|--rollback] проверка, установка bundle или откат на предыдущую версию");
        Console.WriteLine("  version                   версия CLI и версия API");
        Console.WriteLine("  help [команда]            эта справка или справка по команде");
        Console.WriteLine();
        Console.WriteLine("Опции:");
        Console.WriteLine("  --url URL                 адрес API (по умолчанию http://127.0.0.1:7788; env OCBRIDGE_URL)");
        Console.WriteLine();
        Console.WriteLine("Коды выхода: 0 — успех, 1 — ошибка API/HTTP, 2 — ошибка аргументов, 3 — демон не запущен.");
    }

    public static void PrintCommand(string command)
    {
        var text = command.ToLowerInvariant() switch
        {
            "status" => new[]
            {
                "status — состояние демона.",
                "Показывает state, @username, версию и адрес OpenCode, режим Telegram, uptime и число сессий.",
            },
            "start" => new[] { "start — запустить бота (POST /api/bot/start)." },
            "stop" => new[] { "stop — остановить бота (POST /api/bot/stop)." },
            "restart" => new[] { "restart — перезапустить бота (POST /api/bot/restart)." },
            "sessions" => new[]
            {
                "sessions [--json] — список сессий OpenCode.",
                "Без флага печатает таблицу id/title/directory; --json — сырой массив JSON.",
            },
            "logs" or "log" => new[]
            {
                "logs [-n N] [--follow] — хвост лога демона.",
                "-n N      сколько строк показать (по умолчанию 100, максимум 1000).",
                "--follow  опрашивать API каждые 2 с и печатать только новые строки (Ctrl+C — выход).",
            },
            "config" => new[]
            {
                "config get [key] — конфигурация демона.",
                "  без key — pretty JSON снапшота config.",
                "  с key   — только значение; dot-path: mode, defaultDirectory, autoTopics, topicsChatId,",
                "            stream.format, stream.showTools, stream.editIntervalMs, telegram.proxy, telegram.apiIp, ui.theme, ui.scheme.",
                "config set key=value — изменить параметр; числа и true/false передаются в API как числа и булевы.",
                "  примеры: config set mode=both | stream.editIntervalMs=1800 | ui.theme=matrix | defaultDirectory=D:\\work",
            },
            "autostart" => new[]
            {
                "autostart on|off|status — автозапуск приложения.",
                "  on/off — POST /api/autostart; status — из /api/state (autostart, autostartSupported).",
            },
            "doctor" => new[]
            {
                "doctor — диагностика: доступность API, state, версия OpenCode, Telegram username,",
                "путь к конфигу, поддержка автозапуска. Каждая проверка — строка ✔ или ✖.",
            },
            "version" => new[] { "version — версия CLI и версия API из /api/state." },
            "update" => new[]
            {
                "update [--check|--install|--rollback] — обновление из GitHub Releases.",
                "  --check (по умолчанию) — POST /api/update/check и вывод текущей/последней версии.",
                "  --install — POST /api/update/install: скачать bundle, проверить SHA256, распаковать и перезапуститься.",
                "  --rollback — POST /api/update/rollback: вернуть версию из prev и перезапуститься.",
            },
            "help" => new[] { "help [команда] — общая справка или справка по команде." },
            _ => Array.Empty<string>(),
        };

        if (text.Length == 0)
            throw new UsageException($"нет справки для команды «{command}»");

        foreach (var line in text)
            Console.WriteLine(line);
    }
}
