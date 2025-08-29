# Ferry Lane Swimming (FLSC — the "Club" is crossed out)
Minimal **Azure Static Web Apps (Free)** project with a static frontend and an **Azure Functions (.NET 8, isolated)** backend to proxy the **Thames Water Open Data** EDM endpoint.
## Structure
/frontend   # static site (HTML/CSS/JS)
/api        # Azure Functions (C# .NET 8 isolated)
## Local run
- In `/api`, run from Visual Studio or `func start` after `dotnet restore`.
- Set `TW_CLIENT_ID` and `TW_CLIENT_SECRET` in local.settings.json (do not commit real secrets).
## Deploy (SWA Free)
App location: `frontend` · API location: `api` · Output: *(blank)*
Then add app settings in Azure: `TW_CLIENT_ID`, `TW_CLIENT_SECRET`.
