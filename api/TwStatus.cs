using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

public class TwStatus
{
    private readonly HttpClient _http;

    public TwStatus(IHttpClientFactory f)
    {
        _http = f.CreateClient();
        _http.Timeout = TimeSpan.FromSeconds(12);
    }

    [Function("TwStatus")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "tw/status")]
        HttpRequestData req)
    {
        var qs = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        var site = qs["site"] ?? "Wargrave";
        var debug = qs["debug"] == "1";

        var baseUrl = "https://prod-tw-opendata-app.uk-e1.cloudhub.io/data/STE/v1/DischargeCurrentStatus";
        var url = $"{baseUrl}?col_1=LocationName&operand_1=eq&value_1={Uri.EscapeDataString(site)}";

        var id = Environment.GetEnvironmentVariable("TW_CLIENT_ID");
        var secret = Environment.GetEnvironmentVariable("TW_CLIENT_SECRET");

        if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(secret))
        {
            return await Json(req, HttpStatusCode.InternalServerError, $$"""
            {
              "ok": false,
              "stage": "config",
              "error": "Missing TW_CLIENT_ID or TW_CLIENT_SECRET"
            }
            """);
        }

        using var msg = new HttpRequestMessage(HttpMethod.Get, url);
        msg.Headers.Add("client_id", id);
        msg.Headers.Add("client_secret", secret);
        msg.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        msg.Headers.UserAgent.ParseAdd("FerryLaneSwimming/1.0");

        var sw = Stopwatch.StartNew();

        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var upstream = await _http.SendAsync(msg, cts.Token);
            var body = await upstream.Content.ReadAsStringAsync(cts.Token);
            sw.Stop();

            if (!upstream.IsSuccessStatusCode)
            {
                var safeBody = debug ? EscapeJson(body) : "";
                return await Json(req, upstream.StatusCode, $$"""
                {
                  "ok": false,
                  "stage": "upstream",
                  "site": "{{EscapeJson(site)}}",
                  "upstreamStatus": {{(int)upstream.StatusCode}},
                  "elapsedMs": {{sw.ElapsedMilliseconds}},
                  "body": "{{safeBody}}"
                }
                """);
            }

            // Normal, non-debug path: return Thames Water JSON as before
            if (!debug)
            {
                var res = req.CreateResponse(HttpStatusCode.OK);
                res.Headers.Add("Cache-Control", "public, max-age=120");
                res.Headers.Add("Content-Type", "application/json; charset=utf-8");
                await res.WriteStringAsync(body);
                return res;
            }

            // Debug path: wrap the upstream response so we can see timing and size
            var debugBody = body.Length > 3000 ? body[..3000] + "...[truncated]" : body;
            return await Json(req, HttpStatusCode.OK, $$"""
            {
              "ok": true,
              "stage": "success",
              "site": "{{EscapeJson(site)}}",
              "elapsedMs": {{sw.ElapsedMilliseconds}},
              "bodyLength": {{body.Length}},
              "bodyPreview": "{{EscapeJson(debugBody)}}"
            }
            """);
        }
        catch (TaskCanceledException ex)
        {
            sw.Stop();
            return await Json(req, HttpStatusCode.GatewayTimeout, $$"""
            {
              "ok": false,
              "stage": "timeout",
              "site": "{{EscapeJson(site)}}",
              "elapsedMs": {{sw.ElapsedMilliseconds}},
              "error": "{{EscapeJson(ex.Message)}}"
            }
            """);
        }
        catch (Exception ex)
        {
            sw.Stop();
            return await Json(req, HttpStatusCode.BadGateway, $$"""
            {
              "ok": false,
              "stage": "exception",
              "site": "{{EscapeJson(site)}}",
              "elapsedMs": {{sw.ElapsedMilliseconds}},
              "error": "{{EscapeJson(ex.Message)}}"
            }
            """);
        }
    }

    private static async Task<HttpResponseData> Json(HttpRequestData req, HttpStatusCode code, string json)
    {
        var res = req.CreateResponse(code);
        res.Headers.Add("Cache-Control", "no-store");
        res.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await res.WriteStringAsync(json);
        return res;
    }

    private static string EscapeJson(string? s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("\r", "\\r")
            .Replace("\n", "\\n");
    }
}
