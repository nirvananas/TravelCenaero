// Offline first: the app opens instantly from the copy stored on the phone, even with
// no or poor network; a fresh copy is fetched in the background when online and is
// used from the next launch on.
const CACHE = 'frais-mission';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'odt.js', 'pdf.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const refresh = fetch(e.request).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    });
    if (hit) {
      // Being offline is the normal case here: the cached copy is already served.
      e.waitUntil(refresh.catch(() => {}));
      return hit;
    }
    return refresh;
  }));
});
