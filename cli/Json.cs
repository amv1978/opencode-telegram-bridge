using System.Globalization;
using System.Text.Json.Nodes;

namespace OcbridgeCli;

/// <summary>Помощники для чтения JsonNode без строгих моделей.</summary>
internal static class Json
{
    /// <summary>Скаляр как текст без кавычек; объекты/массивы — как JSON.</summary>
    public static string Text(JsonNode? node)
    {
        switch (node)
        {
            case null:
                return "";
            case JsonObject or JsonArray:
                return node.ToJsonString(Program.PrettyJson);
            case JsonValue value:
                if (value.TryGetValue<string>(out var text)) return text;
                if (value.TryGetValue<bool>(out var flag)) return flag ? "true" : "false";
                return value.ToJsonString();
            default:
                return node.ToJsonString();
        }
    }

    /// <summary>
    /// Читает значение по dot-path. Для снапшота /api/state плоские имена
    /// (stream.format, telegram.proxy) разворачиваются в фактические ключи.
    /// </summary>
    public static bool TryGet(JsonNode? root, string path, out JsonNode? value)
    {
        value = root;
        var actual = Alias(path);

        foreach (var segment in actual.Split('.', StringSplitOptions.RemoveEmptyEntries))
        {
            if (value is JsonObject obj && obj.TryGetPropertyValue(segment, out var child))
            {
                value = child;
            }
            else if (value is JsonArray array
                     && int.TryParse(segment, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index)
                     && index >= 0 && index < array.Count)
            {
                value = array[index];
            }
            else
            {
                value = null;
                return false;
            }
        }
        return true;
    }

    /// <summary>Плоские ключи снапшота → привычные dot-path конфига.</summary>
    private static string Alias(string key) => key switch
    {
        "telegram.proxy" => "proxy",
        "telegram.apiIp" => "apiIp",
        "telegram.tokenTail" => "tokenTail",
        "telegram.hasToken" => "hasToken",
        "stream.format" => "format",
        "stream.showTools" => "showTools",
        "stream.editIntervalMs" => "editIntervalMs",
        _ => key,
    };

    public static string Uptime(JsonNode? state)
    {
        if (state?["startedAt"] is not JsonValue value || !value.TryGetValue<long>(out var startedAt) || startedAt <= 0)
            return "—";

        var delta = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - startedAt;
        if (delta < 0) delta = 0;
        var span = TimeSpan.FromMilliseconds(delta);

        if (span.TotalDays >= 1)
            return $"{(int)span.TotalDays}д {span.Hours}ч {span.Minutes}м";
        if (span.TotalHours >= 1)
            return $"{span.Hours}ч {span.Minutes}м";
        if (span.TotalMinutes >= 1)
            return $"{span.Minutes}м {span.Seconds}с";
        return $"{span.Seconds}с";
    }
}
