using System.Net;
using System.Text;
using System.Text.RegularExpressions;

public static class BoardsFunction
{
    private static readonly HttpClient Http = new HttpClient(new HttpClientHandler{
        AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
    })
    {
        Timeout = TimeSpan.FromSeconds(15)
    };

    // GOV.UK + TVM sources
    private const string GovUk = "https://www.gov.uk/guidance/river-thames-current-river-conditions";
    private const string Tvm   = "https://www.thamesvisitormoorings.co.uk/river-conditions/";

    [Microsoft.Azure.Functions.Worker.Function("eaBoards")]
    public static async Task<HttpResponseData> Run(
        [Microsoft.Azure.Functions.Worker.HttpTrigger(
            Microsoft.Azure.Functions.Worker.AuthorizationLevel.Anonymous,
            "get", Route = "ea/boards")] Microsoft.Azure.Functions.Worker.HttpRequestData req,
        Microsoft.Azure.Functions.Worker.FunctionContext ctx)
    {
        var log = ctx.GetLogger("eaBoards");

        List<Row> rows = new();
        try
        {
            var html = await GetString(GovUk);
            rows = ParseGovUk(html);
            if (rows.Count < 5) // defensive: if parsing failed or page changed
            {
                log.LogWarning("GOV.UK parse yielded {Count} rows; trying TVM fallback.", rows.Count);
                var html2 = await GetString(Tvm);
                rows = ParseTvm(html2);
            }
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Boards fetch/parse failed; trying TVM fallback.");
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

        // As a last resort, return a neutral row rather than [] so the frontend stays happy
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

        var resp = req.CreateResponse(HttpStatusCode.OK);
        await resp.WriteStringAsync(System.Text.Json.JsonSerializer.Serialize(rows));
        resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
        return resp;
    }

    private static async Task<string> GetString(string url)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.UserAgent.ParseAdd("Mozilla/5.0 (compatible; FerryLane/1.0)");
        req.Headers.Accept.ParseAdd("text/html,*/*;q=0.8");
        var res = await Http.SendAsync(req);
        res.EnsureSuccessStatusCode();
        var bytes = await res.Content.ReadAsByteArrayAsync();
        // normalise to UTF-8 text
        return Encoding.UTF8.GetString(bytes);
    }

    // --- GOV.UK parser ---
    // The page contains a "Current river conditions" section listing reaches like:
    // "<strong>Shiplake Lock to Marsh Lock</strong>: Red increasing"
    private static List<Row> ParseGovUk(string html)
    {
        var rows = new List<Row>();

        // narrow to the "Current river conditions" section to reduce false positives
        var sec = ExtractSection(html, "Current river conditions", "What the warnings mean");

        // match lines like "<strong>Shiplake Lock to Marsh Lock</strong>: Red increasing"
        var rx = new Regex(
            @"<strong>\s*([^<]+?)\s*</strong>\s*:\s*([Rr]ed|[Yy]ellow|[Gg]reen)\s*(increasing|decreasing|unchanged)?",
            RegexOptions.Compiled);

        foreach (Match m in rx.Matches(sec))
        {
            var reach = WebUtility.HtmlDecode(m.Groups[1].Value.Trim());
            var status = m.Groups[2].Value.ToLowerInvariant();      // red|yellow|green
            var trend  = m.Groups[3]?.Success == true ? m.Groups[3].Value.ToLowerInvariant() : null;

            SplitReach(reach, out var from, out var to);

            rows.Add(new Row
            {
                Reach   = reach,
                FromLock= from,
                ToLock  = to,
                Status  = status,     // red|yellow|green
                Trend   = trend       // increasing|decreasing|unchanged|null
            });
        }

        return rows;
    }

    // --- TVM fallback parser ---
    // Structure appears as H3 reach lines and following text "Red caution: strong stream"
    private static List<Row> ParseTvm(string html)
    {
        var rows = new List<Row>();

        // Grab only the main article content area
        var main = ExtractSection(html, "> River Thames - River Conditions", "### Thames Visitor Moorings");
        if (string.IsNullOrWhiteSpace(main)) main = html;

        // Reach lines like "### Shiplake Lock to Marsh Lock"
        var reachRx = new Regex(@"<h3[^>]*>\s*(.*?)\s*</h3>", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        // The following status text often appears as a <p> right after h3 (e.g., "Red caution: strong stream")
        var pRx = new Regex(@"</h3>\s*<p[^>]*>\s*([^<]+)\s*</p>", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        foreach (Match m in reachRx.Matches(main))
        {
            var start = m.Index;
            var tail = main.Substring(start, Math.Min(main.Length - start, 600)); // look ahead
            var p = pRx.Match(tail);
            var reach = WebUtility.HtmlDecode(m.Groups[1].Value.Trim());
            string status = "green";
            string? trend = null;

            if (p.Success)
            {
                var txt = WebUtility.HtmlDecode(p.Groups[1].Value.Trim()).ToLowerInvariant();
                if (txt.Contains("red")) status = "red";
                else if (txt.Contains("yellow")) status = "yellow";
                else status = "green";

                if (txt.Contains("increasing")) trend = "increasing";
                else if (txt.Contains("decreasing")) trend = "decreasing";
                else if (txt.Contains("strong stream")) trend = null; // not specified
            }

            SplitReach(reach, out var from, out var to);

            rows.Add(new Row
            {
                Reach   = reach,
                FromLock= from,
                ToLock  = to,
                Status  = status,
                Trend   = trend
            });
        }

        return rows;
    }

    private static string ExtractSection(string html, string fromHeadingText, string toHeadingText)
    {
        // make a plain-text-ish copy to robustly find headings
        var normalized = Regex.Replace(html, @"\s+", " ");
        int i1 = IndexOfHeading(normalized, fromHeadingText);
        if (i1 < 0) return html;
        int i2 = IndexOfHeading(normalized, toHeadingText);
        if (i2 < 0 || i2 <= i1) i2 = Math.Min(normalized.Length, i1 + 200000);
        return normalized.Substring(i1, i2 - i1);
    }

    private static int IndexOfHeading(string html, string headingText)
    {
        // match either an H2 with text or an anchor in a contents list
        var rx = new Regex($@"(<h2[^>]*>\s*{Regex.Escape(headingText)}\s*</h2>|>{Regex.Escape(headingText)}<)",
            RegexOptions.IgnoreCase);
        var m = rx.Match(html);
        return m.Success ? m.Index : -1;
    }

    private static void SplitReach(string reach, out string from, out string to)
    {
        from = ""; to = "";
        if (string.IsNullOrWhiteSpace(reach)) return;
        var parts = reach.Split(" to ", StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 2)
        {
            from = parts[0].Replace(" Lock", "", StringComparison.OrdinalIgnoreCase);
            to   = parts[1].Replace(" Lock", "", StringComparison.OrdinalIgnoreCase);
        }
        else
        {
            // e.g. "Upstream of St John's Lock" or "Downstream of X"
            from = reach;
        }
    }

    private class Row
    {
        public string Reach { get; set; } = "";
        public string FromLock { get; set; } = "";
        public string ToLock { get; set; } = "";
        public string Status { get; set; } = "green";       // red|yellow|green
        public string? Trend { get; set; }                   // increasing|decreasing|unchanged|null
    }
}
