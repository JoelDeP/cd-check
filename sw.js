/**
 * CD Check service worker.
 *
 * BUILD is rewritten with the commit SHA by tools/stamp-build.mjs, which you
 * run before each push. That changes this file's bytes on every deploy, so the
 * browser notices, installs the new worker, and app.js offers a one-tap
 * reload - nobody has to hard-refresh.
 *
 * Everything is relative so the app works under a /repo-name/ subpath.
 */

const BUILD = 'f35a34772e79';
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

function isDDragonImage(url) {
  return url.hostname === 'ddragon.leagueoflegends.com' && /\/img\//.test(url.pathname);
}

/**
 * Fetch Data Dragon art in CORS mode (Riot sends the headers). An <img> tag's
 * own request is no-cors, which yields an opaque response: its `ok` is always
 * false, so it was never cached, and Chrome would bill each one as ~7 MB of
 * quota if it were. A CORS response caches at its real size and is still fine
 * to hand back to the <img>.
 */
async function fetchArt(url) {
  try {
    return await fetch(url, { mode: 'cors', credentials: 'omit' });
  } catch {
    return fetch(url);
  }
}

const IMG_PATCH_RE = /\/cdn\/(\d+\.\d+\.\d+)\/img\//;

/**
 * Background-cache a batch of Data Dragon images (the page sends every
 * champion square after first load). Drops art from other patches first -
 * those URLs are never requested again - and skips anything already cached,
 * so repeating this on every load is cheap.
 */
async function precacheImages(urls, patch) {
  const cache = await caches.open(IMG_CACHE);
  for (const req of await cache.keys()) {
    const m = req.url.match(IMG_PATCH_RE);
    if (m && m[1] !== patch) await cache.delete(req);
  }
  const have = new Set((await cache.keys()).map((r) => r.url));
  const todo = urls.filter((u) => {
    try {
      return isDDragonImage(new URL(u)) && !have.has(u);
    } catch {
      return false;
    }
  });

  let fetched = 0;
  let failed = 0;
  let next = 0;
  // A few at a time: done in seconds, gentle on a phone connection.
  const worker = async () => {
    while (next < todo.length) {
      const url = todo[next++];
      try {
        const res = await fetchArt(url);
        if (res.ok) {
          await cache.put(url, res);
          fetched += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { requested: urls.length, alreadyCached: urls.length - todo.length, fetched, failed };
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'PRECACHE_IMAGES' && Array.isArray(msg.urls) && msg.patch) {
    event.waitUntil(
      precacheImages(msg.urls, msg.patch).then((result) => {
        event.source?.postMessage({ type: 'PRECACHE_IMAGES_DONE', patch: msg.patch, ...result });
      })
    );
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Champion / spell art is immutable per patch URL - cache it forever.
  if (isDDragonImage(url)) {
    event.respondWith(
      caches.open(IMG_CACHE).then(async (cache) => {
        const hit = await cache.match(request.url);
        if (hit) return hit;
        const res = await fetchArt(request.url);
        if (res.ok) cache.put(request.url, res.clone());
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
