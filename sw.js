'use strict';

// Keeps the app shell on the glasses so it opens quickly on a slow link. Network first, so an update
// shows on the next launch. Only this app's own files are handled: Quran.com data, the recitation
// audio, the font and the optional reciter timings (another path on the same site) always come from
// their own servers.
const CACHE = 'quran-glass-v10';
const SCOPE = new URL(self.registration.scope);
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'icon.svg', 'icon-mono.svg'];

// The copy is filled straight from the server, never from the browser's own cache.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await Promise.race([
        // no-cache: always ask the server (a tiny 304 when nothing changed), so Back → Refresh never
        // shows a version the browser's own cache kept for up to ten minutes after an update.
        fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('slow network')), 3000)),
      ]);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    } catch (e) {
      return (await cache.match(event.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
