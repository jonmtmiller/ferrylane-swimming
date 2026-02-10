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
        Timeout = TimeSpan.FromSeconds(20)
    };

    [Function("boards")]
    public static async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "ea/boards")]
        HttpRequestData req,
        FunctionContext ctx)
    {
        // Optional debug: /api/ea/boards?debug=1 returns raw lines we parsed
        var debug = System.Web.HttpUtility.ParseQueryString(req.Url.Query).Get("debug") == "1";

        if (!debug && _cache is not null && (DateTime.UtcNow - _cacheAt) < TimeSpan.FromMinutes(10))
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

        var lines = HtmlToCandidateLines(html).ToList();

        if (debug)
            return JsonOk(req, lines); // help diagnose page changes

        // Regex: "<A> Lock to <B> Lock  <free text>"
        var re = new Regex(@"(?<from>[A-Za-z’' \-]+?) Lock to (?<to>[A-Za-z’' \-]+?) Lock\s+(?<text>.+)",
                           RegexOptions.IgnoreCase);

        var rows = new List<ReachRow>();
        foreach (var line in lines)
        {
            var m = re.Match(line);
            if (!m.Success) continue;

            var from = m.Groups["from"].Value.Trim();
            var to   = m.Groups["to"].Value.Trim();
            var text = m.Groups["text"].Value.Trim();

            var (status, trend) = Classify(text);

            rows.Add(new ReachRow
            {
                Reach   = $"{from} Lock to {to} Lock",
                FromLock = from,
                ToLock   = to,
                Status   = status,
                Trend    = trend
            });
        }

        // If we somehow got zero, return a friendly minimal payload rather than 200 []
        if (rows.Count == 0)
        {
            // Return at least a single placeholder so the UI shows a message
            rows.Add(new ReachRow
            {
                Reach = "River Thames (boards)",
                FromLock = "",
                ToLock = "",
                Status = "green",
                Trend = null
            });
        }

        _cache = rows;
        _cacheAt = DateTime.UtcNow;
        return JsonOk(req, rows);
    }

    private static (string status, string? trend) Classify(string rawText)
    {
        var text = rawText.ToLowerInvariant();
        // Red / strong stream
        if (text.Contains("red") || text.Contains("strong stream"))
            return ("red", null);

        // Yellow with trend
        if (text.Contains("stream increasing"))
            return ("yellow", "increasing");
        if (text.Contains("stream decreasing"))
            return ("yellow", "decreasing");

        // Explicit “no stream warnings” → green
        if (text.Contains("no stream warnings"))
            return ("green", null);

        // Generic “caution” without strong-stream phrasing usually maps to yellow (conservative)
        if (text.Contains("caution"))
            return ("yellow", null);

        // Default: green
        return ("green", null);
    }

    private static IEnumerable<string> HtmlToCandidateLines(string html)
    {
        // 1) remove scripts/styles
        var s = Regex.Replace(html, @"<script[\s\S]*?</script>", "", RegexOptions.IgnoreCase);
        s = Regex.Replace(s, @"<style[\s\S]*?</style>", "", RegexOptions.IgnoreCase);

        // 2) inject newlines at structural boundaries so list items/paras become lines
        s = Regex.Replace(s, @"</(li|p|h\d|tr)>", "\n", RegexOptions.IgnoreCase);
        s = Regex.Replace(s, @"<br\s*/?>", "\n", RegexOptions.IgnoreCase);

        // 3) strip remaining tags
        s = Regex.Replace(s, "<.*?>", " ");

        // 4) decode entities, collapse whitespace
        s = WebUtility.HtmlDecode(s);
        s = Regex.Replace(s, @"\s+", " ").Trim();

        // 5) split by our injected newlines (they might have been lost by step 3 for unmatched tags,
        //    so also split by ". " as a backup to give more candidate chunks).
        var primary = s.Split('\n').Select(x => x.Trim()).Where(x => x.Length > 0);
        var expanded = primary.SelectMany(line =>
            line.Contains(" Lock to ", StringComparison.OrdinalIgnoreCase)
                ? new[] { line }
                : line.Split(new[] { ". " }, StringSplitOptions.None).Select(y => y.Trim())
        );

        // 6) keep lines that clearly reference a reach
        return expanded
            .Where(x => x.IndexOf(" Lock to ", StringComparison.OrdinalIgnoreCase) >= 0)
            .Where(x => x.Length <= 320); // be generous
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
