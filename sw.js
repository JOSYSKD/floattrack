// floatTRACK Service Worker – App offline verfügbar, Kartenkacheln zwischenspeichern
const APP = 'ft-app-v1';
const TILES = 'ft-tiles-v1';
const SHELL = [
  './', './index.html', './style.css', './manifest.webmanifest',
  './js/app.js', './js/store.js', './js/geo.js', './js/chart.js', './js/tracker.js',
  './vendor/leaflet.js', './vendor/leaflet.css',
  './icons/icon.svg', './icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== APP && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isTile = (url) => /tile|basemaps|arcgisonline/.test(url.host) || /\/tile\//.test(url.pathname);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Kartenkacheln: erst Cache, dann Netz (und Netz-Ergebnis ablegen)
  if (isTile(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone()).then(() => trimTiles(cache));
        return res;
      }).catch(() => hit);
      return hit || net;
    })());
    return;
  }

  // App-Dateien: Netz zuerst, Cache als Rückfall (offline)
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(APP)).put(req, res.clone());
        return res;
      } catch {
        const hit = await caches.match(req);
        return hit || caches.match('./index.html');
      }
    })());
  }
});

async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length > 1200) for (const k of keys.slice(0, keys.length - 1000)) await cache.delete(k);
}
