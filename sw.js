// Offline first: the app opens instantly from the copy stored on the phone, even with
// no or poor network; a fresh copy is fetched in the background when online and is
// used from the next launch on. Also receives receipts shared to the app (Share → Frais).
const CACHE = 'frais-mission';
const INBOX = 'frais-inbox';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'odt.js', 'pdf.js', 'xlsx.js', 'receipt.js', 'summary.js', 'backup.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  // pdf.js (PDF receipts) and Tesseract (reading receipts), ~7 MB, so they work offline too
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/tesseract/tesseract.esm.min.js', 'vendor/tesseract/worker.min.js',
  'vendor/tesseract/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract/lang/fra.traineddata.gz'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/** Share target (see manifest.webmanifest): keep the files, then open the inbox view. */
async function receiveShare(request) {
  const form = await request.formData();
  const inbox = await caches.open(INBOX);
  for (const f of form.getAll('files')) {
    if (!(f instanceof File)) continue;
    const key = `${self.registration.scope}__inbox/${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await inbox.put(key, new Response(f, { headers: {
      'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || 'justificatif'),
    } }));
  }
  return Response.redirect(`${self.registration.scope}#/inbox`, 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
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
