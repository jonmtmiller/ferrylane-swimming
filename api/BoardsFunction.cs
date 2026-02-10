// File: api/BoardsFunction.cs
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace FerryLane.Api;

public class BoardsFunction
{
    private static DateTime _cacheAt = DateTime.MinValue;
    private static List<ReachRow>? _cache;

    private static readonly HttpClient _http = new HttpClient(new HttpClientHandler
    {
        AutomaticDecompression = DecompressionMethods.All
    })
    {
        Timeout = TimeSpan.FromSeconds(15)
    };

    [Function("boards")]
    public static async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "ea/boards")]
        HttpRequestData req,
        FunctionContext ctx)
    {
        // Serve cached for 10 minutes
        if (_cache is not null && (DateTime.UtcNow - _cacheAt) < TimeSpan.FromMinutes(10))
            return JsonOk(req, _cache);

        const string url = "https://www.gov.uk/guidance/river-thames-current-river-conditions";
        string html;
        try
        {
            html = await _http.GetStringAsync(url);
        }
        catch (Exception ex)
        {
            var err = req.CreateResponse(HttpStatusCode.BadGateway);
            await err.WriteStringAsync($"Failed to fetch GOV.UK page: {ex.Message}");
            return err;
        }

        var lines = StripHtmlToLines(html);
        var rows = new List<ReachRow>();
        var re = new Regex(@"(?<from>[A-Za-z' ]+?) Lock to (?<to>[A-Za-z' ]+?) Lock\s+(?<text>.+)", RegexOptions.IgnoreCase);

        foreach (var line in lines)
        {
            var m = re.Match(line);
            if (!m.Success) continue;

            var from = m.Groups["from"].Value.Trim();
            var to   = m.Groups["to"].Value.Trim();
            var text = m.Groups["text"].Value.Trim().ToLowerInvariant();

            var (status, trend) = Classify(text);
            rows.Add(new ReachRow
            {
                Reach = $"{from} Lock to {to} Lock",
                FromLock = from,
                ToLock = to,
                Status = status,   // "green" | "yellow" | "red"
                Trend  = trend     // "increasing" | "decreasing" | null
            });
        }

        _cache = rows;
        _cacheAt = DateTime.UtcNow;
        return JsonOk(req, rows);
    }

    private static (string status, string? trend) Classify(string text)
    {
        // Red boards
        if (text.Contains("red") || text.Contains("strong stream"))
            return ("red", null);

        // Yellow boards (trend)
        if (text.Contains("stream increasing"))
            return ("yellow", "increasing");
        if (text.Contains("stream decreasing"))
            return ("yellow", "decreasing");

        // Green / none
        if (text.Contains("no stream warnings") || !text.Contains("caution"))
            return ("green", null);

        // Fallback
        return ("green", null);
    }

    private static IEnumerable<string> StripHtmlToLines(string html)
    {
        // Remove scripts/styles, convert <br> to newlines, strip tags
        var noScripts = Regex.Replace(html, @"<script[\s\S]*?</script>", "", RegexOptions.IgnoreCase);
        var noStyles  = Regex.Replace(noScripts, @"<style[\s\S]*?</style>", "", RegexOptions.IgnoreCase);
        var brToNl    = Regex.Replace(noStyles, @"<br\s*/?>", "\n", RegexOptions.IgnoreCase);
        var text      = Regex.Replace(brToNl, "<.*?>", " ");
        text = WebUtility.HtmlDecode(text);

        return text.Replace("\r", "")
                   .Split('\n')
                   .Select(s => Regex.Replace(s, @"\s+", " ").Trim())
                   .Where(s => s.Contains(" Lock to ", StringComparison.OrdinalIgnoreCase) && s.Length < 160);
    }

    private static HttpResponseData JsonOk(HttpRequestData req, object o)
    {
        var res = req.CreateResponse(HttpStatusCode.OK);
        res.Headers.Add("Content-Type", "application/json; charset=utf-8");
        res.WriteString(JsonSerializer.Serialize(o));
        return res;
    }

    private record ReachRow
    {
        public string Reach { get; set; } = "";
        public string FromLock { get; set; } = "";
        public string ToLock { get; set; } = "";
        public string Status { get; set; } = "";
        public string? Trend { get; set; }
    }
}
