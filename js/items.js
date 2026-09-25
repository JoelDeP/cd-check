/**
 * Item haste, read from Data Dragon item.json at runtime so it follows every
 * patch without edits here.
 *
 * Data Dragon's `stats` object has no haste fields, so haste is parsed from
 * the description:
 *   - the <stats> block: "15 Ability Haste", "25 Basic Ability Haste", ...
 *   - unconditional passive sentences: "Gain 20 Ultimate Ability Haste."
 * Conditional passives ("... for your abilities with Immobilizing effects",
 * "... for 6 seconds") deliberately do not match; the ones that matter are
 * described in haste-sources.json itemExceptions instead.
 */

import { img } from './ddragon.js';

const STRIP = (s) => s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// Order matters: the specific kinds are consumed before the generic one.
const STAT_PATTERNS = [
  ['ultimate', /(\d+(?:\.\d+)?)\s*Ultimate Ability Haste/gi],
  ['basic', /(\d+(?:\.\d+)?)\s*Basic Ability Haste/gi],
  ['summoner', /(\d+(?:\.\d+)?)\s*Summoner Spell Haste/gi],
  ['item', /(\d+(?:\.\d+)?)\s*Item Haste/gi],
  ['ability', /(\d+(?:\.\d+)?)\s*Ability Haste/gi],
];

const PASSIVE_RE = /Gain (\d+(?:\.\d+)?) (Ultimate Ability|Basic Ability|Summoner Spell|Item|Ability) Haste\.(?!\S)/g;
const PASSIVE_KIND = {
  'Ultimate Ability': 'ultimate',
  'Basic Ability': 'basic',
  'Summoner Spell': 'summoner',
  Item: 'item',
  Ability: 'ability',
};

/** @returns {Array<{kind: string, amount: number}>} */
export function parseItemHaste(description) {
  const grants = {};
  const bump = (kind, n) => { grants[kind] = (grants[kind] || 0) + n; };

  const statsHtml = (description.match(/<stats>([\s\S]*?)<\/stats>/i) || [])[1] || '';
  let stats = STRIP(statsHtml);
  for (const [kind, re] of STAT_PATTERNS) {
    for (const m of stats.matchAll(re)) bump(kind, Number(m[1]));
    stats = stats.replace(re, '');
  }

  const rest = STRIP(description.replace(/<stats>[\s\S]*?<\/stats>/i, ''));
  for (const m of rest.matchAll(PASSIVE_RE)) bump(PASSIVE_KIND[m[2]], Number(m[1]));

  return Object.entries(grants).map(([kind, amount]) => ({ kind, amount }));
}

/** Summoner's Rift, buyable, in the shop, not champion-locked. */
export function isRiftItem(id, it) {
  return Number(id) < 10000
    && it.maps?.['11']
    && it.gold?.purchasable
    && it.inStore !== false
    && !it.requiredChampion;
}

/**
 * Items the haste picker offers: every Rift item that grants haste, plus the
 * formula/conditional ones listed in haste-sources.json.
 * @returns {Record<string, {id, name, icon, gold, group, grants, note}>}
 */
export function buildItems(patch, itemsRaw, sources) {
  const exceptions = sources?.itemExceptions || {};
  const out = {};
  for (const [id, it] of Object.entries(itemsRaw || {})) {
    if (!isRiftItem(id, it)) continue;
    const grants = parseItemHaste(it.description || '');
    const exc = exceptions[id];
    if (!grants.length && !exc) continue;
    const tags = it.tags || [];
    const group = tags.includes('Boots') ? 'Boots'
      : (it.depth || 1) >= 3 ? 'Legendary'
        : (it.depth || 1) === 2 ? 'Epic' : 'Basic';
    out[id] = {
      id,
      name: it.name,
      icon: img.item(patch, it.image?.full || `${id}.png`),
      gold: it.gold?.total || 0,
      group,
      grants,
      note: exc?.note || '',
      formula: Boolean(exc?.formula),
    };
  }
  return out;
}

/** One-line summary of an item's haste: "15 AH, 20 ult". */
export function describeGrants(grants) {
  const SHORT = { ability: 'AH', basic: 'basic AH', ultimate: 'ult AH', summoner: 'summ.', item: 'item' };
  return grants.map((g) => `${g.amount} ${SHORT[g.kind]}`).join(', ');
}
