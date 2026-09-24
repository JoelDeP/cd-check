/**
 * Normalises Data Dragon into the shape the UI renders, applying overrides.json
 * on top and auto-flagging abilities whose published cooldown is unreliable.
 *
 * Reliability is detected two ways:
 *   1. Explicitly, from overrides.json (hand-verified against the LoL Wiki).
 *   2. Structurally, from Data Dragon itself - a spell whose name contains " / "
 *      is two abilities merged into one entry, a spell with maxammo is
 *      charge-based, and an all-zero cooldown means the real gate is something
 *      else. These need no curation and keep working for champions released
 *      after this was written.
 */

import { img } from './ddragon.js';

export const SLOTS = ['P', 'Q', 'W', 'E', 'R'];

/** Merged names that are a recast of one ability, not a second form. */
const RECAST_NOT_FORM = new Set([
  'Ambessa:Q', 'AurelionSol:R', 'Briar:W', 'Fizz:E', 'LeeSin:Q', 'LeeSin:W',
  'LeeSin:E', 'Qiyana:Q', 'Skarner:Q', 'Sylas:E',
]);

const FLAG = {
  override: {
    code: 'override',
    label: 'Corrected',
    text: 'Data Dragon is wrong or incomplete here. This value was verified by hand against the LoL Wiki.',
  },
  form: {
    code: 'form',
    label: 'Form swap',
    text: 'Data Dragon merges both forms into one entry and publishes only one form’s cooldown.',
  },
  recast: {
    code: 'recast',
    label: 'Recast',
    text: 'Two names, one ability. The recast does not start a second cooldown.',
  },
  ammo: {
    code: 'ammo',
    label: 'Charges',
    text: 'Charge-based. The listed cooldown is only the delay between casts — charges refill on a separate, longer timer.',
  },
  none: {
    code: 'none',
    label: 'No cooldown',
    text: 'Data Dragon publishes no cooldown. This ability is gated by something else (a resource, an on-hit counter, or it is passive).',
  },
  passive: {
    code: 'passive',
    label: 'Not published',
    text: 'Data Dragon publishes no cooldown for any passive. Add one to overrides.json if you need it.',
  },
  level: {
    code: 'level',
    label: 'Scales with level',
    text: 'This cooldown scales with champion level, not with ability rank.',
  },
};

/**
 * Round for display and drop trailing zeros. Sub-second cooldowns (Rengar,
 * Teemo R, Yasuo E) get a second decimal so 0.25 does not render as 0.3.
 */
export function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const dp = Math.abs(n) < 1 ? 2 : 1;
  const f = 10 ** dp;
  return String(Math.round(n * f) / f);
}

function makeAbility(fields) {
  return {
    slot: 'Q',
    id: '',
    name: '',
    icon: '',
    cooldown: [],
    scaling: 'rank',
    levelBreaks: null,
    maxrank: 5,
    cost: null,
    costType: '',
    range: '',
    description: '',
    ammo: null,
    note: '',
    source: 'ddragon',
    flags: [],
    ...fields,
  };
}

function autoFlags(champId, slot, spell) {
  const flags = [];
  if (spell.name.includes(' / ')) {
    flags.push(RECAST_NOT_FORM.has(champId + ':' + slot) ? FLAG.recast : FLAG.form);
  }
  if (spell.maxammo && spell.maxammo !== '-1' && spell.maxammo !== '0') flags.push(FLAG.ammo);
  if (Array.isArray(spell.cooldown) && spell.cooldown.every((c) => c === 0)) flags.push(FLAG.none);
  return flags;
}

function cleanCostType(spell) {
  const raw = (spell.costType || '').replace(/\{\{[^}]*\}\}/g, '').trim();
  return raw || spell.resource || '';
}

function spellToAbility(patch, champId, slot, spell) {
  return makeAbility({
    slot,
    id: spell.id,
    name: spell.name,
    icon: img.spell(patch, spell.image.full),
    cooldown: spell.cooldown.slice(),
    maxrank: spell.maxrank,
    cost: spell.costBurn,
    costType: cleanCostType(spell),
    range: spell.rangeBurn,
    description: spell.description,
    flags: autoFlags(champId, slot, spell),
  });
}

function passiveToAbility(patch, passive) {
  return makeAbility({
    slot: 'P',
    id: 'passive',
    name: passive.name,
    icon: img.passive(patch, passive.image.full),
    cooldown: [],
    scaling: 'none',
    maxrank: 1,
    description: passive.description,
    flags: [FLAG.passive],
  });
}

/** Apply one overrides.json ability patch on top of a base ability. */
function applyAbilityOverride(base, o) {
  const a = { ...base, flags: base.flags.slice() };
  if (o.name) a.name = o.name;
  if (o.cooldown) {
    a.cooldown = o.cooldown.slice();
    a.source = 'override';
    a.scaling = o.scaling || 'rank';
  }
  if (o.maxrank) a.maxrank = o.maxrank;
  if (o.scaling) a.scaling = o.scaling;
  if (o.levelBreaks) a.levelBreaks = o.levelBreaks.slice();
  if (o.ammo) a.ammo = o.ammo;
  if (o.note) a.note = o.note;

  if (o.cooldown || o.ammo) {
    a.flags = a.flags.filter((f) => f.code !== 'passive' && f.code !== 'none' && f.code !== 'form');
    if (!a.flags.some((f) => f.code === 'override')) a.flags.unshift(FLAG.override);
  } else if (o.unreliable && !a.flags.some((f) => f.code === 'override')) {
    a.flags.unshift({ code: 'override', label: 'Caveat', text: o.note || FLAG.override.text });
  }
  if (a.scaling === 'level' && !a.flags.some((f) => f.code === 'level')) a.flags.push(FLAG.level);

  // An override that pins every rank to zero is saying "this has no cooldown",
  // not "here is a corrected number".
  if (a.cooldown.length && a.cooldown.every((c) => c === 0)) {
    a.flags = a.flags.filter((f) => f.code !== 'override');
    if (!a.flags.some((f) => f.code === 'none')) a.flags.push(FLAG.none);
  }
  return a;
}

function buildForm(patch, champ, base, formDef) {
  const abilities = { ...base };
  for (const [slot, o] of Object.entries(formDef.abilities || {})) {
    const from = o.from !== undefined ? champ.spells[o.from] : null;
    const start = from
      ? spellToAbility(patch, champ.id, slot, from)
      : abilities[slot] || makeAbility({ slot });
    abilities[slot] = applyAbilityOverride({ ...start, slot }, o);
  }
  return { name: formDef.name, short: formDef.short || formDef.name, abilities };
}

export function buildChampion(patch, champ, overrides) {
  const o = (overrides.champions || {})[champ.id] || {};

  const base = { P: passiveToAbility(patch, champ.passive) };
  ['Q', 'W', 'E', 'R'].forEach((slot, i) => {
    base[slot] = spellToAbility(patch, champ.id, slot, champ.spells[i]);
  });

  // Slot-level overrides apply to every form.
  for (const [slot, ao] of Object.entries(o.abilities || {})) {
    if (base[slot]) base[slot] = applyAbilityOverride(base[slot], ao);
  }

  const forms = o.forms
    ? o.forms.map((f) => buildForm(patch, champ, base, f))
    : [{ name: null, short: null, abilities: base }];

  return {
    id: champ.id,
    key: champ.key,
    name: champ.name,
    title: champ.title,
    tags: champ.tags || [],
    icon: img.champion(patch, champ.image.full),
    forms,
    note: o.note || '',
  };
}

export function buildAllChampions(patch, championsRaw, overrides) {
  const out = {};
  for (const champ of Object.values(championsRaw)) {
    out[champ.id] = buildChampion(patch, champ, overrides);
  }
  return out;
}

export function buildSummoners(patch, summonersRaw, overrides) {
  const so = overrides.summoners || {};
  return Object.values(summonersRaw)
    .filter((s) => s.modes.includes('CLASSIC'))
    .map((s) => {
      const o = so[s.id] || {};
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        icon: img.spell(patch, s.image.full),
        cooldown: o.cooldown ? o.cooldown[0] : s.cooldown[0],
        note: o.note || '',
        unreliable: Boolean(o.unreliable || o.cooldown),
        upgrade: o.upgrade || null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every ability of every champion, flattened - used by the Sort view. */
export function flattenAbilities(champions) {
  const rows = [];
  for (const champ of Object.values(champions)) {
    champ.forms.forEach((form, formIndex) => {
      for (const slot of SLOTS) {
        const a = form.abilities[slot];
        if (!a || !a.cooldown.length) continue;
        if (a.cooldown.every((c) => c === 0)) continue;
        rows.push({ champ, form, formIndex, ability: a, slot });
      }
    });
  }
  return rows;
}
