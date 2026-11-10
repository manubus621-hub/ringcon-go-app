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

// Avisos push (Firebase Cloud Messaging): muestra el aviso y, al tocarlo, abre o enfoca la app.
self.addEventListener('push', e => {
  let p = {}; try { p = e.data ? e.data.json() : {}; } catch {}
  const d = { ...(p.notification || {}), ...(p.data || {}) };
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    if (cs.some(c => c.focused)) return;   // con la app abierta y a la vista, alcanza con el aviso en pantalla
    return self.registration.showNotification(d.title || 'Ringcon Go', {
      body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
      tag: d.tag || 'ringcon-go', renotify: true, vibrate: [200, 100, 200], data: { link: d.link || './' }
    });
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const link = new URL((e.notification.data && e.notification.data.link) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const open = cs.find(c => c.url.split(/[?#]/)[0] === link.split(/[?#]/)[0]);
    return open ? open.focus() : self.clients.openWindow(link);
  }));
});
