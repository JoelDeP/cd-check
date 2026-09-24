/**
 * Lists every hand-verified value in data/overrides.json that the live patch
 * has moved past, so you know exactly what to re-check after a patch.
 *
 *   node tools/stale-overrides.mjs            # compare against the live patch
 *   node tools/stale-overrides.mjs 16.21      # pretend the live patch is 16.21
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

const argPatch = process.argv[2];
const ddragonPatch = (await getJson(`${CDN}/api/versions.json`))[0];
const livePatch = argPatch || ddragonPatch;

/* ------------------------------------------------------------ collect */

const stale = [];

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
    check({ kind: 'ability', champ, slot }, a.verifiedPatch || entryPatch, { ours: a.cooldown || null, note: a.note });
  }
  for (const form of entry.forms || []) {
    for (const [slot, a] of Object.entries(form.abilities || {})) {
      touched = true;
      check(
        { kind: 'ability', champ, slot, form: form.short || form.name, from: a.from },
        a.verifiedPatch || entryPatch,
        { ours: a.cooldown || null }
      );
    }
  }
  // An entry with only a note still asserts something about the champion.
  if (!touched) check({ kind: 'champion', champ }, entryPatch);
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

function ddragonValue(s) {
  const w = s.where;
  if (w.kind === 'summoner') return summonerData?.[w.id]?.cooldown ?? null;
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
if (!stale.length) {
  console.log('All overrides are verified for this patch.');
  process.exitCode = 0;
} else {
  console.log(`${stale.length} stale override${stale.length === 1 ? '' : 's'}:\n`);

  const rows = stale.map((s) => {
    const w = s.where;
    const label = w.kind === 'summoner'
      ? w.id
      : `${w.champ}${w.slot ? ` ${w.slot}` : ''}${w.form ? ` [${w.form}]` : ''}`;
    return [label, s.verified, fmt(s.ours), fmt(ddragonValue(s))];
  });
  const head = ['override', 'verified', 'ours', 'Data Dragon now'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  rows.forEach((r) => console.log(line(r)));

  console.log('\nAfter re-checking each against the LoL Wiki, bump its verifiedPatch.');
  console.log('"Data Dragon now" is the merged/raw value; for form-swap champions it is expected to differ from ours.');
  process.exitCode = 1;
}
