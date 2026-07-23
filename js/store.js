// IndexedDB-Speicher für floatTRACK
const DB_NAME = 'floattrack';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('rides')) {
        const s = db.createObjectStore('rides', { keyPath: 'id' });
        s.createIndex('trailId', 'trailId');
        s.createIndex('startedAt', 'startedAt');
      }
      if (!db.objectStoreNames.contains('trails')) db.createObjectStore('trails', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('spots')) {
        const s = db.createObjectStore('spots', { keyPath: 'id' });
        s.createIndex('trailId', 'trailId');
      }
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      void e;
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (err) { rej(err); return; }
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const db = {
  get: (store, id) => tx(store, 'readonly', (s) => s.get(id)),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  put: (store, val) => tx(store, 'readwrite', (s) => { s.put(val); return val; }),
  del: (store, id) => tx(store, 'readwrite', (s) => s.delete(id)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  async byIndex(store, index, value) {
    return tx(store, 'readonly', (s) => s.index(index).getAll(value));
  },
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---- Einstellungen (localStorage, klein & synchron) ----
const SET_KEY = 'ft_settings';
const defaults = {
  theme: 'dark',
  units: 'kmh',
  keepAwake: true,
  minAccuracy: 35,
  lapRadius: 25,
  autoLap: true,
  lastMode: 'free',
  lastTrailId: null,
};
export const settings = { ...defaults, ...JSON.parse(localStorage.getItem(SET_KEY) || '{}') };
export function saveSettings() {
  localStorage.setItem(SET_KEY, JSON.stringify(settings));
}

// ---- Fotos ----
export async function savePhoto(blob, thumb) {
  const id = uid();
  await db.put('photos', { id, blob, thumb, createdAt: Date.now() });
  return id;
}
const urlCache = new Map();
export async function photoUrl(id, wantThumb) {
  const key = id + (wantThumb ? ':t' : '');
  if (urlCache.has(key)) return urlCache.get(key);
  const p = await db.get('photos', id);
  if (!p) return null;
  const url = URL.createObjectURL(wantThumb && p.thumb ? p.thumb : p.blob);
  urlCache.set(key, url);
  return url;
}
export function forgetPhotoUrl(id) {
  for (const k of [id, id + ':t']) {
    if (urlCache.has(k)) { URL.revokeObjectURL(urlCache.get(k)); urlCache.delete(k); }
  }
}

// Bild auf Maxbreite runterrechnen -> {blob, thumb}
export async function processImage(file) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return { blob: file, thumb: file };
  const shrink = (max, q) => {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', q));
  };
  const [blob, thumb] = await Promise.all([shrink(1600, 0.82), shrink(360, 0.7)]);
  bmp.close?.();
  return { blob: blob || file, thumb: thumb || blob || file };
}
