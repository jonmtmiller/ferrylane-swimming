// EaProxy.cs
using System.Net;
using System.Net.Http.Headers;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

public class EaProxy
{
    private readonly HttpClient _http;
    public EaProxy(IHttpClientFactory f) => _http = f.CreateClient();

    // GET /api/ea/flow?measure=2604TH-flow--i-15_min-m3_s&since=2025-08-18T00:00:00Z&limit=10000
    [Function("EaFlow")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "ea/flow")]
        HttpRequestData req)
    {
        var qs      = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        var measure = qs["measure"] ?? "2604TH-flow--i-15_min-m3_s";
        var limit   = qs["limit"]   ?? "10000"; // allow big windows
        var since   = qs["since"];  // ISO timestamp (optional)

        var upstream = $"https://environment.data.gov.uk/flood-monitoring/id/measures/{Uri.EscapeDataString(measure)}/readings?_sorted&_limit={Uri.EscapeDataString(limit)}";
        if (!string.IsNullOrWhiteSpace(since))
            upstream += $"&since={Uri.EscapeDataString(since)}";  // EA supports `since` on readings

        using var msg = new HttpRequestMessage(HttpMethod.Get, upstream);
        msg.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        msg.Headers.UserAgent.ParseAdd("FerryLaneSwimming/1.0");

        var upstreamRes = await _http.SendAsync(msg);
        var res = req.CreateResponse(upstreamRes.IsSuccessStatusCode ? HttpStatusCode.OK : upstreamRes.StatusCode);
        res.Headers.Add("Cache-Control", "public, max-age=120");
        res.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await res.WriteStringAsync(await upstreamRes.Content.ReadAsStringAsync());
        return res;
    }
}
