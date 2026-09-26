/**
 * Lists every hand-verified value in data/overrides.json and
 * data/haste-sources.json that the live patch has moved past, so you know
 * exactly what to re-check after a patch.
 *
 *   node tools/stale-overrides.mjs            # compare against the live patch
 *   node tools/stale-overrides.mjs 16.21      # pretend the live patch is 16.21
 *   --json file   also write the stale list as JSON (used by tools/patch-day.mjs)
 *   --quiet       skip the table
 *
 * For each stale entry it prints the value we ship next to what Data Dragon
 * publishes today, which is usually enough to spot what changed. After
 * re-verifying, bump that entry's verifiedPatch.
 *
 * Exit code: 0 when everything is current, 1 when anything is stale, so it
 * can gate CI later if you want.
 *
 * Dev-only; not loaded by the site.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staleness, shortPatch } from '../js/patch.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDN = 'https://ddragon.leagueoflegends.com';
const SLOT_INDEX = { Q: 0, W: 1, E: 2, R: 3 };

const overrides = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/overrides.json'), 'utf8'));

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

// Flags take a value (--json file); the remaining positional arg is a patch to simulate.
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const jsonOut = flag('--json');
const quiet = argv.includes('--quiet');
const argPatch = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--json');
const ddragonPatch = (await getJson(`${CDN}/api/versions.json`))[0];
const livePatch = argPatch || ddragonPatch;

/* ------------------------------------------------------------ collect */

const stale = [];
// What an entry claims: numbers the wiki audit can re-check, or prose it can't.
const assertsOf = (a) => Object.keys(a).filter((k) => !['verifiedPatch', 'from'].includes(k));

function check(where, verifiedPatch, extra = {}) {
  const v = staleness(verifiedPatch, livePatch);
  if (v.stale) stale.push({ where, verified: v.verifiedPatch || '(missing)', ...extra });
}

for (const [id, entry] of Object.entries(overrides.summoners || {})) {
  check({ kind: 'summoner', id }, entry.verifiedPatch, { ours: entry.cooldown || null });
}

for (const [champ, entry] of Object.entries(overrides.champions || {})) {
  const entryPatch = entry.verifiedPatch;
  let touched = false;

  for (const [slot, a] of Object.entries(entry.abilities || {})) {
    touched = true;
    check({ kind: 'ability', champ, slot }, a.verifiedPatch || entryPatch, { ours: a.cooldown || null, note: a.note, asserts: assertsOf(a) });
  }
  for (const form of entry.forms || []) {
    for (const [slot, a] of Object.entries(form.abilities || {})) {
      touched = true;
      check(
        { kind: 'ability', champ, slot, form: form.short || form.name, from: a.from },
        a.verifiedPatch || entryPatch,
        { ours: a.cooldown || null, asserts: assertsOf(a) }
      );
    }
  }
  // An entry with only a note still asserts something about the champion.
  if (!touched) check({ kind: 'champion', champ }, entryPatch);
}

// Generated files: fixed by rerunning their script, not by hand.
for (const file of ['data/lanes.json', 'data/charges.json']) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  check({ kind: 'haste', label: `${file} (generated)` }, j.verifiedPatch, { ours: 'rerun: node tools/sync-lanes-charges.mjs' });
}

// Haste sources: runes, buffs and item exceptions the calculator uses.
const hasteSources = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/haste-sources.json'), 'utf8'));
const grantText = (grants = []) => grants.map((g) => (g.byLevel
  ? `${g.byLevel.values.join('/')} ${g.kind} @L${g.byLevel.levels.join('/')}`
  : g.perStack !== undefined
    ? `${g.perStack}/stack ${g.kind}${g.maxStacks ? ` (max ${g.maxStacks})` : ''}`
    : `${g.amount} ${g.kind}${g.fromLevel ? ` @L${g.fromLevel}` : ''}`)).join(' + ');
for (const b of hasteSources.buffs || []) {
  check({ kind: 'haste', label: `haste: ${b.name}` }, b.verifiedPatch, { ours: grantText(b.grants) });
}
for (const r of hasteSources.runes || []) {
  check({ kind: 'haste', label: `haste: ${r.name}`, runeId: r.runeId }, r.verifiedPatch, { ours: grantText(r.grants) || 'note only' });
}
for (const [id, e] of Object.entries(hasteSources.itemExceptions || {})) {
  check({ kind: 'haste', label: `haste: ${e.name} (item ${id})`, itemId: id }, e.verifiedPatch, { ours: e.formula ? `${e.formula.base} + %bonusAD` : 'note only' });
}

/* ------------------------------------------------------ Data Dragon now */

const champsToFetch = [...new Set(stale.filter((s) => s.where.champ).map((s) => s.where.champ))];
const ddragon = {};
await Promise.all(
  champsToFetch.map(async (id) => {
    try {
      const j = await getJson(`${CDN}/cdn/${ddragonPatch}/data/en_US/champion/${id}.json`);
      ddragon[id] = j.data[id];
    } catch (err) {
      ddragon[id] = null;
      console.warn(`could not fetch ${id}: ${err.message}`);
    }
  })
);
let summonerData = null;
if (stale.some((s) => s.where.kind === 'summoner')) {
  summonerData = (await getJson(`${CDN}/cdn/${ddragonPatch}/data/en_US/summoner.json`)).data;
}
const runeText = {};
if (stale.some((s) => s.where.runeId)) {
  for (const tree of await getJson(`${CDN}/cdn/${ddragonPatch}/data/en_US/runesReforged.json`)) {
    for (const slot of tree.slots) {
      for (const r of slot.runes) {
        runeText[r.id] = r.longDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
  }
}

function ddragonValue(s) {
  const w = s.where;
  if (w.kind === 'summoner') return summonerData?.[w.id]?.cooldown ?? null;
  if (w.kind === 'haste') {
    if (w.runeId && runeText[w.runeId]) return `rune text: ${runeText[w.runeId].slice(0, 70)}…`;
    if (w.runeId) return 'not in runesReforged (stat shard?) - check wiki';
    if (w.itemId) return 'check item.json text / wiki';
    return 'not in Data Dragon - check wiki';
  }
  const c = ddragon[w.champ];
  if (!c) return null;
  if (w.slot === 'P') return 'n/a (passives unpublished)';
  const idx = w.from !== undefined ? w.from : SLOT_INDEX[w.slot];
  return c.spells[idx]?.cooldown ?? null;
}

/* -------------------------------------------------------------- print */

const fmt = (v) => (Array.isArray(v) ? v.join('/') : v === null || v === undefined ? 'note only' : String(v));

console.log(`Live patch: ${shortPatch(livePatch)}${argPatch ? ` (simulated; Data Dragon is ${shortPatch(ddragonPatch)})` : ''}`);

// process.exitCode rather than process.exit(): exiting while fetch's sockets
// are still closing trips a libuv assertion on Windows.
const labelOf = (w) => (w.kind === 'summoner' ? w.id : w.kind === 'haste' ? w.label
  : `${w.champ}${w.slot ? ` ${w.slot}` : ''}${w.form ? ` [${w.form}]` : ''}`);
if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({ livePatch: shortPatch(livePatch), stale: stale.map((x) => ({ ...x, label: labelOf(x.where) })) }, null, 1));
}

if (!stale.length) {
  console.log('All overrides are verified for this patch.');
  process.exitCode = 0;
} else if (quiet) {
  console.log(`${stale.length} stale override${stale.length === 1 ? '' : 's'} (run without --quiet for the table).`);
} else {
  console.log(`${stale.length} stale override${stale.length === 1 ? '' : 's'}:\n`);

  const rows = stale.map((s) => [labelOf(s.where), s.verified, fmt(s.ours), fmt(ddragonValue(s))]);
  const head = ['override', 'verified', 'ours', 'Data Dragon now'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  rows.forEach((r) => console.log(line(r)));

  console.log('\nAfter re-checking each against the LoL Wiki, bump its verifiedPatch.');
  console.log('"Data Dragon now" is the merged/raw value; for form-swap champions it is expected to differ from ours.');
}
if (stale.length) process.exitCode = 1;
