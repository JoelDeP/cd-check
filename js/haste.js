/**
 * The haste calculator. Every cooldown the app shows goes through here.
 *
 *   final = base x 100 / (100 + haste)
 *
 * Haste comes in five kinds, which apply to different things:
 *
 *   ability   - every ability (Q/W/E/R; passives only if not static)
 *   basic     - Q/W/E only        (Spear of Shojin, Legend: Haste)
 *   ultimate  - R only            (Malignance, Ultimate Hunter)
 *   summoner  - summoner spells   (Ionian Boots, Cosmic Insight)
 *   item      - item actives      (Cosmic Insight; tracked, not displayed)
 *
 * Kinds stack additively with each other where they overlap:
 * an R uses ability + ultimate, a Q uses ability + basic.
 *
 * Inputs are a *loadout* - everything that grants haste to one champion - and
 * a context holding the data it is interpreted with:
 *   ctx.sources  data/haste-sources.json (buffs, runes, item exceptions)
 *   ctx.items    js/items.js output: parsed Data Dragon items with grants
 *
 * The loadout is plain JSON so it can be saved, put in a URL, and later be
 * filled field-by-field from the Live Client API (Phase 3). Everything here is
 * pure: same inputs, same answer, cheap enough to rerun every frame.
 */

export const KINDS = ['ability', 'basic', 'ultimate', 'summoner', 'item'];
export const QUICK_HASTE = [0, 10, 20, 30, 45, 60];
export const MAX_HASTE = 150;

export function applyHaste(base, haste) {
  if (!Number.isFinite(base)) return NaN;
  return (base * 100) / (100 + Math.max(0, haste));
}

/**
 * Everything that can grant one champion haste.
 *   items   Data Dragon item ids
 *   buffs   { hextech: stacks, blue: bool, cinders: stacks }
 *   runes   { [runeSourceId]: true | stacks }   absent / false = not taken
 *   extra   manual additions: [{ kind, amount, label }]
 *   bonusAD, ranged   inputs for formula items (Endless Hunger)
 *   live    Phase 3: { 'items': true, 'level': true, ... } for fields the
 *           Live Client API filled, so the UI can label the rest "manual".
 */
export function emptyLoadout() {
  return {
    level: 1,
    items: [],
    buffs: {},
    runes: {},
    extra: [],
    bonusAD: 0,
    ranged: false,
    live: {},
  };
}

/** Value of one grant for a given stack count and champion level. */
export function grantAmount(g, stacks, level) {
  if (g.byLevel) {
    let v = 0;
    g.byLevel.levels.forEach((lv, i) => {
      if (level >= lv) v = g.byLevel.values[i];
    });
    return v;
  }
  if (g.perStack !== undefined) {
    const n = Math.max(0, Math.min(Number(stacks) || 0, g.maxStacks ?? Infinity));
    return n * g.perStack;
  }
  if (g.fromLevel && level < g.fromLevel) return 0;
  return g.amount || 0;
}

/**
 * Total haste for a loadout, with a line per contributing source.
 * @returns {{
 *   totals: Record<string, number>,
 *   lines: Array<{kind, amount, label, group, hint?}>,
 *   notes: Array<{label, note}>,
 * }}
 */
export function computeHaste(loadout, ctx) {
  const L = { ...emptyLoadout(), ...(loadout || {}) };
  const level = L.level || 1;
  const sources = ctx?.sources || { buffs: [], runes: [], itemExceptions: {} };
  const items = ctx?.items || {};

  const totals = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const lines = [];
  const notes = [];
  const add = (kind, amount, label, group, hint) => {
    if (!amount) return;
    totals[kind] += amount;
    lines.push({ kind, amount, label, group, hint });
  };

  // Items: stat/passive haste parsed from Data Dragon, plus formula exceptions.
  for (const id of L.items || []) {
    const item = items[id];
    const exc = sources.itemExceptions?.[id];
    const name = item?.name || exc?.name || `Item ${id}`;
    for (const g of item?.grants || []) add(g.kind, g.amount, name, 'item');
    if (exc?.formula) {
      const f = exc.formula;
      const pct = L.ranged ? f.perBonusAD.ranged : f.perBonusAD.melee;
      const amt = f.base + pct * (Number(L.bonusAD) || 0);
      add(f.kind, Math.round(amt * 10) / 10, name, 'item', `${f.base} + ${Math.round(pct * 100)}% of ${L.bonusAD || 0} bonus AD`);
    }
    if (exc?.note) notes.push({ label: name, note: exc.note });
  }

  // Buffs (dragons, blue buff, cinders).
  for (const buff of sources.buffs || []) {
    const state = L.buffs?.[buff.id];
    if (!state) continue;
    for (const g of buff.grants) {
      const stacks = state === true ? 1 : state;
      const amt = grantAmount(g, stacks, level);
      const hint = g.perStack !== undefined ? `${stacks} x ${g.perStack}` : g.byLevel ? `level ${level}` : undefined;
      add(g.kind, amt, buff.name, 'buff', hint);
    }
  }

  // Runes and shards.
  for (const rune of sources.runes || []) {
    const state = L.runes?.[rune.id];
    if (state === undefined || state === false || state === null) continue;
    const stacks = state === true ? 0 : Number(state) || 0;
    for (const g of rune.grants) {
      const amt = grantAmount(g, stacks, level);
      if (!amt && g.fromLevel && level < g.fromLevel) {
        notes.push({ label: rune.name, note: `+${g.amount} ${g.kind} haste at level ${g.fromLevel}.` });
        continue;
      }
      const hint = g.perStack !== undefined ? `${stacks} x ${g.perStack}` : undefined;
      add(g.kind, amt, rune.name, 'rune', hint);
    }
    if (rune.note && !rune.grants.length) notes.push({ label: rune.name, note: rune.note });
  }

  // Manual extras (the Champion tab's slider, per-side "+ haste" boxes).
  for (const e of L.extra || []) add(e.kind, Number(e.amount) || 0, e.label || 'Manual', 'manual');

  return { totals, lines, notes };
}

/** Which haste a slot receives. Passives only take ability haste. */
export function hasteForSlot(slot, totals) {
  if (slot === 'R') return totals.ability + totals.ultimate;
  if (slot === 'P') return totals.ability;
  return totals.ability + totals.basic;
}

/** One ability's cooldown at a cooldown-array index, after haste. */
export function abilityCooldown(ability, index, totals) {
  const base = ability.cooldown[Math.max(0, Math.min(index, ability.cooldown.length - 1))];
  if (base === undefined) return { base: NaN, final: NaN, haste: 0, static: ability.static };
  if (ability.static) return { base, final: base, haste: 0, static: true };
  const haste = hasteForSlot(ability.slot, totals);
  return { base, final: applyHaste(base, haste), haste, static: false };
}

export function summonerCooldown(base, totals) {
  return { base, final: applyHaste(base, totals.summoner), haste: totals.summoner };
}

/**
 * Index into a level-scaled cooldown array (Camille P: [14,11,8] at levels
 * 1 / 7 / 13; linear 18-entry arrays from levelRange).
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
 * Cooldown-array index for an ability given champion level and its rank.
 * Returns -1 when the ability is not learned yet.
 */
export function cooldownIndex(ability, level, rank) {
  if (ability.scaling === 'level') return levelIndex(ability, level);
  if (ability.scaling === 'flat' || ability.slot === 'P') return 0;
  if (!rank) return -1;
  return rank - 1;
}

/**
 * Haste needed to bring `base` down to `target` seconds - e.g. "what do I
 * need for a 4s Q?".
 */
export function hasteNeeded(base, target) {
  if (!target || target <= 0 || target >= base) return 0;
  return Math.ceil((100 * (base - target)) / target);
}

/**
 * Phase 3 timers: a countdown started at one haste value, rescaled when the
 * champion's haste changes mid-countdown (they finish an item, hit level 6
 * with blue buff). Cooldowns tick at a rate proportional to (100 + haste), so
 * the remaining time scales by the ratio of the two.
 */
export function rescaleRemaining(remaining, oldHaste, newHaste) {
  return (remaining * (100 + Math.max(0, oldHaste))) / (100 + Math.max(0, newHaste));
}
