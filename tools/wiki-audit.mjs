/**
 * One-shot audit: compares what the app shows for every champion ability with
 * the LoL Wiki's ability data, via the MediaWiki API (batched 50 pages per
 * request, 1.5s apart, descriptive User-Agent - see tools/lib/wiki.mjs).
 *
 *   node tools/wiki-audit.mjs [--cache file.json] [--json report.json] [--quiet]
 *
 * --cache reuses previously fetched wikitext (and writes it on first run), so
 * re-analysing doesn't hit the wiki again.
 *
 * It builds the app's own champion model (Data Dragon + overrides.json +
 * data/charges.json + data/lanes.json, exactly as the site does) and checks,
 * for each current ability the wiki lists (Module:ChampionData skill_i/q/w/e/r):
 *   - charges     the wiki has a recharge but the app has no charge data
 *   - recharge    both have charges but the recharge / max differs
 *   - cooldown    per-rank cooldown differs
 *   - static      the wiki's cooldown is static (haste doesn't apply) but the
 *                 app would apply haste
 *   - level       the wiki's cooldown scales with level, the app's with rank
 *   - passive     the wiki gives the passive a cooldown the app doesn't show
 * Dev-only. Changes nothing; prints a report.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchPages, loadChampionModule, listOf, parseRankValue, parseLevelValue, templateFields, findMaxCharges,
} from './lib/wiki.mjs';
import { buildAllChampions } from '../js/model.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const cacheFile = arg('--cache');
const jsonOut = arg('--json');
const quiet = process.argv.includes('--quiet');

const DD = 'https://ddragon.leagueoflegends.com';
const patch = (await (await fetch(`${DD}/api/versions.json`)).json())[0];
const full = (await (await fetch(`${DD}/cdn/${patch}/data/en_US/championFull.json`)).json()).data;
// Same shape the site stores (js/ddragon.js trimChampion) - only the fields model.js reads.
for (const c of Object.values(full)) { c.range = c.stats?.attackrange; }
const app = buildAllChampions(patch, full, readJson('data/overrides.json'), {
  lanes: readJson('data/lanes.json'), charges: readJson('data/charges.json'),
});
console.log(`Data Dragon ${patch}: ${Object.keys(app).length} champions in the app model`);

const wikiChamps = await loadChampionModule();
const byKey = Object.fromEntries(Object.entries(wikiChamps).filter(([, c]) => c?.id).map(([name, c]) => [Number(c.id), { name, ...c }]));

/* ------------------------------------------------ which pages to fetch */

const SLOT_OF = { i: 'P', q: 'Q', w: 'W', e: 'E', r: 'R' };
const wanted = []; // { champId, wikiName, slot, ability, title }
for (const c of Object.values(full)) {
  const w = byKey[Number(c.key)];
  if (!w) { console.warn(`no wiki entry for ${c.id}`); continue; }
  for (const [k, slot] of Object.entries(SLOT_OF)) {
    for (const ability of listOf(w[`skill_${k}`])) {
      wanted.push({ champId: c.id, wikiName: w.name, slot, ability, title: `Template:Data ${w.name}/${ability}` });
    }
  }
}

let pages;
if (cacheFile && fs.existsSync(cacheFile)) {
  pages = new Map(Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))));
  console.log(`Using cached wikitext for ${pages.size} pages (${cacheFile})`);
} else {
  const titles = [...new Set(wanted.map((x) => x.title))];
  console.log(`Fetching ${titles.length} ability pages in ${Math.ceil(titles.length / 50)} batched requests...`);
  pages = await fetchPages(titles, { onBatch: (n, total) => process.stdout.write(`\r  ${n}/${total}`) });
  process.stdout.write('\n');
  if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(pages)));
}

/* -------------------------------------------------------------- compare */

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, k) => Math.abs(x - b[k]) < 0.011);
const fmtArr = (a) => (Array.isArray(a) ? a.join('/') : String(a));

/** The app's ability for this wiki ability: same slot, same (or merged) name, any form. */
function findAppAbility(champId, slot, name) {
  const c = app[champId];
  if (!c) return null;
  const n = norm(name);
  for (const f of c.forms) {
    const a = f.abilities[slot];
    if (!a) continue;
    if (norm(a.name) === n || a.name.split(' / ').some((part) => norm(part) === n)) return { a, form: f.short };
  }
  return null;
}

const findings = [];
const add = (type, x, detail) => findings.push({ type, champ: x.champId, slot: x.slot, ability: x.ability, ...detail });
let checked = 0;
// Abilities whose numbers were actually compared (for tools/patch-day.mjs).
const compared = [];
let missingPages = 0;

for (const x of wanted) {
  const text = pages.get(x.title);
  if (!text) { missingPages += 1; add('no-wiki-page', x, {}); continue; }
  const f = templateFields(text);
  const match = findAppAbility(x.champId, x.slot, x.ability);
  const n = match?.a?.maxrank || (x.slot === 'R' ? 3 : 5);

  const wikiRecharge = parseRankValue(f.recharge, n);
  const wikiCd = parseRankValue(f.cooldown, n);
  const wikiCdLevel = parseLevelValue(f.cooldown);
  const wikiStatic = parseRankValue(f.static, n);
  const wikiStaticLevel = parseLevelValue(f.static);
  const unparsed = [['recharge', f.recharge, wikiRecharge], ['cooldown', f.cooldown, wikiCd || wikiCdLevel], ['static', f.static, wikiStatic || wikiStaticLevel]]
    .filter(([, raw, parsed]) => raw && !parsed).map(([k, raw]) => `${k}=${raw}`);

  if (x.slot === 'P') {
    const cd = wikiCd || wikiStatic || wikiCdLevel || wikiStaticLevel;
    const appP = app[x.champId]?.forms[0].abilities.P;
    const wikiText = cd ? (Array.isArray(cd) ? fmtArr(cd) : `${fmtArr(cd.values)} @L${fmtArr(cd.levels)}`) : '';
    const sameName = appP && norm(appP.name) === norm(x.ability.replace(/ \d+$/, ''));
    if (cd && appP && !appP.cooldown.length) {
      add('passive', x, { wiki: wikiText, static: Boolean(wikiStatic || wikiStaticLevel) && !(wikiCd || wikiCdLevel) });
    } else if (cd && appP && sameName && appP.cooldown.length) {
      // The app already shows a passive cooldown (from overrides.json): check it still matches.
      const wikiVals = Array.isArray(cd) ? [cd[0]] : cd.values;
      const appVals = appP.scaling === 'flat' ? [appP.cooldown[0]] : appP.cooldown;
      const levelsOk = Array.isArray(cd) || !appP.levelBreaks || same(appP.levelBreaks, cd.levels);
      if (!same(appVals, wikiVals) || !levelsOk) {
        add('passive-mismatch', x, { app: `${fmtArr(appVals)}${appP.levelBreaks ? ` @L${fmtArr(appP.levelBreaks)}` : ''}`, wiki: wikiText });
      }
      compared.push({ champ: x.champId, slot: 'P', ability: x.ability });
    }
    if (unparsed.length) add('unparsed', x, { raw: unparsed });
    checked += 1;
    continue;
  }

  if (!match) {
    // Sub-abilities (Wall Dive, recasts) and form abilities with no app entry.
    if (wikiRecharge || wikiCd || wikiStatic) add('no-app-match', x, { wiki: fmtArr(wikiRecharge || wikiCd || wikiStatic) });
    continue;
  }
  const { a, form } = match;
  checked += 1;
  // Recorded only when the wiki gave numbers we could compare.
  if (wikiRecharge || wikiCd || wikiCdLevel || wikiStatic || wikiStaticLevel) {
    compared.push({ champ: x.champId, slot: x.slot, ability: x.ability, ...(form ? { form } : {}) });
  }
  const where = form ? { form } : {};
  if (unparsed.length) add('unparsed', x, { raw: unparsed, ...where });

  if (wikiRecharge) {
    const max = findMaxCharges(text, n)?.values || null;
    if (!a.ammo?.recharge) add('charges', x, { wikiRecharge: fmtArr(wikiRecharge), wikiMax: max ? fmtArr(max) : '?', between: fmtArr(wikiStatic || wikiCd || []), betweenStatic: Boolean(wikiStatic), ...where });
    else {
      if (!same(a.ammo.recharge, wikiRecharge)) add('recharge', x, { app: fmtArr(a.ammo.recharge), wiki: fmtArr(wikiRecharge), ...where });
      if (max && !same([].concat(a.ammo.max).length === 1 ? Array(n).fill(a.ammo.max[0] ?? a.ammo.max) : [].concat(a.ammo.max), max)) add('charges-max', x, { app: fmtArr([].concat(a.ammo.max)), wiki: fmtArr(max), ...where });
    }
    continue;
  }

  // Ordinary cooldown: rank-based, level-based, static or not.
  const isStatic = !wikiCd && !wikiCdLevel && Boolean(wikiStatic || wikiStaticLevel);
  const cdRank = wikiCd || (isStatic ? wikiStatic : null);
  const cdLevel = wikiCdLevel || (isStatic ? wikiStaticLevel : null);
  if (cdLevel && a.scaling !== 'level') add('level', x, { app: fmtArr(a.cooldown), wiki: `${fmtArr(cdLevel.values)} @L${fmtArr(cdLevel.levels)}`, static: isStatic, ...where });
  else if (cdRank && !same(a.cooldown, cdRank) && !(cdRank.every((v) => v === cdRank[0]) && a.cooldown.every((v) => Math.abs(v - cdRank[0]) < 0.011))) {
    add('cooldown', x, { app: fmtArr(a.cooldown), wiki: fmtArr(cdRank), static: isStatic, ...where });
  }
  if (isStatic && !a.static) add('static', x, { value: fmtArr(cdRank || cdLevel?.values || []), ...where });
}

/* ---------------------------------------------------------------- report */

const byType = {};
for (const f of findings) (byType[f.type] ||= []).push(f);
console.log(`\nChecked ${checked} abilities (${missingPages} wiki pages missing).`);
const ORDER = ['charges', 'recharge', 'charges-max', 'cooldown', 'static', 'level', 'passive', 'passive-mismatch', 'no-app-match', 'no-wiki-page', 'unparsed'];
if (quiet) console.log(`  ${ORDER.map((t) => `${t}: ${(byType[t] || []).length}`).join(', ')}`);
for (const t of quiet ? [] : ORDER) {
  const list = byType[t] || [];
  console.log(`\n=== ${t} (${list.length})`);
  for (const f of list) {
    const { type, champ, slot, ability, ...rest } = f;
    console.log(`  ${`${champ} ${slot}`.padEnd(18)} ${String(ability).padEnd(26)} ${JSON.stringify(rest)}`);
  }
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ patch, checked, compared, findings }, null, 1));
