const $ = (id) => document.getElementById(id);

let tempChart, flowChart;
const DAY = 24*60*60*1000;
const daysAgoISO = (n) => new Date(Date.now() - n*DAY).toISOString();

// Simple icon mapping for Met Office significantWeatherCode
const metIcon = (code) => {
  if (code == null) return "❓";
  if ([0, 1].includes(code)) return "☀️";   // clear/sunny
  if ([2, 3].includes(code)) return "⛅";   // partly/cloudy
  if ([5, 6, 7].includes(code)) return "🌫️";
  if ([8, 9, 10, 11, 12].includes(code)) return "🌧️"; // rain / showers
  if ([14, 15].includes(code)) return "🌨️"; // snow
  if ([30, 31].includes(code)) return "⛈️"; // thunder
  return "❓";
};
const arrow = (deg=0)=>["↑","↗","→","↘","↓","↙","←","↖"][Math.round(((deg%360)+360)%360/45)%8];


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

/*
async function loadWeather() {
  const lat=51.5, lon=-0.87;
  const url=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation&current=temperature_2m&timezone=Europe%2FLondon`;
  try {
    const wx = await (await fetch(url)).json();
    const cur = wx.current || {};
    const t = cur.temperature_2m;
    $('wxNow').textContent = (t!=null) ? `${(t.toFixed?t.toFixed(1):t)}°C` : '—';
    const hours = wx.hourly?.time?.slice(0,6)||[];
    const prec = wx.hourly?.precipitation?.slice(0,6)||[];
    $('wxDetail').textContent = hours.map((t,i)=>{
      const hh = new Date(t).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      return `${hh}: ${prec[i] ?? 0} mm`;
    }).join(' · ');
  } catch(e){ console.error('weather failed', e); }
  }
  */

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
    const curHtml = `
      <div class="big">${metIcon(hNext.significantWeatherCode)} ${Math.round(hNext.screenTemperature)}°C</div>
      <div class="muted">
        Wind ${Math.round(hNext.windSpeed10m ?? 0)}${hNext.windGustSpeed10m?`/${Math.round(hNext.windGustSpeed10m)}`:""} mph ${arrow(hNext.windDirectionFrom10m ?? 0)}
        · Precip ${(hNext.totalPrecipAmount ?? hNext.precipitationAmount ?? 0).toFixed(1)} mm
      </div>`;
    document.getElementById("wx-current").innerHTML = curHtml;
  }

  // ----- Daily (7d) -----
  const dayName = (dt)=> new Date(dt).toLocaleDateString("en-GB",{weekday:"short"});
  document.getElementById("wx-daily").innerHTML = daily.map(d => `
    <div class="wx-day">
      <div class="d">${dayName(d.time)}</div>
      <div class="ico">${metIcon(d.significantWeatherCode)}</div>
      <div class="row"><span>Rain</span><span>${((d.totalPrecipAmount ?? d.precipitationAmount ?? 0).toFixed(1))} mm</span></div>
      <div class="row"><span>Wind</span><span>${Math.round(d.max10mWindGust ?? d.windGustSpeed10m ?? 0)} mph</span></div>
    </div>
  `).join("");

  // ----- Hourly (next 24h) -----
  const end = now + 24*60*60*1000;
  const next24 = hourly.filter(h => {
    const t = new Date(h.time).getTime();
    return t >= now && t < end;
  });
  document.getElementById("wx-hourly").innerHTML = next24.map(h => `
    <div class="wx-hour">
      <div>${new Date(h.time).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}</div>
      <div class="ico">${metIcon(h.significantWeatherCode)}</div>
      <div>
        <span class="badge blue">${Math.round(h.probOfPrecipitation ?? h.precipitationProbability ?? 0)}%</span>
        <span class="badge green">${((h.totalPrecipAmount ?? h.precipitationAmount ?? 0)).toFixed(1)} mm</span>
      </div>
      <div>${Math.round(h.windSpeed10m ?? 0)}${h.windGustSpeed10m?`/${Math.round(h.windGustSpeed10m)}`:""} mph ${arrow(h.windDirectionFrom10m ?? 0)}</div>
    </div>
  `).join("");
}



window.addEventListener('DOMContentLoaded', () => {
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

