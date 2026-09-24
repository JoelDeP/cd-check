/**
 * pre-push guard: refuses to push `main` unless its tip is a fresh
 * service-worker stamp from tools/stamp-build.mjs.
 *
 * Installed per clone with:   git config core.hooksPath tools/hooks
 * Bypass once (not advised):  git push --no-verify
 *
 * Rule: the commit being pushed to main must contain a sw.js whose BUILD is
 * the hash of that commit's parent - exactly what stamp-build produces. Any
 * commit on top of a stamp invalidates it, so "stamped last week, pushed
 * today" is caught too. Other branches and branch deletions are left alone.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const ZERO = /^0+$/;
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const lines = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean);
const problems = [];

for (const line of lines) {
  const [, localSha, remoteRef] = line.split(' ');
  if (remoteRef !== 'refs/heads/main') continue;
  if (!localSha || ZERO.test(localSha)) continue; // deleting the branch

  let sw;
  try {
    sw = git('show', `${localSha}:sw.js`);
  } catch {
    problems.push('sw.js is missing from the pushed commit.');
    continue;
  }
  const build = (sw.match(/const BUILD = '([^']*)';/) || [])[1] || '';

  let parent = '';
  try {
    parent = git('rev-parse', `${localSha}^`);
  } catch {
    /* root commit: cannot be a valid stamp */
  }

  const short = localSha.slice(0, 12);
  if (!/^[0-9a-f]{7,40}$/.test(build)) {
    problems.push(`sw.js BUILD is '${build}' - never stamped.`);
  } else if (!parent.startsWith(build)) {
    problems.push(
      `main's tip ${short} is not a fresh stamp: sw.js BUILD is ${build}, ` +
        `but the tip's parent is ${parent.slice(0, 12) || '(none)'}.`
    );
  }
}

if (problems.length) {
  console.error('\npre-push: blocked - service worker not stamped for this push.');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nRun:   node tools/stamp-build.mjs   then push again.');
  console.error('Without a new stamp, installed copies of CD Check keep serving the old app.');
  console.error('(Bypass once with --no-verify if you really mean it.)\n');
  process.exitCode = 1;
}
