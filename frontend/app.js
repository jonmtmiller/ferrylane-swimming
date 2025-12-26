const $ = (id) => document.getElementById(id);

let tempChart, flowChart;
const DAY = 24*60*60*1000;
const daysAgoISO = (n) => new Date(Date.now() - n*DAY).toISOString();

// Met Office icon mapping (keep your version if you already have one)
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

// Aggregate hourly into local-day buckets (mm total + max winds)
function bucketHourly(hourly) {
  const map = new Map(); // key: 'YYYY-MM-DD' -> { mm, maxWind, maxGust }
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




// Try common daily code field names, then fall back to any key that looks like a sig. weather code.
function resolveDailyWxCode(d) {
  const candidates = [
    'significantWeatherCode',        // some daily payloads use the same name as hourly
    'daySignificantWeatherCode',     // daytime code
    'significantWeatherCodeDay',     // alt naming
    'significantWeatherCodeMostLikely', // some blends/summary variants
    'weatherCode', 'wxCode'          // very rare alternates
  ];
  for (const k of candidates) {
    const v = d?.[k];
    if (v !== undefined && v !== null) return v;
  }
  // Fallback: pick any property that looks like a “significant…code”
  for (const [k, v] of Object.entries(d || {})) {
    if (/significant.*code/i.test(k) && v !== undefined && v !== null) return v;
  }
  return null;
}

// Daily: pick whichever field the API provides - JM: this was created after the one above, but keeping the one that has more info
/*
function resolveDailyWxCode(d) {
  const candidates = [
    'significantWeatherCode', 'daySignificantWeatherCode',
    'significantWeatherCodeDay', 'significantWeatherCodeMostLikely',
    'weatherCode', 'wxCode'
  ];
  for (const k of candidates) if (d?.[k] != null) return d[k];
  for (const [k, v] of Object.entries(d||{})) if (/significant.*code/i.test(k) && v != null) return v;
  return null;
}
*/

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
  // fallback to gust if that’s all we have
  const g = resolveDailyGustMaxMph(d);
  return Number.isFinite(g) ? g : 0;
}
function resolveDailyGustMaxMph(d) {
  const gustKeys = ['max10mWindGust','windGustSpeed10mMax','maxWindGustSpeed10m','windGust10mMax'];
  for (const k of gustKeys) if (Number.isFinite(d?.[k])) return d[k];
  return undefined; // optional
}
const dayName = (dt)=> new Date(dt).toLocaleDateString("en-GB",{weekday:"short"});




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
  const spanDays = all.length ? (all[all.length-1].t - all[0].t) / (24*60*60*1000) : 0;
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
  const cutMs = endMs - days * 24*60*60*1000;
  const pts = all.filter(p => p.t.getTime() >= cutMs);

  console.info(endMs, cutMs, pts.length);
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
  const sec = Math.max(0, (Date.now() - last.t.getTime())/1000);
  elUpdated.textContent = sec < 90 ? `${Math.round(sec)}s ago`
    : sec/60 < 90 ? `${Math.round(sec/60)}m ago`
    : sec/3600 < 36 ? `${Math.round(sec/3600)}h ago`
    : `${Math.round(sec/86400)}d ago`;

  // 4) Title shows requested range + data source used (optional)
  titleEl.textContent = `Temperatures (last ${days} days${source === 'hourly' ? ' • hourly data' : ''})`;

  // 5) Render chart
  /*tempChart?.destroy();
  tempChart = new Chart(document.getElementById('tempChart'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'River °C', data: pts.map(p => ({ x: p.t, y: p.river })) },
        { label: 'Air °C',   data: pts.filter(p => p.air != null).map(p => ({ x: p.t, y: p.air })) },
      ]
    },
    options: {
      animation: false, parsing: false, responsive: true,
      plugins: { legend: { position: 'bottom' }, decimation: { enabled: true, algorithm: 'min-max' } },
      interaction: { intersect: false, mode: 'nearest' },
      scales: {
        x: { type: 'time', time: { unit: days <= 2 ? 'hour' : 'day' } },
        y: { title: { display: true, text: '°C' } }
      }
    }
  });*/

  // after you have `pts`
const xMin = pts[0].t.getTime();
const xMax = pts[pts.length - 1].t.getTime();

tempChart?.destroy();
tempChart = new Chart(document.getElementById('tempChart'), {
  type: 'line',
  data: {
    datasets: [
      // NOTE: use getTime() for x
      { label: 'River °C', data: pts.map(p => ({ x: p.t.getTime(), y: p.river })) },
      { label: 'Air °C',   data: pts.filter(p => p.air != null).map(p => ({ x: p.t.getTime(), y: p.air })) },
    ]
  },
  options: {
    animation: false, parsing: false, responsive: true,
    plugins: { legend: { position: 'bottom' }, decimation: { enabled: true, algorithm: 'min-max' } },
    interaction: { intersect: false, mode: 'nearest' },
    scales: {
      x: {
        type: 'time',
        min: xMin,               // <-- explicitly set window
        max: xMax,
        time: { unit: days <= 2 ? 'hour' : 'day' }
      },
      y: { title: { display: true, text: '°C' } }
    }
  }
});


  setActive('tempRanges', days);
}





async function loadFlow(days = 14) {
  const DAY = 24 * 60 * 60 * 1000;
  const sinceISO = new Date(Date.now() - days * DAY).toISOString();

  // Ask your proxy for a big enough window (limit ~= 15-min samples per day)
  const estLimit = Math.ceil(days * 96 * 1.2); // buffer
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

  // Anchor the window to the newest reading we actually have
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
  const sec = Math.max(0, (Date.now() - last.t.getTime()) / 1000);
  flowUpdated.textContent =
    sec < 90 ? `${Math.round(sec)}s ago`
    : sec / 60 < 90 ? `${Math.round(sec / 60)}m ago`
    : sec / 3600 < 36 ? `${Math.round(sec / 3600)}h ago`
    : `${Math.round(sec / 86400)}d ago`;

  // Title + chart (NOTE: feed milliseconds to x, and set min/max)
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
      animation: false,
      parsing: false,
      responsive: true,
      plugins: {
        legend: { position: 'bottom' },
        decimation: { enabled: true, algorithm: 'min-max' }
      },
      interaction: { intersect: false, mode: 'nearest' },
      scales: {
        x: {
          type: 'time',
          min: xMin,
          max: xMax,
          time: { unit: days <= 2 ? 'hour' : 'day' }
        },
        y: { title: { display: true, text: 'm³/s' } }
      }
    }
  });

  setActive('flowRanges', days);
}




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

  const dayName = (dt)=> new Date(dt).toLocaleDateString("en-GB",{weekday:"short"});

  document.getElementById("wx-daily").innerHTML = dailyFromToday.map(d => {
    // Icon: use day code (fallback to night code if needed)
    const code = d.daySignificantWeatherCode ?? d.significantWeatherCode ?? d.nightSignificantWeatherCode ?? null;

    // Rain: prefer summed mm from hourly (if we have that day in range), otherwise show probability
    const k = localDayKey(d.time);
    const agg = buckets.get(k);
    const mm = agg?.hasPrecip ? agg.mm : null; // only show if we truly had hourly for that day
    const prob = d.dayProbabilityOfPrecipitation ?? d.dayProbabilityOfRain ?? null;

    // Wind/Gust: prefer hourly max; otherwise use midday values
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




window.addEventListener('DOMContentLoaded', () => {
  // collapse by default
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


// --- Christmas mode (Dec 25–31, Europe/London) ---
(function christmasMode(){
  const TZ = "Europe/London";

  function isXmasWindow(dUtc = new Date()){
    const uk = new Date(dUtc.toLocaleString("en-GB", { timeZone: TZ }));
    const m = uk.getMonth() + 1; // 1..12
    const d = uk.getDate();      // 1..31
    //return (m === 12 && d >= 25 && d <= 31); // exact window
    return (m === 12); // exact window
  }

  // Ensure the DOM exists before we touch elements
  window.addEventListener('DOMContentLoaded', () => {
    // Make sure elements exist (create if missing so we never bail)
    let btn = document.getElementById('xmas-toggle');
    let cnv = document.getElementById('snow-canvas');

    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'xmas-toggle';
      btn.className = 'btn btn-small xmas-toggle';
      btn.title = 'Toggle Christmas mode';
      document.body.appendChild(btn);
    }
    if (!cnv) {
      cnv = document.createElement('canvas');
      cnv.id = 'snow-canvas';
      cnv.setAttribute('aria-hidden', 'true');
      document.body.appendChild(cnv);
    }

    const root = document.documentElement;
    let stopSnow = () => {};

    function startSnow(canvas) {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { stopSnow = () => {}; return; }
      const ctx = canvas.getContext("2d");
      let w, h, flakes = [], rafId;
      const DPR = Math.min(window.devicePixelRatio || 1, 2);
      function resize(){ w = canvas.width = Math.floor(window.innerWidth * DPR);
                         h = canvas.height= Math.floor(window.innerHeight* DPR); }
      resize(); window.addEventListener("resize", resize);

      const N = Math.floor((window.innerWidth * window.innerHeight) / 18000) + 60;
      for (let i=0;i<N;i++) flakes.push({
        x: Math.random()*w, y: Math.random()*h,
        r: 0.7+Math.random()*2.2, s: 0.4+Math.random()*0.9,
        a: Math.random()*Math.PI*2, drift: 0.3+Math.random()*0.7, o: 0.5+Math.random()*0.5
      });

      function tick(){
        ctx.clearRect(0,0,w,h);
        ctx.fillStyle = "#fff";
        ctx.globalCompositeOperation = "lighter";
        for (const f of flakes){
          f.y += f.s * DPR;
          f.x += Math.cos(f.a += 0.01) * f.drift * DPR;
          if (f.y > h + 5) { f.y = -10; f.x = Math.random()*w; }
          if (f.x < -5) f.x = w + 5; else if (f.x > w + 5) f.x = -5;
          ctx.globalAlpha = f.o;
          ctx.beginPath(); ctx.arc(f.x, f.y, f.r * DPR, 0, Math.PI*2); ctx.fill();
        }
        rafId = requestAnimationFrame(tick);
      }
      tick();

      stopSnow = () => { cancelAnimationFrame(rafId); window.removeEventListener("resize", resize); };
    }

    function setMode(on){
      if (on) {
        root.classList.add('christmas');
        btn.hidden = false;
        btn.textContent = '🎄 Christmas mode: on';
        startSnow(cnv);
        try { localStorage.setItem('xmasMode', 'on'); } catch {}
      } else {
        root.classList.remove('christmas');
        btn.hidden = false;
        btn.textContent = '🎄 Christmas mode: off';
        stopSnow();
        const ctx = cnv.getContext('2d'); if (ctx) ctx.clearRect(0,0,cnv.width,cnv.height);
        try { localStorage.setItem('xmasMode', 'off'); } catch {}
      }
    }

    // Decide initial state
    let wants = null;
    try { wants = localStorage.getItem('xmasMode'); } catch {}
    const enable = (wants === 'on') || (wants == null && isXmasWindow());

    // Wire the toggle
    btn.addEventListener('click', () => {
      const isOn = root.classList.contains('christmas');
      setMode(!isOn);
    });

    const enable = isXmasWindow();  // ignores localStorage entirely
    
    // Apply initial
    setMode(enable);
  });
})();




function ensureSantaHat() {
  const brand = document.querySelector('.brand');
  if (!brand) return;

  // already added?
  let hat = document.getElementById('santa-hat');
  if (!hat) {
    hat = document.createElement('img');
    hat.id = 'santa-hat';
    hat.className = 'hat';
    hat.alt = '';
    hat.decoding = 'async';
    // Inline SVG → data URL (utf8-encoded)
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 100">
  <defs>
    <linearGradient id="r" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#e53935"/>
      <stop offset="1" stop-color="#b71c1c"/>
    </linearGradient>
  </defs>
  <!-- red cap -->
  <path d="M12 82 C 18 35, 70 8, 128 20 C 85 35, 66 55, 52 82 Z" fill="url(#r)"/>
  <!-- brim -->
  <rect x="8" y="78" width="124" height="18" rx="9" ry="9" fill="#ffffff"/>
  <!-- bobble -->
  <circle cx="120" cy="26" r="12" fill="#ffffff"/>
</svg>`;
    hat.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    brand.appendChild(hat);
  }
}

// In your existing Christmas mode code, call ensureSantaHat() on enable,
// and optionally remove it on disable:
function setMode(on){
  const root = document.documentElement;
  const btn  = document.getElementById('xmas-toggle');
  const cnv  = document.getElementById('snow-canvas');

  if (on) {
    root.classList.add('christmas');
    btn.hidden = false;
    btn.textContent = '🎄 Christmas mode: on';
    // ... your startSnow(canvas) call ...
    try { localStorage.setItem('xmasMode', 'on'); } catch {}
    ensureSantaHat(); // <- add hat when turning on
  } else {
    root.classList.remove('christmas');
    btn.hidden = false;
    btn.textContent = '🎄 Christmas mode: off';
    // ... your stopSnow() code ...
    try { localStorage.setItem('xmasMode', 'off'); } catch {}
    // Optional: remove the element (or leave it hidden by CSS)
    // const hat = document.getElementById('santa-hat'); if (hat) hat.remove();
  }
}

