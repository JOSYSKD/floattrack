// GPS-Aufzeichnung: Filterung, Live-Werte, automatische Rundenzeiten, Absturz-Sicherung
import { distM } from './geo.js';
import { db, settings } from './store.js';

const MIN_LAP_S = 8;

export const tracker = {
  active: false,
  paused: false,
  mode: 'free',           // free | scan | lap
  trail: null,            // Trail-Objekt im lap-Modus
  name: '',
  points: [],
  laps: [],
  startedAt: 0,
  pausedMs: 0,
  _pauseStart: 0,
  dist: 0,
  movingMs: 0,
  maxV: 0,
  up: 0, down: 0,
  _altRef: null, _altBuf: [],
  v: 0,                   // geglättete aktuelle Geschwindigkeit (m/s)
  acc: null,
  quality: 'off',         // off | wait | weak | ok | err
  lapState: 'idle',       // idle | armed | running
  lapStartT: 0,
  _visit: null,
  _watchId: null,
  _wakeLock: null,
  _saveTimer: null,
  _simTimer: null,
  on: {},                 // {pos, lap, quality, error}

  emit(ev, arg) { this.on[ev]?.(arg); },

  // ---------- GPS an/aus ----------
  async startGPS() {
    if (this._watchId != null || this._simTimer) return;
    if (!navigator.geolocation) { this.quality = 'err'; this.emit('quality', 'Kein GPS im Browser'); return; }
    this.quality = 'wait'; this.emit('quality', 'Suche Satelliten …');
    this._watchId = navigator.geolocation.watchPosition(
      (p) => this.onPosition(p),
      (err) => {
        this.quality = 'err';
        const msg = err.code === 1 ? 'Standort nicht erlaubt' : err.code === 2 ? 'Kein Signal' : 'GPS-Timeout';
        this.emit('quality', msg);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  },
  stopGPS() {
    if (this._watchId != null) { navigator.geolocation.clearWatch(this._watchId); this._watchId = null; }
    if (this._simTimer) { clearInterval(this._simTimer); this._simTimer = null; }
    if (!this.active) { this.quality = 'off'; this.emit('quality', 'GPS aus'); }
  },

  // ---------- Aufzeichnung ----------
  async start({ mode = 'free', trail = null, name = '' } = {}) {
    this.active = true; this.paused = false;
    this.mode = mode; this.trail = trail; this.name = name;
    this.points = []; this.laps = [];
    this.dist = 0; this.movingMs = 0; this.maxV = 0; this.v = 0;
    this.up = 0; this.down = 0; this._altRef = null; this._altBuf = [];
    this.pausedMs = 0; this._pauseStart = 0;
    this.startedAt = Date.now();
    this.lapState = mode === 'lap' && trail ? 'armed' : 'idle';
    this.lapStartT = 0; this._visit = null;
    await this.startGPS();
    await this.keepAwake(true);
    this._saveTimer = setInterval(() => this.autosave(), 8000);
  },
  pause() {
    if (!this.active || this.paused) return;
    this.paused = true; this._pauseStart = Date.now(); this.v = 0;
  },
  resume() {
    if (!this.active || !this.paused) return;
    this.pausedMs += Date.now() - this._pauseStart;
    this.paused = false; this._pauseStart = 0;
  },
  async stop() {
    this.active = false; this.paused = false;
    clearInterval(this._saveTimer); this._saveTimer = null;
    await this.keepAwake(false);
    await db.del('meta', 'active').catch(() => {});
    const res = {
      points: this.points, laps: this.laps, startedAt: this.startedAt,
      endedAt: Date.now(), mode: this.mode, trailId: this.trail?.id || null, name: this.name,
    };
    this.points = []; this.laps = []; this.v = 0; this.dist = 0;
    this.lapState = 'idle';
    return res;
  },

  get elapsed() {
    if (!this.startedAt) return 0;
    const end = this.paused ? this._pauseStart : Date.now();
    return (end - this.startedAt - this.pausedMs) / 1000;
  },

  // ---------- Positions-Verarbeitung ----------
  onPosition(pos) {
    const c = pos.coords;
    const t = Date.now();
    this.acc = c.accuracy;
    const limit = settings.minAccuracy;

    if (!isFinite(c.latitude) || !isFinite(c.longitude)) return;
    if (c.accuracy > limit * 3) {
      this.quality = 'err'; this.emit('quality', `Signal zu schwach (±${Math.round(c.accuracy)} m)`);
      return;
    }
    this.quality = c.accuracy > limit ? 'weak' : 'ok';
    this.emit('quality', `±${Math.round(c.accuracy)} m`);

    const cur = {
      t, lat: c.latitude, lon: c.longitude,
      alt: typeof c.altitude === 'number' && isFinite(c.altitude) ? c.altitude : null,
      acc: Math.round(c.accuracy), v: 0,
    };

    if (!this.active || this.paused) { this.emit('pos', cur); return; }

    const prev = this.points[this.points.length - 1];
    if (prev) {
      const dt = (t - prev.t) / 1000;
      if (dt < 0.35) return;                       // zu dicht
      const d = distM(prev, cur);
      if (d / dt > 45) { this.emit('pos', cur); return; }  // GPS-Sprung verwerfen

      const gpsV = typeof c.speed === 'number' && isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
      const noise = Math.max(1.8, c.accuracy * 0.45);
      let raw;
      if (gpsV !== null) raw = gpsV;
      else raw = d < noise ? 0 : d / dt;
      if (gpsV === null && d >= noise) this.dist += d;
      else if (gpsV !== null && (d > noise * 0.6 || gpsV > 0.9)) this.dist += d;

      this.v = this.v * 0.55 + raw * 0.45;          // EMA-Glättung
      if (this.v < 0.35) this.v = 0;
      if (raw > 0.8) this.movingMs += dt * 1000;
      if (this.v > this.maxV) this.maxV = this.v;
      cur.v = this.v;
    } else {
      cur.v = typeof c.speed === 'number' && c.speed > 0 ? c.speed : 0;
      this.v = cur.v;
    }

    // Höhenmeter laufend mitzählen (geglättet, 3-m-Schwelle gegen GPS-Rauschen)
    if (cur.alt !== null) {
      this._altBuf.push(cur.alt);
      if (this._altBuf.length > 5) this._altBuf.shift();
      const avg = this._altBuf.reduce((a, b) => a + b, 0) / this._altBuf.length;
      if (this._altRef === null) this._altRef = avg;
      const diff = avg - this._altRef;
      if (Math.abs(diff) >= 3) { if (diff > 0) this.up += diff; else this.down -= diff; this._altRef = avg; }
    }

    this.points.push(cur);
    this.checkLap(cur);
    this.emit('pos', cur);
  },

  // ---------- Rundenerkennung (Radius-Durchfahrt, präziser Zeitpunkt) ----------
  checkLap(cur) {
    if (this.mode !== 'lap' || !this.trail || !settings.autoLap) return;
    const R = settings.lapRadius;
    const start = this.trail.start, finish = this.trail.finish;
    if (!start) return;
    const loop = !finish || distM(start, finish) < 60;
    const target = this.lapState === 'armed' ? start : (loop ? start : finish);
    const d = distM(cur, target);

    if (d <= R) {
      if (!this._visit || this._visit.bestD > d) this._visit = { bestD: d, bestT: cur.t, idx: this.points.length - 1 };
      return;
    }
    if (!this._visit) return;

    const { bestT, idx } = this._visit;
    this._visit = null;

    if (this.lapState === 'armed') {
      this.lapState = 'running'; this.lapStartT = bestT; this._lapStartIdx = idx;
      this.emit('lap', { type: 'start' });
    } else if (this.lapState === 'running') {
      const secs = (bestT - this.lapStartT) / 1000;
      if (secs < MIN_LAP_S) return;
      const lap = { n: this.laps.length + 1, time: secs, ts: bestT, from: this._lapStartIdx, to: idx };
      this.laps.push(lap);
      if (loop) { this.lapStartT = bestT; this._lapStartIdx = idx; }
      else { this.lapState = 'armed'; this.lapStartT = 0; }
      this.emit('lap', { type: 'done', lap });
    }
  },

  get lapClock() {
    return this.lapState === 'running' && this.lapStartT ? Math.max(0, (Date.now() - this.lapStartT) / 1000) : null;
  },

  // ---------- Display an ----------
  async keepAwake(on) {
    try {
      if (on && settings.keepAwake && 'wakeLock' in navigator) {
        this._wakeLock = await navigator.wakeLock.request('screen');
        this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
      } else if (!on && this._wakeLock) {
        await this._wakeLock.release(); this._wakeLock = null;
      }
    } catch { /* nicht kritisch */ }
  },
  async reacquireWake() {
    if (this.active && !this._wakeLock) await this.keepAwake(true);
  },

  // ---------- Absturzsicherung ----------
  async autosave() {
    if (!this.active || this.points.length < 2) return;
    await db.put('meta', {
      key: 'active', savedAt: Date.now(),
      state: {
        points: this.points, laps: this.laps, startedAt: this.startedAt,
        mode: this.mode, trailId: this.trail?.id || null, name: this.name,
      },
    }).catch(() => {});
  },

  // ---------- Simulator (Demo/Test ohne echtes GPS) ----------
  simulate(path, speedFactor = 1) {
    this.stopGPS();
    let i = 0;
    this.quality = 'ok';
    this._simTimer = setInterval(() => {
      if (i >= path.length) { clearInterval(this._simTimer); this._simTimer = null; return; }
      const p = path[i++];
      this.onPosition({ coords: { latitude: p.lat, longitude: p.lon, altitude: p.alt ?? null, accuracy: 6, speed: p.v ?? null }, timestamp: Date.now() });
    }, Math.max(60, 1000 / speedFactor));
  },
};
