/* Service worker mínimo: hace instalable la app (PWA/APK) sin cachear datos de pedidos ni pagos. */
const CACHE = 'rcg-shell-v2';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/config.js', 'icon.svg', 'manifest.webmanifest', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
// Red primero; el caché solo sirve si no hay conexión. Nada de otros dominios.
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
