// App-Hülle offline verfügbar machen. Footage liegt in IndexedDB, nicht im Cache.
// Bei jeder App-Änderung VERSION hochzählen, damit Geräte die neue Fassung laden.
const VERSION = 'framepoint-v49k';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'vertrag.js', 'slip.js', 'sequenz.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'hero.jpg', 'logo.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Push vom Briefkasten (ohne Inhalt): Benachrichtigung zeigen; Tippen öffnet Framepoint (Robert 13.11.)
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  e.waitUntil(self.registration.showNotification(d.titel || 'Framepoint', {
    body: d.text || '🎵 Deine Musikvorschläge sind da – tippen, reinhören und auswählen.',
    icon: 'icon-192.png', badge: 'icon-192.png', tag: 'framepoint-musik', renotify: true, data: { url: './' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const c = cs.find((x) => 'focus' in x);
    return c ? c.focus() : self.clients.openWindow('./');
  }));
});
// Netz zuerst (neue Fassung sofort), Cache als Rückfall ohne Netz
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  // nur die App-Hülle cachen, nie Footage (das liegt schon in IndexedDB)
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/projekt/')) return;
  // no-cache: immer beim Server nachfragen (GitHub Pages cacht sonst 10 min) – neue Fassungen kommen sofort an
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((r) => {
    const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
