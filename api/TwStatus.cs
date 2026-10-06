using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

public class TwStatus
{
    private readonly HttpClient _http;

    public TwStatus(IHttpClientFactory f)
    {
        _http = f.CreateClient();
        _http.Timeout = TimeSpan.FromSeconds(15);
    }

    [Function("TwStatus")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "tw/status")]
        HttpRequestData req)
    {
        var qs = System.Web.HttpUtility.ParseQueryString(req.Url.Query);

        var site = qs["site"] ?? "Wargrave";
        var debug = qs["debug"] == "1";
        var useV1 = qs["v1"] == "1";

        var id = Environment.GetEnvironmentVariable("TW_CLIENT_ID");
        var secret = Environment.GetEnvironmentVariable("TW_CLIENT_SECRET");

        if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(secret))
        {
            return await Json(req, HttpStatusCode.InternalServerError, new
            {
                ok = false,
                stage = "config",
                error = "Missing TW_CLIENT_ID or TW_CLIENT_SECRET"
            });
        }

        var url = useV1
            ? $"https://prod-tw-opendata-app.uk-e1.cloudhub.io/data/STE/v1/DischargeCurrentStatus?col_1=LocationName&operand_1=eq&value_1={Uri.EscapeDataString(site)}"
            : "https://api.thameswater.co.uk/opendata/v2/discharge/status";

        using var msg = new HttpRequestMessage(HttpMethod.Get, url);
        msg.Headers.Add("client_id", id);
        msg.Headers.Add("client_secret", secret);
        msg.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        msg.Headers.UserAgent.ParseAdd("FerryLaneSwimming/1.0");

        var sw = Stopwatch.StartNew();

        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(12));
            var upstream = await _http.SendAsync(msg, cts.Token);
            var body = await upstream.Content.ReadAsStringAsync(cts.Token);
            sw.Stop();

            if (!upstream.IsSuccessStatusCode)
            {
                return await Json(req, upstream.StatusCode, new
                {
                    ok = false,
                    stage = "upstream",
                    site,
                    source = useV1 ? "v1" : "v2",
                    upstreamUrl = url,
                    upstreamStatus = (int)upstream.StatusCode,
                    elapsedMs = sw.ElapsedMilliseconds,
                    body = debug ? body : ""
                });
            }

            // Legacy v1 path: return raw body as before.
            // Mostly kept for comparison/debug.
            if (useV1)
            {
                if (!debug)
                    return await RawJson(req, HttpStatusCode.OK, body, "public, max-age=120");

                return await Json(req, HttpStatusCode.OK, new
                {
                    ok = true,
                    stage = "success",
                    site,
                    source = "v1",
                    upstreamUrl = url,
                    elapsedMs = sw.ElapsedMilliseconds,
                    bodyLength = body.Length,
                    bodyPreview = body.Length > 3000 ? body[..3000] + "...[truncated]" : body
                });
            }

            // v2 path: parse full list, filter locally.
            using var doc = JsonDocument.Parse(body);

            if (!doc.RootElement.TryGetProperty("items", out var items) ||
                items.ValueKind != JsonValueKind.Array)
            {
                return await Json(req, HttpStatusCode.BadGateway, new
                {
                    ok = false,
                    stage = "parse",
                    source = "v2",
                    site,
                    error = "Response did not contain an items array",
                    bodyPreview = debug ? (body.Length > 3000 ? body[..3000] + "...[truncated]" : body) : ""
                });
            }

            var exactMatches = new List<JsonElement>();
            var containsMatches = new List<JsonElement>();
            var sampleNames = new List<string>();

            foreach (var item in items.EnumerateArray())
            {
                var name = GetString(item, "locationName");

                if (!string.IsNullOrWhiteSpace(name))
                {
                    if (sampleNames.Count < 30) sampleNames.Add(name);

                    if (string.Equals(name, site, StringComparison.OrdinalIgnoreCase))
                    {
                        exactMatches.Add(item.Clone());
                    }
                    else if (name.Contains(site, StringComparison.OrdinalIgnoreCase))
                    {
                        containsMatches.Add(item.Clone());
                    }
                }
            }

            var matches = exactMatches.Count > 0 ? exactMatches : containsMatches;

            if (!debug)
            {
                return await Json(req, HttpStatusCode.OK, new
                {
                    items = matches
                }, "public, max-age=120");
            }

            return await Json(req, HttpStatusCode.OK, new
            {
                ok = true,
                stage = "success",
                source = "v2",
                site,
                upstreamUrl = url,
                elapsedMs = sw.ElapsedMilliseconds,
                totalItems = items.GetArrayLength(),
                exactMatchCount = exactMatches.Count,
                containsMatchCount = containsMatches.Count,
                returnedCount = matches.Count,
                items = matches,
                sampleNames
            });
        }
        catch (TaskCanceledException ex)
        {
            sw.Stop();
            return await Json(req, HttpStatusCode.GatewayTimeout, new
            {
                ok = false,
                stage = "timeout",
                site,
                elapsedMs = sw.ElapsedMilliseconds,
                error = ex.Message
            });
        }
        catch (Exception ex)
        {
            sw.Stop();
            return await Json(req, HttpStatusCode.BadGateway, new
            {
                ok = false,
                stage = "exception",
                site,
                elapsedMs = sw.ElapsedMilliseconds,
                error = ex.Message
            });
        }
    }

    private static string? GetString(JsonElement e, string name)
    {
        return e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;
    }

    private static async Task<HttpResponseData> Json(
        HttpRequestData req,
        HttpStatusCode code,
        object payload,
        string cacheControl = "no-store")
    {
        var res = req.CreateResponse(code);
        res.Headers.Add("Cache-Control", cacheControl);
        res.Headers.Add("Content-Type", "application/json; charset=utf-8");

        await res.WriteStringAsync(JsonSerializer.Serialize(payload, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        }));

        return res;
    }

    private static async Task<HttpResponseData> RawJson(
        HttpRequestData req,
        HttpStatusCode code,
        string json,
        string cacheControl = "no-store")
    {
        var res = req.CreateResponse(code);
        res.Headers.Add("Cache-Control", cacheControl);
        res.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await res.WriteStringAsync(json);
        return res;
    }
}
