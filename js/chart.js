// Canvas-Diagramme: Speed-Profil (mit Höhe-/Tiefpunkt) + Höhenprofil + Live-Sparkline
import { kmh, nf, fmtTime, fmtDist } from './geo.js';

function css(el, name) { return getComputedStyle(el).getPropertyValue(name).trim(); }

function setupCanvas(cv, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = cv.clientWidth || cv.parentElement.clientWidth || 320;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.height = h + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function niceTicks(max, count = 4) {
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  return ticks;
}

// Datenreduktion auf Pixelbreite (Peaks bleiben erhalten)
function resample(series, xKey, yKey, targetPx) {
  if (series.length <= targetPx) return series.slice();
  const x0 = series[0][xKey], x1 = series[series.length - 1][xKey];
  const span = (x1 - x0) || 1;
  const out = [];
  let bucket = 0, best = null, bestV = -Infinity, first = null;
  for (const s of series) {
    const b = Math.floor(((s[xKey] - x0) / span) * (targetPx - 1));
    if (b !== bucket) {
      if (best) out.push(best);
      bucket = b; best = null; bestV = -Infinity; first = null;
    }
    if (!first) first = s;
    if ((s[yKey] ?? -Infinity) > bestV) { bestV = s[yKey] ?? -Infinity; best = s; }
  }
  if (best) out.push(best);
  if (out[0] !== series[0]) out.unshift(series[0]);
  if (out[out.length - 1] !== series[series.length - 1]) out.push(series[series.length - 1]);
  return out;
}

/**
 * Speed-Diagramm mit markiertem Höchst- und Tiefpunkt.
 * opts: {series, xMode:'t'|'d', stats, height, onHover(point|null)}
 */
export function speedChart(canvas, opts) {
  const { series, xMode = 't', stats } = opts;
  const height = opts.height || 190;
  const data = series.filter((s) => isFinite(s.v));
  const state = { hoverIdx: null, pts: [], plot: null, data };

  function draw() {
    const { ctx, w, h } = setupCanvas(canvas, height);
    const line = css(canvas, '--line'), muted = css(canvas, '--text-muted');
    const txt = css(canvas, '--text-primary'), sec = css(canvas, '--text-secondary');
    const s1 = css(canvas, '--series-1'), soft = css(canvas, '--series-1-soft');
    const surf = css(canvas, '--surface-1');
    ctx.clearRect(0, 0, w, h);
    if (data.length < 2) {
      ctx.fillStyle = muted; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('Zu wenig Daten', w / 2, h / 2); return;
    }

    const padL = 34, padR = 12, padT = 26, padB = 20;
    const pw = w - padL - padR, ph = h - padT - padB;
    const xKey = xMode === 'd' ? 'd' : 't';
    const x0 = data[0][xKey], x1 = data[data.length - 1][xKey] || 1;
    const maxV = Math.max(...data.map((s) => kmh(s.v)), 1);
    const yMax = maxV * 1.15;                      // Skala immer über dem Höchstwert
    const ticks = niceTicks(yMax, 4).filter((t) => t <= yMax);
    const X = (v) => padL + ((v - x0) / ((x1 - x0) || 1)) * pw;
    const Y = (v) => padT + ph - (v / yMax) * ph;
    state.plot = { padL, padR, padT, padB, pw, ph, X, Y, xKey, x0, x1 };

    // Grid + Y-Achse (zurückhaltend)
    ctx.font = '10px system-ui'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (const t of ticks) {
      const y = Math.round(Y(t)) + 0.5;
      ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = muted; ctx.fillText(String(Math.round(t)), padL - 6, y);
    }

    const pts = resample(data, xKey, 'v', Math.max(60, Math.round(pw)));
    state.pts = pts;

    // Fläche
    ctx.beginPath();
    ctx.moveTo(X(pts[0][xKey]), Y(0));
    for (const p of pts) ctx.lineTo(X(p[xKey]), Y(kmh(p.v)));
    ctx.lineTo(X(pts[pts.length - 1][xKey]), Y(0));
    ctx.closePath();
    const g = ctx.createLinearGradient(0, padT, 0, padT + ph);
    g.addColorStop(0, soft); g.addColorStop(1, 'transparent');
    ctx.fillStyle = g; ctx.fill();

    // Linie
    ctx.beginPath();
    pts.forEach((p, i) => { const x = X(p[xKey]), y = Y(kmh(p.v)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = s1; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();

    // Ø-Linie
    if (stats && stats.avgMoving) {
      const y = Y(kmh(stats.avgMoving));
      ctx.save(); ctx.setLineDash([3, 4]); ctx.strokeStyle = muted; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.restore();
      ctx.fillStyle = muted; ctx.textAlign = 'left'; ctx.font = '10px system-ui';
      ctx.fillText('Ø ' + nf(kmh(stats.avgMoving), 1), padL + 4, y - 7);
    }

    // Höchst- und Tiefpunkt markieren
    const mark = (item, label, preferAbove) => {
      if (!item) return;
      const x = X(item[xKey]), y = Y(kmh(item.v));
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 7); ctx.fillStyle = s1; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = surf; ctx.stroke();
      // Label kippt nach unten, falls oben kein Platz ist (und umgekehrt)
      let above = preferAbove;
      if (above && y - 9 < padT + 2) above = false;
      if (!above && y + 10 > padT + ph - 4) above = true;
      ctx.font = '600 11px system-ui'; ctx.fillStyle = txt;
      ctx.textAlign = x > w - 70 ? 'right' : (x < padL + 40 ? 'left' : 'center');
      ctx.textBaseline = above ? 'bottom' : 'top';
      ctx.fillText(`${label} ${nf(kmh(item.v), 1)}`, x, above ? y - 9 : y + 10);
    };
    const hi = data[0] && stats ? data.find((s) => s.i === stats.maxIdx) : null;
    const lo = data[0] && stats ? data.find((s) => s.i === stats.minIdx) : null;
    mark(hi, 'MAX', true);
    mark(lo, 'MIN', false);

    // X-Achse
    ctx.fillStyle = muted; ctx.font = '10px system-ui'; ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(xMode === 'd' ? '0 km' : '0:00', padL, h - 13);
    ctx.textAlign = 'right';
    const end = xMode === 'd' ? (fmtDist(x1).v + ' ' + fmtDist(x1).u) : fmtTime(x1);
    ctx.fillText(end, w - padR, h - 13);
    void sec;

    // Crosshair
    if (state.hoverIdx != null) {
      const p = data[state.hoverIdx];
      if (p) {
        const x = X(p[xKey]), y = Y(kmh(p.v));
        ctx.strokeStyle = line; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, padT - 6); ctx.lineTo(x, padT + ph); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fillStyle = s1; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = surf; ctx.stroke();
      }
    }
  }

  function idxAt(clientX) {
    const r = canvas.getBoundingClientRect();
    const p = state.plot; if (!p) return null;
    const x = clientX - r.left;
    const frac = (x - p.padL) / p.pw;
    const target = p.x0 + frac * (p.x1 - p.x0);
    let best = 0, bd = Infinity;
    for (let i = 0; i < data.length; i++) {
      const d = Math.abs(data[i][p.xKey] - target);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  const tip = document.createElement('div');
  tip.className = 'tip';
  canvas.parentElement.appendChild(tip);

  function hover(clientX) {
    const i = idxAt(clientX);
    if (i == null) return;
    state.hoverIdx = i;
    const p = data[i];
    const r = canvas.getBoundingClientRect();
    const pr = canvas.parentElement.getBoundingClientRect();
    const x = state.plot.X(p[state.plot.xKey]) + (r.left - pr.left);
    const y = state.plot.Y(kmh(p.v)) + (r.top - pr.top);
    tip.innerHTML = `<b>${nf(kmh(p.v), 1)} km/h</b><br><span class="tip-m">${fmtTime(p.t)} · ${fmtDist(p.d).v} ${fmtDist(p.d).u}${typeof p.alt === 'number' ? ' · ' + Math.round(p.alt) + ' m' : ''}</span>`;
    tip.style.left = Math.max(52, Math.min(pr.width - 52, x)) + 'px';
    tip.style.top = Math.max(30, y) + 'px';
    tip.style.opacity = '1';
    draw();
    opts.onHover?.(p);
  }
  function leave() {
    state.hoverIdx = null; tip.style.opacity = '0'; draw(); opts.onHover?.(null);
  }

  canvas.addEventListener('pointermove', (e) => { e.preventDefault(); hover(e.clientX); });
  canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); hover(e.clientX); });
  canvas.addEventListener('pointerleave', leave);
  canvas.addEventListener('pointercancel', leave);

  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(canvas.parentElement);
  return { draw, destroy: () => { ro.disconnect(); tip.remove(); } };
}

/** Höhenprofil – eigenes Chart, gleiche X-Achse (nie zwei Y-Achsen in einem Bild) */
export function elevChart(canvas, series, xMode = 't') {
  const data = series.filter((s) => typeof s.alt === 'number' && isFinite(s.alt));
  if (data.length < 3) return null;
  const { ctx, w, h } = setupCanvas(canvas, 90);
  const line = css(canvas, '--line'), muted = css(canvas, '--text-muted');
  const s1 = css(canvas, '--series-1');
  const padL = 34, padR = 12, padT = 10, padB = 14;
  const pw = w - padL - padR, ph = h - padT - padB;
  const xKey = xMode === 'd' ? 'd' : 't';
  const x0 = data[0][xKey], x1 = data[data.length - 1][xKey] || 1;
  let lo = Math.min(...data.map((d) => d.alt)), hi = Math.max(...data.map((d) => d.alt));
  if (hi - lo < 10) { const m = (hi + lo) / 2; lo = m - 5; hi = m + 5; }
  const X = (v) => padL + ((v - x0) / ((x1 - x0) || 1)) * pw;
  const Y = (v) => padT + ph - ((v - lo) / (hi - lo)) * ph;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = line; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT + ph + .5); ctx.lineTo(w - padR, padT + ph + .5); ctx.stroke();
  const pts = resample(data, xKey, 'alt', Math.max(60, Math.round(pw)));
  ctx.beginPath();
  ctx.moveTo(X(pts[0][xKey]), padT + ph);
  for (const p of pts) ctx.lineTo(X(p[xKey]), Y(p.alt));
  ctx.lineTo(X(pts[pts.length - 1][xKey]), padT + ph);
  ctx.closePath();
  ctx.fillStyle = css(canvas, '--surface-3'); ctx.fill();
  ctx.beginPath();
  pts.forEach((p, i) => { const x = X(p[xKey]), y = Y(p.alt); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = s1; ctx.lineWidth = 1.5; ctx.globalAlpha = .75; ctx.stroke(); ctx.globalAlpha = 1;
  ctx.fillStyle = muted; ctx.font = '10px system-ui'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText(Math.round(hi) + ' m', padL - 6, padT + 4);
  ctx.fillText(Math.round(lo) + ' m', padL - 6, padT + ph - 4);
  return true;
}

/** Live-Sparkline während der Fahrt */
export function sparkline(canvas, values, maxKeep = 90) {
  const { ctx, w, h } = setupCanvas(canvas, 70);
  ctx.clearRect(0, 0, w, h);
  const vals = values.slice(-maxKeep);
  if (vals.length < 2) return;
  const max = Math.max(...vals.map(kmh), 5) * 1.15;
  const X = (i) => (i / (vals.length - 1)) * w;
  const Y = (v) => h - 6 - (kmh(v) / max) * (h - 12);
  const s1 = css(canvas, '--accent');
  ctx.beginPath();
  ctx.moveTo(0, h);
  vals.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
  ctx.lineTo(w, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(25,192,127,.28)'); g.addColorStop(1, 'transparent');
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath();
  vals.forEach((v, i) => { const x = X(i), y = Y(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = s1; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  const lx = X(vals.length - 1), ly = Y(vals[vals.length - 1]);
  ctx.beginPath(); ctx.arc(lx, ly, 4, 0, 7); ctx.fillStyle = s1; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = css(canvas, '--surface-0'); ctx.stroke();
}
