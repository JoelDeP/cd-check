/**
 * CD Check service worker.
 *
 * BUILD is rewritten by .github/workflows/deploy.yml with the commit SHA, so
 * every deploy changes this file's bytes. The browser notices, installs the new
 * worker, and app.js offers a one-tap reload - nobody has to hard-refresh.
 *
 * Everything is relative so the app works under a /repo-name/ subpath.
 */

const BUILD = '__BUILD_ID__';
const SHELL_CACHE = `cd-check-shell-${BUILD}`;
const IMG_CACHE = 'cd-check-ddragon-img';

/** Resolved against the worker's own scope, never against the site root. */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/ddragon.js',
  './js/model.js',
  './js/patch.js',
  './js/haste.js',
  './js/search.js',
  './js/store.js',
  './js/ui.js',
  './js/views/champion.js',
  './js/views/sort.js',
  './data/overrides.json',
  './data/nicknames.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll is all-or-nothing; tolerate one missing file rather than
      // leaving the worker permanently uninstallable.
      Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
            console.warn('[sw] could not precache', url, err);
          })
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('cd-check-shell-') && k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isDDragonImage(url) {
  return url.hostname === 'ddragon.leagueoflegends.com' && /\/img\//.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Champion / spell art is immutable per patch URL - cache it forever.
  if (isDDragonImage(url)) {
    event.respondWith(
      caches.open(IMG_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      }).catch(() => fetch(request))
    );
    return;
  }

  // Champion JSON is cached in IndexedDB by ddragon.js - don't double-store it.
  if (url.hostname === 'ddragon.leagueoflegends.com') return;

  if (url.origin !== self.location.origin) return;

  // Navigations: network first so a new deploy lands immediately, cache as backup.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(async () => (await caches.match('./index.html')) || Response.error())
    );
    return;
  }

  // App shell: serve from cache, refresh in the background.
  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      const network = fetch(request)
        .then((res) => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
