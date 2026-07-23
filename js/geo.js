// Geo-Mathe, Track-Statistik, Formatierung, GPX

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function distM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const la1 = rad(a.lat), la2 = rad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// kürzester Abstand eines Punktes zu einem Track (grob, Punkt-zu-Punkt)
export function distToTrack(p, pts, step = 1) {
  let min = Infinity;
  for (let i = 0; i < pts.length; i += step) {
    const d = distM(p, pts[i]);
    if (d < min) min = d;
  }
  return min;
}

export function bounds(pts) {
  let n = -90, s = 90, e = -180, w = 180;
  for (const p of pts) {
    if (p.lat > n) n = p.lat; if (p.lat < s) s = p.lat;
    if (p.lon > e) e = p.lon; if (p.lon < w) w = p.lon;
  }
  return [[s, w], [n, e]];
}

// Vollständige Auswertung eines Punkte-Arrays {t,lat,lon,alt,acc,v}
export function analyze(pts) {
  const out = {
    dist: 0, dur: 0, moving: 0, avg: 0, avgMoving: 0, max: 0, min: 0,
    up: 0, down: 0, maxAlt: null, minAlt: null,
    maxIdx: 0, minIdx: 0, series: [],
  };
  if (!pts || pts.length < 2) return out;
  out.dur = (pts[pts.length - 1].t - pts[0].t) / 1000;

  let dist = 0;
  const series = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      const d = distM(pts[i - 1], pts[i]);
      const dt = (pts[i].t - pts[i - 1].t) / 1000;
      dist += d;
      if (dt > 0 && d / dt > 0.7) out.moving += dt;
    }
    series.push({ t: (pts[i].t - pts[0].t) / 1000, d: dist, v: Math.max(0, pts[i].v || 0), alt: pts[i].alt, lat: pts[i].lat, lon: pts[i].lon, i });
  }
  out.dist = dist;
  out.series = series;
  out.avg = out.dur > 0 ? dist / out.dur : 0;
  out.avgMoving = out.moving > 0 ? dist / out.moving : 0;

  // Höchst-/Tiefpunkt der Geschwindigkeit (Tiefpunkt nur im fahrenden Teil suchen)
  let max = -1, maxIdx = 0;
  for (const s of series) if (s.v > max) { max = s.v; maxIdx = s.i; }
  out.max = Math.max(0, max); out.maxIdx = maxIdx;
  const mid = series.filter((s) => s.t > 5 && s.t < (out.dur - 5));
  const pool = mid.length > 4 ? mid : series;
  let min = Infinity, minIdx = 0;
  for (const s of pool) if (s.v < min) { min = s.v; minIdx = s.i; }
  out.min = min === Infinity ? 0 : min; out.minIdx = minIdx;

  // Höhenmeter mit Rauschfilter
  const alts = pts.map((p) => p.alt).filter((a) => typeof a === 'number' && isFinite(a));
  if (alts.length > 4) {
    out.maxAlt = Math.max(...alts); out.minAlt = Math.min(...alts);
    const sm = smooth(pts.map((p) => (typeof p.alt === 'number' ? p.alt : null)), 5);
    let ref = sm.find((a) => a !== null);
    for (const a of sm) {
      if (a === null || ref === undefined) continue;
      const diff = a - ref;
      if (Math.abs(diff) >= 3) { if (diff > 0) out.up += diff; else out.down -= diff; ref = a; }
    }
  }
  return out;
}

export function smooth(arr, win) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(arr.length - 1, i + win); j++) {
      if (arr[j] === null || arr[j] === undefined || !isFinite(arr[j])) continue;
      sum += arr[j]; n++;
    }
    out.push(n ? sum / n : null);
  }
  return out;
}

// ---- Formatierung ----
export const kmh = (ms) => (ms || 0) * 3.6;
export const nf = (v, d = 1) => (v || 0).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

export function fmtSpeed(ms, d = 1) { return nf(kmh(ms), d); }
export function fmtDist(m) {
  if (m < 1000) return { v: Math.round(m).toString(), u: 'm' };
  return { v: nf(m / 1000, 2), u: 'km' };
}
export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export function fmtLap(sec) {
  const neg = sec < 0;
  sec = Math.abs(sec || 0);
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${neg ? '−' : ''}${m}:${s.toFixed(2).padStart(5, '0')}`;
}
export function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
    + ' · ' + new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

// ---- GPX ----
export function toGPX(name, pts, spots = []) {
  const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const wpt = spots.map((s) => `  <wpt lat="${s.lat}" lon="${s.lon}"><name>${esc(s.name)}</name>${s.note ? `<desc>${esc(s.note)}</desc>` : ''}</wpt>`).join('\n');
  const trk = pts.map((p) => `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${typeof p.alt === 'number' ? `<ele>${p.alt.toFixed(1)}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="floatTRACK" xmlns="http://www.topografix.com/GPX/1/1">
${wpt}
  <trk><name>${esc(name)}</name><trkseg>
${trk}
  </trkseg></trk>
</gpx>`;
}

export function download(filename, text, type = 'application/gpx+xml') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
