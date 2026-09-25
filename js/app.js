/** Bootstrap: load data, build views, wire tabs and global keys. */

import { loadDataDragon } from './ddragon.js';
import { buildAllChampions, buildSummoners } from './model.js';
import { buildSearchIndex, searchChampions } from './search.js';
import { buildItems } from './items.js';
import { computeHaste } from './haste.js';
import { decodeMatchup } from './matchup-state.js';
import { createChampionView } from './views/champion.js';
import { createSortView } from './views/sort.js';
import { createMatchupView } from './views/matchup.js';
import { settings } from './store.js';
import { el, clear, $ } from './ui.js';

const statusEl = $('#status');
const patchEl = $('#patch');
const mainEl = $('#main');
const tabsEl = $('#tabs');

function status(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

async function getJson(path, fallback) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch (err) {
    console.warn(`[cd-check] could not load ${path}`, err);
    return fallback;
  }
}

async function main() {
  status('Loading…');

  let data;
  const [overrides, nicknames, hasteSources, matchupData, lanesData, chargeData] = await Promise.all([
    getJson('./data/overrides.json', { champions: {}, summoners: {} }),
    getJson('./data/nicknames.json', { aliases: {} }),
    getJson('./data/haste-sources.json', { buffs: [], runes: [], itemExceptions: {} }),
    getJson('./data/matchup.json', { skillOrders: {}, keys: {}, pinnedDefault: [] }),
    getJson('./data/lanes.json', { lanes: {} }),
    getJson('./data/charges.json', { charges: {}, notCharges: {} }),
  ]);

  try {
    data = await loadDataDragon((msg) => status(msg));
  } catch (err) {
    status(err.message, 'error');
    clear(mainEl).append(
      el('section', { class: 'panel error-panel' },
        el('h2', { text: 'Could not load champion data' }),
        el('p', { text: err.message }),
        el('button', { class: 'chip', type: 'button', text: 'Retry', onclick: () => location.reload() }))
    );
    return;
  }

  const champions = buildAllChampions(data.patch, data.champions, overrides, { lanes: lanesData, charges: chargeData });
  const summoners = buildSummoners(data.patch, data.summoners, overrides);
  const index = buildSearchIndex(champions, nicknames.aliases || {});

  patchEl.textContent = data.patch;
  patchEl.title = data.stale
    ? `Offline — showing cached patch ${data.patch}`
    : `Data Dragon patch ${data.patch}`;
  patchEl.classList.toggle('stale', data.stale);
  status(data.stale ? 'Offline — cached data' : '', data.stale ? 'warn' : '');

  // The one haste calculator's data: live-parsed items + hand-verified sources.
  const hasteCtx = { sources: hasteSources, items: buildItems(data.patch, data.items, hasteSources) };

  // The Champion and Sort tabs share one simple loadout: the slider is your
  // total ability haste, plus ultimate haste and the two summoner toggles.
  const cosmicSummoner = hasteSources.runes?.find((r) => r.id === 'cosmic')
    ?.grants.find((g) => g.kind === 'summoner')?.amount ?? 18;
  const ionianSummoner = hasteCtx.items['3158']?.grants.find((g) => g.kind === 'summoner')?.amount ?? 10;
  const tabSummonerToggles = [
    { id: 'cosmic', short: 'Cosmic', name: 'Cosmic Insight (rune)', haste: cosmicSummoner },
    { id: 'ionian', short: 'Ionian', name: 'Ionian Boots of Lucidity (summoner haste part)', haste: ionianSummoner },
  ];
  const tabHaste = () => computeHaste({
    level: 18,
    runes: settings.cosmicInsight ? { cosmic: true } : {},
    extra: [
      { kind: 'ability', amount: settings.abilityHaste, label: 'Ability haste slider' },
      { kind: 'ultimate', amount: settings.ultimateHaste, label: 'Ultimate haste' },
      ...(settings.ionianBoots ? [{ kind: 'summoner', amount: ionianSummoner, label: 'Ionian Boots' }] : []),
    ],
  }, hasteCtx);

  const resolveChamp = (name) => {
    if (!name) return null;
    const lower = name.toLowerCase();
    const exact = Object.keys(champions).find((id) => id.toLowerCase() === lower);
    return exact || searchChampions(index, name, 1)[0]?.id || null;
  };

  const ctx = {
    patch: data.patch, champions, summoners, index, hasteCtx, matchupData, tabHaste, tabSummonerToggles, lanesData,
    decodeQuery: (q) => decodeMatchup(new URLSearchParams(q), resolveChamp),
  };

  const sortView = createSortView({
    ...ctx,
    onPickChampion: (id) => { championView.show(id); showTab('champion'); },
  });
  const championView = createChampionView(ctx);
  const matchupView = createMatchupView(ctx);

  // A shared matchup link (?me=renekton&vs=darius&lvl=6) opens that exact
  // state, then the query is dropped so later edits aren't overwritten on reload.
  const linked = decodeMatchup(new URLSearchParams(location.search), resolveChamp);
  if (linked) {
    matchupView.setState(linked);
    history.replaceState(null, '', `${location.pathname}#matchup`);
  }

  clear(mainEl).append(championView.el, sortView.el, matchupView.el);

  /* ------------------------------------------------------------------ tabs */

  const TABS = [
    { id: 'champion', label: 'Champion', view: championView },
    { id: 'matchup', label: 'Matchup', view: matchupView },
    { id: 'sort', label: 'Sort by cooldown', view: sortView },
  ];
  let activeTab = 'champion';

  function showTab(id) {
    activeTab = id;
    for (const t of TABS) {
      t.view.el.hidden = t.id !== id;
      const btn = tabsEl.querySelector(`[data-tab="${t.id}"]`);
      if (btn) {
        btn.classList.toggle('on', t.id === id);
        btn.setAttribute('aria-selected', String(t.id === id));
      }
    }
    if (id === 'sort') sortView.refresh();
    if (id === 'champion') championView.refresh();
    if (id === 'matchup') matchupView.refresh();
    const hash = id === 'champion' ? '' : `#${id}`;
    if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  }

  clear(tabsEl).append(
    ...TABS.map((t) =>
      el('button', {
        type: 'button',
        role: 'tab',
        class: 'tab',
        dataset: { tab: t.id },
        text: t.label,
        onclick: () => showTab(t.id),
      })
    )
  );

  const tabFromHash = () => ({ '#sort': 'sort', '#matchup': 'matchup' })[location.hash] || 'champion';
  showTab(tabFromHash());
  window.addEventListener('hashchange', () => {
    const want = tabFromHash();
    if (want !== activeTab) showTab(want);
  });

  /* ------------------------------------------------------------ global keys */

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') {
      if (!championView.clearSearch() && activeTab === 'champion') championView.focusSearch();
      return;
    }
    if (typing) return;
    if (e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      showTab('champion');
      championView.focusSearch();
    } else if (e.key === '1') showTab('champion');
    else if (e.key === '2') showTab('matchup');
    else if (e.key === '3') showTab('sort');
  });

  if (activeTab === 'champion') championView.focusSearch();

  if (registerServiceWorker()) {
    precacheChampionIcons(Object.values(champions).map((c) => c.icon), data.patch);
  }
}

/**
 * Once the UI is up and the browser is idle, ask the service worker to cache
 * every champion square (~170 small PNGs, a few MB) so search results and
 * cards have art offline. The worker skips what it already has, so this is
 * near-free on later visits. Honours Data Saver.
 */
function precacheChampionIcons(urls, patch) {
  if (navigator.connection?.saveData) return;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 3000));
  idle(() => {
    navigator.serviceWorker.ready
      .then((reg) => reg.active?.postMessage({ type: 'PRECACHE_IMAGES', patch, urls }))
      .catch(() => {});
  }, { timeout: 8000 });
}

/* --------------------------------------------------------- service worker */

const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/** @returns {boolean} whether a service worker is (being) registered */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return false;

  // Locally the worker's cache-first shell would serve stale files on every
  // edit, so it stays off unless you ask for it with ?sw=1.
  if (IS_LOCAL && !new URLSearchParams(location.search).has('sw')) {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()))
      .catch(() => {});
    caches?.keys?.().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
    return false;
  }

  navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
    // Check for a new deploy on load and whenever the tab comes back into view,
    // so friends never have to hard-refresh.
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reg.update().catch(() => {});
    });

    // Offer a new worker once it has finished installing. Only when a worker
    // already controls the page - on a first visit there is nothing to update.
    const offer = (sw) => {
      if (sw && navigator.serviceWorker.controller) showUpdateBanner(sw);
    };
    const whenInstalled = (sw) => {
      if (!sw) return;
      if (sw.state === 'installed') return offer(sw);
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed') offer(sw);
      });
    };

    // A worker may already be waiting when the page loads: the browser's own
    // navigation check can finish before this script runs, or the banner was
    // ignored and the page refreshed. No 'updatefound' fires for it again, so
    // without this the new version would sit unused until every tab closed.
    offer(reg.waiting);
    whenInstalled(reg.installing);
    reg.addEventListener('updatefound', () => whenInstalled(reg.installing));
  }).catch((err) => console.warn('[cd-check] service worker failed', err));

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  return true;
}

function showUpdateBanner(sw) {
  // Several paths can report the same waiting worker; show one banner that
  // always targets the newest.
  const existing = document.querySelector('.update-bar');
  if (existing) {
    existing.targetWorker = sw;
    return;
  }
  const bar = el(
    'div',
    { class: 'update-bar', role: 'status' },
    el('span', { text: 'A new version of CD Check is ready.' }),
    el('button', {
      class: 'chip on',
      type: 'button',
      text: 'Reload',
      onclick: () => bar.targetWorker.postMessage({ type: 'SKIP_WAITING' }),
    })
  );
  bar.targetWorker = sw;
  document.body.append(bar);
}

main().catch((err) => {
  console.error(err);
  status(err.message || 'Something went wrong', 'error');
});
