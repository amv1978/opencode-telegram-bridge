using System.Globalization;
using System.Text.Json.Nodes;

namespace OcbridgeCli;

/// <summary>Все команды CLI.</summary>
internal static class Commands
{
    private const int LabelWidth = 14;

    // ---------------------------------------------------------------- status

    public static async Task<int> StatusAsync(ApiClient api)
    {
        var state = await api.GetAsync("/api/state");
        WriteRow("Состояние", Text(state?["state"]));
        WriteRow("Версия", Text(state?["version"]));
        WriteRow("Пользователь", User(state));
        WriteRow("OpenCode", VersionUrl(state));
        WriteRow("Telegram", OrDash(Text(state?["telegramMode"])));
        WriteRow("Uptime", Json.Uptime(state));
        WriteRow("Сессий", (state?["sessions"] as JsonArray)?.Count.ToString(CultureInfo.InvariantCulture) ?? "0");

        var error = Text(state?["error"]);
        if (error.Length > 0)
            Console.WriteLine("Ошибка:        " + error);
        return 0;
    }

    // ------------------------------------------------------------- update

    public static async Task<int> UpdateAsync(ApiClient api, List<string> args)
    {
        var mode = args.Count > 0 ? args[0].ToLowerInvariant() : "--check";
        if (mode == "--install")
        {
            var install = await api.PostAsync("/api/update/install");
            var error = Text(install?["update"]?["error"]);
            if (error.Length > 0)
            {
                Console.Error.WriteLine("Ошибка: " + error);
                return 1;
            }
            Console.WriteLine("Bundle скачивается и распаковывается, мост перезапустится автоматически.");
            return 0;
        }

        if (mode == "--rollback")
        {
            var rollback = await api.PostAsync("/api/update/rollback");
            var error = Text(rollback?["update"]?["error"]);
            if (error.Length > 0)
            {
                Console.Error.WriteLine("Ошибка: " + error);
                return 1;
            }
            Console.WriteLine("Откат запущен, мост перезапустится с предыдущей версией.");
            return 0;
        }

        if (mode is not ("--check" or "check"))
            throw new UsageException($"неизвестный параметр update: {args[0]} (ожидается --check, --install или --rollback)");

        var result = await api.PostAsync("/api/update/check");
        var update = result?["update"];
        WriteRow("Текущая", Text(update?["current"]));
        WriteRow("Последняя", Text(update?["latest"]));
        WriteRow("Доступна", update?["available"]?.GetValue<bool>() == true ? "да" : "нет");
        var prev = Text(update?["prevVersion"]);
        if (prev.Length > 0)
            WriteRow("Откат на", prev);
        var notes = Text(update?["notes"]);
        if (notes.Length > 0)
            Console.WriteLine("Заметки:       " + notes.Split('\n')[0]);
        var downloadError = Text(update?["error"]);
        if (downloadError.Length > 0)
            Console.Error.WriteLine("Ошибка: " + downloadError);
        return 0;
    }

    // ------------------------------------------------------------- bot control
    public static async Task<int> BotAsync(ApiClient api, string action)
    {
        await api.PostAsync("/api/bot/" + action);
        Console.WriteLine(action switch
        {
            "start" => "Бот запускается.",
            "stop" => "Бот остановлен.",
            _ => "Бот перезапускается.",
        });

        try
        {
            await Task.Delay(300);
            var state = await api.GetAsync("/api/state");
            var current = Text(state?["state"]);
            if (current.Length > 0)
                Console.WriteLine("Состояние: " + current);
        }
        catch (ApiException)
        {
            // состояние — необязательная информация, команда уже выполнена
        }
        return 0;
    }

    // ---------------------------------------------------------------- sessions

    public static async Task<int> SessionsAsync(ApiClient api, List<string> args)
    {
        var asJson = false;
        foreach (var arg in args)
        {
            if (arg is "--json" or "-j") asJson = true;
            else throw new UsageException($"неизвестный параметр sessions: {arg}");
        }

        var node = await api.GetAsync("/api/sessions");
        var sessions = node?["sessions"] as JsonArray ?? new JsonArray();

        if (asJson)
        {
            Console.WriteLine(sessions.ToJsonString(Program.PrettyJson));
            return 0;
        }

        if (sessions.Count == 0)
        {
            Console.WriteLine("Сессий нет.");
            return 0;
        }

        var rows = new List<string[]>();
        foreach (var item in sessions)
        {
            rows.Add(new[]
            {
                OrDash(Text(item?["id"])),
                Clean(Text(item?["title"]), 44),
                OrDash(Clean(Text(item?["directory"]), 46)),
            });
        }

        WriteTable(new[] { "ID", "TITLE", "DIRECTORY" }, rows);
        return 0;
    }

    // -------------------------------------------------------------------- logs

    public static async Task<int> LogsAsync(ApiClient api, List<string> args)
    {
        var lines = 100;
        var follow = false;

        for (var i = 0; i < args.Count; i++)
        {
            switch (args[i])
            {
                case "-n" or "--lines":
                    if (i + 1 >= args.Count)
                        throw new UsageException("после -n требуется число строк");
                    if (!int.TryParse(args[++i], NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) || n <= 0)
                        throw new UsageException($"некорректное число строк: {args[i]}");
                    lines = Math.Min(n, 1000);
                    break;
                case "-f" or "--follow":
                    follow = true;
                    break;
                default:
                    throw new UsageException($"неизвестный параметр logs: {args[i]}");
            }
        }

        var initial = SplitLines(await FetchLogAsync(api, follow ? 1000 : lines));
        if (!follow)
        {
            foreach (var line in initial.Skip(Math.Max(0, initial.Count - lines))) Console.WriteLine(line);
            return 0;
        }

        var from = Math.Max(0, initial.Count - lines);
        for (var i = from; i < initial.Count; i++) Console.WriteLine(initial[i]);
        Console.Out.Flush();
        Console.Error.WriteLine("Слежение за логом (новые строки каждые 2 с), Ctrl+C — остановить.");

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cts.Cancel();
        };

        var previous = initial;
        try
        {
            while (true)
            {
                await Task.Delay(2000, cts.Token);
                var current = SplitLines(await FetchLogAsync(api, 1000));
                foreach (var line in Diff(previous, current)) Console.WriteLine(line);
                Console.Out.Flush();
                previous = current;
            }
        }
        catch (OperationCanceledException)
        {
            Console.Error.WriteLine();
            return 0;
        }
    }

    private static async Task<string> FetchLogAsync(ApiClient api, int lines)
    {
        var node = await api.GetAsync($"/api/log?lines={lines.ToString(CultureInfo.InvariantCulture)}");
        return Text(node?["log"]);
    }

    private static List<string> SplitLines(string text)
    {
        var list = text.Replace("\r\n", "\n").Split('\n').ToList();
        while (list.Count > 0 && list[^1].Length == 0) list.RemoveAt(list.Count - 1);
        return list;
    }

    /// <summary>Строки, появившиеся после последней известной строки.</summary>
    private static List<string> Diff(List<string> previous, List<string> current)
    {
        if (previous.Count == 0 || current.Count == 0) return current;

        var anchor = previous[^1];
        for (var i = current.Count - 1; i >= 0; i--)
        {
            if (current[i] == anchor)
                return current.Skip(i + 1).ToList();
        }
        // Лог обрезан или перезаписан — печатаем всё, что видим.
        return current;
    }

    // ------------------------------------------------------------------ config

    public static async Task<int> ConfigAsync(ApiClient api, List<string> args)
    {
        if (args.Count == 0)
            throw new UsageException("ожидается config get [key] или config set key=value");

        return args[0].ToLowerInvariant() switch
        {
            "get" => await ConfigGetAsync(api, args.Skip(1).ToList()),
            "set" => await ConfigSetAsync(api, args.Skip(1).ToList()),
            _ => throw new UsageException($"неизвестное действие config: {args[0]} (ожидается get или set)"),
        };
    }

    private static async Task<int> ConfigGetAsync(ApiClient api, List<string> args)
    {
        if (args.Count > 1)
            throw new UsageException("config get принимает не больше одного ключа");

        var state = await api.GetAsync("/api/state");
        var config = state?["config"];
        if (config is null)
            throw new ApiException("API не вернул секцию config");

        if (args.Count == 0)
        {
            Console.WriteLine(config.ToJsonString(Program.PrettyJson));
            return 0;
        }

        var key = args[0];
        if (!Json.TryGet(config, key, out var value))
        {
            // Известный параметр может отсутствовать в снапшоте (undefined в JSON).
            if (ConfigKeys.ContainsKey(key))
            {
                Console.WriteLine("(не задано)");
                return 0;
            }
            throw new UsageException($"нет такого ключа: {key}");
        }

        Console.WriteLine(value is null ? "(не задано)" : Json.Text(value));
        return 0;
    }

    private static async Task<int> ConfigSetAsync(ApiClient api, List<string> args)
    {
        if (args.Count != 1)
            throw new UsageException("ожидается ровно один аргумент: config set key=value");

        var assignment = args[0];
        var eq = assignment.IndexOf('=');
        if (eq <= 0)
            throw new UsageException("ожидается key=value, например mode=both");

        var key = assignment[..eq].Trim();
        var raw = assignment[(eq + 1)..];

        if (!ConfigKeys.TryGetValue(key, out var spec))
            throw new UsageException($"неизвестный ключ конфигурации: {key}");

        var value = ParseValue(key, raw, spec);
        object body = value;
        for (var i = spec.Path.Length - 1; i >= 1; i--)
            body = new Dictionary<string, object?> { [spec.Path[i]] = body };
        var patch = new Dictionary<string, object?> { [spec.Path[0]] = body };

        await api.PostAsync("/api/config", patch);
        Console.WriteLine($"Готово: {key} = {Display(value)}");
        return 0;
    }

    private enum Kind { Text, Number, Bool }

    private sealed record KeySpec(string[] Path, Kind Kind, string[]? Allowed = null, long Min = long.MinValue, long Max = long.MaxValue);

    private static KeySpec S(string[] path, Kind kind, string[]? allowed = null, long min = long.MinValue, long max = long.MaxValue)
        => new(path, kind, allowed, min, max);

    private static readonly Dictionary<string, KeySpec> ConfigKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        ["mode"] = S(["mode"], Kind.Text, ["topics", "private", "both"]),
        ["topicsChatId"] = S(["topicsChatId"], Kind.Number),
        ["defaultDirectory"] = S(["defaultDirectory"], Kind.Text),
        ["autoTopics"] = S(["autoTopics"], Kind.Bool),
        ["editIntervalMs"] = S(["stream", "editIntervalMs"], Kind.Number, null, 500, 10000),
        ["stream.editIntervalMs"] = S(["stream", "editIntervalMs"], Kind.Number, null, 500, 10000),
        ["showTools"] = S(["stream", "showTools"], Kind.Text, ["off", "compact", "full"]),
        ["stream.showTools"] = S(["stream", "showTools"], Kind.Text, ["off", "compact", "full"]),
        ["format"] = S(["stream", "format"], Kind.Text, ["rich", "html"]),
        ["stream.format"] = S(["stream", "format"], Kind.Text, ["rich", "html"]),
        ["proxy"] = S(["telegram", "proxy"], Kind.Text),
        ["telegram.proxy"] = S(["telegram", "proxy"], Kind.Text),
        ["apiIp"] = S(["telegram", "apiIp"], Kind.Text),
        ["telegram.apiIp"] = S(["telegram", "apiIp"], Kind.Text),
        ["ui.theme"] = S(["ui", "theme"], Kind.Text, ["opencode", "matrix"]),
        ["ui.scheme"] = S(["ui", "scheme"], Kind.Text, ["system", "light", "dark"]),
    };

    private static object ParseValue(string key, string raw, KeySpec spec)
    {
        switch (spec.Kind)
        {
            case Kind.Bool:
                if (bool.TryParse(raw.Trim(), out var flag)) return flag;
                throw new UsageException($"для {key} ожидается true или false, получено «{raw}»");

            case Kind.Number:
                if (!long.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var number))
                    throw new UsageException($"для {key} ожидается целое число, получено «{raw}»");
                if (number < spec.Min || number > spec.Max)
                    throw new UsageException($"для {key} допустим диапазон {spec.Min}…{spec.Max}");
                return number;

            default:
                var text = raw;
                if (spec.Allowed is null) return text;
                var match = spec.Allowed.FirstOrDefault(a => a.Equals(text, StringComparison.OrdinalIgnoreCase));
                if (match is null)
                    throw new UsageException($"для {key} допустимо: {string.Join(", ", spec.Allowed)}");
                return match;
        }
    }

    private static string Display(object value) => value switch
    {
        bool b => b ? "true" : "false",
        string s => s.Length == 0 ? "(пусто)" : s,
        _ => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "",
    };

    // --------------------------------------------------------------- autostart

    public static async Task<int> AutostartAsync(ApiClient api, List<string> args)
    {
        if (args.Count != 1)
            throw new UsageException("ожидается autostart on|off|status");

        var action = args[0].ToLowerInvariant();

        if (action == "status")
        {
            var state = await api.GetAsync("/api/state");
            PrintAutostart(state);
            return 0;
        }

        if (action is not ("on" or "off"))
            throw new UsageException($"неизвестное действие autostart: {args[0]} (ожидается on, off или status)");

        var enabled = action == "on";
        await api.PostAsync("/api/autostart", new Dictionary<string, object?> { ["enabled"] = enabled });
        Console.WriteLine(enabled ? "Автозапуск включён." : "Автозапуск отключён.");
        return 0;
    }

    private static void PrintAutostart(JsonNode? state)
    {
        var enabled = state?["autostart"] is JsonValue ev && ev.TryGetValue<bool>(out var e) && e;
        var supported = state?["autostartSupported"] is JsonValue sv && sv.TryGetValue<bool>(out var s) && s;

        WriteRow("Автозапуск", enabled ? "включён" : "отключён");
        WriteRow("Поддержка", supported ? "да" : "нет (dev-сборка или не Windows)");
    }

    // ------------------------------------------------------------------ doctor

    public static async Task<int> DoctorAsync(ApiClient api)
    {
        var failures = 0;

        void Ok(string text) => Console.WriteLine("✔ " + text);
        void Fail(string text)
        {
            failures++;
            Console.WriteLine("✖ " + text);
        }

        JsonNode? state;
        try
        {
            state = await api.GetAsync("/api/state");
        }
        catch (ApiException ex)
        {
            Fail($"API: {ex.Message}");
            Console.WriteLine("  Подсказка: запустите приложение или ocbridge.exe --no-browser");
            return ex.ExitCode == 3 ? 3 : 1;
        }

        Ok($"API: {api.BaseUrl} доступен");

        var stateName = Text(state?["state"]);
        var error = Text(state?["error"]);
        if (stateName == "error")
            Fail($"Состояние: error — {OrDash(error)}");
        else
            Ok($"Состояние: {OrDash(stateName)}");

        var ocVersion = Text(state?["ocVersion"]);
        var ocUrl = Text(state?["ocUrl"]);
        if (ocVersion.Length > 0 && ocUrl.Length > 0)
            Ok($"OpenCode: {ocVersion} ({ocUrl})");
        else if (ocVersion.Length > 0)
            Ok($"OpenCode: {ocVersion}");
        else
            Fail("OpenCode: версия не определена (сервис не найден или не запущен)");

        var username = Text(state?["username"]);
        if (username.Length > 0)
            Ok($"Telegram: @{username}");
        else
            Fail("Telegram: username не получен (бот не подключён)");

        var configPath = Text(state?["configPath"]);
        if (configPath.Length == 0)
            Fail("Конфиг: путь не указан");
        else if (!File.Exists(configPath))
            Fail($"Конфиг: файл не найден — {configPath}");
        else
            Ok($"Конфиг: {configPath}");

        var supported = state?["autostartSupported"] is JsonValue sv && sv.TryGetValue<bool>(out var s) && s;
        var enabled = state?["autostart"] is JsonValue ev && ev.TryGetValue<bool>(out var e) && e;
        if (supported)
            Ok($"Автозапуск: {(enabled ? "включён" : "отключён")}, поддерживается");
        else
            Fail("Автозапуск: не поддерживается (dev-сборка или не Windows)");

        var hasToken = state?["config"]?["hasToken"] is JsonValue tv && tv.TryGetValue<bool>(out var t) && t;
        var tokenTail = Text(state?["config"]?["tokenTail"]);
        if (hasToken)
            Ok($"Токен Telegram: задан ({tokenTail})");
        else
            Fail("Токен Telegram: не задан (config set telegram.token=… недоступен через CLI)");

        Console.WriteLine();
        Console.WriteLine(failures == 0 ? "Все проверки пройдены." : $"Проблем: {failures}.");
        return failures == 0 ? 0 : 1;
    }

    // ----------------------------------------------------------------- version

    public static async Task<int> VersionAsync(ApiClient api)
    {
        Console.WriteLine($"ocbridge-cli {Program.Version}");

        JsonNode? state;
        try
        {
            state = await api.GetAsync("/api/state");
        }
        catch (ApiException ex)
        {
            Console.WriteLine("API: недоступен");
            Console.Error.WriteLine("Ошибка: " + ex.Message);
            if (ex.ExitCode == 3)
                Console.Error.WriteLine("Подсказка: запустите приложение или ocbridge.exe --no-browser");
            return ex.ExitCode;
        }

        var apiVersion = Text(state?["version"]);
        Console.WriteLine(apiVersion.Length > 0
            ? $"API: {apiVersion}"
            : "API: неизвестна (поле version отсутствует в /api/state)");

        var ocVersion = Text(state?["ocVersion"]);
        if (ocVersion.Length > 0)
            Console.WriteLine($"OpenCode: {ocVersion}");

        return 0;
    }

    // ---------------------------------------------------------------- helpers

    private static string Text(JsonNode? node) => Json.Text(node);

    private static string OrDash(string value) => value.Length == 0 ? "—" : value;

    private static string User(JsonNode? state)
    {
        var name = Text(state?["username"]);
        return name.Length == 0 ? "—" : "@" + name;
    }

    private static string VersionUrl(JsonNode? state)
    {
        var version = Text(state?["ocVersion"]);
        var url = Text(state?["ocUrl"]);
        if (version.Length == 0 && url.Length == 0) return "—";
        if (version.Length == 0) return url;
        if (url.Length == 0) return version;
        return $"{version} ({url})";
    }

    /// <summary>Убирает переводы строк и обрезает длинный текст.</summary>
    private static string Clean(string value, int max)
    {
        var flat = value.Replace("\r", " ").Replace("\n", " ").Replace("\t", " ");
        while (flat.Contains("  ")) flat = flat.Replace("  ", " ");
        flat = flat.Trim();
        return flat.Length <= max ? flat : flat[..(max - 1)] + "…";
    }

    private static void WriteRow(string label, string value)
        => Console.WriteLine(label.PadRight(LabelWidth) + value);

    private static void WriteTable(string[] headers, List<string[]> rows)
    {
        var widths = new int[headers.Length];
        for (var c = 0; c < headers.Length; c++)
        {
            widths[c] = headers[c].Length;
            foreach (var row in rows)
                widths[c] = Math.Max(widths[c], row[c].Length);
        }

        PrintRow(headers);
        PrintRow(widths.Select(w => new string('-', w)).ToArray());

        foreach (var row in rows) PrintRow(row);
        return;

        void PrintRow(string[] cells)
        {
            var parts = new string[cells.Length];
            for (var c = 0; c < cells.Length; c++)
                parts[c] = c == cells.Length - 1 ? cells[c] : cells[c].PadRight(widths[c] + 2);
            Console.WriteLine(string.Join("", parts).TrimEnd());
        }
    }
}
