/**
 * Cooldown maths.
 *
 * Ability haste is not cooldown reduction: it is linear in casts-per-second, so
 * it never hits a cap and never reaches zero.
 *
 *   effective = base * 100 / (100 + haste)
 *
 * Ultimate haste stacks additively with ability haste, and applies only to R.
 * Summoner spell haste is its own pool and does not benefit from ability haste.
 */

export const QUICK_HASTE = [0, 10, 20, 30, 45, 60];
export const MAX_HASTE = 150;

/** Runes and boots that grant summoner spell haste. */
export const SUMMONER_HASTE_SOURCES = [
  { id: 'cosmic', name: 'Cosmic Insight', short: 'Cosmic', haste: 18 },
  { id: 'ionian', name: 'Ionian Boots of Lucidity', short: 'Ionian', haste: 10 },
];

export function applyHaste(base, haste) {
  if (!Number.isFinite(base)) return NaN;
  return (base * 100) / (100 + Math.max(0, haste));
}

/** Haste that applies to a given slot, given ability + ultimate haste pools. */
export function hasteForSlot(slot, abilityHaste, ultimateHaste) {
  return slot === 'R' ? abilityHaste + ultimateHaste : abilityHaste;
}

/** Cooldowns at every rank, after haste. */
export function cooldownsWithHaste(ability, abilityHaste, ultimateHaste) {
  const h = hasteForSlot(ability.slot, abilityHaste, ultimateHaste);
  return ability.cooldown.map((cd) => applyHaste(cd, h));
}

/**
 * How much haste is needed to bring `base` down to `target` seconds.
 * Useful for "what do I need to have Q up every 4s?".
 */
export function hasteNeeded(base, target) {
  if (!target || target <= 0 || target >= base) return 0;
  return Math.ceil((100 * (base - target)) / target);
}

export function summonerHaste({ cosmic = false, ionian = false, extra = 0 } = {}) {
  let h = extra;
  for (const src of SUMMONER_HASTE_SOURCES) {
    if ((src.id === 'cosmic' && cosmic) || (src.id === 'ionian' && ionian)) h += src.haste;
  }
  return h;
}

/**
 * Index into a level-scaled cooldown array (e.g. Camille P: [14,11,8] at levels
 * 1 / 7 / 13). Falls back to a smooth interpolation when no breaks are given.
 */
export function levelIndex(ability, level) {
  const breaks = ability.levelBreaks;
  const n = ability.cooldown.length;
  if (breaks && breaks.length === n) {
    let idx = 0;
    for (let i = 0; i < n; i += 1) if (level >= breaks[i]) idx = i;
    return idx;
  }
  if (n <= 1) return 0;
  return Math.min(n - 1, Math.floor(((level - 1) / 17) * (n - 1) + 0.0001));
}

/**
 * The rank an ability is at, given a champion level and a skill order.
 * `order` is an array of slots in the sequence they are levelled, e.g.
 * ['Q','E','W','Q','Q','R', ...]. Returns 0 when not yet learned.
 */
export function rankAtLevel(slot, level, order) {
  if (!order || !order.length) return null;
  let rank = 0;
  for (let i = 0; i < Math.min(level, order.length); i += 1) {
    if (order[i] === slot) rank += 1;
  }
  return rank;
}
