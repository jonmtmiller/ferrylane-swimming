// File: api/BoardsFunction.cs
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace FerryLane.Api;

public sealed class BoardsFunction
{
    private static readonly HttpClient Http = new HttpClient(new HttpClientHandler
    {
        AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
    })
    {
        Timeout = TimeSpan.FromSeconds(20)
    };

    // Sources
    private const string GovUk = "https://www.gov.uk/guidance/river-thames-current-river-conditions";
    private const string Tvm   = "https://www.thamesvisitormoorings.co.uk/river-conditions/";

    [Function("Boards")]
    public static async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "ea/boards")]
        HttpRequestData req,
        FunctionContext ctx)
    {
        var log = ctx.GetLogger("Boards");
        List<Row> rows = new();

        try
        {
            var html = await GetString(GovUk);
            rows = ParseGovUk(html, log);
            if (rows.Count < 5)
            {
                log.LogWarning("GOV.UK parse yielded {Count} rows; trying TVM fallback.", rows.Count);
                var html2 = await GetString(Tvm);
                rows = ParseTvm(html2);
            }
        }
        catch (Exception ex)
        {
            log.LogError(ex, "GOV.UK fetch/parse failed; trying TVM fallback.");
            try
            {
                var html2 = await GetString(Tvm);
                rows = ParseTvm(html2);
            }
            catch (Exception ex2)
            {
                log.LogError(ex2, "TVM fallback failed.");
            }
        }

        if (rows.Count == 0)
        {
            rows.Add(new Row
            {
                Reach   = "River Thames (boards)",
                FromLock= "",
                ToLock  = "",
                Status  = "green",
                Trend   = null
            });
        }

        var res = req.CreateResponse(HttpStatusCode.OK);
        res.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await res.WriteStringAsync(JsonSerializer.Serialize(rows));
        return res;
    }

    private static async Task<string> GetString(string url)
    {
        using var rq = new HttpRequestMessage(HttpMethod.Get, url);
        rq.Headers.UserAgent.ParseAdd("Mozilla/5.0 (compatible; FerryLane/1.0; +https://example.invalid)");
        rq.Headers.Accept.ParseAdd("text/html,*/*;q=0.8");
        rq.Headers.AcceptLanguage.ParseAdd("en-GB,en;q=0.8");
        var rs = await Http.SendAsync(rq);
        rs.EnsureSuccessStatusCode();
        var bytes = await rs.Content.ReadAsByteArrayAsync();
        return Encoding.UTF8.GetString(bytes);
    }

    // --------- GOV.UK parsing ---------

    // Text-mode matcher:
    //   "Shiplake Lock to Marsh Lock Red caution: strong stream"
    //   "Upstream of Blakes Lock Red caution: strong stream"
    private static readonly Regex ReachLine = new(
        @"(?<reach>(?:Upstream of\s+[A-Za-z’'\- ]+ Lock|[A-Za-z’'\- ]+ Lock to [A-Za-z’'\- ]+ Lock))\s+(?<status>(?:Red|Yellow|Green)[^\.:\r\n<]*)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static (string Status, string? Trend) ParseStatusTrend(string raw)
    {
        var s = (raw ?? "").Trim().ToLowerInvariant();

        // Strong stream (always red)
        if (s.Contains("red caution")) return ("red", null);

        // Yellow variations & trends
        if (s.Contains("increasing")) return ("yellow", "increasing");
        if (s.Contains("decreasing")) return ("yellow", "decreasing");
        if (s.Contains("yellow caution") || s.Contains("caution stream") || s.Contains("caution"))
            return ("yellow", null);

        // Explicit "no stream warning"
        if (s.Contains("no stream warning")) return ("green", null);

        // If they literally wrote "Green", treat as green
        if (s.StartsWith("green")) return ("green", null);

        // Fallback (unknown wording)
        return ("green", null);
    }

    private static List<Row> ParseGovUk(string html, ILogger log)
    {
        var rows = new List<Row>();

        // 1) First try your original strict pattern (strong tag + colon)
        var section = ExtractSection(html, "Current river conditions", "What the warnings mean");
        var rxStrong = new Regex(
            @"<strong>\s*([^<]+?)\s*</strong>\s*:\s*([Rr]ed|[Yy]ellow|[Gg]reen)\s*(increasing|decreasing|unchanged)?",
            RegexOptions.Compiled);

        foreach (Match m in rxStrong.Matches(section))
        {
            var reach  = WebUtility.HtmlDecode(m.Groups[1].Value.Trim());
            var status = m.Groups[2].Value.ToLowerInvariant();
            var trend  = m.Groups[3].Success ? m.Groups[3].Value.ToLowerInvariant() : null;

            SplitReach(reach, out var from, out var to);
            rows.Add(new Row { Reach = reach, FromLock = from, ToLock = to, Status = status, Trend = trend });
        }

        // 2) If we didn't get much, strip tags and do text-mode scan
        if (rows.Count < 5)
        {
            var text = Regex.Replace(section, @"<[^>]+>", " ");     // remove HTML tags
            text = WebUtility.HtmlDecode(text);
            text = Regex.Replace(text, @"\s+", " ").Trim();

            foreach (Match m in ReachLine.Matches(text))
            {
                var reach = m.Groups["reach"].Value.Trim();
                var rawStatus = m.Groups["status"].Value.Trim();

                var (status, trend) = ParseStatusTrend(rawStatus);

                SplitReach(reach, out var from, out var to);
                rows.Add(new Row { Reach = reach, FromLock = from, ToLock = to, Status = status, Trend = trend });
            }

            // It’s possible the two passes added duplicates; dedupe on Reach
            rows = rows
                .GroupBy(r => r.Reach, StringComparer.OrdinalIgnoreCase)
                .Select(g => g.First())
                .ToList();

            log.LogInformation("GOV.UK text-mode parser produced {Count} rows.", rows.Count);
        }

        return rows;
    }

    // --------- TVM fallback (unchanged) ---------
    private static List<Row> ParseTvm(string html)
    {
        var rows = new List<Row>();
        var main = ExtractSection(html, "> River Thames - River Conditions", "### Thames Visitor Moorings");
        if (string.IsNullOrWhiteSpace(main)) main = html;

        var reachRx = new Regex(@"<h3[^>]*>\s*(.*?)\s*</h3>", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        var pRx     = new Regex(@"</h3>\s*<p[^>]*>\s*([^<]+)\s*</p>", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        foreach (Match m in reachRx.Matches(main))
        {
            var start = m.Index;
            var tail  = main.Substring(start, Math.Min(main.Length - start, 1000));
            var p     = pRx.Match(tail);

            var reach = WebUtility.HtmlDecode(m.Groups[1].Value.Trim());
            var status = "green"; string? trend = null;

            if (p.Success)
            {
                var t = WebUtility.HtmlDecode(p.Groups[1].Value.Trim()).ToLowerInvariant();
                if (t.Contains("red")) status = "red";
                else if (t.Contains("yellow")) status = "yellow";

                if (t.Contains("increasing")) trend = "increasing";
                else if (t.Contains("decreasing")) trend = "decreasing";
            }

            SplitReach(reach, out var from, out var to);
            rows.Add(new Row { Reach = reach, FromLock = from, ToLock = to, Status = status, Trend = trend });
        }
        return rows;
    }

    // --------- Utilities (unchanged) ---------
    private static string ExtractSection(string html, string fromHeading, string toHeading)
    {
        var s = Regex.Replace(html, @"\s+", " ");
        int i1 = IndexOfHeading(s, fromHeading);
        if (i1 < 0) return html;
        int i2 = IndexOfHeading(s, toHeading);
        if (i2 <= i1) i2 = Math.Min(s.Length, i1 + 200000);
        return s.Substring(i1, i2 - i1);
    }

    private static int IndexOfHeading(string s, string headingText)
    {
        var rx = new Regex($@"(<h\d[^>]*>\s*{Regex.Escape(headingText)}\s*</h\d>|>{Regex.Escape(headingText)}<)",
            RegexOptions.IgnoreCase);
        var m = rx.Match(s);
        return m.Success ? m.Index : -1;
    }

    private static void SplitReach(string reach, out string from, out string to)
    {
        from = ""; to = "";
        if (string.IsNullOrWhiteSpace(reach)) return;

        if (reach.Contains(" to ", StringComparison.OrdinalIgnoreCase))
        {
            var parts = reach.Split(" to ", 2, StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 2)
            {
                from = parts[0].Replace(" Lock", "", StringComparison.OrdinalIgnoreCase);
                to   = parts[1].Replace(" Lock", "", StringComparison.OrdinalIgnoreCase);
                return;
            }
        }

        // e.g., "Upstream of Blakes Lock" or anything else
        from = reach;
        to   = "";
    }

    private sealed class Row
    {
        public string Reach { get; set; } = "";
        public string FromLock { get; set; } = "";
        public string ToLock { get; set; } = "";
        public string Status { get; set; } = "green";   // red|yellow|green
        public string? Trend { get; set; }              // increasing|decreasing|unchanged|null
    }
}
