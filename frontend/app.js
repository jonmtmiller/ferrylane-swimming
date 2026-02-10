/* ========= Small helpers ========= */
const $ = (id) => document.getElementById(id);

let tempChart, flowChart;
const DAY = 24*60*60*1000;
const daysAgoISO = (n) => new Date(Date.now() - n*DAY).toISOString();

const metIcon = (code) => {
  if (code == null) return "❓";
  if ([0, 1].includes(code)) return "☀️";
  if ([2, 3].includes(code)) return "⛅";
  if ([5, 6, 7].includes(code)) return "🌫️";
  if ([8, 9,10,11,12].includes(code)) return "🌧️";
  if ([14,15].includes(code)) return "🌨️";
  if ([30,31].includes(code)) return "⛈️";
  return "❓";
};
const arrow = (deg=0)=>["↑","↗","→","↘","↓","↙","←","↖"][Math.round(((deg%360)+360)%360/45)%8];

const MS_TO_MPH = 2.23693629;
const toMph = (v) => v==null ? null : v * MS_TO_MPH; // keep decimals; round on print

const localDayKey = (date) =>
  new Date(date).toLocaleDateString("en-CA"); // YYYY-MM-DD in local time

function setActive(groupId, days) {
  const g = document.getElementById(groupId);
  if (!g) return;
  [...g.querySelectorAll('button[data-days]')]
    .forEach(b => b.classList.toggle('active', b.dataset.days === String(days)));
}

function since(d) {
  const sec = Math.max(0, (Date.now() - d.getTime())/1000);
  if (sec < 90) return `${Math.round(sec)}s ago`;
  const min = sec/60; if (min < 90) return `${Math.round(min)}m ago`;
  const hr = min/60; if (hr < 36) return `${Math.round(hr)}h ago`;
  const dd = hr/24; return `${Math.round(dd)}d ago`;
}

/* ========= Weather helpers ========= */

// Aggregate hourly into local-day buckets (mm total + max winds)
function bucketHourly(hourly) {
  const map = new Map(); // key: 'YYYY-MM-DD' -> { mm, maxWind, maxGust, hasPrecip }
  for (const h of hourly) {
    const t = new Date(h.time);
    const k = localDayKey(t);
    const cur = map.get(k) || { mm:0, maxWind:0, maxGust:0, hasPrecip:false };
    cur.mm += Number(h.totalPrecipAmount || 0);
    cur.maxWind = Math.max(cur.maxWind, Number(h.windSpeed10m || 0));
    cur.maxGust = Math.max(cur.maxGust, Number(h.windGustSpeed10m || 0), Number(h.max10mWindGust || 0));
    if (h.totalPrecipAmount != null) cur.hasPrecip = true;
    map.set(k, cur);
  }
  return map;
}

// Try common daily code field names, then fall back to anything “significant…code”
function resolveDailyWxCode(d) {
  const candidates = [
    'significantWeatherCode', 'daySignificantWeatherCode',
    'significantWeatherCodeDay', 'significantWeatherCodeMostLikely',
    'weatherCode', 'wxCode'
  ];
  for (const k of candidates) {
    const v = d?.[k];
    if (v !== undefined && v !== null) return v;
  }
  for (const [k, v] of Object.entries(d || {})) {
    if (/significant.*code/i.test(k) && v != null) return v;
  }
  return null;
}
function resolveDailyPrecipMm(d) {
  const mmKeys = [
    'totalPrecipAmount', 'precipitationAmount', 'totalPrecipitationAmount',
    'precipAmount', 'totalPrecipMm'
  ];
  for (const k of mmKeys) if (Number.isFinite(d?.[k])) return d[k];
  return 0;
}
function resolveDailyWindMaxMph(d) {
  const spdKeys = ['max10mWindSpeed','windSpeed10mMax','maxWindSpeed10m','windSpeedMax10m'];
  for (const k of spdKeys) if (Number.isFinite(d?.[k])) return d[k];
  const g = resolveDailyGustMaxMph(d);
  return Number.isFinite(g) ? g : 0;
}
function resolveDailyGustMaxMph(d) {
  const gustKeys = ['max10mWindGust','windGustSpeed10mMax','maxWindGustSpeed10m','windGust10mMax'];
  for (const k of gustKeys) if (Number.isFinite(d?.[k])) return d[k];
  return undefined; // optional
}
const dayName = (dt)=> new Date(dt).toLocaleDateString("en-GB",{weekday:"short"});

/* ========= Temps ========= */
async function loadTemps(days = 10) {
  const elRiverNow = document.getElementById('riverNow');
  const elAirNow = document.getElementById('airNow');
  const elUpdated = document.getElementById('riverUpdated');
  const titleEl = document.getElementById('tempTitle');

  const parseTime = (s) => {
    if (!s) return null;
    s = String(s).trim().replace(/^"|"$/g, '');
    // Compact UTC: YYYYMMDDHHMMSS(Z)
    let m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(Z)?$/);
    if (m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]));
    // Epochs
    if (/^\d{10}(\.\d+)?$/.test(s)) return new Date(parseFloat(s) * 1000);
    if (/^\d{13}$/.test(s))         return new Date(parseInt(s, 10));
    // ISO-ish "YYYY-MM-DD HH:mm(:ss) [UTC]"
    m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\s*(UTC|GMT))?$/i);
    if (m) return new Date(`${m[1]}T${m[2]}Z`);
    const d = new Date(s);
    return isNaN(d) ? null : d;
  };

  const parseCsv = (txt) => {
    const clean = txt.replace(/^\uFEFF/, '').trim();
    if (!clean) return [];
    const lines = clean.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const firstLine = lines[0];
    const delim = (firstLine.match(/,/g)?.length || 0) >= (firstLine.match(/;/g)?.length || 0) ? ',' : ';';
    const startIdx = /date/i.test(firstLine) ? 1 : 0;

    const out = [];
    for (let i = startIdx; i < lines.length; i++) {
      const parts = lines[i].split(delim).map(x => x.trim());
      if (parts.length < 3) continue;
      const t = parseTime(parts[0]); if (!t) continue;
      const airRaw = parts[1], riverRaw = parts[2];
      const air   = /^\s*(nan|NaN)?\s*$/.test(airRaw)   ? undefined : parseFloat(airRaw);
      const river = /^\s*(nan|NaN)?\s*$/.test(riverRaw) ? undefined : parseFloat(riverRaw);
      if (!isFinite(river)) continue;
      out.push({ t, air: isFinite(air) ? air : undefined, river });
    }
    return out.sort((a,b) => a.t - b.t);
  };

  async function fetchCsv(freq /* '5m' | '1h' */) {
    const url = freq === '1h' ? '/api/csv/shiplake?freq=1h' : '/api/csv/shiplake';
    const res = await fetch(url, { cache: 'no-store' });
    const raw = await res.text();
    if (!res.ok) throw new Error(`CSV ${freq} HTTP ${res.status}`);
    return parseCsv(raw);
  }

  // 1) Try 5-minute file first
  let source = '5-minute', all = await fetchCsv('5m');

  console.info('[temps]',
    'rows:', all.length,
    'first:', all[0]?.t?.toISOString(),
    'last:',  all.at?.(-1)?.t?.toISOString()
  );

  // If the available span is shorter than requested, fall back to hourly
  const spanDays = all.length ? (all[all.length-1].t - all[0].t) / DAY : 0;
  if (spanDays + 0.1 < days) {
    console.info('Falling back to hourly');
    try {
      const hourly = await fetchCsv('1h');
      if (hourly.length) { all = hourly; source = 'hourly'; }
    } catch (_) { /* ignore, keep 5m if hourly fails */ }
  }

  if (!all.length) {
    elRiverNow.textContent = 'No data';
    elAirNow.textContent = '—';
    elUpdated.textContent = '—';
    return;
  }

  // 2) Cut window relative to the LAST timestamp in the dataset (not "now")
  const endMs = all[all.length - 1].t.getTime();
  const cutMs = endMs - days * DAY;
  const pts = all.filter(p => p.t.getTime() >= cutMs);

  console.info('[pts]',
    'rows:', pts.length,
    'first:', pts[0]?.t?.toISOString(),
    'last:',  pts.at?.(-1)?.t?.toISOString()
  );

  if (!pts.length) {
    elRiverNow.textContent = 'No data';
    elAirNow.textContent = '—';
    elUpdated.textContent = '—';
    return;
  }

  // 3) Update "Now" panel from the last point
  const last = pts[pts.length - 1];
  elRiverNow.textContent = `${last.river.toFixed(1)}°C`;
  elAirNow.textContent   = last.air != null ? `${last.air.toFixed(1)}°C` : '—';
  elUpdated.textContent  = since(last.t);

  // 4) Title shows requested range + data source used (optional)
  titleEl.textContent = `Temperatures (last ${days} days${source === 'hourly' ? ' • hourly data' : ''})`;

  // 5) Render chart with explicit x window (ms)
  const xMin = pts[0].t.getTime();
  const xMax = pts[pts.length - 1].t.getTime();

  tempChart?.destroy();
  tempChart = new Chart(document.getElementById('tempChart'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'River °C', data: pts.map(p => ({ x: p.t.getTime(), y: p.river })) },
        { label: 'Air °C',   data: pts.filter(p => p.air != null).map(p => ({ x: p.t.getTime(), y: p.air })) },
      ]
    },
    options: {
      animation: false, parsing: false, responsive: true,
      plugins: { legend: { position: 'bottom' }, decimation: { enabled: true, algorithm: 'min-max' } },
      interaction: { intersect: false, mode: 'nearest' },
      scales: {
        x: { type: 'time', min: xMin, max: xMax, time: { unit: days <= 2 ? 'hour' : 'day' } },
        y: { title: { display: true, text: '°C' } }
      }
    }
  });

  setActive('tempRanges', days);
}

/* ========= Flow ========= */
async function loadFlow(days = 14) {
  const sinceISO = new Date(Date.now() - days * DAY).toISOString();
  const estLimit = Math.ceil(days * 96 * 1.2); // ~15-min samples per day with buffer
  const url = `/api/ea/flow?measure=2604TH-flow--i-15_min-m3_s&since=${encodeURIComponent(sinceISO)}&limit=${estLimit}`;

  let data;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    data = await res.json();
  } catch (e) {
    console.error('EA fetch failed', e);
    flowNow.textContent = 'Unavailable';
    flowUpdated.textContent = '—';
    return;
  }

  const items = (data.items || [])
    .map(r => ({ t: new Date(r.dateTime), v: Number(r.value) }))
    .filter(r => Number.isFinite(r.v))
    .sort((a, b) => a.t - b.t);

  if (!items.length) {
    flowNow.textContent = 'No data';
    flowUpdated.textContent = '—';
    return;
  }

  // Anchor window to newest reading
  const endMs = items[items.length - 1].t.getTime();
  const cutMs = endMs - days * DAY;
  const pts = items.filter(p => p.t.getTime() >= cutMs);
  if (!pts.length) {
    flowNow.textContent = 'No data';
    flowUpdated.textContent = '—';
    return;
  }

  // “Now” panel
  const last = pts[pts.length - 1];
  flowNow.textContent = `${last.v.toFixed(1)} m³/s`;
  flowUpdated.textContent = since(last.t);

  // Title + chart
  document.getElementById('flowTitle').textContent = `Flow rate (last ${days} days)`;
  const xMin = pts[0].t.getTime();
  const xMax = pts[pts.length - 1].t.getTime();

  flowChart?.destroy();
  flowChart = new Chart(document.getElementById('flowChart'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'Flow (m³/s)', data: pts.map(p => ({ x: p.t.getTime(), y: p.v })) }
      ]
    },
    options: {
      animation: false, parsing: false, responsive: true,
      plugins: { legend: { position: 'bottom' }, decimation: { enabled: true, algorithm: 'min-max' } },
      interaction: { intersect: false, mode: 'nearest' },
      scales: {
        x: { type: 'time', min: xMin, max: xMax, time: { unit: days <= 2 ? 'hour' : 'day' } },
        y: { title: { display: true, text: 'm³/s' } }
      }
    }
  });

  setActive('flowRanges', days);
}

/* ========= EDM ========= */
async function loadEDM() {
  try {
    const res = await fetch('/api/tw/status?site=Wargrave', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const item = (json.items && json.items[0]) || json[0] || json;
    if (!item) { $('edmStatus').textContent = 'No data'; return; }
    const status = item.AlertStatus || item.alertStatus || item.status || '—';
    const start = item.MostRecentDischargeAlertStart || item.startTime || item.LastStart || item.lastStart;
    const stop  = item.MostRecentDischargeAlertStop  || item.stopTime  || item.LastStop  || item.lastStop;
    $('edmStatus').textContent = String(status).toUpperCase();
    if (start && !stop) $('sewageCard').classList.add('alert');
    $('edmDetail').textContent = start
      ? (stop ? `Last event ended ${new Date(stop).toLocaleString()}` 
              : `Event started ${new Date(start).toLocaleString()}`)
      : 'No recent event info';
  } catch(e){ console.error('EDM load failed', e); $('edmStatus').textContent='Unavailable'; $('edmDetail').textContent='Check later'; }
}

/* ========= Weather (Met Office proxy) ========= */
async function loadWeather(lat = 51.50144, lon = -0.870961) {
  let data;
  try {
    const res = await fetch(`/api/metoffice?lat=${lat}&lon=${lon}`, { cache: "no-store" });
    data = await res.json();
  } catch (e) {
    console.error("Met Office fetch failed", e);
    return;
  }

  const hourly = data?.hourly?.features?.[0]?.properties?.timeSeries || [];
  const daily  = data?.daily?.features?.[0]?.properties?.timeSeries || [];

  // ----- Current (first future hourly step) -----
  const now = Date.now();
  const hNext = hourly.find(h => new Date(h.time).getTime() >= now) || hourly[0];
  if (hNext) {
    const windMph = toMph(hNext.windSpeed10m ?? 0);
    const gustMph = toMph(hNext.windGustSpeed10m ?? null);
    const curHtml = `
      <div class="big">${metIcon(hNext.significantWeatherCode)} ${Math.round(hNext.screenTemperature)}°C</div>
      <div class="muted">
        Wind ${Math.round(windMph ?? 0)}${gustMph?`/${Math.round(gustMph)}`:""} mph ${arrow(hNext.windDirectionFrom10m ?? 0)}
        · Precip ${(hNext.totalPrecipAmount ?? 0).toFixed(1)} mm
      </div>`;
    document.getElementById("wx-current").innerHTML = curHtml;
  }

  // Precompute hourly aggregates by local day
  const buckets = bucketHourly(hourly);

  // ----- Daily (start today, 6 days) -----
  const startLocalMidnight = new Date(); startLocalMidnight.setHours(0,0,0,0);
  const dailyFromToday = daily
    .filter(d => new Date(d.time).getTime() >= startLocalMidnight.getTime())
    .slice(0, 6);

  document.getElementById("wx-daily").innerHTML = dailyFromToday.map(d => {
    // Icon: use day code (fallback to night code if needed)
    const code = resolveDailyWxCode(d) ?? d.nightSignificantWeatherCode ?? null;

    // Rain: prefer summed mm from hourly (if we have that day), otherwise show probability
    const k = localDayKey(d.time);
    const agg = buckets.get(k);
    const mm = agg?.hasPrecip ? agg.mm : null; // show only if hourly covers that day
    const prob = d.dayProbabilityOfPrecipitation ?? d.dayProbabilityOfRain ?? null;

    // Wind/Gust: prefer hourly max; otherwise midday values
    const windMps = agg ? agg.maxWind : (d.midday10MWindSpeed ?? d.midnight10MWindSpeed ?? 0);
    const gustMps = agg ? agg.maxGust : (d.midday10MWindGust ?? d.midnight10MWindGust ?? null);

    const windMph = toMph(windMps);
    const gustMph = toMph(gustMps);

    return `
      <div class="wx-day">
        <div class="d">${dayName(d.time)}</div>
        <div class="ico">${metIcon(code)}</div>
        ${mm != null
          ? `<div class="row"><span>Rain</span><span>${mm.toFixed(1)} mm</span></div>`
          : `<div class="row"><span>Prob</span><span>${prob != null ? Math.round(prob) : 0}%</span></div>`
        }
        <div class="row"><span>Wind</span><span>${Math.round(windMph ?? 0)}${gustMph?`/${Math.round(gustMph)}`:""} mph</span></div>
      </div>
    `;
  }).join("");

  // ----- Hourly (next 24h) -----
  const end = now + 24*60*60*1000;
  const next24 = hourly.filter(h => {
    const t = new Date(h.time).getTime();
    return t >= now && t < end;
  });
  document.getElementById("wx-hourly").innerHTML = next24.map(h => {
    const ws = toMph(h.windSpeed10m ?? 0);
    const wg = toMph(h.windGustSpeed10m ?? null);
    return `
      <div class="wx-hour">
        <div>${new Date(h.time).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}</div>
        <div class="ico">${metIcon(h.significantWeatherCode)}</div>
        <div>
          <span class="badge blue">${Math.round(h.probOfPrecipitation ?? 0)}%</span>
          <span class="badge green">${(h.totalPrecipAmount ?? 0).toFixed(1)} mm</span>
        </div>
        <div>${Math.round(ws)}${wg?`/${Math.round(wg)}`:""} mph ${arrow(h.windDirectionFrom10m ?? 0)}</div>
      </div>
    `;
  }).join("");
}


async function loadBoards(centerReach = "Shiplake Lock to Marsh Lock") {
  const row = document.getElementById("boardRow");
  if (!row) return;
  row.innerHTML = "<div class='muted'>Loading…</div>";

  try {
    const res = await fetch("/api/ea/boards", { cache: "no-store" });
    const itemsRaw = await res.json();

    // Guard against weird shapes
    const items = (Array.isArray(itemsRaw) ? itemsRaw : [])
      .filter(r => r && typeof r.reach === "string" && typeof r.status === "string");

    const makeArrow = (trend) =>
      trend === "increasing" ? "↑" : trend === "decreasing" ? "↓" : "";

    if (!items.length) {
      row.innerHTML = "<div class='muted'>No board data available right now.</div>";
      return;
    }

    row.innerHTML = items.map(r => {
      const cls = `board ${r.status}`;
      const arrow = makeArrow(r.trend);
      const label =
        r.status === "red" ? "Strong stream" :
        (r.status === "yellow" && r.trend === "increasing") ? "Stream increasing" :
        (r.status === "yellow" && r.trend === "decreasing") ? "Stream decreasing" :
        "No stream warnings";

      const isCenter = r.reach.toLowerCase() === centerReach.toLowerCase();
      return `
        <div class="${cls}${isCenter ? " center": ""}" role="listitem" data-reach="${r.reach}">
          <div class="reach">${r.reach}</div>
          <div class="status">
            <span class="badge">${label}</span>
            ${arrow ? `<span class="arrow">${arrow}</span>` : ``}
          </div>
        </div>`;
    }).join("");

    // Try to center the target reach if present
    const el = [...row.children].find(div => (div.dataset.reach || "").toLowerCase() === centerReach.toLowerCase());
    if (el) el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  } catch (e) {
    console.error("boards load failed", e);
    row.innerHTML = "<div class='muted'>Couldn’t load EA boards right now.</div>";
  }
}



/* ========= Santa hat helper (kept) ========= */
function ensureSantaHat() {
  const brand = document.querySelector('.brand');
  if (!brand) return;

  let hat = document.getElementById('santa-hat');
  if (!hat) {
    hat = document.createElement('img');
    hat.id = 'santa-hat';
    hat.className = 'hat';
    hat.alt = '';
    hat.decoding = 'async';
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 100">
  <defs>
    <linearGradient id="r" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#e53935"/>
      <stop offset="1" stop-color="#b71c1c"/>
    </linearGradient>
  </defs>
  <path d="M12 82 C 18 35, 70 8, 128 20 C 85 35, 66 55, 52 82 Z" fill="url(#r)"/>
  <rect x="8" y="78" width="124" height="18" rx="9" ry="9" fill="#ffffff"/>
  <circle cx="120" cy="26" r="12" fill="#ffffff"/>
</svg>`;
    hat.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    brand.appendChild(hat);
  }
}

/* ========= Collapsible forecast & initial loads ========= */
window.addEventListener('DOMContentLoaded', () => {
  // collapse forecast by default
  const card = document.getElementById('forecastCard');
  const toggle = document.getElementById('wx-toggle');
  if (card && toggle) {
    card.classList.add('collapsed');
    toggle.addEventListener('click', () => {
      const isCollapsed = card.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.textContent = isCollapsed ? 'Show forecast ▾' : 'Hide forecast ▴';
    });
  }

  // defaults that match the 'active' buttons
  loadTemps(10);
  loadFlow(14);
  loadEDM();
  loadWeather();
  loadBoards("Shiplake Lock to Marsh Lock");


  // range button handlers
  document.getElementById('tempRanges')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-days]'); if (!btn) return;
    loadTemps(parseInt(btn.dataset.days, 10));
  });
  document.getElementById('flowRanges')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-days]'); if (!btn) return;
    loadFlow(parseInt(btn.dataset.days, 10));
  });
});



/* ========= Seasonal effects (Christmas + Snow + 💩 easter egg) =========
   Christmas theme: ON 1 Dec – 1 Jan (inclusive), hidden otherwise.
   Snow: visible Dec–Feb; default ON in Dec, OFF in Jan–Feb (remember choice in localStorage per winter).
   Easter egg: triple-click “Snow” within 7s → 💩 mode; stored in sessionStorage for this tab.
======================================================================= */
(function seasonalEffects() {
  const TZ = "Europe/London";
  const root = document.documentElement;

  // --- robust UK date parts ---
  function ukParts(dUtc = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, year: "numeric", month: "numeric", day: "numeric"
    }).formatToParts(dUtc).reduce((acc, p) => (p.type !== "literal" ? (acc[p.type] = p.value, acc) : acc), {});
    return { y: +parts.year, m: +parts.month, d: +parts.day };
  }

  // --- seasonal windows ---
  function inChristmasWindow() { const { m, d } = ukParts(); return (m === 12 && d >= 1) || (m === 1 && d === 1); }
  function inSnowSeason() { const { m } = ukParts(); return m === 12 || m === 1 || m === 2; }
  function inJanFeb() { const { m } = ukParts(); return m === 1 || m === 2; }

  // --- elements ---
  let btn = document.getElementById("snow-toggle");
  let cnv = document.getElementById("snow-canvas");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "snow-toggle";
    btn.className = "btn btn-small xmas-toggle";
    btn.title = "Toggle snow";
    btn.textContent = "Snow";
    document.body.appendChild(btn);
  }
  if (!cnv) {
    cnv = document.createElement("canvas");
    cnv.id = "snow-canvas";
    cnv.setAttribute("aria-hidden", "true");
    document.body.appendChild(cnv);
  }

  // --- snow engine state ---
  let rafId = null;
  let onResize = null;
  let pooMode = false; // easter egg (session only)

  try {
    pooMode = sessionStorage.getItem("pooMode") === "1";
  } catch {}

  function savePoo(v) {
    pooMode = !!v;
    try { sessionStorage.setItem("pooMode", pooMode ? "1" : "0"); } catch {}
  }

  // --- draw helpers ---
  function startSnow(canvas) {
    if (rafId) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const ctx = canvas.getContext("2d");
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0, h = 0, flakes = [];

    function resize() {
      w = canvas.width  = Math.floor(window.innerWidth  * DPR);
      h = canvas.height = Math.floor(window.innerHeight * DPR);
      // perf: fewer particles if using emoji (heavier than circles)
      const density = pooMode ? 28000 : 18000;
      const base = pooMode ? 44 : 60;
      const N = Math.floor((window.innerWidth * window.innerHeight) / density) + base;

      flakes = [];
      for (let i = 0; i < N; i++) {
        flakes.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: 0.9 + Math.random() * 1.8,           // “size”
          s: 0.45 + Math.random() * 0.9,          // fall speed
          a: Math.random() * Math.PI * 2,         // phase
          drift: 0.3 + Math.random() * 0.7,       // side-to-side
          o: 0.55 + Math.random() * 0.45,         // opacity
          spin: (Math.random() * 0.8 - 0.4) * 0.02
        });
      }
    }

    resize();
    onResize = () => resize();
    window.addEventListener("resize", onResize);

    function drawCircle(f) {
      ctx.globalAlpha = f.o;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * DPR * 1.3, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawPoo(f) {
      // render small emoji with gentle rotation
      const px = 22 * f.r * DPR; // emoji size (tweakable)
      ctx.save();
      ctx.globalAlpha = Math.min(0.95, f.o + 0.1);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `${px}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;
      ctx.translate(f.x, f.y);
      ctx.rotate(f.a * 0.15);
      ctx.fillText("💩", 0, 0);
      ctx.restore();
    }

    function tick() {
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = pooMode ? "source-over" : "lighter";

      for (const f of flakes) {
        // motion
        f.y += f.s * DPR;
        f.x += Math.cos((f.a += 0.01)) * f.drift * DPR;
        f.a += f.spin;

        // wrap
        if (f.y > h + 5) { f.y = -10; f.x = Math.random() * w; }
        if (f.x < -5) f.x = w + 5; else if (f.x > w + 5) f.x = -5;

        // draw
        if (pooMode) drawPoo(f); else drawCircle(f);
      }
      rafId = requestAnimationFrame(tick);
    }

    tick();
  }

  function stopSnow(canvas) {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (onResize) { window.removeEventListener("resize", onResize); onResize = null; }
    const ctx = canvas.getContext("2d");
    ctx && ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // --- theme + snow control ---
  function enableChristmasTheme(on) {
    if (on) {
      root.classList.add("christmas");
      try { ensureSantaHat && ensureSantaHat(); } catch {}
    } else {
      root.classList.remove("christmas");
    }
  }

  function setSnow(on) {
    btn.dataset.on = on ? "1" : "";
    // show 💩 only when easter egg active AND snow visible AND on
    const label = pooMode && !btn.hidden && on ? "Snow: on 💩" : on ? "Snow: on" : "Snow: off";
    btn.textContent = label;
    if (on) startSnow(cnv); else stopSnow(cnv);
  }

  // --- localStorage key for Jan–Feb preference ---
  function snowPrefKey() {
    const { y } = ukParts();
    return `snowPref-${y}`;
  }

  // --- initialise per season ---
  const xmas = inChristmasWindow();
  const snowWindow = inSnowSeason();
  const janFeb = inJanFeb();

  btn.hidden = !snowWindow;
  enableChristmasTheme(xmas);

  let snowOn;
  if (xmas) {
    snowOn = true;
  } else if (janFeb) {
    let stored = null;
    try { stored = localStorage.getItem(snowPrefKey()); } catch {}
    snowOn = stored ? stored === 'on' : false;
  } else {
    snowOn = false;
  }
  setSnow(snowOn);

  // --- easter egg triple-click detection (3 toggles in <= 7s) ---
  const CLICK_WINDOW_MS = 7000;
  const clicks = [];

  btn.addEventListener("click", () => {
    // actual on/off toggle
    const next = !(btn.dataset.on === "1");
    setSnow(next);

    // remember Jan–Feb choice
    if (janFeb) {
      try { localStorage.setItem(snowPrefKey(), next ? 'on' : 'off'); } catch {}
    } else {
      try { localStorage.removeItem(snowPrefKey()); } catch {}
    }

    // record click time & prune
    const now = Date.now();
    clicks.push(now);
    while (clicks.length && now - clicks[0] > CLICK_WINDOW_MS) clicks.shift();

    // 3 clicks within window? toggle poo mode and restart animation to apply density change
    if (clicks.length >= 3) {
      savePoo(!pooMode);            // flip mode
      clicks.length = 0;            // reset
      if (btn.dataset.on === "1") { // if currently running, restart to rebuild flakes
        stopSnow(cnv);
        setSnow(true);
      } else {
        // update label to show the 💩 hint even when off
        btn.textContent = pooMode ? "Snow: off 💩" : "Snow: off";
      }
    }
  });

})();
