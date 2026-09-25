/**
 * Stamps the current commit into sw.js before a push.
 *
 *   node tools/stamp-build.mjs              # validate, stamp, commit the stamp
 *   node tools/stamp-build.mjs --no-commit  # validate and stamp only
 *
 * Why: browsers only install a new service worker when sw.js changes byte-for-
 * byte. Writing the HEAD commit into `const BUILD` guarantees that every push
 * ships a different sw.js, so friends get the one-tap "Reload" banner instead
 * of stale files. Forget to run this and a deploy still goes live, but
 * installed copies keep serving the old app shell until the next stamped push.
 *
 * The stamp is HEAD at the time you run it, i.e. the commit *before* the stamp
 * commit - a commit can't contain its own hash. That is fine: it is unique per
 * push, which is all the browser needs.
 *
 * It also validates the JSON data files first, so a typo in overrides.json
 * can't be pushed as a broken site.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW = path.join(ROOT, 'sw.js');
const JSON_FILES = [
  'data/overrides.json', 'data/nicknames.json', 'data/haste-sources.json', 'data/matchup.json', 'manifest.webmanifest',
];
const STAMP_SUBJECT = 'Stamp service worker build';
const BUILD_RE = /const BUILD = '[^']*';/;

const noCommit = process.argv.includes('--no-commit');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function fail(msg) {
  console.error(`stamp-build: ${msg}`);
  process.exitCode = 1;
}

function main() {
  // 1. Data files must parse.
  for (const f of JSON_FILES) {
    try {
      JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      console.log(`ok    ${f}`);
    } catch (err) {
      return fail(`${f} is not valid JSON: ${err.message}`);
    }
  }

  // 2. Stamp exactly what is committed, nothing half-edited.
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  if (dirty) {
    return fail(`commit or stash your changes first:\n${dirty}`);
  }

  // 3. Running twice in a row should be a no-op, not an endless stamp chain.
  const subject = git('log', '-1', '--format=%s');
  if (subject.startsWith(STAMP_SUBJECT)) {
    console.log(`HEAD is already a stamp commit (${subject}). Nothing to do - push away.`);
    return;
  }

  const sha = git('rev-parse', '--short=12', 'HEAD');
  const src = fs.readFileSync(SW, 'utf8');
  if (!BUILD_RE.test(src)) return fail("could not find `const BUILD = '...';` in sw.js");

  const next = src.replace(BUILD_RE, `const BUILD = '${sha}';`);
  if (next === src) {
    console.log(`sw.js is already stamped with ${sha}.`);
    return;
  }
  fs.writeFileSync(SW, next);
  console.log(`stamp sw.js BUILD = '${sha}'`);

  if (noCommit) {
    console.log('Not committing (--no-commit). Commit sw.js yourself before pushing.');
    return;
  }
  git('commit', '--quiet', '-m', `${STAMP_SUBJECT} ${sha}`, '--', 'sw.js');
  console.log(`commit ${git('log', '-1', '--format=%h %s')}`);
  console.log('\nReady: git push');
}

main();
