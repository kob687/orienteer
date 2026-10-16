const SHELL = 'orienteer-shell-v3', TILES = 'orienteer-tiles-v1', MAX_TILES = 3000;
const ASSETS = ['./','index.html','app.js','app.css','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png','vendor/leaflet.js','vendor/leaflet.css','vendor/turf.min.js','vendor/images/layers.png','vendor/images/layers-2x.png','vendor/images/marker-icon.png','vendor/images/marker-shadow.png'];
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
    // network-first for app shell (so updates land), fall back to cache offline
    e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(SHELL).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
  }
});
let trimming = false;
async function trim(c) { if (trimming) return; trimming = true; const ks = await c.keys(); if (ks.length > MAX_TILES) for (const k of ks.slice(0, ks.length - MAX_TILES)) await c.delete(k); trimming = false; }
