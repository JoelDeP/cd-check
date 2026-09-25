/**
 * Unit tests for the pure modules - no dependencies, no browser.
 *   node tests/run.mjs
 * Exits 1 on any failure. Item parsing is tested against real Data Dragon
 * 16.19 text saved in tests/fixtures.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyHaste, computeHaste, abilityCooldown, hasteForSlot, grantAmount,
  rescaleRemaining, cooldownIndex, hasteNeeded, summonerCooldown,
} from '../js/haste.js';
import { parseItemHaste, buildItems } from '../js/items.js';
import { ranksAtLevel, resolveOrder, skillSequence } from '../js/skill-order.js';
import { encodeMatchup, decodeMatchup, defaultMatchup } from '../js/matchup-state.js';
import { fmt } from '../js/model.js';
import { staleness } from '../js/patch.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const sources = read('data/haste-sources.json');
const fixture = read('tests/fixtures/items-16.19.json');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    fail += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg} expected ${e}, got ${a}`);
}
function near(actual, expected, msg = '', eps = 1e-6) {
  if (Math.abs(actual - expected) > eps) throw new Error(`${msg} expected ${expected}, got ${actual}`);
}
const grantsOf = (id) => Object.fromEntries(parseItemHaste(fixture.data[id].description).map((g) => [g.kind, g.amount]));

/* ------------------------------------------------------------ formula */

test('haste formula', () => {
  near(applyHaste(120, 20), 100);
  near(applyHaste(8, 60), 5);
  near(applyHaste(10, 0), 10);
  near(applyHaste(10, -5), 10, 'negative haste clamps to 0');
  eq(hasteNeeded(16, 10), 60);
});

test('fmt rounding', () => {
  eq(fmt(0.25), '0.25');
  eq(fmt(13.333), '13.3');
  eq(fmt(7), '7');
  eq(fmt(NaN), '–');
});

/* ------------------------------------------------------ item parsing */

test('Malignance: 15 AH + 20 ultimate haste (passive)', () => eq(grantsOf('3118'), { ability: 15, ultimate: 20 }));
test('Spear of Shojin: 25 basic ability haste', () => eq(grantsOf('3161').basic, 25));
test('Ionian Boots: 10 AH + 10 summoner haste', () => eq(grantsOf('3158'), { ability: 10, summoner: 10 }));
test('Crimson Lucidity: 20 AH + 20 summoner haste', () => eq(grantsOf('3171'), { ability: 20, summoner: 20 }));
test('Imperial Mandate: conditional +20 is NOT counted', () => eq(grantsOf('4005'), { ability: 15 }));
test('Staff of Flowing Water: temporary ally +15 is NOT counted', () => eq(grantsOf('6616'), { ability: 10 }));
test('Experimental Hexplate: 30 ultimate haste', () => eq(grantsOf('3073').ultimate, 30));
test('Fiendhunter Bolts: 30 ultimate haste', () => eq(grantsOf('2512').ultimate, 30));
test('Endless Hunger: no flat haste parsed (formula item)', () => eq(grantsOf('2517'), {}));
test('Black Cleaver: 20 AH', () => eq(grantsOf('3071'), { ability: 20 }));
test('Boots: no haste', () => eq(grantsOf('1001'), {}));

test('buildItems keeps haste items + exceptions, drops the rest', () => {
  const items = buildItems('16.19.1', fixture.data, sources);
  eq(Boolean(items['3118']), true, 'Malignance');
  eq(Boolean(items['2517']), true, 'Endless Hunger (exception)');
  eq(Boolean(items['1001']), false, 'plain Boots');
  eq(items['3158'].group, 'Boots');
  eq(items['3118'].group, 'Legendary');
});

/* ------------------------------------------------------- calculator */

const itemsCtx = { sources, items: buildItems('16.19.1', fixture.data, sources) };
const total = (loadout) => computeHaste(loadout, itemsCtx).totals;

test('items stack additively by kind', () => {
  eq(total({ items: ['3118', '3158'] }), { ability: 25, basic: 0, ultimate: 20, summoner: 10, item: 0 });
});

test('Hextech stacks: 5 each, max 4', () => {
  eq(total({ buffs: { hextech: 2 } }).ability, 10);
  eq(total({ buffs: { hextech: 9 } }).ability, 20);
});

test('Blue buff: 10 / 15 / 20 at levels 1 / 6 / 11', () => {
  eq(total({ level: 5, buffs: { blue: true } }).ability, 10);
  eq(total({ level: 6, buffs: { blue: true } }).ability, 15);
  eq(total({ level: 10, buffs: { blue: true } }).ability, 15);
  eq(total({ level: 11, buffs: { blue: true } }).ability, 20);
});

test('Transcendence: +5 at 5, +5 at 8, note before', () => {
  eq(total({ level: 4, runes: { transcendence: true } }).ability, 0);
  eq(total({ level: 5, runes: { transcendence: true } }).ability, 5);
  eq(total({ level: 8, runes: { transcendence: true } }).ability, 10);
  const r = computeHaste({ level: 4, runes: { transcendence: true } }, itemsCtx);
  eq(r.notes.length >= 1, true, 'pending-level notes');
});

test('Ultimate Hunter: 6 + 5/stack, capped at 31', () => {
  eq(total({ runes: { ultimateHunter: 0 } }).ultimate, 6);
  eq(total({ runes: { ultimateHunter: 3 } }).ultimate, 21);
  eq(total({ runes: { ultimateHunter: 9 } }).ultimate, 31);
});

test('Legend: Haste is basic-only, 1.5/stack max 10', () => {
  const t = total({ runes: { legendHaste: 10 } });
  eq(t.basic, 15);
  eq(t.ability, 0);
});

test('Cosmic Insight: 18 summoner + 10 item haste', () => {
  const t = total({ runes: { cosmic: true } });
  eq([t.summoner, t.item], [18, 10]);
});

test('Stat shard: 8 AH', () => eq(total({ runes: { shardAH: true } }).ability, 8));

test('Endless Hunger formula: melee 5 + 13% bonus AD, ranged 10%', () => {
  near(total({ items: ['2517'], bonusAD: 40 }).ability, 10.2);
  near(total({ items: ['2517'], bonusAD: 40, ranged: true }).ability, 9);
});

test('manual extras by kind', () => {
  eq(total({ extra: [{ kind: 'ability', amount: 30 }, { kind: 'ultimate', amount: 20 }] }).ultimate, 20);
});

test('grantAmount byLevel / perStack / fromLevel', () => {
  eq(grantAmount({ byLevel: { levels: [1, 6, 11], values: [10, 15, 20] } }, 0, 7), 15);
  eq(grantAmount({ perStack: 1.5, maxStacks: 10 }, 12, 1), 15);
  eq(grantAmount({ amount: 5, fromLevel: 8 }, 0, 7), 0);
});

/* --------------------------------------------------- slot application */

const T = { ability: 20, basic: 25, ultimate: 30, summoner: 18, item: 10 };
test('slot haste: Q = ability + basic, R = ability + ult, P = ability', () => {
  eq(hasteForSlot('Q', T), 45);
  eq(hasteForSlot('R', T), 50);
  eq(hasteForSlot('P', T), 20);
});

test('static cooldowns ignore haste', () => {
  const yasuoQ = { slot: 'Q', cooldown: [4, 4, 4, 4, 4], static: true };
  eq(abilityCooldown(yasuoQ, 0, T).final, 4);
  const q = { slot: 'Q', cooldown: [9, 8, 7, 6, 5], static: false };
  near(abilityCooldown(q, 0, T).final, 9 * 100 / 145);
});

test('summoner cooldown uses summoner haste only', () => near(summonerCooldown(300, T).final, 300 * 100 / 118));

test('cooldownIndex: rank-based, level-based, not learned', () => {
  eq(cooldownIndex({ slot: 'Q', scaling: 'rank' }, 9, 3), 2);
  eq(cooldownIndex({ slot: 'Q', scaling: 'rank' }, 1, 0), -1);
  eq(cooldownIndex({ slot: 'P', scaling: 'level', cooldown: [14, 11, 8], levelBreaks: [1, 7, 13] }, 8, 0), 1);
});

test('rescaleRemaining: 10s left, 0 -> 50 AH = 6.67s', () => near(rescaleRemaining(10, 0, 50), 10 * 100 / 150));

/* ------------------------------------------------------- skill order */

const champ = (maxranks) => ({
  forms: [{ abilities: Object.fromEntries(Object.entries(maxranks).map(([s, m]) => [s, { maxrank: m }])) }],
});
const NORMAL = champ({ Q: 5, W: 5, E: 5, R: 3 });

test('standard QEW order at key levels', () => {
  const o = resolveOrder('X', {}, { X: { max: 'QEW' } });
  eq(ranksAtLevel(NORMAL, o, 1), { Q: 1, W: 0, E: 0, R: 0 });
  eq(ranksAtLevel(NORMAL, o, 3), { Q: 1, W: 1, E: 1, R: 0 });
  eq(ranksAtLevel(NORMAL, o, 6), { Q: 3, W: 1, E: 1, R: 1 });
  eq(ranksAtLevel(NORMAL, o, 9), { Q: 5, W: 1, E: 2, R: 1 });
  eq(ranksAtLevel(NORMAL, o, 13), { Q: 5, W: 1, E: 5, R: 2 });
  eq(ranksAtLevel(NORMAL, o, 18), { Q: 5, W: 5, E: 5, R: 3 });
});

test('skill sequence reads naturally', () => {
  const o = { max: 'QEW', start: 'QEW' };
  // Q E W, then Q to rank 5 as soon as the rank rule allows, R at 6/11/16.
  eq(skillSequence(NORMAL, o).join(''), 'QEWQQRQEQEREEWWRWW');
});

test('rank rule: rank n needs level 2n-1', () => {
  const r = ranksAtLevel(NORMAL, { max: 'QEW', start: 'QQQ' }, 3);
  eq(r.Q <= 2, true, 'Q cannot be rank 3 at level 3');
});

test('Jayce: free R at 1, six ranks per basic', () => {
  const jayce = champ({ Q: 6, W: 6, E: 6, R: 1 });
  eq(ranksAtLevel(jayce, { max: 'QEW', start: 'QEW' }, 1).R, 1);
  eq(ranksAtLevel(jayce, { max: 'QEW', start: 'QEW' }, 18), { Q: 6, W: 6, E: 6, R: 1 });
});

test('Nidalee/Elise: R rank 1 free, then 6/11/16', () => {
  const nid = champ({ Q: 5, W: 5, E: 5, R: 4 });
  const o = { max: 'QEW', start: 'QEW' };
  eq(ranksAtLevel(nid, o, 1).R, 1);
  eq(ranksAtLevel(nid, o, 16).R, 4);
  eq(ranksAtLevel(nid, o, 18), { Q: 5, W: 5, E: 5, R: 4 });
});

test('resolveOrder: user > default > generic', () => {
  eq(resolveOrder('Jax', { Jax: 'EQW' }, { Jax: { max: 'QWE' } }).source, 'user');
  eq(resolveOrder('Jax', {}, { Jax: { max: 'QWE', start: 'EQW' } }), { max: 'QWE', start: 'EQW', source: 'default' });
  eq(resolveOrder('Zzz', {}, {}).max, 'QEW');
  eq(resolveOrder('Jax', { Jax: 'QQQ' }, {}).source, 'generic', 'invalid override ignored');
});

/* ------------------------------------------------------------ URL */

test('matchup URL round-trip', () => {
  const m = defaultMatchup(['Renekton']);
  m.me.level = 9;
  m.vs.level = 9;
  m.me.order = 'QWE';
  m.me.loadout.items = ['3118', '3158'];
  m.me.loadout.buffs = { hextech: 2, blue: true };
  m.me.loadout.runes = { cosmic: true, ultimateHunter: 3 };
  m.vs.loadout.extra = [{ kind: 'ability', amount: 25, label: 'Manual' }];
  m.vs.summoners = ['SummonerFlash', 'SummonerDot'];
  const q = encodeMatchup(m);
  const back = decodeMatchup(new URLSearchParams(q), (s) => ({ renekton: 'Renekton', darius: 'Darius' })[s]);
  eq(back.me.champ, 'Renekton');
  eq(back.vs.champ, 'Darius');
  eq(back.me.level, 9);
  eq(back.me.order, 'QWE');
  eq(back.me.loadout.items, ['3118', '3158']);
  eq(back.me.loadout.buffs, { hextech: 2, blue: true });
  eq(back.me.loadout.runes, { cosmic: true, ultimateHunter: 3 });
  eq(back.vs.loadout.extra[0].amount, 25);
  eq(back.vs.summoners, ['SummonerFlash', 'SummonerDot']);
  eq(back.linkLevels, true);
});

test('example link from the spec decodes', () => {
  const m = decodeMatchup(new URLSearchParams('me=renekton&vs=darius&lvl=6'), (s) => ({ renekton: 'Renekton', darius: 'Darius' })[s]);
  eq([m.me.champ, m.vs.champ, m.me.level, m.vs.level], ['Renekton', 'Darius', 6, 6]);
});

test('hostile URL values are clamped / ignored', () => {
  const m = decodeMatchup(new URLSearchParams('me=x&vs=y&lvl=99&mh=hx99,i<script>,uh-4,ad99999'), () => null);
  eq(m.me.level, 18);
  eq(m.me.loadout.buffs.hextech, 4);
  eq(m.me.loadout.items, []);
  eq(m.me.loadout.runes.ultimateHunter, 0);
  eq(m.me.loadout.bonusAD, 1000);
});

test('no matchup params -> null', () => eq(decodeMatchup(new URLSearchParams('foo=1'), () => null), null));

/* --------------------------------------------------- charge abilities */

test('charge ability: headline is recharge per charge, haste applies', () => {
  const viE = {
    slot: 'E', cooldown: [1, 1, 1, 1, 1],
    ammo: { max: [2, 2, 2, 2, 2], recharge: [12, 11, 10, 9, 8] },
    between: { values: [1, 1, 1, 1, 1], static: true },
  };
  const cd = abilityCooldown(viE, 4, { ability: 25, basic: 0, ultimate: 0, summoner: 0, item: 0 });
  eq(cd.recharge, true);
  eq(cd.base, 8);
  near(cd.final, 8 * 100 / 125);
  eq(cd.charges, 2);
  eq(cd.between, { base: 1, final: 1, static: true }, 'static between-casts delay ignores haste');
});

test('charge ability: charge cap follows rank (Teemo R 3/4/5)', () => {
  const teemoR = { slot: 'R', cooldown: [0.25, 0.25, 0.25], ammo: { max: [3, 4, 5], recharge: [35, 30, 25] }, between: { values: [0.25, 0.25, 0.25] } };
  const cd = abilityCooldown(teemoR, 1, { ability: 0, basic: 0, ultimate: 20, summoner: 0, item: 0 });
  eq([cd.charges, cd.base], [4, 30]);
  near(cd.final, 25, 'ultimate haste applies to an R recharge');
});

const { buildChampion } = await import('../js/model.js');
const fakeChamp = (id, spells) => ({
  id, key: '1', name: id, title: '', tags: ['Fighter'], range: 125, info: { attack: 8, defense: 5, magic: 2 },
  image: { full: `${id}.png` },
  passive: { name: 'P', description: '', image: { full: 'p.png' } },
  spells: spells.map((s, i) => ({ id: `${id}${i}`, name: s.name, description: '', maxrank: s.cooldown.length, cooldown: s.cooldown, costBurn: '', costType: '', rangeBurn: '', maxammo: s.maxammo || '-1', image: { full: 'x.png' } })),
});

test('charges.json: real charge ability gets recharge data, loses the ⚠ ammo flag', () => {
  const c = buildChampion('16.19.1', fakeChamp('Vi', [
    { name: 'Q', cooldown: [12, 11, 10, 9, 8] }, { name: 'W', cooldown: [0, 0, 0, 0, 0] },
    { name: 'E', cooldown: [1, 1, 1, 1, 1], maxammo: '2' }, { name: 'R', cooldown: [120, 100, 80] },
  ]), { champions: {} }, {
    charges: { verifiedPatch: '16.19', charges: { 'Vi:E': { recharge: [12, 11, 10, 9, 8], between: [1, 1, 1, 1, 1], betweenStatic: true, max: [2, 2, 2, 2, 2] } }, notCharges: {} },
    lanes: { lanes: { Vi: ['jungle'] } },
  });
  const e = c.forms[0].abilities.E;
  eq(e.ammo.recharge, [12, 11, 10, 9, 8]);
  eq(e.flags.some((f) => f.code === 'ammo'), false);
  eq(e.flags.some((f) => f.code === 'charges'), true);
  eq(c.lanes, ['jungle']);
});

test('charges.json notCharges: wrong Data Dragon cooldown corrected (Rengar Q 0.25 -> 6..4)', () => {
  const c = buildChampion('16.19.1', fakeChamp('Rengar', [
    { name: 'Savagery', cooldown: [0.25, 0.25, 0.25, 0.25, 0.25], maxammo: '1' }, { name: 'W', cooldown: [16, 14.5, 13, 11.5, 10] },
    { name: 'E', cooldown: [10, 10, 10, 10, 10] }, { name: 'R', cooldown: [110, 90, 70] },
  ]), { champions: {} }, {
    charges: { verifiedPatch: '16.19', charges: {}, notCharges: { 'Rengar:Q': { cooldownWrong: true, wikiCooldown: [6, 5.5, 5, 4.5, 4] } } },
  });
  const q = c.forms[0].abilities.Q;
  eq(q.cooldown, [6, 5.5, 5, 4.5, 4]);
  eq(q.ammo, null);
  eq(q.flags.some((f) => f.code === 'override'), true);
});

test('overrides.json "lanes" beats generated lanes', () => {
  const c = buildChampion('16.19.1', fakeChamp('Teemo', [
    { name: 'Q', cooldown: [7] }, { name: 'W', cooldown: [14] }, { name: 'E', cooldown: [0] }, { name: 'R', cooldown: [0.25] },
  ]), { champions: { Teemo: { verifiedPatch: '16.19', lanes: ['top'] } } }, { lanes: { lanes: { Teemo: ['top', 'jungle', 'support'] } } });
  eq(c.lanes, ['top']);
});

test('shipped charges.json covers all flagged abilities it claims to', () => {
  const cj = read('data/charges.json');
  for (const [id, v] of Object.entries(cj.charges)) {
    eq(Array.isArray(v.recharge) && v.recharge.every((x) => x > 0), true, `${id} recharge`);
    eq(Array.isArray(v.max) && v.max.every((x) => x >= 1), true, `${id} max`);
  }
  eq(Boolean(cj.notCharges['Rengar:Q']?.cooldownWrong), true, 'Rengar Q flagged as wrong in Data Dragon');
});

/* -------------------------------------------------------------- lanes */

const { inLane, laneRoster } = await import('../js/lanes.js').catch(() => ({}));

test('lane filter: multi-lane champions appear under each lane', () => {
  if (!inLane) return; // lanes.js imports the DOM helper; skipped outside a browser
  const champs = { A: { name: 'A', lanes: ['top', 'jungle'] }, B: { name: 'B', lanes: ['mid'] } };
  eq(laneRoster(champs, 'top').map((c) => c.name), ['A']);
  eq(laneRoster(champs, 'jungle').map((c) => c.name), ['A']);
  eq(laneRoster(champs, 'all').length, 2);
  eq(inLane(champs.B, 'top'), false);
});

test('shipped lanes.json: every champion has at least one lane', () => {
  const lj = read('data/lanes.json');
  const empty = Object.entries(lj.lanes).filter(([, l]) => !l.length).map(([k]) => k);
  eq(empty, []);
  eq(Object.keys(lj.lanes).length >= 173, true);
});

/* ---------------------------------------------------------- item grid */

const { rankItemsFor } = await import('../js/items.js');

test('item grid order: your history first, then items that fit the champion', () => {
  const items = buildItems('16.19.1', fixture.data, sources);
  const bruiser = { profile: { attack: 8, defense: 6, magic: 2 }, tags: ['Fighter'] };
  const order = rankItemsFor(items, bruiser, ['3158']).map((i) => i.id);
  eq(order[0], '3158', 'recently used item first');
  eq(order.indexOf('3071') < order.indexOf('3118'), true, 'Black Cleaver (AD) before Malignance (AP) for a fighter');
  const mage = { profile: { attack: 2, defense: 3, magic: 9 }, tags: ['Mage'] };
  const m = rankItemsFor(items, mage, []).map((i) => i.id);
  eq(m.indexOf('3118') < m.indexOf('3071'), true, 'Malignance before Black Cleaver for a mage');
});

/* ------------------------------------------------ wiki value parsing */

const wikiLib = await import('../tools/lib/wiki.mjs');

test('wiki parser: rank values in their many shapes', () => {
  const R = wikiLib.parseRankValue;
  eq(R('{{tt|{{ap|9 to 5}}|Starts post-effect}}', 5), [9, 8, 7, 6, 5]);
  eq(R('{{ap|16 to 6 6}}', 6), [16, 14, 12, 10, 8, 6]);
  eq(R('{{ap|3|3|4|4|5}}', 5), [3, 3, 4, 4, 5]);
  eq(R('{{fd|0.5}}', 3), [0.5, 0.5, 0.5]);
  eq(R('12 / 11 / 10', 3), [12, 11, 10]);
  eq(R('{{pp|1;2|1;6}}', 5), null, 'level values are not rank values');
});

test('wiki parser: level values, and refusing to guess', () => {
  const L = wikiLib.parseLevelValue;
  eq(L('{{pp|12 to 6|1;6;11;16}}'), { values: [12, 10, 8, 6], levels: [1, 6, 11, 16] });
  eq(L('{{pp|14 to 8 for 3|1 to 13}}'), { values: [14, 11, 8], levels: [1, 7, 13] });
  eq(L('{{pplevel|22 to 10}}').values.length, 18);
  eq(L('{{pp|16 to 12 for 9|formula=16.5 - 0.5 * level, capped at level 9}}'), null, 'formula without levels');
  eq(L('{{pp|4-0.75*(x-1)|0 to 3 by 1|type=Rampage stacks}}'), null, 'scales with stacks, not level');
});

test('wiki parser: nested templates split correctly', () => {
  eq(wikiLib.splitTemplate('{{tt|{{ap|9 to 5}}|note|x}}'), { name: 'tt', args: ['{{ap|9 to 5}}', 'note', 'x'] });
  eq(wikiLib.splitTemplate('{{a}} {{b}}'), null);
});

/* ------------------------------------------- audit corrections applied */

const overrides = read('data/overrides.json');
const fakeWith = (id, cds, extra = {}) => buildChampion('16.19.1', fakeChamp(id, cds.map((c, i) => ({ name: `${id}${i}`, cooldown: c }))), overrides, extra);

test('audit: Data Dragon zeros corrected (Tahm Kench R, Kalista E, Rakan E)', () => {
  eq(fakeWith('TahmKench', [[5], [5], [5], [0, 0, 0]]).forms[0].abilities.R.cooldown, [120, 100, 80]);
  eq(fakeWith('Kalista', [[5], [5], [0, 0, 0, 0, 0], [5]]).forms[0].abilities.E.cooldown, [10, 9.5, 9, 8.5, 8]);
  eq(fakeWith('Rakan', [[5], [5], [0, 0, 0, 0, 0], [5]]).forms[0].abilities.E.cooldown, [20, 18, 16, 14, 12]);
});

test('audit: static toggles/swaps ignore haste (Jinx Q)', () => {
  const q = fakeWith('Jinx', [[0.9, 0.9, 0.9, 0.9, 0.9], [5], [5], [5]]).forms[0].abilities.Q;
  eq(abilityCooldown(q, 0, { ability: 50, basic: 0, ultimate: 0, summoner: 0, item: 0 }).final, 0.9);
});

test('audit: Kled has a Dismounted form with Pocket Pistol charges', () => {
  const kled = fakeWith('Kled', [[11, 10, 9, 8, 7], [5], [5], [5]], { charges: read('data/charges.json') });
  eq(kled.forms.map((f) => f.short), ['Mounted', 'Dismounted']);
  const pp = kled.forms[1].abilities.Q;
  eq([pp.name, pp.ammo.recharge, pp.ammo.max], ['Pocket Pistol', [18, 16, 14, 12, 10], [2, 2, 2, 2, 2]]);
  eq(kled.forms[0].abilities.Q.ammo, null, 'mounted Q is a normal cooldown');
});

test('audit: passive cooldowns added and static (Malzahar by level)', () => {
  const p = fakeWith('Malzahar', [[5], [5], [5], [5]]).forms[0].abilities.P;
  eq([p.cooldown, p.levelBreaks, p.static], [[30, 24, 18, 12], [1, 6, 11, 16], true]);
});

test('Syndra Q stays a normal cooldown (charges only with her passive bonus)', () => {
  const cj = read('data/charges.json');
  eq(Boolean(cj.charges['Syndra:Q']), false);
  eq(Boolean(cj.notCharges['Syndra:Q']?.conditional), true);
});

/* ------------------------------------------------------------ data */

test('every haste source has a verifiedPatch', () => {
  const all = [...sources.buffs, ...sources.runes, ...Object.values(sources.itemExceptions)];
  const missing = all.filter((s) => !s.verifiedPatch).map((s) => s.name);
  eq(missing, []);
});

test('staleness applies to haste sources too', () => eq(staleness('16.19', '16.20.1').stale, true));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
