const $ = (id) => document.getElementById(id);
const DAY = 24*60*60*1000;
const daysAgoISO = (n) => new Date(Date.now() - n*DAY).toISOString();

function since(d) {
  const sec = Math.max(0, (Date.now() - d.getTime())/1000);
  if (sec < 90) return `${Math.round(sec)}s ago`;
  const min = sec/60; if (min < 90) return `${Math.round(min)}m ago`;
  const hr = min/60; if (hr < 36) return `${Math.round(hr)}h ago`;
  const dd = hr/24; return `${Math.round(dd)}d ago`;
}


async function loadTemps() {
  const res = await fetch('/api/csv/shiplake', { cache: 'no-store' });
  const raw = await res.text();
  if (!res.ok || !raw) { riverNow.textContent='No data'; riverUpdated.textContent='—'; return; }

  const txt = raw.replace(/^\uFEFF/, '').trim();
  const lines = txt.split(/\r?\n/).filter(Boolean);

  // Detect delimiter and header
  const firstLine = lines[0] || '';
  const delim = (firstLine.match(/,/g)?.length || 0) >= (firstLine.match(/;/g)?.length || 0) ? ',' : ';';
  const startIdx = /date/i.test(firstLine) ? 1 : 0;

  // Your working parseTime that handles YYYYMMDDHHMMSSZ stays the same
  const parseTime = (s) => {
    if (!s) return null;
    s = String(s).trim().replace(/^"|"$/g, '');
    let m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(Z)?$/);
    if (m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]));
    if (/^\d{10}(\.\d+)?$/.test(s)) return new Date(parseFloat(s) * 1000);
    if (/^\d{13}$/.test(s))         return new Date(parseInt(s, 10));
    m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\s*(UTC|GMT))?$/i);
    if (m) return new Date(`${m[1]}T${m[2]}Z`);
    const d = new Date(s);
    return isNaN(d) ? null : d;
  };

  // Parse rows
  const all = [];
  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].split(delim).map(x => x.trim());
    if (parts.length < 3) continue;
    const t = parseTime(parts[0]); if (!t) continue;
    const air   = /^\s*(nan|NaN)?\s*$/.test(parts[1]) ? undefined : parseFloat(parts[1]);
    const river = /^\s*(nan|NaN)?\s*$/.test(parts[2]) ? undefined : parseFloat(parts[2]);
    if (!isFinite(river)) continue;
    all.push({ t, air: isFinite(air) ? air : undefined, river });
  }

  // Keep last 10 days explicitly
  const cut = Date.now() - 10*DAY;
  const pts = all.filter(p => p.t.getTime() >= cut);
  if (!pts.length) { riverNow.textContent='No data'; riverUpdated.textContent='—'; return; }

  // Now panel
  const last = pts[pts.length - 1];
  riverNow.textContent = `${last.river.toFixed(1)}°C`;
  airNow.textContent   = last.air != null ? `${last.air.toFixed(1)}°C` : '—';
  const sec = Math.max(0, (Date.now() - last.t.getTime())/1000);
  riverUpdated.textContent = sec < 90 ? `${Math.round(sec)}s ago`
    : sec/60 < 90 ? `${Math.round(sec/60)}m ago`
    : sec/3600 < 36 ? `${Math.round(sec/3600)}h ago`
    : `${Math.round(sec/86400)}d ago`;

  // Update chart title text to reflect actual window
  document.querySelector('h3:nth-of-type(1)').textContent = 'Temperatures (last 10 days)';

  new Chart(document.getElementById('tempChart'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'River °C', data: pts.map(p => ({ x: p.t, y: p.river })) },
        { label: 'Air °C',   data: pts.filter(p => p.air != null).map(p => ({ x: p.t, y: p.air })) },
      ]
    },
    options: {
      animation: false, parsing: false, responsive: true,
      plugins: {
        legend: { position: 'bottom' },
        // keep charts fast with thousands of points
        decimation: { enabled: true, algorithm: 'min-max' } // or 'lttb'
      },
      interaction: { intersect: false, mode: 'nearest' },
      scales: {
        x: { type: 'time', time: { unit: 'day' } },   // <-- show day ticks
        y: { title: { display: true, text: '°C' } }
      }
    }
  });
}



async function loadFlow() {
  const since = daysAgoISO(14);
  const url = `/api/ea/flow?measure=2604TH-flow--i-15_min-m3_s&since=${encodeURIComponent(since)}&limit=10000`;
  let data;
  try {
    data = await (await fetch(url, { cache: 'no-store' })).json();
  } catch (e) { console.error('EA fetch failed', e); flowNow.textContent='Unavailable'; flowUpdated.textContent='—'; return; }

  const items = (data.items || [])
    .map(r => ({ t: new Date(r.dateTime), v: +r.value }))
    .filter(r => isFinite(r.v))
    .sort((a,b) => a.t - b.t);

  if (!items.length) { flowNow.textContent='No data'; flowUpdated.textContent='—'; return; }

  const last = items[items.length - 1];
  flowNow.textContent = `${last.v.toFixed(1)} m³/s`;
  const sec = Math.max(0, (Date.now() - last.t.getTime())/1000);
  flowUpdated.textContent = sec < 90 ? `${Math.round(sec)}s ago`
    : sec/60 < 90 ? `${Math.round(sec/60)}m ago`
    : sec/3600 < 36 ? `${Math.round(sec/3600)}h ago`
    : `${Math.round(sec/86400)}d ago`;

  // Update chart title text
  document.querySelector('h3:nth-of-type(2)').textContent = 'Flow rate (last 14 days)';

  new Chart(document.getElementById('flowChart'), {
    type: 'line',
    data: { datasets: [{ label: 'Flow (m³/s)', data: items.map(r => ({ x: r.t, y: r.v })) }] },
    options: {
      animation:false, parsing:false, responsive:true,
      plugins: { legend:{ position:'bottom' }, decimation:{ enabled:true, algorithm:'min-max' } },
      scales: {
        x:{ type:'time', time:{ unit:'day' } },   // <-- day ticks
        y:{ title:{ display:true, text:'m³/s' } }
      }
    }
  });
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
