using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OcbridgeCli;

internal static class Program
{
    public const string Version = "0.6.1";
    public const string DefaultUrl = "http://127.0.0.1:7788";

    public static readonly JsonSerializerOptions PrettyJson = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);

        try
        {
            return await RunAsync(args);
        }
        catch (UsageException ex)
        {
            Console.Error.WriteLine("Ошибка: " + ex.Message);
            Console.Error.WriteLine("Справка: ocbridge-cli help");
            return 2;
        }
        catch (ApiException ex)
        {
            Console.Error.WriteLine("Ошибка: " + ex.Message);
            if (ex.ExitCode == 3)
                Console.Error.WriteLine("Подсказка: запустите приложение или ocbridge.exe --no-browser");
            return ex.ExitCode;
        }
    }

    private static async Task<int> RunAsync(string[] rawArgs)
    {
        var args = new List<string>(rawArgs);
        var url = ParseGlobalOptions(args);

        if (args.Count == 0)
        {
            Help.PrintGeneral();
            return 0;
        }

        var command = args[0].ToLowerInvariant();
        args.RemoveAt(0);
        var api = new ApiClient(url);

        switch (command)
        {
            case "help" or "-h" or "--help" or "/?":
                if (args.Count > 0) Help.PrintCommand(args[0]);
                else Help.PrintGeneral();
                return 0;
            case "status":
                return await Commands.StatusAsync(api);
            case "start":
                return await Commands.BotAsync(api, "start");
            case "stop":
                return await Commands.BotAsync(api, "stop");
            case "restart":
                return await Commands.BotAsync(api, "restart");
            case "sessions":
                return await Commands.SessionsAsync(api, args);
            case "logs" or "log":
                return await Commands.LogsAsync(api, args);
            case "config":
                return await Commands.ConfigAsync(api, args);
            case "autostart":
                return await Commands.AutostartAsync(api, args);
            case "doctor":
                return await Commands.DoctorAsync(api);
            case "update":
                return await Commands.UpdateAsync(api, args);
            case "version" or "--version" or "-v":
                return await Commands.VersionAsync(api);
            default:
                Console.Error.WriteLine($"Ошибка: неизвестная команда «{command}»");
                Console.Error.WriteLine("Справка: ocbridge-cli help");
                return 2;
        }
    }

    /// <summary>Забирает --url/--url= из аргументов, учитывает OCBRIDGE_URL.</summary>
    private static string ParseGlobalOptions(List<string> args)
    {
        string? url = null;
        for (var i = 0; i < args.Count; i++)
        {
            var arg = args[i];
            if (arg == "--url" || arg == "-u")
            {
                if (i + 1 >= args.Count)
                    throw new UsageException("после --url требуется адрес, например http://127.0.0.1:7788");
                url = args[i + 1];
                args.RemoveRange(i, 2);
                i--;
            }
            else if (arg.StartsWith("--url=", StringComparison.Ordinal))
            {
                url = arg["--url=".Length..];
                args.RemoveAt(i);
                i--;
            }
        }

        url ??= Environment.GetEnvironmentVariable("OCBRIDGE_URL");
        if (string.IsNullOrWhiteSpace(url))
            url = DefaultUrl;
        url = url.Trim();

        if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            && !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            url = "http://" + url;

        if (!Uri.TryCreate(url, UriKind.Absolute, out _))
            throw new UsageException($"некорректный адрес API: {url}");

        return url;
    }
}
