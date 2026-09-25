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
import { staleness } from './patch.js';

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
  charges: {
    code: 'charges',
    label: 'Charges',
    text: 'Charge ability: the number shown is the recharge time per charge (ability haste shortens it). The small delay between casts is shown separately. Verified against the LoL Wiki.',
  },
  passive: {
    code: 'passive',
    label: 'Not published',
    text: 'Data Dragon publishes no cooldown for any passive. Add one to overrides.json if you need it.',
  },
  stale: {
    code: 'stale',
    label: 'Needs re-check',
    text: '',
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
    between: null,   // charge abilities: { values: [...], static }
    note: '',
    source: 'ddragon',
    verified: null,
    // Static cooldowns ignore ability haste entirely (Yasuo Q, most passives).
    static: false,
    // Short notes on refunds / resets / reductions, from overrides.json.
    mechanics: [],
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

/** Badge text for a hand-verified value the live patch has moved past. */
function staleFlag(v) {
  return {
    ...FLAG.stale,
    label: v.verifiedPatch ? `Verified on ${v.verifiedPatch}` : 'Unverified',
    text: v.verifiedPatch
      ? `This correction was last checked on patch ${v.verifiedPatch}; the live patch is ${v.livePatch}. It may have changed — re-verify and bump verifiedPatch in overrides.json.`
      : 'This correction has no verifiedPatch in overrides.json, so it has never been confirmed against a patch.',
  };
}

/**
 * Apply one overrides.json ability patch on top of a base ability.
 * `vctx` = { livePatch, entryPatch } for staleness; an ability-level
 * verifiedPatch wins over its champion entry's.
 */
function applyAbilityOverride(base, o, vctx) {
  const a = { ...base, flags: base.flags.slice(), mechanics: base.mechanics.slice() };
  if (o.name) a.name = o.name;
  if (o.cooldown) {
    a.cooldown = o.cooldown.slice();
    a.source = 'override';
    a.scaling = o.scaling || 'rank';
  }
  // "22 - 10 (based on level)" on the wiki: linear from level 1 to level 18.
  if (o.levelRange) {
    const [from, to] = o.levelRange;
    a.cooldown = Array.from({ length: 18 }, (_, i) => from + ((to - from) * i) / 17);
    a.levelBreaks = Array.from({ length: 18 }, (_, i) => i + 1);
    a.scaling = 'level';
    a.source = 'override';
  }
  if (o.maxrank) a.maxrank = o.maxrank;
  if (o.scaling) a.scaling = o.scaling;
  if (o.levelBreaks) a.levelBreaks = o.levelBreaks.slice();
  if (o.ammo) a.ammo = o.ammo;
  if (o.note) a.note = o.note;
  if (o.static !== undefined) a.static = Boolean(o.static);
  if (o.mechanics) a.mechanics = [...new Set([...a.mechanics, ...o.mechanics])];

  if (o.cooldown || o.levelRange || o.ammo) {
    a.flags = a.flags.filter((f) => f.code !== 'passive' && f.code !== 'none' && f.code !== 'form');
    if (!a.flags.some((f) => f.code === 'override')) a.flags.unshift(FLAG.override);
  } else if (o.unreliable && !a.flags.some((f) => f.code === 'override')) {
    a.flags.unshift({ code: 'override', label: 'Caveat', text: o.note || FLAG.override.text });
  }
  if (a.scaling === 'level' && !a.flags.some((f) => f.code === 'level')) a.flags.push(FLAG.level);

  a.verified = staleness(o.verifiedPatch || vctx.entryPatch, vctx.livePatch);
  a.flags = a.flags.filter((f) => f.code !== 'stale');
  if (a.verified.stale) a.flags.push(staleFlag(a.verified));

  // An override that pins every rank to zero is saying "this has no cooldown",
  // not "here is a corrected number".
  if (a.cooldown.length && a.cooldown.every((c) => c === 0)) {
    a.flags = a.flags.filter((f) => f.code !== 'override');
    if (!a.flags.some((f) => f.code === 'none')) a.flags.push(FLAG.none);
  }
  return a;
}

function buildForm(patch, champ, base, formDef, vctx) {
  const abilities = { ...base };
  for (const [slot, o] of Object.entries(formDef.abilities || {})) {
    const from = o.from !== undefined ? champ.spells[o.from] : null;
    const start = from
      ? spellToAbility(patch, champ.id, slot, from)
      : abilities[slot] || makeAbility({ slot });
    abilities[slot] = applyAbilityOverride({ ...start, slot }, o, vctx);
  }
  return { name: formDef.name, short: formDef.short || formDef.name, abilities };
}

/**
 * Apply data/charges.json (generated, wiki-verified) to one ability:
 *   charges    - a real charge system: recharge per charge becomes the number
 *                the app shows; the delay between casts is secondary.
 *   notCharges - Data Dragon flags maxammo but it is an ordinary cooldown;
 *                where Data Dragon's number is also wrong, correct it.
 */
function applyChargeData(a, key, chargeData, livePatch) {
  const c = chargeData?.charges?.[key];
  const nc = chargeData?.notCharges?.[key];
  if (!c && !nc) return a;
  const out = { ...a, flags: a.flags.filter((f) => f.code !== 'ammo') };
  if (c) {
    out.ammo = { max: c.max, recharge: c.recharge };
    out.between = { values: c.between, static: Boolean(c.betweenStatic) };
    out.flags.push(FLAG.charges);
  } else if (nc.cooldownWrong && nc.wikiCooldown) {
    out.flags.push({
      ...FLAG.override,
      text: `Data Dragon lists ${a.cooldown.join('/')}s and flags this as a charge ability; the LoL Wiki shows an ordinary ${nc.wikiCooldown.join('/')}s cooldown.`,
    });
    out.cooldown = nc.wikiCooldown.slice();
    out.source = 'override';
    out.flags = out.flags.filter((f) => f.code !== 'none');
  }
  out.verified = staleness(chargeData.verifiedPatch, livePatch);
  if (out.verified.stale) out.flags.push(staleFlag(out.verified));
  return out;
}

export function buildChampion(patch, champ, overrides, extras = {}) {
  const o = (overrides.champions || {})[champ.id] || {};
  const vctx = { livePatch: patch, entryPatch: o.verifiedPatch };

  const base = { P: passiveToAbility(patch, champ.passive) };
  ['Q', 'W', 'E', 'R'].forEach((slot, i) => {
    base[slot] = applyChargeData(
      spellToAbility(patch, champ.id, slot, champ.spells[i]), `${champ.id}:${slot}`, extras.charges, patch
    );
  });

  // Slot-level overrides apply to every form.
  for (const [slot, ao] of Object.entries(o.abilities || {})) {
    if (base[slot]) base[slot] = applyAbilityOverride(base[slot], ao, vctx);
  }

  const forms = o.forms
    ? o.forms.map((f) => buildForm(patch, champ, base, f, vctx))
    : [{ name: null, short: null, abilities: base }];

  return {
    id: champ.id,
    key: champ.key,
    name: champ.name,
    title: champ.title,
    tags: champ.tags || [],
    // Base attack range; >300 is ranged (Endless Hunger's formula differs).
    ranged: (champ.range ?? 125) > 300,
    // Riot's 0-10 ratings; used to order the item grid by relevance.
    profile: champ.info || { attack: 5, defense: 5, magic: 5 },
    // overrides.json "lanes" wins over the generated data/lanes.json.
    lanes: o.lanes || extras.lanes?.lanes?.[champ.id] || [],
    icon: img.champion(patch, champ.image.full),
    forms,
    note: o.note || '',
  };
}

export function buildAllChampions(patch, championsRaw, overrides, extras = {}) {
  const out = {};
  for (const champ of Object.values(championsRaw)) {
    out[champ.id] = buildChampion(patch, champ, overrides, extras);
  }
  return out;
}

export const LANES = [
  { id: 'top', label: 'Top' },
  { id: 'jungle', label: 'Jungle' },
  { id: 'mid', label: 'Mid' },
  { id: 'bot', label: 'Bot' },
  { id: 'support', label: 'Support' },
];

export function buildSummoners(patch, summonersRaw, overrides) {
  const so = overrides.summoners || {};
  return Object.values(summonersRaw)
    .filter((s) => s.modes.includes('CLASSIC'))
    .map((s) => {
      const o = so[s.id] || {};
      const hasEntry = Boolean(so[s.id]);
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        icon: img.spell(patch, s.image.full),
        cooldown: o.cooldown ? o.cooldown[0] : s.cooldown[0],
        note: o.note || '',
        unreliable: Boolean(o.unreliable || o.cooldown),
        upgrade: o.upgrade || null,
        verified: hasEntry ? staleness(o.verifiedPatch, patch) : null,
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
        if (!a.ammo?.recharge && a.cooldown.every((c) => c === 0)) continue;
        rows.push({ champ, form, formIndex, ability: a, slot });
      }
    });
  }
  return rows;
}
