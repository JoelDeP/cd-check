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
      tags,
      grants,
      note: exc?.note || '',
      formula: Boolean(exc?.formula),
    };
  }
  return out;
}

/**
 * Order items for a champion's quick grid. Real "most bought" data only
 * exists on stats sites (not used), and Data Dragon's recommended sets are
 * empty, so: items this user added for this champion before come first (most
 * recent first), then items whose stats fit Riot's attack / magic / defense
 * ratings for the champion, then legendaries before components.
 */
export function rankItemsFor(items, champ, history = []) {
  const p = champ?.profile || { attack: 5, magic: 5, defense: 5 };
  const ad = p.attack >= p.magic;
  const ap = p.magic > p.attack;
  const tanky = p.defense >= 6;
  const support = (champ?.tags || []).includes('Support');
  const fit = (it) => {
    const t = new Set(it.tags || []);
    let s = 0;
    if (t.has('Damage') || t.has('ArmorPenetration')) s += ad ? 3 : -2;
    if (t.has('SpellDamage') || t.has('MagicPenetration')) s += ap ? 3 : -2;
    if (t.has('CriticalStrike')) s += ad && !tanky ? 1 : -2;
    if (t.has('Health') || t.has('Armor') || t.has('SpellBlock')) s += tanky ? 2 : 0;
    if (t.has('Aura') || t.has('ManaRegen')) s += support ? 2 : 0;
    if (it.group === 'Boots') s += 2;
    if (it.grants?.some((g) => g.kind === 'ultimate' || g.kind === 'basic')) s += 1;
    return s;
  };
  const recency = (it) => {
    const i = history.indexOf(it.id);
    return i < 0 ? 0 : 100 - i;
  };
  const tier = { Boots: 1, Legendary: 2, Epic: 1, Basic: 0 };
  return Object.values(items).sort((a, b) =>
    recency(b) - recency(a)
    || fit(b) - fit(a)
    || (tier[b.group] ?? 0) - (tier[a.group] ?? 0)
    || b.gold - a.gold
    || a.name.localeCompare(b.name));
}

/** One-line summary of an item's haste: "15 AH, 20 ult". */
export function describeGrants(grants) {
  const SHORT = { ability: 'AH', basic: 'basic AH', ultimate: 'ult AH', summoner: 'summ.', item: 'item' };
  return grants.map((g) => `${g.amount} ${SHORT[g.kind]}`).join(', ');
}
