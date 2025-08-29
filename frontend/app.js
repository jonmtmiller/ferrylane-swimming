const $ = (id) => document.getElementById(id);
function since(d) {
  const sec = Math.max(0, (Date.now() - d.getTime())/1000);
  if (sec < 90) return `${Math.round(sec)}s ago`;
  const min = sec/60; if (min < 90) return `${Math.round(min)}m ago`;
  const hr = min/60; if (hr < 36) return `${Math.round(hr)}h ago`;
  const dd = hr/24; return `${Math.round(dd)}d ago`;
}
async function loadTemps() {
  const debug = (msg) => {
    const el = document.getElementById('tempsDebug');
    if (el) el.textContent = String(msg);
    console.log('[temps]', msg);
  };

  // Fetch CSV from your proxy (avoids CORS)
  const res = await fetch('/api/csv/shiplake', { cache: 'no-store' });
  const raw = await res.text();
  if (!res.ok || !raw) {
    $('riverNow').textContent = 'No data';
    $('riverUpdated').textContent = '—';
    debug(`HTTP ${res.status}\n${raw.slice(0,200)}`);
    return;
  }

  // Heuristics: delimiter + strip BOM + trim
  const txt = raw.replace(/^\uFEFF/, '').trim();
  const firstLine = txt.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/,/g)?.length || 0) >= (firstLine.match(/;/g)?.length || 0) ? ',' : ';';

  // Robust time parser: epoch 10/13, or 'YYYY-MM-DD HH:MM(:SS)' (space or T), or ISO
  const parseTime = (s) => {
    if (!s) return null;
    s = s.trim();
    if (/^\d{10}(\.\d+)?$/.test(s)) return new Date(parseFloat(s) * 1000);
    if (/^\d{13}$/.test(s))         return new Date(parseInt(s, 10));
    // Common “YYYY-MM-DD HH:MM(:SS)”
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      // treat as UTC to be consistent
      const iso = s.replace(' ', 'T');
      return new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    }
    // Try native parse as last resort
    const d = new Date(s);
    return isNaN(d) ? null : d;
  };

  // Parse lines
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const points = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(delim).map(x => x.trim());
    if (parts.length < 3) continue;
    const [tRaw, airRaw, riverRaw] = parts;

    // Skip header if present
    const maybeHeader = i === 0 && (/[a-zA-Z]/.test(tRaw) || /air/i.test(airRaw) || /river/i.test(riverRaw));
    if (maybeHeader) continue;

    const t = parseTime(tRaw);
    if (!t) continue;

    // Accept both 'nan' and empty cells
    const air   = /^\s*(nan|NaN)?\s*$/.test(airRaw)   ? undefined : parseFloat(airRaw);
    const river = /^\s*(nan|NaN)?\s*$/.test(riverRaw) ? undefined : parseFloat(riverRaw);

    if (!isFinite(river)) continue; // require river for plotting
    points.push({ t, air: isFinite(air) ? air : undefined, river });
  }

  // Diagnostics (helpful if still empty)
  debug([
    `lines: ${lines.length}`,
    `delimiter: "${delim}"`,
    `firstLine: ${firstLine}`,
    `parsed points: ${points.length}`,
    points[0] ? `first: ${points[0].t.toISOString()} • ${points[0].river}°C` : 'first: —',
    points.at?.(-1) ? `last:  ${points.at(-1).t.toISOString()} • ${points.at(-1).river}°C` : 'last: —',
  ].join('\n'));

  if (!points.length) {
    $('riverNow').textContent = 'No data';
    $('riverUpdated').textContent = '—';
    return;
  }

  // Show latest
  const last = points[points.length - 1];
  $('riverNow').textContent = `${last.river.toFixed(1)}°C`;
  $('airNow').textContent   = last.air != null ? `${last.air.toFixed(1)}°C` : '—';
  const sec = Math.max(0, (Date.now() - last.t.getTime())/1000);
  $('riverUpdated').textContent = sec < 90 ? `${Math.round(sec)}s ago`
    : sec/60 < 90 ? `${Math.round(sec/60)}m ago`
    : sec/3600 < 36 ? `${Math.round(sec/3600)}h ago`
    : `${Math.round(sec/86400)}d ago`;

  // Draw chart
  new Chart(document.getElementById('tempChart'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'River °C', data: points.map(p => ({ x: p.t, y: p.river })) },
        { label: 'Air °C',   data: points.filter(p => p.air != null).map(p => ({ x: p.t, y: p.air })) },
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
