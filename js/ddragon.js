/**
 * Data Dragon fetching + IndexedDB cache.
 *
 * Nothing about champions is hardcoded here. On load we ask Riot for the latest
 * patch, and only re-download when that patch string differs from what we have
 * cached. Everything is keyed by patch so a rollback is a cache hit, not a refetch.
 */

const CDN = 'https://ddragon.leagueoflegends.com';
const VERSIONS_URL = `${CDN}/api/versions.json`;

const DB_NAME = 'cd-check';
const DB_VERSION = 1;
const STORE = 'ddragon';

/* ------------------------------------------------------------------ IndexedDB */

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    // Private-mode Safari and friends. Fall through to network-only.
    console.warn('[cd-check] IndexedDB unavailable, running without cache', err);
    return null;
  });
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function idbKeys() {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/**
 * Bump when the trimmed shape changes, so cached data from an older app
 * version is refetched instead of read with fields missing.
 * v2: champion attack range, item.json.  v3: champion info ratings.
 */
const DATA_VERSION = 3;
const keyFor = (patch, name) => `${patch}:v${DATA_VERSION}:${name}`;

/** Drop every cached entry that is not this patch in this data version. */
async function evictOtherPatches(keepPatch) {
  const keep = `${keepPatch}:v${DATA_VERSION}:`;
  const keys = await idbKeys();
  await Promise.all(
    keys.filter((k) => typeof k === 'string' && k.includes(':') && !k.startsWith(keep))
      .map(idbDelete)
  );
}

/* ------------------------------------------------------------------- trimming */

/**
 * championFull.json is ~2.2 MB, most of which is skins, lore and item build
 * recommendations we never render. Strip it down before it goes into IndexedDB.
 */
function trimChampion(c) {
  return {
    id: c.id,
    key: c.key,
    name: c.name,
    title: c.title,
    tags: c.tags,
    partype: c.partype,
    range: c.stats?.attackrange ?? 125,
    info: c.info ? { attack: c.info.attack, defense: c.info.defense, magic: c.info.magic } : undefined,
    image: { full: c.image.full },
    passive: {
      name: c.passive.name,
      description: c.passive.description,
      image: { full: c.passive.image.full },
    },
    spells: c.spells.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      maxrank: s.maxrank,
      cooldown: s.cooldown,
      cost: s.cost,
      costType: s.costType,
      costBurn: s.costBurn,
      maxammo: s.maxammo,
      rangeBurn: s.rangeBurn,
      resource: s.resource,
      image: { full: s.image.full },
    })),
  };
}

function trimSummoner(s) {
  return {
    id: s.id,
    key: s.key,
    name: s.name,
    description: s.description,
    cooldown: s.cooldown,
    summonerLevel: s.summonerLevel,
    modes: s.modes,
    image: { full: s.image.full },
  };
}

/**
 * Only Summoner's Rift items that are in the shop; the description is kept
 * because haste lives in its text (see js/items.js). ~200 of ~700 entries.
 */
function trimItems(data) {
  const out = {};
  for (const [id, it] of Object.entries(data)) {
    if (Number(id) >= 10000 || !it.maps?.['11'] || !it.gold?.purchasable || it.inStore === false) continue;
    out[id] = {
      name: it.name,
      description: it.description,
      gold: { total: it.gold.total, purchasable: true },
      maps: { 11: true },
      depth: it.depth || 1,
      tags: it.tags || [],
      requiredChampion: it.requiredChampion || '',
      image: { full: it.image?.full },
    };
  }
  return out;
}

/* ---------------------------------------------------------------------- fetch */

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/**
 * Newest patch string, e.g. "16.19.1". Returns null when offline so the caller
 * can fall back to whatever is already in IndexedDB.
 */
async function fetchLatestPatch() {
  try {
    const versions = await getJson(VERSIONS_URL);
    return Array.isArray(versions) && versions.length ? versions[0] : null;
  } catch (err) {
    console.warn('[cd-check] could not reach Data Dragon version list', err);
    return null;
  }
}

/* ----------------------------------------------------------------------- load */

/**
 * @param {(stage: string) => void} [onProgress]
 * @returns {Promise<{patch: string, champions: object, summoners: object, stale: boolean}>}
 */
export async function loadDataDragon(onProgress = () => {}) {
  onProgress('Checking for the latest patch…');

  const [latest, cachedPatch] = await Promise.all([fetchLatestPatch(), idbGet('latestPatch')]);
  const online = latest !== null;
  const patch = latest || cachedPatch;

  if (!patch) {
    throw new Error(
      'No patch data available. CD Check needs one online visit before it can work offline.'
    );
  }

  const [cachedChampions, cachedSummoners, cachedItems] = await Promise.all([
    idbGet(keyFor(patch, 'champions')),
    idbGet(keyFor(patch, 'summoners')),
    idbGet(keyFor(patch, 'items')),
  ]);

  if (cachedChampions && cachedSummoners && cachedItems) {
    onProgress(`Patch ${patch} — loaded from cache`);
    if (online && patch !== cachedPatch) await idbSet('latestPatch', patch);
    return {
      patch, champions: cachedChampions, summoners: cachedSummoners, items: cachedItems, stale: !online,
    };
  }

  if (!online) {
    throw new Error(
      `Offline, and patch ${patch} is not fully cached. Reconnect once to finish downloading.`
    );
  }

  onProgress(`Downloading patch ${patch} champion data…`);
  const base = `${CDN}/cdn/${patch}/data/en_US`;
  const [full, summoner, item] = await Promise.all([
    getJson(`${base}/championFull.json`),
    getJson(`${base}/summoner.json`),
    getJson(`${base}/item.json`),
  ]);

  onProgress('Preparing data…');
  const champions = {};
  for (const [id, c] of Object.entries(full.data)) champions[id] = trimChampion(c);

  const summoners = {};
  for (const [id, s] of Object.entries(summoner.data)) summoners[id] = trimSummoner(s);

  const items = trimItems(item.data);

  await Promise.all([
    idbSet(keyFor(patch, 'champions'), champions),
    idbSet(keyFor(patch, 'summoners'), summoners),
    idbSet(keyFor(patch, 'items'), items),
    idbSet('latestPatch', patch),
  ]);
  await evictOtherPatches(patch);

  return { patch, champions, summoners, items, stale: false };
}

/* ----------------------------------------------------------------------- URLs */

export const img = {
  champion: (patch, file) => `${CDN}/cdn/${patch}/img/champion/${file}`,
  spell: (patch, file) => `${CDN}/cdn/${patch}/img/spell/${file}`,
  passive: (patch, file) => `${CDN}/cdn/${patch}/img/passive/${file}`,
  item: (patch, file) => `${CDN}/cdn/${patch}/img/item/${file}`,
  splash: (id) => `${CDN}/cdn/img/champion/loading/${id}_0.jpg`,
};
