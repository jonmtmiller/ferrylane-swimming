using System.Net;
using System.Net.Http.Headers;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
public class TwStatus
{
    private readonly HttpClient _http;
    public TwStatus(IHttpClientFactory f) => _http = f.CreateClient();
    [Function("TwStatus")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "tw/status")]
        HttpRequestData req)
    {
        var qs = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        var site = qs["site"] ?? "Wargrave";
        var baseUrl = "https://prod-tw-opendata-app.uk-e1.cloudhub.io/data/STE/v1/DischargeCurrentStatus";
        var url = $"{baseUrl}?col_1=LocationName&operand_1=eq&value_1={Uri.EscapeDataString(site)}";
        var id = Environment.GetEnvironmentVariable("TW_CLIENT_ID");
        var secret = Environment.GetEnvironmentVariable("TW_CLIENT_SECRET");
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(secret))
        {
            var bad = req.CreateResponse(HttpStatusCode.InternalServerError);
            await bad.WriteStringAsync("{\"error\":\"Missing credentials\"}");
            return bad;
        }
        using var msg = new HttpRequestMessage(HttpMethod.Get, url);
        msg.Headers.Add("client_id", id);
        msg.Headers.Add("client_secret", secret);
        msg.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        var upstream = await _http.SendAsync(msg);
        var res = req.CreateResponse(upstream.IsSuccessStatusCode ? HttpStatusCode.OK : upstream.StatusCode);
        res.Headers.Add("Cache-Control", "public, max-age=120");
        await res.WriteStringAsync(await upstream.Content.ReadAsStringAsync());
        return res;
    }
}
