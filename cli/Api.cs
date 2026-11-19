using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OcbridgeCli;

/// <summary>Ошибка, которая уже содержит нужный код выхода процесса.</summary>
internal sealed class ApiException : Exception
{
    public int ExitCode { get; }

    public ApiException(string message, int exitCode = 1) : base(message) => ExitCode = exitCode;
}

/// <summary>Ошибка разбора аргументов (код выхода 2).</summary>
internal sealed class UsageException(string message) : Exception(message);

/// <summary>Минимальный клиент локального JSON API демона.</summary>
internal sealed class ApiClient
{
    private static readonly HttpClient Http = CreateHttp();

    private readonly string _baseUrl;

    public ApiClient(string baseUrl) => _baseUrl = baseUrl.TrimEnd('/');

    public string BaseUrl => _baseUrl;

    public Task<JsonNode?> GetAsync(string path, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Get, path, null, ct);

    public Task<JsonNode?> PostAsync(string path, object? body = null, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Post, path, body, ct);

    private static HttpClient CreateHttp()
    {
        var handler = new SocketsHttpHandler
        {
            ConnectTimeout = TimeSpan.FromSeconds(5),
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
        };
        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(10) };
    }

    private async Task<JsonNode?> SendAsync(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, _baseUrl + path);
        if (body is not null)
            request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        HttpResponseMessage response;
        try
        {
            response = await Http.SendAsync(request, ct);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new ApiException($"Таймаут запроса к {_baseUrl}{path} (10 с)");
        }
        catch (HttpRequestException ex)
        {
            if (IsConnectionRefused(ex))
                throw new ApiException($"Демон не отвечает на {_baseUrl}", 3);
            throw new ApiException($"Не удалось подключиться к {_baseUrl}: {ex.Message}");
        }
        catch (IOException ex)
        {
            throw new ApiException($"Ошибка сети при запросе к {_baseUrl}: {ex.Message}");
        }

        string text;
        try
        {
            text = await response.Content.ReadAsStringAsync(ct);
        }
        catch (Exception ex) when (ex is IOException or TaskCanceledException)
        {
            throw new ApiException($"Не удалось прочитать ответ API: {ex.Message}");
        }

        if (!response.IsSuccessStatusCode)
        {
            var message = ExtractError(text);
            if (string.IsNullOrWhiteSpace(message))
                message = $"HTTP {(int)response.StatusCode} {ReasonPhrase(response.StatusCode)}";
            throw new ApiException(message);
        }

        if (string.IsNullOrWhiteSpace(text))
            return null;

        try
        {
            return JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            throw new ApiException("Некорректный JSON в ответе API");
        }
    }

    private static bool IsConnectionRefused(HttpRequestException ex)
    {
        if (ex.HttpRequestError == HttpRequestError.ConnectionError)
            return true;
        for (Exception? inner = ex.InnerException; inner is not null; inner = inner.InnerException)
        {
            if (inner is SocketException socket)
            {
                return socket.SocketErrorCode is SocketError.ConnectionRefused
                    or SocketError.ConnectionReset
                    or SocketError.HostUnreachable
                    or SocketError.NetworkUnreachable
                    or SocketError.TimedOut
                    or SocketError.HostNotFound;
            }
        }
        return false;
    }

    private static string? ExtractError(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
            return null;
        try
        {
            var node = JsonNode.Parse(body);
            if (node?["error"] is JsonValue value && value.TryGetValue<string>(out var text))
                return text;
        }
        catch (JsonException)
        {
            // не JSON — вернём как есть ниже
        }
        var trimmed = body.Trim();
        return trimmed.Length > 300 ? trimmed[..300] + "…" : trimmed;
    }

    private static string ReasonPhrase(HttpStatusCode code) => code switch
    {
        HttpStatusCode.BadRequest => "Bad Request",
        HttpStatusCode.NotFound => "Not Found",
        HttpStatusCode.InternalServerError => "Internal Server Error",
        _ => code.ToString(),
    };
}
