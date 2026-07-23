// floatTRACK – UI, Karten, Trails, Spots, Auswertung
import { db, uid, settings, saveSettings, savePhoto, photoUrl, processImage } from './store.js';
import { distM, distToTrack, bounds, analyze, kmh, nf, fmtDist, fmtTime, fmtLap, fmtDate, toGPX, download } from './geo.js';
import { speedChart, elevChart, sparkline } from './chart.js';
import { tracker } from './tracker.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Farben in geprüfter Slot-Reihenfolge (auch bei Rot-Grün-Schwäche unterscheidbar);
// das Symbol im Pin trägt die Identität, die Farbe unterstützt sie nur.
const CATS = {
  berm:  { icon: '🌀', label: 'Anlieger',  color: '#3987e5' },
  jump:  { icon: '🛫', label: 'Sprung',    color: '#d95926' },
  view:  { icon: '🌄', label: 'Aussicht',  color: '#199e70' },
  warn:  { icon: '⚠️', label: 'Gefahr',    color: '#c98500' },
  drop:  { icon: '🪨', label: 'Drop',      color: '#d55181' },
  other: { icon: '⭐', label: 'Sonstiges', color: '#008300' },
  start: { icon: '🅿️', label: 'Start',     color: '#9085e9' },
};

const state = {
  screen: 'ride',
  trails: [], rides: [], spots: [],
  maps: {}, layers: {},
  liveTrack: null, livePos: null,
  spark: [], detailChart: null,
  mapFilter: { trails: true, spots: true, rides: false },
  pendingLatLng: null,
};

/* ==================== Basis-Helfer ==================== */
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
function esc(s) { return String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

function openModal(html) {
  $('#modal-card').innerHTML = html;
  $('#modal').hidden = false;
  history.pushState({ modal: 1 }, '');
  return $('#modal-card');
}
function closeModal(pop = true) {
  $('#modal').hidden = true;
  $('#modal-card').innerHTML = '';
  if (pop && history.state?.modal) history.back();
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

function openDetail(title, render) {
  $('#detail-title').textContent = title;
  $('#detail-body').innerHTML = '';
  $('#detail').hidden = false;
  history.pushState({ detail: 1 }, '');
  render($('#detail-body'));
}
function closeDetail(pop = true) {
  state.detailChart?.destroy?.(); state.detailChart = null;
  state.maps.detail?.remove(); state.maps.detail = null;
  $('#detail').hidden = true;
  $('#detail-body').innerHTML = '';
  if (pop && history.state?.detail) history.back();
}
$('#detail-back').addEventListener('click', () => closeDetail());
window.addEventListener('popstate', () => {
  if (!$('#modal').hidden) closeModal(false);
  else if (!$('#detail').hidden) closeDetail(false);
});

async function confirmBox(text, okLabel = 'Löschen') {
  return new Promise((res) => {
    const c = openModal(`<h2>${esc(text)}</h2>
      <div class="row-btns">
        <button class="btn" id="c-no">Abbrechen</button>
        <button class="btn btn-danger" id="c-yes">${esc(okLabel)}</button>
      </div>`);
    $('#c-no', c).onclick = () => { closeModal(); res(false); };
    $('#c-yes', c).onclick = () => { closeModal(); res(true); };
  });
}

/* ==================== Theme ==================== */
function applyTheme() {
  const t = settings.theme === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : settings.theme;
  document.documentElement.dataset.theme = t;
  $('meta[name=theme-color]').content = t === 'light' ? '#f4f5f3' : '#0f1113';
  Object.values(state.maps).forEach((m) => m && setBase(m));
}

/* ==================== Karten ==================== */
const TILES = {
  dark: { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', attr: '© OpenStreetMap, © CARTO', max: 20, sub: 'abcd' },
  light: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '© OpenStreetMap', max: 19 },
  sat: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: '© Esri, Maxar, Earthstar Geographics', max: 19 },
};
function setBase(map, kind) {
  const want = kind || map._baseKind || (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const t = TILES[want];
  if (map._base) map.removeLayer(map._base);
  map._baseKind = want;
  map._base = L.tileLayer(t.url, { attribution: t.attr, maxZoom: t.max, subdomains: t.sub || 'abc', crossOrigin: true }).addTo(map);
  map._base.bringToBack?.();
}
function makeMap(elId, opts = {}) {
  const map = L.map(elId, { zoomControl: false, preferCanvas: true, ...opts });
  map.setView([47.8, 11.6], 12);
  setBase(map);
  if (opts.zoom !== false) L.control.zoom({ position: 'topright' }).addTo(map);
  return map;
}
function trackLayer(pts, color) {
  const latlngs = pts.map((p) => [p.lat, p.lon]);
  return L.layerGroup([
    L.polyline(latlngs, { color: '#ffffff', weight: 7, opacity: .55, lineCap: 'round', lineJoin: 'round' }),
    L.polyline(latlngs, { color: color || accent(), weight: 4, opacity: 1, lineCap: 'round', lineJoin: 'round' }),
  ]);
}
function accent() { return getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#19c07f'; }
function spotIcon(cat) {
  const c = CATS[cat] || CATS.other;
  return L.divIcon({
    className: '', iconSize: [26, 26], iconAnchor: [13, 26], popupAnchor: [0, -24],
    html: `<div class="spot-pin" style="background:${c.color}"><span>${c.icon}</span></div>`,
  });
}
function posIcon() { return L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8], html: '<div class="pos-dot"></div>' }); }

async function spotPopup(spot) {
  const c = CATS[spot.cat] || CATS.other;
  let img = '';
  if (spot.photoIds?.length) {
    const u = await photoUrl(spot.photoIds[0], true);
    if (u) img = `<img src="${u}" alt="">`;
  }
  return `<b>${c.icon} ${esc(spot.name)}</b>${spot.note ? esc(spot.note) : ''}${img}
    <div style="margin-top:6px"><a href="#" data-spot="${spot.id}">Details ›</a></div>`;
}

/* ==================== Daten laden ==================== */
async function loadAll() {
  [state.trails, state.rides, state.spots] = await Promise.all([db.all('trails'), db.all('rides'), db.all('spots')]);
  state.rides.sort((a, b) => b.startedAt - a.startedAt);
  state.trails.sort((a, b) => b.createdAt - a.createdAt);
}
const trailById = (id) => state.trails.find((t) => t.id === id);
function trailTimes(trailId) {
  const out = [];
  for (const r of state.rides.filter((r) => r.trailId === trailId)) {
    if (r.laps?.length) r.laps.forEach((l) => out.push({ time: l.time, ts: l.ts || r.startedAt, rideId: r.id, lap: l.n }));
    else if (r.stats?.dur > 5 && r.mode === 'lap') out.push({ time: r.stats.dur, ts: r.startedAt, rideId: r.id, lap: null, whole: true });
  }
  return out.sort((a, b) => a.time - b.time);
}

/* ==================== Navigation ==================== */
function showScreen(name) {
  state.screen = name;
  $$('.screen').forEach((s) => s.classList.toggle('is-active', s.dataset.screen === name));
  $$('.tab').forEach((t) => t.classList.toggle('is-on', t.dataset.goto === name));
  if (name === 'map') { ensureBigMap(); setTimeout(() => state.maps.big?.invalidateSize(), 60); }
  if (name === 'ride') setTimeout(() => state.maps.mini?.invalidateSize(), 60);
  if (name === 'trails') renderTrails();
  if (name === 'rides') renderRides();
  if (name === 'stats') renderStats();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showScreen(t.dataset.goto)));
$('#btn-map-expand').addEventListener('click', () => showScreen('map'));

/* ==================== Fahren-Screen ==================== */
let rideMode = 'free';
let selectedTrailId = null;

$$('#mode-row .chip').forEach((c) => c.addEventListener('click', () => {
  if (tracker.active) return toast('Erst die Fahrt beenden');
  rideMode = c.dataset.mode;
  $$('#mode-row .chip').forEach((x) => x.classList.toggle('is-on', x === c));
  renderModeExtra();
}));

function renderModeExtra() {
  const box = $('#mode-extra');
  if (rideMode === 'lap') {
    if (!state.trails.length) {
      box.className = 'mode-extra'; box.innerHTML = `<div class="muted" style="font-size:13px">Noch kein Trail gespeichert – erst „Trail scannen“ fahren.</div>`;
      return;
    }
    if (!selectedTrailId) selectedTrailId = state.trails[0].id;
    box.className = 'mode-extra';
    box.innerHTML = `<div class="field" style="margin:0"><label>Welcher Trail?</label>
      <select id="sel-trail">${state.trails.map((t) => `<option value="${t.id}" ${t.id === selectedTrailId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>`;
    $('#sel-trail').onchange = (e) => { selectedTrailId = e.target.value; drawTrailPreview(); };
    drawTrailPreview();
  } else {
    box.className = 'mode-extra hidden'; box.innerHTML = '';
    state.layers.preview?.remove(); state.layers.preview = null;
  }
  $('#live-mode-label').textContent = rideMode === 'free' ? 'Freie Fahrt' : rideMode === 'scan' ? 'Trail wird gescannt' : 'Trail fahren';
}
function drawTrailPreview() {
  ensureMiniMap();
  state.layers.preview?.remove();
  const t = trailById(selectedTrailId);
  if (!t) return;
  state.layers.preview = trackLayer(t.pts, '#9085e9').addTo(state.maps.mini);
  state.maps.mini.fitBounds(bounds(t.pts), { padding: [20, 20] });
}

function ensureMiniMap() {
  if (state.maps.mini) return state.maps.mini;
  state.maps.mini = makeMap('minimap', { zoom: false, attributionControl: false });
  state.maps.mini.on('dragstart', () => { state.maps.mini._userMoved = true; });
  return state.maps.mini;
}

$('#btn-start').addEventListener('click', async () => {
  if (rideMode === 'lap' && !selectedTrailId) return toast('Kein Trail ausgewählt');
  const trail = rideMode === 'lap' ? trailById(selectedTrailId) : null;
  await tracker.start({ mode: rideMode, trail });
  state.spark = [];
  ensureMiniMap();
  state.layers.live?.remove();
  state.layers.live = L.polyline([], { color: accent(), weight: 4 }).addTo(state.maps.mini);
  $('#btn-start').classList.add('hidden');
  $('#btn-pause').classList.remove('hidden');
  $('#btn-stop').classList.remove('hidden');
  $('#lapbox').classList.toggle('hidden', rideMode !== 'lap');
  $('#lap-list').innerHTML = '';
  $('#mode-row').style.opacity = '.45';
  toast(rideMode === 'scan' ? 'Trail wird aufgezeichnet – fahr ihn einmal ab' : 'Aufzeichnung läuft');
});

$('#btn-pause').addEventListener('click', () => {
  if (tracker.paused) { tracker.resume(); $('#btn-pause').textContent = 'Pause'; }
  else { tracker.pause(); $('#btn-pause').textContent = 'Weiter'; }
});

$('#btn-stop').addEventListener('click', async () => {
  const res = await tracker.stop();
  $('#btn-start').classList.remove('hidden');
  $('#btn-pause').classList.add('hidden'); $('#btn-pause').textContent = 'Pause';
  $('#btn-stop').classList.add('hidden');
  $('#mode-row').style.opacity = '1';
  $('#lapbox').classList.add('hidden');
  if (res.points.length < 5) return toast('Zu kurz – nichts gespeichert');
  saveRideDialog(res);
});

function saveRideDialog(res) {
  const st = analyze(res.points);
  const d = fmtDist(st.dist);
  const nameSuggest = res.mode === 'scan'
    ? 'Neuer Trail'
    : (res.trailId ? trailById(res.trailId)?.name + ' – Runde' : new Date(res.startedAt).toLocaleDateString('de-DE', { weekday: 'short' }) + '-Fahrt');
  const c = openModal(`<h2>Fahrt speichern</h2>
    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat"><span class="stat-label">Strecke</span><span class="stat-num">${d.v}<i>${d.u}</i></span></div>
      <div class="stat"><span class="stat-label">Zeit</span><span class="stat-num">${fmtTime(st.dur)}</span></div>
      <div class="stat"><span class="stat-label">Top</span><span class="stat-num">${nf(kmh(st.max), 1)}<i>km/h</i></span></div>
    </div>
    <div class="field"><label>${res.mode === 'scan' ? 'Trail-Name' : 'Name der Fahrt'}</label>
      <input id="ride-name" value="${esc(nameSuggest)}" autocomplete="off"></div>
    ${res.laps.length ? `<div class="muted" style="font-size:13px;margin-bottom:10px">${res.laps.length} Runde(n) erkannt – schnellste ${fmtLap(Math.min(...res.laps.map((l) => l.time)))}</div>` : ''}
    <div class="row-btns">
      <button class="btn" id="ride-discard">Verwerfen</button>
      <button class="btn btn-primary" id="ride-save">Speichern</button>
    </div>`);
  $('#ride-discard', c).onclick = async () => { closeModal(); toast('Verworfen'); };
  $('#ride-save', c).onclick = async () => {
    const name = $('#ride-name', c).value.trim() || 'Fahrt';
    await persistRide(res, st, name);
    closeModal();
  };
}

function simplify(pts, minDist = 4) {
  const out = [];
  for (const p of pts) {
    if (!out.length || distM(out[out.length - 1], p) >= minDist) out.push(p);
  }
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

async function persistRide(res, st, name) {
  let trailId = res.trailId;
  if (res.mode === 'scan') {
    const pts = simplify(res.points, 4).map((p) => ({ lat: p.lat, lon: p.lon, alt: p.alt }));
    const trail = {
      id: uid(), name, createdAt: Date.now(), pts,
      start: { lat: pts[0].lat, lon: pts[0].lon },
      finish: { lat: pts[pts.length - 1].lat, lon: pts[pts.length - 1].lon },
      dist: st.dist, up: st.up, down: st.down,
    };
    await db.put('trails', trail);
    trailId = trail.id;
  }
  const ride = {
    id: uid(), name, trailId: trailId || null, mode: res.mode,
    startedAt: res.startedAt, endedAt: res.endedAt,
    points: res.points, laps: res.laps,
    stats: { dist: st.dist, dur: st.dur, moving: st.moving, avg: st.avg, avgMoving: st.avgMoving, max: st.max, up: st.up, down: st.down },
  };
  await db.put('rides', ride);
  await loadAll();
  renderModeExtra();
  refreshBigMap();
  toast(res.mode === 'scan' ? `Trail „${name}“ gespeichert` : 'Fahrt gespeichert');
  showScreen('rides');
  openRide(ride.id);
}

/* ---- Live-Anzeige ---- */
tracker.on.quality = (msg) => {
  const q = tracker.quality;
  $('#gps-dot').className = 'gps-dot ' + (q === 'ok' ? 'ok' : q === 'weak' ? 'weak' : q === 'err' ? 'err' : '');
  $('#gps-text').textContent = q === 'off' ? 'GPS aus' : msg;
};
tracker.on.pos = (p) => {
  state.livePos = p;
  ensureMiniMap();
  if (!state.layers.posMarker) state.layers.posMarker = L.marker([p.lat, p.lon], { icon: posIcon(), interactive: false }).addTo(state.maps.mini);
  else state.layers.posMarker.setLatLng([p.lat, p.lon]);
  if (tracker.active && !tracker.paused) {
    state.layers.live?.addLatLng([p.lat, p.lon]);
    state.spark.push(tracker.v);
    if (state.maps.mini) state.maps.mini.setView([p.lat, p.lon], Math.max(state.maps.mini.getZoom(), 16), { animate: false });
  } else if (state.maps.mini && !state.maps.mini._userMoved) {
    state.maps.mini.setView([p.lat, p.lon], 16, { animate: false });
  }
  updateLive();
};
tracker.on.lap = (ev) => {
  if (ev.type === 'start') { $('#lap-state').textContent = 'Runde läuft'; navigator.vibrate?.(60); toast('Los!'); return; }
  const lap = ev.lap;
  const best = trailTimes(tracker.trail?.id)[0];
  const delta = best ? lap.time - best.time : null;
  navigator.vibrate?.([80, 60, 80]);
  toast(`Runde ${lap.n}: ${fmtLap(lap.time)}${delta !== null ? (delta < 0 ? ` (${fmtLap(Math.abs(delta))} schneller!)` : ` (+${fmtLap(delta)})`) : ''}`, 3600);
  renderLiveLaps();
};
function renderLiveLaps() {
  const best = trailTimes(tracker.trail?.id)[0];
  $('#lap-list').innerHTML = tracker.laps.slice().reverse().map((l) => {
    const d = best ? l.time - best.time : null;
    return `<div class="lap-row"><span>Runde ${l.n}</span><span><b>${fmtLap(l.time)}</b>${d !== null ? ` <span class="${d < 0 ? 'delta-good' : 'delta-bad'}">${d < 0 ? '−' : '+'}${fmtLap(Math.abs(d))}</span>` : ''}</span></div>`;
  }).join('');
}

function updateLive() {
  const v = tracker.active && !tracker.paused ? tracker.v : (tracker.active ? 0 : tracker.v);
  $('#live-speed').innerHTML = `${nf(kmh(v), v * 3.6 >= 10 ? 0 : 1)}<span class="speed-unit">km/h</span>`;
  const d = fmtDist(tracker.dist);
  $('#live-dist').innerHTML = `${d.v}<i>${d.u}</i>`;
  $('#live-time').textContent = fmtTime(tracker.elapsed);
  const avg = tracker.movingMs > 1000 ? tracker.dist / (tracker.movingMs / 1000) : 0;
  $('#live-avg').innerHTML = `${nf(kmh(avg), 1)}<i>km/h</i>`;
  $('#live-max').innerHTML = `${nf(kmh(tracker.maxV), 1)}<i>km/h</i>`;
  $('#live-moving').textContent = fmtTime(tracker.movingMs / 1000);
  $('#live-elev').innerHTML = `${Math.round(tracker.up)}<i>hm</i>`;
  const clock = tracker.lapClock;
  $('#lap-clock').textContent = clock !== null ? fmtLap(clock) : '–';
  if (tracker.mode === 'lap' && tracker.lapState === 'armed') $('#lap-state').textContent = 'Fahr zum Trail-Start …';
  sparkline($('#spark'), state.spark);
}
setInterval(() => { if (tracker.active) updateLive(); }, 300);

/* ==================== Spots ==================== */
$('#btn-spot-now').addEventListener('click', () => {
  const p = state.livePos;
  if (!p) { tracker.startGPS(); return toast('Warte auf GPS-Position …'); }
  spotDialog({ lat: p.lat, lon: p.lon });
});
$('#btn-add-spot').addEventListener('click', () => {
  const p = state.livePos || (state.maps.big && { lat: state.maps.big.getCenter().lat, lon: state.maps.big.getCenter().lng });
  if (!p) return toast('Keine Position');
  spotDialog({ lat: p.lat, lon: p.lon });
});

function nearestTrail(latlng) {
  let best = null, bd = Infinity;
  for (const t of state.trails) {
    const d = distToTrack(latlng, t.pts, Math.max(1, Math.floor(t.pts.length / 200)));
    if (d < bd) { bd = d; best = t; }
  }
  return bd < 60 ? best : null;
}

function spotDialog(pos, existing = null) {
  const sp = existing || { id: uid(), lat: pos.lat, lon: pos.lon, cat: 'jump', name: '', note: '', photoIds: [], createdAt: Date.now(), trailId: nearestTrail(pos)?.id || null };
  const photos = [...(sp.photoIds || [])];
  const near = sp.trailId ? trailById(sp.trailId) : null;
  const c = openModal(`<h2>${existing ? 'Spot bearbeiten' : 'Neuer Spot'}</h2>
    <div class="field"><label>Name</label><input id="sp-name" placeholder="z.B. Doppelkicker im Wald" value="${esc(sp.name)}"></div>
    <div class="field"><label>Art</label><div class="cat-row" id="sp-cats">
      ${Object.entries(CATS).map(([k, v]) => `<button class="cat-btn ${k === sp.cat ? 'is-on' : ''}" data-cat="${k}">${v.icon} ${v.label}</button>`).join('')}
    </div></div>
    <div class="field"><label>Notiz</label><textarea id="sp-note" rows="2" placeholder="Anfahrt, Absprung, Gefahr …">${esc(sp.note)}</textarea></div>
    <div class="field"><label>Fotos</label><div class="photo-strip" id="sp-photos"><button class="photo-add" id="sp-addphoto">＋</button></div></div>
    <div class="muted" style="font-size:12px;margin-bottom:10px">${sp.lat.toFixed(5)}, ${sp.lon.toFixed(5)}${near ? ` · am Trail „${esc(near.name)}“` : ''}</div>
    <div class="row-btns">
      ${existing ? '<button class="btn btn-danger" id="sp-del">Löschen</button>' : '<button class="btn" id="sp-cancel">Abbrechen</button>'}
      <button class="btn btn-primary" id="sp-save">Speichern</button>
    </div>`);

  let cat = sp.cat;
  $$('#sp-cats .cat-btn', c).forEach((b) => b.onclick = () => {
    cat = b.dataset.cat;
    $$('#sp-cats .cat-btn', c).forEach((x) => x.classList.toggle('is-on', x === b));
  });

  async function paintPhotos() {
    const strip = $('#sp-photos', c);
    strip.querySelectorAll('img').forEach((i) => i.remove());
    for (const id of photos) {
      const u = await photoUrl(id, true);
      if (!u) continue;
      const img = document.createElement('img');
      img.src = u; img.alt = ''; img.title = 'Tippen zum Entfernen';
      img.onclick = () => { photos.splice(photos.indexOf(id), 1); paintPhotos(); };
      strip.insertBefore(img, $('#sp-addphoto', c));
    }
  }
  $('#sp-addphoto', c).onclick = () => pickPhoto(async (ids) => { photos.push(...ids); paintPhotos(); });
  paintPhotos();

  if (!existing) $('#sp-cancel', c).onclick = () => closeModal();
  else $('#sp-del', c).onclick = async () => {
    if (!await confirmBox('Spot wirklich löschen?')) return;
    await db.del('spots', sp.id); await loadAll(); refreshBigMap(); closeModal(); closeDetail(); toast('Spot gelöscht');
  };
  $('#sp-save', c).onclick = async () => {
    sp.name = $('#sp-name', c).value.trim() || CATS[cat].label;
    sp.note = $('#sp-note', c).value.trim();
    sp.cat = cat; sp.photoIds = photos;
    await db.put('spots', sp);
    await loadAll(); refreshBigMap(); closeModal();
    toast('Spot gespeichert');
  };
}

function pickPhoto(cb) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
  inp.capture = 'environment';
  inp.onchange = async () => {
    const ids = [];
    for (const f of inp.files) {
      const { blob, thumb } = await processImage(f);
      ids.push(await savePhoto(blob, thumb));
    }
    cb(ids);
  };
  inp.click();
}

/* ==================== Große Karte ==================== */
function ensureBigMap() {
  if (state.maps.big) return state.maps.big;
  const map = makeMap('bigmap');
  state.maps.big = map;
  const satBtn = L.control({ position: 'topright' });
  satBtn.onAdd = () => {
    const d = L.DomUtil.create('button', 'fab');
    d.style.cssText = 'width:40px;height:40px;font-size:16px;margin-top:6px';
    d.textContent = '🛰';
    d.title = 'Satellit / Karte';
    L.DomEvent.on(d, 'click', (e) => {
      L.DomEvent.stop(e);
      const next = map._baseKind === 'sat' ? (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark') : 'sat';
      setBase(map, next);
    });
    return d;
  };
  satBtn.addTo(map);

  // Leaflet feuert 'contextmenu' auch beim langen Drücken auf dem Handy
  map.on('contextmenu', (e) => spotDialog({ lat: e.latlng.lat, lon: e.latlng.lng }));
  map.on('popupopen', (e) => {
    const link = e.popup.getElement()?.querySelector('[data-spot]');
    if (link) link.onclick = (ev) => { ev.preventDefault(); openSpot(link.dataset.spot); };
  });
  setTimeout(() => { $('#map-hint').style.opacity = '0'; }, 5000);
  refreshBigMap();
  return map;
}
$$('.filters .chip').forEach((c) => c.addEventListener('click', () => {
  const k = c.dataset.layer;
  state.mapFilter[k] = !state.mapFilter[k];
  c.classList.toggle('is-on', state.mapFilter[k]);
  refreshBigMap();
}));
$('#btn-locate').addEventListener('click', () => {
  tracker.startGPS();
  if (state.livePos) state.maps.big?.setView([state.livePos.lat, state.livePos.lon], 17);
  else toast('Suche Position …');
});

async function refreshBigMap() {
  const map = state.maps.big; if (!map) return;
  state.layers.big?.remove();
  const g = L.layerGroup().addTo(map);
  state.layers.big = g;
  const all = [];

  if (state.mapFilter.trails) {
    for (const t of state.trails) {
      const l = trackLayer(t.pts, accent()).addTo(g);
      l.eachLayer((x) => x.on('click', () => openTrail(t.id)));
      all.push(...t.pts);
      L.marker([t.pts[0].lat, t.pts[0].lon], { icon: spotIcon('start') })
        .bindPopup(`<b>${esc(t.name)}</b>${fmtDist(t.dist).v} ${fmtDist(t.dist).u} · <a href="#" data-trail="${t.id}">öffnen ›</a>`)
        .on('popupopen', (e) => {
          const a = e.popup.getElement()?.querySelector('[data-trail]');
          if (a) a.onclick = (ev) => { ev.preventDefault(); openTrail(t.id); };
        }).addTo(g);
    }
  }
  if (state.mapFilter.rides) {
    for (const r of state.rides.slice(0, 40)) {
      if (r.trailId && state.mapFilter.trails) continue;
      L.polyline(r.points.map((p) => [p.lat, p.lon]), { color: '#3987e5', weight: 2.5, opacity: .7 }).addTo(g);
      all.push(...r.points);
    }
  }
  if (state.mapFilter.spots) {
    for (const s of state.spots) {
      const m = L.marker([s.lat, s.lon], { icon: spotIcon(s.cat) }).addTo(g);
      m.bindPopup('…');
      m.on('click', async () => m.setPopupContent(await spotPopup(s)));
      all.push(s);
    }
  }
  if (all.length && !map._fitted) { map.fitBounds(bounds(all), { padding: [40, 40], maxZoom: 16 }); map._fitted = true; }
}

/* ==================== Trails ==================== */
function renderTrails() {
  const box = $('#trail-list');
  if (!state.trails.length) {
    box.innerHTML = `<div class="empty"><b>Noch keine Trails</b>Wähle unten „Trail scannen“, fahr deinen Singletrail einmal ab – danach kannst du ihn immer wieder auf Zeit fahren.</div>`;
    return;
  }
  box.innerHTML = state.trails.map((t) => {
    const times = trailTimes(t.id);
    const rides = state.rides.filter((r) => r.trailId === t.id).length;
    const spots = state.spots.filter((s) => s.trailId === t.id).length;
    const d = fmtDist(t.dist);
    return `<div class="card" data-trail="${t.id}">
      <h3>${esc(t.name)}</h3>
      <div class="meta"><b>${d.v} ${d.u}</b> · ${Math.round(t.down || 0)} hm bergab · ${rides} Fahrt${rides === 1 ? '' : 'en'} · ${spots} Spot${spots === 1 ? '' : 's'}</div>
      ${times.length ? `<div class="meta" style="margin-top:6px">Bestzeit <b style="font-size:15px;color:var(--accent)">${fmtLap(times[0].time)}</b>${times.length > 1 ? ` · Ø ${fmtLap(times.reduce((a, b) => a + b.time, 0) / times.length)}` : ''}</div>` : `<div class="meta" style="margin-top:6px">Noch keine Zeit gefahren</div>`}
    </div>`;
  }).join('');
  $$('[data-trail]', box).forEach((c) => c.onclick = () => openTrail(c.dataset.trail));
}

function openTrail(id) {
  const t = trailById(id); if (!t) return;
  openDetail(t.name, async (body) => {
    const times = trailTimes(id);
    const rides = state.rides.filter((r) => r.trailId === id);
    const spots = state.spots.filter((s) => s.trailId === id);
    const d = fmtDist(t.dist);
    body.innerHTML = `
      <div class="detail-map" id="dmap"></div>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Länge</span><span class="stat-num">${d.v}<i>${d.u}</i></span></div>
        <div class="stat"><span class="stat-label">Bergab</span><span class="stat-num">${Math.round(t.down || 0)}<i>hm</i></span></div>
        <div class="stat"><span class="stat-label">Fahrten</span><span class="stat-num">${rides.length}</span></div>
      </div>
      ${times.length ? `<div class="card" style="text-align:center">
        <div class="stat-label">Bestzeit</div>
        <div style="font-size:38px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">${fmtLap(times[0].time)}</div>
        <div class="meta">${fmtDate(times[0].ts)}</div></div>` : ''}
      <div class="row-btns">
        <button class="btn btn-primary" id="t-ride">Trail fahren</button>
        <button class="btn" id="t-gpx">GPX</button>
        <button class="btn" id="t-ren">Umbenennen</button>
      </div>
      <div class="section-title">Zeiten</div>
      <div class="card" id="t-times">${times.length ? times.map((x, i) => `
        <div class="list-line"><span>${i === 0 ? '🏆 ' : ''}${fmtDate(x.ts)}${x.lap ? ` · Runde ${x.lap}` : ''}</span>
        <span><b>${fmtLap(x.time)}</b>${i > 0 ? ` <span class="muted">+${fmtLap(x.time - times[0].time)}</span>` : '<span class="badge best">Best</span>'}</span></div>`).join('')
      : '<div class="muted">Noch keine Zeit. Modus „Trail fahren“ wählen – die Uhr startet automatisch am Trail-Anfang.</div>'}</div>
      <div class="section-title">Spots am Trail (${spots.length})</div>
      <div class="gallery" id="t-spots"></div>
      <div class="row-btns" style="margin-top:20px">
        <button class="btn btn-danger" id="t-del">Trail löschen</button>
      </div>
      <div style="height:30px"></div>`;

    const map = makeMap('dmap', { zoom: false });
    state.maps.detail = map;
    trackLayer(t.pts).addTo(map);
    spots.forEach((s) => L.marker([s.lat, s.lon], { icon: spotIcon(s.cat) }).addTo(map).on('click', () => openSpot(s.id)));
    map.fitBounds(bounds(t.pts), { padding: [24, 24] });
    setTimeout(() => map.invalidateSize(), 80);

    const gal = $('#t-spots', body);
    if (!spots.length) gal.innerHTML = '<div class="muted" style="font-size:13px">Noch keine Spots – auf der Karte lange drücken oder während der Fahrt „Spot hier“.</div>';
    for (const s of spots) {
      const u = s.photoIds?.[0] ? await photoUrl(s.photoIds[0], true) : null;
      const wrap = document.createElement('div');
      wrap.innerHTML = u ? `<img src="${u}" alt="${esc(s.name)}">` : `<div style="aspect-ratio:1;display:grid;place-items:center;background:var(--surface-2);border-radius:12px;font-size:26px">${(CATS[s.cat] || CATS.other).icon}</div>`;
      wrap.innerHTML += `<div class="meta" style="margin-top:4px;font-size:11.5px">${esc(s.name)}</div>`;
      wrap.onclick = () => openSpot(s.id);
      gal.appendChild(wrap);
    }

    $('#t-ride', body).onclick = () => {
      closeDetail(); rideMode = 'lap'; selectedTrailId = id;
      $$('#mode-row .chip').forEach((x) => x.classList.toggle('is-on', x.dataset.mode === 'lap'));
      renderModeExtra(); showScreen('ride'); toast('Fahr zum Trail-Start – die Uhr startet automatisch');
    };
    $('#t-gpx', body).onclick = () => download(t.name.replace(/\W+/g, '_') + '.gpx', toGPX(t.name, t.pts.map((p) => ({ ...p, t: t.createdAt })), spots));
    $('#t-ren', body).onclick = () => {
      const c = openModal(`<h2>Trail umbenennen</h2><div class="field"><input id="rn" value="${esc(t.name)}"></div>
        <div class="row-btns"><button class="btn" id="rn-c">Abbrechen</button><button class="btn btn-primary" id="rn-ok">OK</button></div>`);
      $('#rn-c', c).onclick = () => closeModal();
      $('#rn-ok', c).onclick = async () => {
        t.name = $('#rn', c).value.trim() || t.name;
        await db.put('trails', t); await loadAll(); closeModal(); closeDetail(); renderTrails(); openTrail(id);
      };
    };
    $('#t-del', body).onclick = async () => {
      if (!await confirmBox(`„${t.name}“ mit allen Zeiten löschen?`)) return;
      await db.del('trails', id);
      for (const r of rides) await db.put('rides', { ...r, trailId: null });
      await loadAll(); closeDetail(); renderTrails(); refreshBigMap(); toast('Trail gelöscht');
    };
  });
}

/* ==================== Fahrten ==================== */
function renderRides() {
  const box = $('#ride-list');
  if (!state.rides.length) {
    box.innerHTML = `<div class="empty"><b>Noch keine Fahrten</b>Drück auf „Fahren“ und starte – Strecke, Tempo und Speed-Diagramm laufen automatisch mit.</div>`;
    return;
  }
  box.innerHTML = state.rides.map((r) => {
    const d = fmtDist(r.stats.dist);
    const t = r.trailId ? trailById(r.trailId) : null;
    return `<div class="card" data-ride="${r.id}">
      <h3>${esc(r.name)}${t ? `<span class="badge">${esc(t.name)}</span>` : ''}</h3>
      <div class="meta">${fmtDate(r.startedAt)}</div>
      <div class="meta" style="margin-top:6px"><b>${d.v} ${d.u}</b> · ${fmtTime(r.stats.dur)} · Ø ${nf(kmh(r.stats.avgMoving), 1)} km/h · Top <b>${nf(kmh(r.stats.max), 1)} km/h</b>${r.laps?.length ? ` · ${r.laps.length} Runden` : ''}</div>
    </div>`;
  }).join('');
  $$('[data-ride]', box).forEach((c) => c.onclick = () => openRide(c.dataset.ride));
}

function openRide(id) {
  const r = state.rides.find((x) => x.id === id); if (!r) return;
  openDetail(r.name, (body) => {
    const st = analyze(r.points);
    const d = fmtDist(st.dist);
    const trail = r.trailId ? trailById(r.trailId) : null;
    const nearSpots = state.spots.filter((s) => distToTrack(s, r.points, 3) < 40);
    body.innerHTML = `
      <div class="detail-map" id="dmap"></div>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Strecke</span><span class="stat-num">${d.v}<i>${d.u}</i></span></div>
        <div class="stat"><span class="stat-label">Dauer</span><span class="stat-num">${fmtTime(st.dur)}</span></div>
        <div class="stat"><span class="stat-label">In Fahrt</span><span class="stat-num">${fmtTime(st.moving)}</span></div>
        <div class="stat"><span class="stat-label">Ø Tempo</span><span class="stat-num">${nf(kmh(st.avgMoving), 1)}<i>km/h</i></span></div>
        <div class="stat"><span class="stat-label">Top-Speed</span><span class="stat-num" style="color:var(--accent)">${nf(kmh(st.max), 1)}<i>km/h</i></span></div>
        <div class="stat"><span class="stat-label">Bergauf/ab</span><span class="stat-num">${Math.round(st.up)}<i>/${Math.round(st.down)} hm</i></span></div>
      </div>

      <div class="chart-card">
        <div class="chart-head">
          <div><div class="chart-title">Geschwindigkeit</div>
            <div class="chart-sub">km/h · Höchst- und Tiefpunkt markiert</div></div>
          <div class="chart-x-toggle">
            <button data-x="t" class="is-on">Zeit</button><button data-x="d">Strecke</button>
          </div>
        </div>
        <canvas class="chart-canvas" id="chart-speed"></canvas>
      </div>

      <div class="chart-card" id="elev-card" hidden>
        <div class="chart-head"><div><div class="chart-title">Höhenprofil</div><div class="chart-sub">Meter über NN</div></div></div>
        <canvas class="chart-canvas" id="chart-elev"></canvas>
      </div>

      ${r.laps?.length ? `<div class="section-title">Runden</div><div class="card">${r.laps.map((l) => {
        const best = Math.min(...r.laps.map((x) => x.time));
        return `<div class="list-line"><span>Runde ${l.n}</span><span><b>${fmtLap(l.time)}</b>${l.time === best ? '<span class="badge best">schnellste</span>' : ` <span class="muted">+${fmtLap(l.time - best)}</span>`}</span></div>`;
      }).join('')}</div>` : ''}

      <details class="tbl-wrap card"><summary>Kilometer-Splits als Tabelle</summary>
        <table class="tbl"><thead><tr><th>km</th><th>Zeit</th><th>Ø km/h</th><th>Top</th></tr></thead>
        <tbody>${splitRows(st)}</tbody></table>
      </details>

      <div class="row-btns">
        <button class="btn" id="r-gpx">GPX exportieren</button>
        ${!trail ? '<button class="btn" id="r-trail">Als Trail sichern</button>' : ''}
        <button class="btn btn-danger" id="r-del">Löschen</button>
      </div>
      <div style="height:30px"></div>`;

    const map = makeMap('dmap', { zoom: false });
    state.maps.detail = map;
    trackLayer(r.points).addTo(map);
    L.marker([r.points[0].lat, r.points[0].lon], { icon: spotIcon('start') }).addTo(map).bindPopup('Start');
    nearSpots.forEach((s) => L.marker([s.lat, s.lon], { icon: spotIcon(s.cat) }).addTo(map).on('click', () => openSpot(s.id)));
    // Höchst-/Tiefpunkt auch auf der Karte
    const hi = r.points[st.maxIdx];
    if (hi) L.circleMarker([hi.lat, hi.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#3987e5', fillOpacity: 1 })
      .addTo(map).bindTooltip(`MAX ${nf(kmh(st.max), 1)} km/h`, { permanent: false });
    map.fitBounds(bounds(r.points), { padding: [24, 24] });
    setTimeout(() => map.invalidateSize(), 80);

    const hover = L.circleMarker([r.points[0].lat, r.points[0].lon], { radius: 6, color: '#fff', weight: 2, fillColor: accent(), fillOpacity: 1 });
    let xMode = 't';
    const build = () => {
      state.detailChart?.destroy();
      state.detailChart = speedChart($('#chart-speed', body), {
        series: st.series, xMode, stats: st,
        onHover: (p) => {
          if (!p) { map.removeLayer(hover); return; }
          hover.setLatLng([p.lat, p.lon]).addTo(map);
        },
      });
      if (elevChart($('#chart-elev', body), st.series, xMode)) $('#elev-card', body).hidden = false;
    };
    build();
    $$('.chart-x-toggle button', body).forEach((b) => b.onclick = () => {
      xMode = b.dataset.x;
      $$('.chart-x-toggle button', body).forEach((x) => x.classList.toggle('is-on', x === b));
      build();
    });

    $('#r-gpx', body).onclick = () => download(r.name.replace(/\W+/g, '_') + '.gpx', toGPX(r.name, r.points, nearSpots));
    $('#r-del', body).onclick = async () => {
      if (!await confirmBox('Fahrt löschen?')) return;
      await db.del('rides', r.id); await loadAll(); closeDetail(); renderRides(); refreshBigMap(); toast('Gelöscht');
    };
    const bt = $('#r-trail', body);
    if (bt) bt.onclick = async () => {
      const pts = simplify(r.points, 4).map((p) => ({ lat: p.lat, lon: p.lon, alt: p.alt }));
      const trailNew = {
        id: uid(), name: r.name, createdAt: Date.now(), pts,
        start: { lat: pts[0].lat, lon: pts[0].lon },
        finish: { lat: pts[pts.length - 1].lat, lon: pts[pts.length - 1].lon },
        dist: st.dist, up: st.up, down: st.down,
      };
      await db.put('trails', trailNew);
      await db.put('rides', { ...r, trailId: trailNew.id });
      await loadAll(); closeDetail(); renderTrails(); refreshBigMap(); toast('Als Trail gesichert');
    };
  });
}

function splitRows(st) {
  const rows = [];
  let kmMark = 1000, last = { t: 0, d: 0 }, maxV = 0;
  for (const s of st.series) {
    maxV = Math.max(maxV, s.v);
    if (s.d >= kmMark) {
      const dt = s.t - last.t, dd = s.d - last.d;
      rows.push(`<tr><td>${kmMark / 1000}</td><td>${fmtTime(dt)}</td><td>${nf(kmh(dd / (dt || 1)), 1)}</td><td>${nf(kmh(maxV), 1)}</td></tr>`);
      last = { t: s.t, d: s.d }; kmMark += 1000; maxV = 0;
    }
  }
  const rest = st.series[st.series.length - 1];
  if (rest && rest.d - last.d > 50) {
    const dt = rest.t - last.t, dd = rest.d - last.d;
    rows.push(`<tr><td>${nf(dd / 1000, 2)}</td><td>${fmtTime(dt)}</td><td>${nf(kmh(dd / (dt || 1)), 1)}</td><td>${nf(kmh(maxV), 1)}</td></tr>`);
  }
  return rows.join('') || '<tr><td colspan="4" class="muted">Zu kurz für Splits</td></tr>';
}

/* ==================== Spot-Detail ==================== */
function openSpot(id) {
  const s = state.spots.find((x) => x.id === id); if (!s) return;
  const c = CATS[s.cat] || CATS.other;
  openDetail(s.name, async (body) => {
    const trail = s.trailId ? trailById(s.trailId) : null;
    body.innerHTML = `
      <div class="card"><div class="meta">${c.icon} ${c.label}${trail ? ` · am Trail <b>${esc(trail.name)}</b>` : ''}</div>
        ${s.note ? `<p style="margin:8px 0 0">${esc(s.note)}</p>` : ''}</div>
      <div class="gallery" id="sp-gal"></div>
      <div class="detail-map" id="dmap" style="margin-top:12px"></div>
      <div class="row-btns">
        <button class="btn" id="sp-edit">Bearbeiten</button>
        <button class="btn" id="sp-nav">Navigation</button>
      </div>
      <div style="height:30px"></div>`;
    const gal = $('#sp-gal', body);
    for (const pid of s.photoIds || []) {
      const u = await photoUrl(pid, false);
      if (!u) continue;
      const img = document.createElement('img'); img.src = u; img.alt = s.name;
      img.onclick = () => window.open(u, '_blank');
      gal.appendChild(img);
    }
    if (!s.photoIds?.length) gal.innerHTML = '<div class="muted" style="font-size:13px">Keine Fotos – über „Bearbeiten“ hinzufügen.</div>';
    const map = makeMap('dmap', { zoom: false });
    state.maps.detail = map;
    map.setView([s.lat, s.lon], 17);
    L.marker([s.lat, s.lon], { icon: spotIcon(s.cat) }).addTo(map);
    if (trail) trackLayer(trail.pts).addTo(map);
    setTimeout(() => map.invalidateSize(), 80);
    $('#sp-edit', body).onclick = () => spotDialog(s, s);
    $('#sp-nav', body).onclick = () => window.open(`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`, '_blank');
  });
}

/* ==================== Statistik ==================== */
function renderStats() {
  const box = $('#stats-body');
  const rides = state.rides;
  const total = rides.reduce((a, r) => a + r.stats.dist, 0);
  const time = rides.reduce((a, r) => a + r.stats.dur, 0);
  const top = rides.reduce((a, r) => Math.max(a, r.stats.max), 0);
  const up = rides.reduce((a, r) => a + (r.stats.up || 0), 0);
  const d = fmtDist(total);
  const weeks = [];
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  for (let i = 7; i >= 0; i--) {
    const from = new Date(monday); from.setDate(monday.getDate() - i * 7);
    const to = new Date(from); to.setDate(from.getDate() + 7);
    const km = rides.filter((r) => r.startedAt >= +from && r.startedAt < +to).reduce((a, r) => a + r.stats.dist, 0) / 1000;
    weeks.push({ label: from.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }), km });
  }
  const maxKm = Math.max(...weeks.map((w) => w.km), 1);
  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><span class="stat-label">Gesamt</span><span class="stat-num">${d.v}<i>${d.u}</i></span></div>
      <div class="stat"><span class="stat-label">Fahrten</span><span class="stat-num">${rides.length}</span></div>
      <div class="stat"><span class="stat-label">Zeit</span><span class="stat-num">${fmtTime(time)}</span></div>
      <div class="stat"><span class="stat-label">Top-Speed</span><span class="stat-num" style="color:var(--accent)">${nf(kmh(top), 1)}<i>km/h</i></span></div>
      <div class="stat"><span class="stat-label">Höhenmeter</span><span class="stat-num">${Math.round(up)}<i>hm</i></span></div>
      <div class="stat"><span class="stat-label">Trails/Spots</span><span class="stat-num">${state.trails.length}<i>/${state.spots.length}</i></span></div>
    </div>
    <div class="section-title">Letzte 8 Wochen (km)</div>
    <div class="card">${weeks.map((w) => `
      <div style="display:flex;align-items:center;gap:8px;margin:6px 0;font-size:12px">
        <span class="muted" style="width:44px">${w.label}</span>
        <span style="flex:1;height:10px;background:var(--surface-3);border-radius:5px;overflow:hidden">
          <span style="display:block;height:100%;width:${(w.km / maxKm) * 100}%;background:var(--accent);border-radius:5px"></span></span>
        <span style="width:48px;text-align:right;font-variant-numeric:tabular-nums">${nf(w.km, 1)}</span>
      </div>`).join('')}</div>
    <div class="section-title">Schnellste Fahrten</div>
    <div class="card">${rides.slice().sort((a, b) => b.stats.max - a.stats.max).slice(0, 5).map((r) => `
      <div class="list-line" data-ride="${r.id}"><span>${esc(r.name)}<br><span class="muted" style="font-size:12px">${fmtDate(r.startedAt)}</span></span>
      <b>${nf(kmh(r.stats.max), 1)} km/h</b></div>`).join('') || '<div class="muted">Noch nichts gefahren</div>'}</div>
    <div style="height:20px"></div>`;
  $$('[data-ride]', box).forEach((e) => e.onclick = () => openRide(e.dataset.ride));
}

/* ==================== Einstellungen ==================== */
$('#btn-settings').addEventListener('click', () => {
  const c = openModal(`<h2>Einstellungen</h2>
    <div class="field"><label>Erscheinungsbild</label>
      <select id="s-theme">
        <option value="dark">Dunkel</option><option value="light">Hell</option><option value="auto">Automatisch</option>
      </select></div>
    <div class="field"><label>Display während der Fahrt anlassen</label>
      <select id="s-wake"><option value="1">Ja</option><option value="0">Nein</option></select></div>
    <div class="field"><label>GPS-Genauigkeit mindestens (m)</label><input id="s-acc" type="number" min="5" max="100" value="${settings.minAccuracy}"></div>
    <div class="field"><label>Rundenzeit automatisch (Radius in m)</label><input id="s-lap" type="number" min="8" max="80" value="${settings.lapRadius}"></div>
    <div class="section-title">Daten</div>
    <div class="row-btns"><button class="btn" id="s-export">Backup laden</button><button class="btn" id="s-import">Backup einspielen</button></div>
    <div class="row-btns"><button class="btn" id="s-demo">Demo-Trail erzeugen</button><button class="btn btn-danger" id="s-wipe">Alles löschen</button></div>
    <div class="muted" style="font-size:11.5px;margin-top:14px">floatTRACK speichert alles nur auf diesem Gerät. Karten © OpenStreetMap-Mitwirkende.</div>
    <div class="row-btns"><button class="btn btn-primary" id="s-ok">Fertig</button></div>`);
  $('#s-theme', c).value = settings.theme;
  $('#s-wake', c).value = settings.keepAwake ? '1' : '0';
  $('#s-theme', c).onchange = (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(); };
  $('#s-wake', c).onchange = (e) => { settings.keepAwake = e.target.value === '1'; saveSettings(); };
  $('#s-acc', c).onchange = (e) => { settings.minAccuracy = Math.max(5, +e.target.value || 35); saveSettings(); };
  $('#s-lap', c).onchange = (e) => { settings.lapRadius = Math.max(8, +e.target.value || 25); saveSettings(); };
  $('#s-ok', c).onclick = () => closeModal();
  $('#s-export', c).onclick = exportBackup;
  $('#s-import', c).onclick = importBackup;
  $('#s-demo', c).onclick = async () => { closeModal(); await makeDemo(); };
  $('#s-wipe', c).onclick = async () => {
    if (!await confirmBox('Wirklich ALLE Fahrten, Trails und Spots löschen?')) return;
    await Promise.all(['rides', 'trails', 'spots', 'photos'].map((s) => db.clear(s)));
    await loadAll(); closeModal(); renderTrails(); renderRides(); refreshBigMap(); toast('Alles gelöscht');
  };
});

async function exportBackup() {
  const photos = await db.all('photos');
  const toB64 = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  const photoData = [];
  for (const p of photos) photoData.push({ id: p.id, data: await toB64(p.blob) });
  const dump = { v: 1, at: Date.now(), trails: state.trails, rides: state.rides, spots: state.spots, photos: photoData };
  download(`floattrack-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(dump), 'application/json');
  toast('Backup erstellt');
}
function importBackup() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json';
  inp.onchange = async () => {
    const txt = await inp.files[0].text();
    try {
      const dump = JSON.parse(txt);
      for (const t of dump.trails || []) await db.put('trails', t);
      for (const r of dump.rides || []) await db.put('rides', r);
      for (const s of dump.spots || []) await db.put('spots', s);
      for (const p of dump.photos || []) {
        const blob = await (await fetch(p.data)).blob();
        await db.put('photos', { id: p.id, blob, thumb: blob });
      }
      await loadAll(); closeModal(); renderTrails(); renderRides(); refreshBigMap();
      toast('Backup eingespielt');
    } catch { toast('Datei nicht lesbar'); }
  };
  inp.click();
}

/* ==================== Demo-Daten ==================== */
function demoPath(seed = 0) {
  // geschlossener Singletrail-artiger Kurs im Voralpenland
  const cx = 47.8021, cy = 11.6043;
  const pts = [];
  let t = Date.now() - (86400000 * (2 + seed));
  for (let i = 0; i <= 320; i++) {
    const a = (i / 320) * Math.PI * 2;
    const wob = Math.sin(a * 7) * 0.00035 + Math.cos(a * 3.3) * 0.0002;
    const r = 0.0042 + wob;
    const lat = cx + Math.cos(a) * r * 0.72;
    const lon = cy + Math.sin(a) * r;
    const alt = 640 + Math.sin(a * 2 + 1) * 28 + Math.cos(a * 5) * 6;
    const v = Math.max(1.4, 6.6 + Math.sin(a * 4.1 + seed) * 3.6 + Math.cos(a * 9) * 1.5 - (i > 150 && i < 175 ? 4.2 : 0));
    pts.push({ t, lat, lon, alt, acc: 5, v });
    t += Math.round(1000 * (1 + seed * 0.06));
  }
  return pts;
}
async function makeDemo() {
  const p1 = demoPath(0);
  const st1 = analyze(p1);
  const pts = simplify(p1, 4).map((p) => ({ lat: p.lat, lon: p.lon, alt: p.alt }));
  const trail = {
    id: uid(), name: 'Demo – Hausrunde', createdAt: Date.now(), pts,
    start: { lat: pts[0].lat, lon: pts[0].lon }, finish: { lat: pts.at(-1).lat, lon: pts.at(-1).lon },
    dist: st1.dist, up: st1.up, down: st1.down, demo: true,
  };
  await db.put('trails', trail);
  await db.put('rides', {
    id: uid(), name: 'Demo – Hausrunde', trailId: trail.id, mode: 'scan', demo: true,
    startedAt: p1[0].t, endedAt: p1.at(-1).t, points: p1, laps: [],
    stats: { dist: st1.dist, dur: st1.dur, moving: st1.moving, avg: st1.avg, avgMoving: st1.avgMoving, max: st1.max, up: st1.up, down: st1.down },
  });
  const p2 = demoPath(1);
  const st2 = analyze(p2);
  await db.put('rides', {
    id: uid(), name: 'Demo – Hausrunde auf Zeit', trailId: trail.id, mode: 'lap', demo: true,
    startedAt: p2[0].t, endedAt: p2.at(-1).t, points: p2,
    laps: [{ n: 1, time: st2.dur * 0.48, ts: p2[0].t + st2.dur * 480, from: 0, to: 160 },
           { n: 2, time: st2.dur * 0.52, ts: p2.at(-1).t, from: 160, to: p2.length - 1 }],
    stats: { dist: st2.dist, dur: st2.dur, moving: st2.moving, avg: st2.avg, avgMoving: st2.avgMoving, max: st2.max, up: st2.up, down: st2.down },
  });
  const demoSpots = [
    { i: 40, cat: 'jump', name: 'Demo – Kicker am Hang', note: 'Anlieger davor mitnehmen, dann sauber abziehen.' },
    { i: 160, cat: 'warn', name: 'Demo – Wurzelfeld nass', note: 'Bei Regen extrem rutschig.' },
    { i: 250, cat: 'view', name: 'Demo – Aussicht', note: 'Kurzer Stopp lohnt sich.' },
  ];
  for (const s of demoSpots) {
    const p = p1[s.i];
    await db.put('spots', { id: uid(), lat: p.lat, lon: p.lon, cat: s.cat, name: s.name, note: s.note, photoIds: [], createdAt: Date.now(), trailId: trail.id, demo: true });
  }
  await loadAll();
  renderModeExtra(); renderTrails(); renderRides(); refreshBigMap();
  toast('Demo-Trail mit 2 Fahrten erzeugt');
  showScreen('trails');
}

/* ==================== Wiederherstellung ==================== */
async function checkCrashed() {
  const rec = await db.get('meta', 'active').catch(() => null);
  if (!rec?.state?.points?.length) return;
  const st = analyze(rec.state.points);
  if (st.dist < 50) { await db.del('meta', 'active'); return; }
  const c = openModal(`<h2>Unterbrochene Fahrt</h2>
    <p class="muted">Vom ${fmtDate(rec.savedAt)} · ${fmtDist(st.dist).v} ${fmtDist(st.dist).u} · ${fmtTime(st.dur)}</p>
    <div class="row-btns"><button class="btn" id="rc-no">Verwerfen</button><button class="btn btn-primary" id="rc-yes">Speichern</button></div>`);
  $('#rc-no', c).onclick = async () => { await db.del('meta', 'active'); closeModal(); };
  $('#rc-yes', c).onclick = async () => {
    closeModal();
    saveRideDialog({ ...rec.state, endedAt: rec.savedAt, trailId: rec.state.trailId, laps: rec.state.laps || [] });
    await db.del('meta', 'active');
  };
}

/* ==================== Start ==================== */
document.addEventListener('visibilitychange', () => { if (!document.hidden) tracker.reacquireWake(); });
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (settings.theme === 'auto') applyTheme(); });
window.addEventListener('beforeunload', (e) => { if (tracker.active) { e.preventDefault(); e.returnValue = ''; } });

(async function init() {
  applyTheme();
  await loadAll();
  ensureMiniMap();
  renderModeExtra();
  updateLive();
  tracker.startGPS();
  await checkCrashed();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (new URLSearchParams(location.search).has('demo') && !state.trails.length) await makeDemo();
  window.ft = { state, tracker, db, makeDemo, showScreen, openRide, openTrail };
})();
