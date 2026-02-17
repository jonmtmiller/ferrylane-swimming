// File: api/BoardsFunction.cs
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

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
            rows = ParseGovUk(html);
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
        rq.Headers.UserAgent.ParseAdd("Mozilla/5.0 (compatible; FerryLane/1.0)");
        rq.Headers.Accept.ParseAdd("text/html,*/*;q=0.8");
        var rs = await Http.SendAsync(rq);
        rs.EnsureSuccessStatusCode();
        var bytes = await rs.Content.ReadAsByteArrayAsync();
        return Encoding.UTF8.GetString(bytes);
    }

    // GOV.UK: look for "<strong>Shiplake Lock to Marsh Lock</strong>: Red increasing"
    private static List<Row> ParseGovUk(string html)
    {
        var rows = new List<Row>();
        var section = ExtractSection(html, "Current river conditions", "What the warnings mean");
        var rx = new Regex(
            @"<strong>\s*([^<]+?)\s*</strong>\s*:\s*([Rr]ed|[Yy]ellow|[Gg]reen)\s*(increasing|decreasing|unchanged)?",
            RegexOptions.Compiled);

        foreach (Match m in rx.Matches(section))
        {
            var reach  = WebUtility.HtmlDecode(m.Groups[1].Value.Trim());
            var status = m.Groups[2].Value.ToLowerInvariant();
            var trend  = m.Groups[3].Success ? m.Groups[3].Value.ToLowerInvariant() : null;

            SplitReach(reach, out var from, out var to);
            rows.Add(new Row { Reach = reach, FromLock = from, ToLock = to, Status = status, Trend = trend });
        }
        return rows;
    }

    // TVM fallback: headings for reach + paragraph with colour text
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
        var parts = reach.Split(" to ", StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 2)
        {
            from = parts[0].Replace(" Lock", "", StringComparison.OrdinalIgnoreCase);
            to   = parts[1].Replace(" Lock", "", StringComparison.OrdinalIgnoreCase);
        }
        else
        {
            from = reach;
        }
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
