const CACHE = 'warm-island-static-v2.0.0';
const BASE = new URL('./', self.location.href);
const FILES = ['./', './index.html', './medication.css', './medication.js', './medication-core.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(file => new URL(file, BASE).href))));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('warm-island-static-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  if (!FILES.some(file => new URL(file, BASE).pathname === url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
      return response;
    }
    return caches.match(event.request).then(cached => cached || response);
  }).catch(async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    return new Response('离线资源尚未缓存，请先联网打开小暖岛。', { status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL('./#medication', BASE).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
    for (const client of windows) {
      if (client.url.startsWith(BASE.href)) {
        await client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
