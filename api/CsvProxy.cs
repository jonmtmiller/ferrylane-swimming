using System.Net;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

public class CsvProxy
{
    private readonly HttpClient _http;
    public CsvProxy(IHttpClientFactory f) => _http = f.CreateClient();

    [Function("CsvProxy")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "csv/shiplake")]
        HttpRequestData req)
    {
        var url = "https://dl1.findlays.net/rawdata/shiplake-5m-averages-latest.csv";
        var upstream = await _http.GetAsync(url);
        var res = req.CreateResponse(upstream.IsSuccessStatusCode ? HttpStatusCode.OK : upstream.StatusCode);
        res.Headers.Add("Cache-Control", "public, max-age=120");
        res.Headers.Add("Content-Type", "text/csv; charset=utf-8");
        await res.WriteStringAsync(await upstream.Content.ReadAsStringAsync());
        return res;
    }
}
