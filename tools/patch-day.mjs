/**
 * Patch day: everything to run when Riot ships a patch, then ONE summary of
 * what needs re-verifying.
 *
 *   node tools/patch-day.mjs                 full run (Data Dragon, Meraki, ~25 wiki requests)
 *   node tools/patch-day.mjs --cache f.json  reuse wiki pages fetched by an earlier run
 *   node tools/patch-day.mjs --simulate 16.20   pretend the live patch is newer (step 1 only)
 *   node tools/patch-day.mjs --acknowledge   after reviewing, accept this run's audit findings
 *
 * Steps, in order:
 *   1. stale-overrides     hand-verified entries (overrides.json, haste-sources.json)
 *                          whose verifiedPatch the live patch has moved past
 *   2. sync-lanes-charges  regenerate data/lanes.json + data/charges.json
 *   3. wiki-audit          compare every ability the app shows with the LoL Wiki
 *
 * The summary then cross-references them: a stale entry whose numbers the
 * audit compared and found still matching the wiki only needs its
 * verifiedPatch bumped; anything with prose (mechanics notes, caveats), haste
 * sources, or numbers the audit couldn't compare needs a look by hand. Audit
 * findings already reviewed (tools/audit-known.json) are hidden unless their
 * values changed.
 *
 * Exit code: 0 nothing to do, 1 something to re-verify, 2 a step failed.
 * Dev-only; the site never loads this.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const cache = opt('--cache');
const simulate = opt('--simulate');
const acknowledge = argv.includes('--acknowledge');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-check-patch-day-'));
const out = (name) => path.join(tmp, name);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function step(n, title, script, args, okCodes = [0]) {
  console.log(`\n━━ ${n}. ${title} ━━`);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', script), ...args], { cwd: ROOT, stdio: 'inherit' });
  if (!okCodes.includes(r.status)) {
    console.error(`\n${script} failed (exit ${r.status}). Stopping.`);
    process.exit(2);
  }
}

/* --------------------------------------------------------------- run */

const GENERATED = ['data/lanes.json', 'data/charges.json'];
const before = Object.fromEntries(GENERATED.map((f) => [f, readJson(path.join(ROOT, f))]));

step(1, 'Hand-verified entries past their patch', 'stale-overrides.mjs', [...(simulate ? [simulate] : []), '--quiet', '--json', out('stale.json')], [0, 1]);
step(2, 'Regenerate lanes + charges', 'sync-lanes-charges.mjs', ['--quiet', '--json', out('sync.json')]);
step(3, 'Audit every ability against the wiki', 'wiki-audit.mjs', ['--quiet', '--json', out('audit.json'), ...(cache ? ['--cache', cache] : [])]);

const stale = readJson(out('stale.json'));
const sync = readJson(out('sync.json'));
const audit = readJson(out('audit.json'));
const after = Object.fromEntries(GENERATED.map((f) => [f, readJson(path.join(ROOT, f))]));

/* ----------------------------------------------------- audit findings */

const ACTIONABLE = ['charges', 'recharge', 'charges-max', 'cooldown', 'static', 'level', 'passive', 'passive-mismatch'];
const knownFile = path.join(ROOT, 'tools/audit-known.json');
const known = fs.existsSync(knownFile) ? readJson(knownFile) : { known: [] };
const keyOf = (f) => `${f.type}:${f.champ}:${f.slot}:${f.ability}`;
const seenOf = ({ type, champ, slot, ability, ...rest }) => rest;
const stable = (o) => JSON.stringify(o, Object.keys(o).sort());
const knownByKey = new Map(known.known.map((k) => [k.key, k]));

const fresh = [];      // never reviewed
const changed = [];    // reviewed, but the values moved since
let acknowledged = 0;
for (const f of audit.findings) {
  const k = knownByKey.get(keyOf(f));
  if (!k) fresh.push(f);
  else if (stable(k.seen) !== stable(seenOf(f))) changed.push({ f, was: k.seen, reason: k.reason });
  else acknowledged += 1;
}
const gone = known.known.filter((k) => !audit.findings.some((f) => keyOf(f) === k.key));

/* ------------------------------------------ stale entries: bump or check */

const flagged = new Set([...fresh, ...changed.map((c) => c.f)].filter((f) => ACTIONABLE.includes(f.type)).map((f) => `${f.champ}:${f.slot}`));
// Differences reviewed earlier: the entry still needs a look, to confirm the reason holds.
const ackReason = new Map(audit.findings.filter((f) => ACTIONABLE.includes(f.type) && knownByKey.has(keyOf(f)))
  .map((f) => [`${f.champ}:${f.slot}`, knownByKey.get(keyOf(f)).reason]));
const PROSE_WORDS = { mechanics: 'mechanics notes', unreliable: 'caveat', lanes: 'lanes', upgrade: 'upgrade note' };
const comparedSet = new Set(audit.compared.map((c) => `${c.champ}:${c.slot}${c.form ? `:${c.form}` : ''}`));
const NUMERIC = new Set(['name', 'cooldown', 'levelRange', 'levelBreaks', 'scaling', 'static', 'ammo', 'maxrank', 'note']);

const bump = [];
const byHand = [];
for (const s of stale.stale) {
  const w = s.where;
  if (w.kind === 'haste' && /\(generated\)/.test(w.label)) continue; // step 2 regenerated it
  if (w.kind !== 'ability') {
    byHand.push({ label: s.label, why: w.kind === 'summoner' ? 'summoner spell note' : 'haste source (not in the wiki audit): check the wiki / rune text' });
    continue;
  }
  const prose = (s.asserts || []).filter((a) => !NUMERIC.has(a));
  const wasCompared = comparedSet.has(`${w.champ}:${w.slot}${w.form ? `:${w.form}` : ''}`) || comparedSet.has(`${w.champ}:${w.slot}`);
  const slotKey = `${w.champ}:${w.slot}`;
  if (flagged.has(slotKey)) byHand.push({ label: s.label, why: 'the audit reports a new difference - see section 3' });
  else if (ackReason.has(slotKey)) byHand.push({ label: s.label, why: `known difference - confirm it still holds: ${ackReason.get(slotKey)}` });
  else if (!wasCompared) byHand.push({ label: s.label, why: 'the audit had no wiki numbers to compare' });
  else if (prose.length) byHand.push({ label: s.label, why: `numbers match the wiki; re-read the ${prose.map((p) => PROSE_WORDS[p] || p).join(' + ')}` });
  else bump.push(s.label);
}

/* ------------------------------------------------- generated data diff */

function diffKeys(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const added = []; const removed = []; const modified = [];
  for (const k of keys) {
    if (!(k in a)) added.push(k);
    else if (!(k in b)) removed.push(k);
    else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) modified.push(k);
  }
  return { added, removed, modified };
}
const laneDiff = diffKeys(before['data/lanes.json'].lanes, after['data/lanes.json'].lanes);
const chargeDiff = diffKeys(before['data/charges.json'].charges, after['data/charges.json'].charges);
const notChargeDiff = diffKeys(before['data/charges.json'].notCharges, after['data/charges.json'].notCharges);

/* ------------------------------------------------------------ summary */

const lines = [];
const say = (s = '') => lines.push(s);
const list = (items, fmt = (x) => x, max = 40) => {
  items.slice(0, max).forEach((x) => say(`    - ${fmt(x)}`));
  if (items.length > max) say(`    … and ${items.length - max} more`);
};
const describe = (f) => {
  const { type, champ, slot, ability, ...rest } = f;
  return `${champ} ${slot} ${ability} [${type}] ${JSON.stringify(rest)}`;
};

say(`\n${'═'.repeat(72)}`);
say(`PATCH DAY SUMMARY — live patch ${stale.livePatch}${simulate ? ' (simulated)' : ''}, Data Dragon ${audit.patch}`);
say('═'.repeat(72));

say(`\n1. Hand-verified entries past their verifiedPatch: ${bump.length + byHand.length}`);
if (bump.length) {
  say(`  Wiki still agrees — just bump verifiedPatch to ${stale.livePatch} (${bump.length}):`);
  list(bump, (x) => x, 60);
}
if (byHand.length) {
  say(`  Check by hand (${byHand.length}):`);
  list(byHand, (x) => `${x.label}: ${x.why}`, 80);
}
if (!bump.length && !byHand.length) say('  None.');

say('\n2. Generated data (regenerated in step 2):');
const lanesChanged = laneDiff.added.length + laneDiff.removed.length + laneDiff.modified.length;
say(`  lanes.json: ${lanesChanged ? `${lanesChanged} champion(s) changed` : 'no change'}`);
if (lanesChanged) list([...laneDiff.added.map((c) => `${c}: new champion ${JSON.stringify(after['data/lanes.json'].lanes[c])}`),
  ...laneDiff.modified.map((c) => `${c}: ${JSON.stringify(before['data/lanes.json'].lanes[c])} -> ${JSON.stringify(after['data/lanes.json'].lanes[c])}`),
  ...laneDiff.removed.map((c) => `${c}: removed`)]);
const chargesChanged = [...chargeDiff.added, ...chargeDiff.removed, ...chargeDiff.modified, ...notChargeDiff.added, ...notChargeDiff.removed, ...notChargeDiff.modified];
say(`  charges.json: ${chargesChanged.length ? `${chargesChanged.length} change(s) — review before shipping` : 'no change'}`);
if (chargesChanged.length) {
  list(chargeDiff.added, (c) => `new charge ability ${c}`);
  list(chargeDiff.removed, (c) => `no longer a charge ability: ${c}`);
  list(chargeDiff.modified, (c) => `changed ${c}: ${JSON.stringify(before['data/charges.json'].charges[c].recharge)} -> ${JSON.stringify(after['data/charges.json'].charges[c].recharge)}`);
  list([...notChargeDiff.added, ...notChargeDiff.modified], (c) => `not-a-charge entry added/changed: ${c}`);
}
const unverified = [...sync.lanes.unverified.map((c) => `lanes: ${c}`), ...sync.charges.unverified.map((u) => `charges: ${u.id} (${u.problem})`)];
if (unverified.length) { say(`  Could not verify (${unverified.length}):`); list(unverified); }

say(`\n3. Wiki audit (${audit.checked} abilities checked, ${audit.compared.length} with comparable numbers):`);
const freshActionable = fresh.filter((f) => ACTIONABLE.includes(f.type));
const freshInfo = fresh.filter((f) => !ACTIONABLE.includes(f.type));
if (freshActionable.length) { say(`  NEW differences to fix (${freshActionable.length}):`); list(freshActionable, describe); }
if (changed.length) { say(`  Reviewed before, but the values changed (${changed.length}):`); list(changed, (c) => `${describe(c.f)} — was ${JSON.stringify(c.was)}; reason then: ${c.reason}`); }
if (freshInfo.length) { say(`  New informational findings (${freshInfo.length}) — new pages, recasts or formulas worth a glance:`); list(freshInfo, describe, 25); }
if (gone.length) say(`  ${gone.length} previously acknowledged finding(s) no longer occur (fixed upstream?) — --acknowledge to tidy.`);
say(`  ${acknowledged} acknowledged finding(s) unchanged and hidden.`);
if (!freshActionable.length && !changed.length && !freshInfo.length) say('  Nothing new.');

const todo = bump.length + byHand.length + chargesChanged.length + unverified.length + freshActionable.length + changed.length;
say(`\n${todo ? `→ ${todo} item(s) to go through.` : '→ Nothing needs re-verifying.'} Then: node tests/run.mjs, commit, node tools/stamp-build.mjs, git push.`);
console.log(lines.join('\n'));

/* ------------------------------------------------------- acknowledge */

if (acknowledge) {
  const reasons = new Map(known.known.map((k) => [k.key, k.reason]));
  const next = audit.findings.map((f) => ({
    key: keyOf(f),
    reason: reasons.get(keyOf(f)) || `Acknowledged on ${audit.patch} — add a reason.`,
    seen: seenOf(f),
  }));
  fs.writeFileSync(knownFile, `${JSON.stringify({ ...known, acknowledgedOn: audit.patch, known: next }, null, 1)}\n`);
  console.log(`\nAcknowledged ${next.length} finding(s) in tools/audit-known.json (${next.filter((n) => /add a reason/.test(n.reason)).length} need a reason written).`);
}

fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = todo ? 1 : 0;
