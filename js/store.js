/**
 * Settings that survive a reload. Everything lives in this user's localStorage;
 * nothing is sent anywhere.
 */

const KEY = 'cd-check.settings.v1';

const DEFAULTS = {
  abilityHaste: 0,
  ultimateHaste: 0,
  cosmicInsight: false,
  ionianBoots: false,
  lastChampion: 'Renekton',
  sort: { rank: 'max', keys: ['Q', 'W', 'E', 'R'], role: 'all' },
  // Matchup tab (Phase 2). All per-user, all in this browser only.
  matchup: null,        // last matchup state; null = start from defaults
  pinned: null,         // pinned quick picks; null = data/matchup.json default
  favorites: [],        // [{ label, query }]
  skillOrders: {},      // { champId: 'QEW' } user overrides
  keyOverrides: {},     // { champId: { Q: true, E: false } } starred abilities
  itemHistory: {},      // { champId: [itemId, ...] } most recent first, orders the item grid
  lane: 'all',          // last-used lane filter, shared by search, Sort and the enemy picker
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed, sort: { ...DEFAULTS.sort, ...(parsed.sort || {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = read();

let pending = null;
export function save() {
  clearTimeout(pending);
  pending = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* quota or private mode - settings just will not persist */
    }
  }, 200);
}

export function set(patch) {
  Object.assign(settings, patch);
  save();
}
