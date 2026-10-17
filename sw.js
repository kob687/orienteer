const SHELL = 'orienteer-shell-v6', TILES = 'orienteer-tiles-v1', MAX_TILES = 3000;
const ASSETS = ['./','index.html','app.js','printmap.js','vendor/internmap.min.js','vendor/d3-array.min.js','vendor/d3-contour.min.js','app.css','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png','vendor/leaflet.js','vendor/leaflet.css','vendor/turf.min.js','vendor/images/layers.png','vendor/images/layers-2x.png','vendor/images/marker-icon.png','vendor/images/marker-shadow.png'];
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => ![SHELL, TILES].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
const isTile = u => /tile\.openstreetmap\.org|arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery|tile\.opentopomap\.org|basemap\.nationalmap\.gov/.test(u);
self.addEventListener('fetch', e => {
  const u = e.request.url; if (e.request.method !== 'GET') return;
  if (isTile(u)) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(u);
      const net = fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') { c.put(u, r.clone()); trim(c); } return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (new URL(u).origin === location.origin) {
    // network-first for app shell, bypassing the HTTP cache (GitHub Pages sends max-age=600) so updates land at once; cache fallback offline
    e.respondWith(fetch(u, { cache:'no-cache', credentials:'same-origin' }).then(r => { if (r.ok) { const cp = r.clone(); caches.open(SHELL).then(c => c.put(e.request, cp)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch:true }).then(r => r || caches.match('index.html'))));
  }
});
let trimming = false;
async function trim(c) { if (trimming) return; trimming = true; const ks = await c.keys(); if (ks.length > MAX_TILES) for (const k of ks.slice(0, ks.length - MAX_TILES)) await c.delete(k); trimming = false; }
