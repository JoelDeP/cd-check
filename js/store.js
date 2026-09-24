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
