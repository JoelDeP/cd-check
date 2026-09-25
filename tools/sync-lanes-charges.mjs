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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DD = 'https://ddragon.leagueoflegends.com';
const MERAKI = 'https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/champions.json';
const WIKI = 'https://wiki.leagueoflegends.com/en-us';
const UA = { 'User-Agent': 'cd-check-dev-sync (github.com/JoelDeP/cd-check)' };
const SLOTS = ['Q', 'W', 'E', 'R'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, as = 'json') {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return as === 'json' ? res.json() : res.text();
}

/* ------------------------------------------------------------ Lua tables */

/** Minimal parser for the wiki's Lua data modules: tables, strings, numbers, booleans. */
function parseLua(src) {
  let i = src.indexOf('return');
  i = src.indexOf('{', i);
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i += 1;
      if (src.startsWith('--', i)) { while (i < src.length && src[i] !== '\n') i += 1; continue; }
      break;
    }
  };
  const str = () => {
    const q = src[i]; i += 1;
    let out = '';
    while (src[i] !== q) {
      if (src[i] === '\\') { out += src[i + 1]; i += 2; } else { out += src[i]; i += 1; }
    }
    i += 1;
    return out;
  };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '{') return table();
    if (c === '"' || c === "'") return str();
    const kw = /^(true|false|nil)\b/.exec(src.slice(i, i + 6));
    if (kw) {
      i += kw[0].length;
      return kw[0] === 'true' ? true : kw[0] === 'false' ? false : null;
    }
    // Numbers, including stat arithmetic such as 1000+1000/17.
    const m = /^-?[\d.(][\d.+\-*/() eE]*/.exec(src.slice(i, i + 80));
    if (!m) throw new Error(`lua parse error at ${i}: ${src.slice(i, i + 30)}`);
    const expr = m[0].trim();
    i += m[0].length;
    if (!/^[\d.+\-*/() eE]+$/.test(expr)) throw new Error(`unsafe expression ${expr}`);
    return Number(Function(`"use strict"; return (${expr});`)());
  };
  const table = () => {
    i += 1; // {
    const obj = {};
    const arr = [];
    let keyed = false;
    for (;;) {
      ws();
      if (src[i] === '}') { i += 1; break; }
      if (src[i] === '[') {
        i += 1; ws();
        const k = src[i] === '"' || src[i] === "'" ? str() : value();
        ws(); i += 1; ws(); i += 1; // ] =
        obj[k] = value();
        keyed = true;
      } else if (/[A-Za-z_]/.test(src[i]) && /^[A-Za-z_]\w*\s*=/.test(src.slice(i, i + 60))) {
        const m = /^([A-Za-z_]\w*)\s*=/.exec(src.slice(i, i + 60));
        i += m[0].length;
        obj[m[1]] = value();
        keyed = true;
      } else {
        arr.push(value());
      }
      ws();
      if (src[i] === ',' || src[i] === ';') i += 1;
    }
    if (!keyed) return arr;
    arr.forEach((v, idx) => { obj[idx + 1] = v; });
    return obj;
  };
  return table();
}

/* ------------------------------------------------- wiki value templates */

const round2 = (n) => Math.round(n * 100) / 100;

/** "{{ap|35 to 25}}", "{{ap|3|3|4|4|5}}", "{{fd|0.5}}", "30" -> array of n per-rank values. */
function parseRankValue(raw, n) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const fd = /^\{\{fd\|([\d.]+)\}\}$/.exec(s);
  if (fd) s = fd[1];
  if (/^[\d.]+$/.test(s)) return Array(n).fill(Number(s));
  const ap = /^\{\{ap\|(.+)\}\}$/.exec(s);
  if (!ap) return null; // {{pp|...}} (level-based) and anything else: not parsed
  const inner = ap[1].trim();
  const to = /^([\d.]+)\s+to\s+([\d.]+)(?:\s+for\s+(\d+))?$/.exec(inner);
  if (to) {
    const a = Number(to[1]);
    const b = Number(to[2]);
    const count = to[3] ? Number(to[3]) : n;
    if (count === 1) return [a];
    return Array.from({ length: count }, (_, k) => round2(a + ((b - a) * k) / (count - 1)));
  }
  const parts = inner.split('|').map((p) => p.trim());
  if (parts.every((p) => /^[\d.]+$/.test(p))) {
    const nums = parts.map(Number);
    return nums.length === 1 ? Array(n).fill(nums[0]) : nums;
  }
  return null;
}

function templateFields(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\|(\w+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** "{{st|Maximum Charges|{{ap|3 to 5}}}}" anywhere in the template. */
function findMaxCharges(text, n) {
  const re = /\{\{st\|([^|{}]*(?:[Cc]harge|[Tt]raps|[Ss]tored|[Kk]egs|[Ss]entinels|[Aa]mmo)[^|{}]*)\|(\{\{ap\|[^}]+\}\}|[\d.]+)\}\}/g;
  for (const m of text.matchAll(re)) {
    if (!/max/i.test(m[1])) continue;
    const v = parseRankValue(m[2], n);
    if (v) return { label: m[1], values: v };
  }
  // Prose form: "... periodically stocks a Hawkshot charge, up to a maximum of 2."
  const prose = /up to a maximum of (\d+)(?!\s*(?:seconds|%|stacks? of))/i.exec(text);
  if (prose) return { label: 'prose', values: Array(n).fill(Number(prose[1])) };
  return null;
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
const wikiData = parseLua(await get(`${WIKI}/Module:ChampionData/data?action=raw`, 'text'));
const wikiByKey = {};
for (const [name, c] of Object.entries(wikiData)) if (c && c.id) wikiByKey[Number(c.id)] = { name, ...c };

/* ---------------------------------------------------------------- lanes */

const LANE = {
  Top: 'top', Jungle: 'jungle', Middle: 'mid', Mid: 'mid', Bottom: 'bot', Bot: 'bot', Support: 'support',
  TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', BOTTOM: 'bot', UTILITY: 'support', SUPPORT: 'support',
};
const ORDER = ['top', 'jungle', 'mid', 'bot', 'support'];
const norm = (list) => [...new Set((list || []).map((p) => LANE[p]).filter(Boolean))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
const listOf = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

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
console.log(`Checking ${candidates.size} charge candidates against the wiki (1 req/s)...`);
for (const [id, why] of candidates) {
  const [champId, slot] = id.split(':');
  const c = dd[champId];
  const i = SLOTS.indexOf(slot);
  const spell = c.spells[i];
  const n = spell.maxrank;
  const m = merakiByKey[Number(c.key)]?.abilities?.[slot]?.[0];
  const mRecharge = Array.isArray(m?.rechargeRate) && m.rechargeRate.some((x) => x > 0) ? m.rechargeRate : null;
  const w = wikiByKey[Number(c.key)];
  const wikiAbility = listOf(w?.[`skill_${slot.toLowerCase()}`])[0];

  let wikiText = '';
  if (w && wikiAbility) {
    const url = `${WIKI}/Template:Data_${encodeURIComponent(w.name.replace(/ /g, '_'))}/${encodeURIComponent(wikiAbility.replace(/ /g, '_'))}?action=raw`;
    try { wikiText = await get(url, 'text'); } catch (err) { wikiText = ''; }
    await sleep(1000);
  }
  const f = templateFields(wikiText);
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
