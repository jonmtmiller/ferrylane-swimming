using System.Net;
using System.Text.Json.Nodes;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace Api;

public class MetOfficeProxy
{
    private static readonly HttpClient _http = new();

    // GET /api/metoffice?lat=51.50144&lon=-0.870961
    [Function("MetOffice")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "metoffice")] HttpRequestData req)
    {
        var q = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        var lat = q["lat"] ?? "51.50144";     // Ferry Lane, Wargrave (approx)
        var lon = q["lon"] ?? "-0.870961";

        var apiKey = Environment.GetEnvironmentVariable("METOFFICE_API_KEY");
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            var bad = req.CreateResponse(HttpStatusCode.InternalServerError);
            await bad.WriteStringAsync("METOFFICE_API_KEY not configured.");
            return bad;
        }

        string baseUrl = "https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point";
        var hourlyReq = new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}/hourly?latitude={WebUtility.UrlEncode(lat)}&longitude={WebUtility.UrlEncode(lon)}");
        var dailyReq  = new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}/daily?latitude={WebUtility.UrlEncode(lat)}&longitude={WebUtility.UrlEncode(lon)}");
        hourlyReq.Headers.Add("apikey", apiKey);
        dailyReq.Headers.Add("apikey", apiKey);

        var hourlyTask = _http.SendAsync(hourlyReq);
        var dailyTask  = _http.SendAsync(dailyReq);

        var hourlyRes = await hourlyTask;
        var dailyRes  = await dailyTask;

        if (!hourlyRes.IsSuccessStatusCode || !dailyRes.IsSuccessStatusCode)
        {
            var fail = req.CreateResponse(HttpStatusCode.BadGateway);
            await fail.WriteStringAsync($"Met Office error: hourly {(int)hourlyRes.StatusCode}, daily {(int)dailyRes.StatusCode}");
            return fail;
        }

        var outJson = new JsonObject
        {
            ["hourly"] = JsonNode.Parse(await hourlyRes.Content.ReadAsStringAsync()),
            ["daily"]  = JsonNode.Parse(await dailyRes.Content.ReadAsStringAsync())
        };

        var ok = req.CreateResponse(HttpStatusCode.OK);
        ok.Headers.Add("Cache-Control", "public, max-age=900"); // 15 minutes
        await ok.WriteStringAsync(outJson.ToJsonString());
        return ok;
    }
}
