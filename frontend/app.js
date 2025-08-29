const $ = (id) => document.getElementById(id);
function since(d) {
  const sec = Math.max(0, (Date.now() - d.getTime())/1000);
  if (sec < 90) return `${Math.round(sec)}s ago`;
  const min = sec/60; if (min < 90) return `${Math.round(min)}m ago`;
  const hr = min/60; if (hr < 36) return `${Math.round(hr)}h ago`;
  const dd = hr/24; return `${Math.round(dd)}d ago`;
}
async function loadTemps() {
  async function fetchCsv(freq='5m') {
    const url = freq === '1h' ? '/api/csv/shiplake?freq=1h' : '/api/csv/shiplake';
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
    return await res.text();
  }

  function parseCsvToPoints(txt) {
    const clean = txt.replace(/^\uFEFF/, '').trim(); // strip BOM
    const lines = clean.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      const [tRaw, airRaw, riverRaw] = line.split(',').map(s => s?.trim());
      if (!tRaw) continue;

      // Timestamp can be epoch seconds or ISO-like
      let t;
      if (/^\d{10}(\.\d+)?$/.test(tRaw)) { t = new Date(parseFloat(tRaw) * 1000); }
      else if (/^\d{13}$/.test(tRaw))     { t = new Date(parseInt(tRaw, 10)); }
      else {
        const d = new Date(tRaw);
        if (!isNaN(d)) t = d; else continue;
      }

      const air = parseFloat(airRaw);
      const river = parseFloat(riverRaw);

      // Drop rows with NaN river (feed sometimes emits 'nan' on the newest row)
      if (!isFinite(river)) continue;

      out.push({ t, air: isFinite(air) ? air : undefined, river });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  let txt, pts = [];
  try {
    txt = await fetchCsv('5m');
    pts = parseCsvToPoints(txt);
    // Fallback to hourly if the 5-minute file yields nothing (rare)
    if (pts.length < 3) {
      txt = await fetchCsv('1h');
      pts = parseCsvToPoints(txt);
    }
  } catch (e) {
    console.error('CSV fetch failed', e);
  }
  if (!pts.length) {
    document.getElementById('riverNow').textContent = 'No data';
    document.getElementById('riverUpdated').textContent = '—';
    return;
  }

  const last = pts[pts.length - 1];
  document.getElementById('riverNow').textContent = `${last.river.toFixed(1)}°C`;
  document.getElementById('airNow').textContent   = (last.air != null ? `${last.air.toFixed(1)}°C` : '—');
  document.getElementById('riverUpdated').textContent = (() => {
    const sec = Math.max(0, (Date.now() - last.t.getTime())/1000);
    if (sec < 90) return `${Math.round(sec)}s ago`;
    const min = sec/60; if (min < 90) return `${Math.round(min)}m ago`;
    const hr = min/60; if (hr < 36) return `${Math.round(hr)}h ago`;
    const dd = hr/24; return `${Math.round(dd)}d ago`;
  })();

  new Chart(document.getElementById('tempChart'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'River °C', data: pts.map(p => ({ x: p.t, y: p.river })) },
        { label: 'Air °C',   data: pts.filter(p => p.air != null).map(p => ({ x: p.t, y: p.air })) }
      ]
    },
    options: {
      animation: false, parsing: false, responsive: true,
      interaction: { intersect: false, mode: 'nearest' },
      scales: { x: { type: 'time', time: { unit: 'hour' } }, y: { title: { display: true, text: '°C' } } },
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

async function loadFlow() {
  const url = 'https://environment.data.gov.uk/flood-monitoring/id/measures/2604TH-flow--i-15_min-m3_s/readings?_sorted&_limit=200';
  try {
    const data = await (await fetch(url)).json();
    const items = (data.items||[]).map(r => ({t:new Date(r.dateTime), v:+r.value})).filter(r=>isFinite(r.v));
    if (!items.length) return;
    const last = items[items.length-1];
    $('flowNow').textContent = `${last.v.toFixed(1)} m³/s`;
    $('flowUpdated').textContent = since(last.t);
    new Chart(document.getElementById('flowChart'), {
      type:'line',
      data:{ datasets:[{ label:'Flow (m³/s)', data: items.map(r=>({x:r.t,y:r.v})) }] },
      options:{ animation:false, parsing:false, responsive:true,
        scales:{ x:{type:'time', time:{unit:'hour'}}, y:{title:{display:true,text:'m³/s'}} },
        plugins:{ legend:{position:'bottom'} }
      }
    });
  } catch(e){ console.error('EA fetch failed', e); }
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
window.addEventListener('DOMContentLoaded', ()=>{ loadTemps(); loadFlow(); loadEDM(); loadWeather(); });
