/**
 * Regenerates data/lanes.json and data/charges.json. Dev-only; run after each
 * patch (the files carry verifiedPatch and go stale like overrides.json).
 *
 *   node tools/sync-lanes-charges.mjs
 *
 * Why a script and not a runtime fetch: Meraki's CDN sends no CORS header, so
 * the site cannot load it from a browser, and the full file is 13 MB. The LoL
 * Wiki is not something the app should hit on every visit either. So this
 * pulls both here, cross-checks them, and writes two small committed files.
 *
 * Sources (all matched by numeric champion id, which all three share):
 *   Data Dragon  - which abilities are flagged maxammo, ranks, ability names
 *   Meraki       - cdn.merakianalytics.com, positions + ability rechargeRate
 *   LoL Wiki     - Module:ChampionData/data (positions) and
 *                  Template:Data_<Champion>/<Ability> (recharge, charges)
 *
 * Rule: Meraki is the first source, but its last update predates 16.19, so
 * every value is checked against the wiki (updated for V26.19); where they
 * disagree, or Meraki has nothing, the wiki wins. Everything the script could
 * not confirm is listed at the end and recorded in the output.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortPatch } from '../js/patch.js';
import {
  UA, fetchPages, loadChampionModule, listOf, parseRankValue, templateFields, findMaxCharges,
} from './lib/wiki.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DD = 'https://ddragon.leagueoflegends.com';
const MERAKI = 'https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/champions.json';
const SLOTS = ['Q', 'W', 'E', 'R'];

async function get(url, as = 'json') {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return as === 'json' ? res.json() : res.text();
}

/* ------------------------------------------------------------------ run */

const versions = await get(`${DD}/api/versions.json`);
const patch = versions[0];
console.log(`Data Dragon ${patch}`);
const dd = (await get(`${DD}/cdn/${patch}/data/en_US/championFull.json`)).data;
const ddByKey = Object.fromEntries(Object.values(dd).map((c) => [Number(c.key), c]));

console.log('Meraki champions.json (13 MB)...');
const meraki = await get(MERAKI);
const merakiByKey = Object.fromEntries(Object.values(meraki).map((c) => [Number(c.id), c]));

console.log('Wiki Module:ChampionData/data...');
const wikiData = await loadChampionModule();
const wikiByKey = {};
for (const [name, c] of Object.entries(wikiData)) if (c && c.id) wikiByKey[Number(c.id)] = { name, ...c };

/* ---------------------------------------------------------------- lanes */

const LANE = {
  Top: 'top', Jungle: 'jungle', Middle: 'mid', Mid: 'mid', Bottom: 'bot', Bot: 'bot', Support: 'support',
  TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', BOTTOM: 'bot', UTILITY: 'support', SUPPORT: 'support',
};
const ORDER = ['top', 'jungle', 'mid', 'bot', 'support'];
const norm = (list) => [...new Set((list || []).map((p) => LANE[p]).filter(Boolean))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

const lanes = {};
const laneNotes = {};
const laneUnverified = [];
for (const c of Object.values(dd)) {
  const key = Number(c.key);
  const m = norm(merakiByKey[key]?.positions);
  const w = wikiByKey[key];
  const wClient = norm(listOf(w?.client_positions));
  const wExternal = norm(listOf(w?.external_positions));
  const wiki = norm([...listOf(w?.client_positions), ...listOf(w?.external_positions)]);
  let chosen;
  let src;
  if (wiki.length) {
    chosen = wiki;
    src = m.length && m.join() === wiki.join() ? 'meraki+wiki' : m.length ? 'wiki (meraki differs)' : 'wiki (not in meraki)';
  } else if (m.length) {
    chosen = m;
    src = 'meraki only (unverified)';
    laneUnverified.push(c.id);
  } else {
    chosen = [];
    src = 'none';
    laneUnverified.push(c.id);
  }
  lanes[c.id] = chosen;
  if (src !== 'meraki+wiki') laneNotes[c.id] = { src, meraki: m, wikiClient: wClient, wikiExternal: wExternal };
}

/* -------------------------------------------------------------- charges */

// Every ability Data Dragon flags with maxammo, plus anything Meraki knows
// has a recharge rate that Data Dragon doesn't flag.
const candidates = new Map();
for (const c of Object.values(dd)) {
  c.spells.forEach((s, i) => {
    if (s.maxammo && s.maxammo !== '-1' && s.maxammo !== '0') candidates.set(`${c.id}:${SLOTS[i]}`, 'ddragon maxammo');
  });
  const m = merakiByKey[Number(c.key)];
  for (const slot of SLOTS) {
    for (const a of m?.abilities?.[slot] || []) {
      if (Array.isArray(a.rechargeRate) && a.rechargeRate.some((x) => x > 0) && !candidates.has(`${c.id}:${slot}`)) {
        candidates.set(`${c.id}:${slot}`, 'meraki rechargeRate only');
      }
    }
  }
}

const charges = {};
const notCharges = {};
const chargeProblems = [];

// One batched API pass for every candidate's ability page (50 per request).
const titleOf = (id) => {
  const [champId, slot] = id.split(':');
  const w = wikiByKey[Number(dd[champId].key)];
  const ability = listOf(w?.[`skill_${slot.toLowerCase()}`])[0];
  return w && ability ? { title: `Template:Data ${w.name}/${ability}`, ability } : null;
};
const titles = [...candidates.keys()].map(titleOf).filter(Boolean).map((t) => t.title);
console.log(`Checking ${candidates.size} charge candidates against the wiki (${Math.ceil(titles.length / 50)} batched request(s))...`);
const pages = await fetchPages(titles);

for (const [id, why] of candidates) {
  const [champId, slot] = id.split(':');
  const c = dd[champId];
  const i = SLOTS.indexOf(slot);
  const spell = c.spells[i];
  const n = spell.maxrank;
  const m = merakiByKey[Number(c.key)]?.abilities?.[slot]?.[0];
  const mRecharge = Array.isArray(m?.rechargeRate) && m.rechargeRate.some((x) => x > 0) ? m.rechargeRate : null;
  const t = titleOf(id);
  const wikiAbility = t?.ability;
  const wikiText = (t && pages.get(t.title)) || '';
  const f = templateFields(wikiText);
  // A recharge wrapped in a tooltip that names a condition ("...with the
  // Transcendent bonus") only applies sometimes: not a charge ability by default.
  const recNote = /^\{\{tt\|.+\|(.+)\}\}$/.exec(f.recharge || '')?.[1] || '';
  if (/\b(with|when|while|during|after|bonus|empowered|upgraded?)\b/i.test(recNote)) {
    notCharges[id] = { name: wikiAbility, why, conditional: recNote, wikiCooldown: parseRankValue(f.cooldown, spell.maxrank), ddragonCooldown: spell.cooldown, cooldownWrong: false };
    continue;
  }
  const wRecharge = parseRankValue(f.recharge, n);
  const wBetween = parseRankValue(f.static, n) || parseRankValue(f.cooldown, n);
  const wCooldown = parseRankValue(f.cooldown, n);
  const wMax = findMaxCharges(wikiText, n);
  const ddMax = Number(spell.maxammo) > 0 ? Array(n).fill(Number(spell.maxammo)) : null;
  const same = (a, b) => a && b && a.length === b.length && a.every((x, k) => Math.abs(x - b[k]) < 0.011);

  if (!wikiText) {
    chargeProblems.push({ id, why, problem: `wiki template not found (${wikiAbility || 'no skill name'})`, meraki: mRecharge });
    continue;
  }
  if (!f.recharge) {
    // No recharge on the wiki: Data Dragon's ammo flag is not a real charge system.
    notCharges[id] = {
      name: wikiAbility,
      why,
      wikiCooldown: wCooldown,
      ddragonCooldown: spell.cooldown,
      cooldownWrong: Boolean(wCooldown && !same(wCooldown, spell.cooldown)),
      unparsedCooldown: !wCooldown && f.cooldown ? f.cooldown : undefined,
    };
    continue;
  }
  if (!wRecharge) {
    chargeProblems.push({ id, why, problem: `wiki recharge not parseable: ${f.recharge}`, meraki: mRecharge });
    continue;
  }
  const status = mRecharge ? (same(mRecharge, wRecharge) ? 'meraki+wiki' : 'wiki (meraki differs)') : 'wiki (not in meraki)';
  charges[id] = {
    name: wikiAbility,
    recharge: wRecharge,
    between: wBetween || spell.cooldown,
    // The wiki's |static field: a between-casts delay ability haste doesn't shorten.
    betweenStatic: Boolean(parseRankValue(f.static, n)),
    max: wMax?.values || ddMax,
    maxSource: wMax ? 'wiki' : 'ddragon maxammo',
    source: status,
    ...(status === 'wiki (meraki differs)' ? { meraki: mRecharge } : {}),
  };
}

/* --------------------------------------------------------------- write */

const verifiedPatch = shortPatch(patch);
const today = new Date().toISOString().slice(0, 10);
const write = (file, obj) => {
  let out = JSON.stringify(obj, null, 2);
  out = out.replace(/\[\s*(-?[\d.]+(?:,\s*-?[\d.]+)*)\s*\]/g, (_, inner) => `[${inner.split(',').map((s) => s.trim()).join(', ')}]`);
  out = out.replace(/\[\s*("[^"\n]*"(?:,\s*"[^"\n]*")*)\s*\]/g, (_, inner) => `[${inner.split(/,\s*/).join(', ')}]`);
  fs.writeFileSync(path.join(ROOT, file), `${out}\n`);
};

write('data/lanes.json', {
  schema: 1,
  verifiedPatch,
  generated: today,
  readme: 'Generated by tools/sync-lanes-charges.mjs - do not hand-edit; put corrections in overrides.json ("lanes": [...] on a champion). Lanes = the wiki\'s client_positions + external_positions (Module:ChampionData/data, updated for V26.19), cross-checked with Meraki positions. Meraki\'s data predates 16.19, so where they differ the wiki wins; differences are listed in notes.',
  lanes,
  notes: laneNotes,
});

write('data/charges.json', {
  schema: 1,
  verifiedPatch,
  generated: today,
  readme: 'Generated by tools/sync-lanes-charges.mjs - do not hand-edit; put corrections in overrides.json (ammo on an ability). charges: abilities with a real charge system - recharge per charge (affected by ability haste), between-casts delay, max charges per rank; values from the LoL Wiki ability data, cross-checked with Meraki rechargeRate. notCharges: abilities Data Dragon flags maxammo but the wiki shows no recharge - they are ordinary cooldowns; wikiCooldown corrects Data Dragon where it is wrong. unverified: what could not be confirmed.',
  charges,
  notCharges,
  unverified: chargeProblems,
});

/* ------------------------------------------------------------- report */

console.log(`\nLanes: ${Object.keys(lanes).length} champions; ${Object.keys(laneNotes).length} differ from Meraki or are missing there.`);
const laneCounts = Object.fromEntries(ORDER.map((l) => [l, Object.values(lanes).filter((x) => x.includes(l)).length]));
console.log('  per lane:', laneCounts);
if (laneUnverified.length) console.log('  UNVERIFIED lanes:', laneUnverified.join(', '));
console.log(`\nCharges: ${Object.keys(charges).length} real charge abilities, ${Object.keys(notCharges).length} flagged but not charges, ${chargeProblems.length} unverified.`);
for (const [id, v] of Object.entries(charges)) console.log(`  ${id.padEnd(16)} ${v.name.padEnd(24)} max ${JSON.stringify(v.max)} recharge ${JSON.stringify(v.recharge)} between ${JSON.stringify(v.between)}  [${v.source}; max from ${v.maxSource}]`);
console.log('  -- flagged by Data Dragon but NOT charge abilities:');
for (const [id, v] of Object.entries(notCharges)) console.log(`  ${id.padEnd(16)} ${String(v.name).padEnd(24)} wiki cd ${JSON.stringify(v.wikiCooldown)} vs DD ${JSON.stringify(v.ddragonCooldown)}${v.cooldownWrong ? '  <- DATA DRAGON WRONG' : ''}${v.unparsedCooldown ? `  (unparsed: ${v.unparsedCooldown})` : ''}`);
if (chargeProblems.length) {
  console.log('  -- UNVERIFIED:');
  for (const p of chargeProblems) console.log(`  ${p.id.padEnd(16)} ${p.problem}${p.meraki ? `  (meraki says ${JSON.stringify(p.meraki)})` : ''}`);
}
