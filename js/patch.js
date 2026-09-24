/**
 * Patch strings and staleness.
 *
 * Data Dragon versions look like "16.19.1"; the third number is a Riot build
 * counter, not a balance patch, so only major.minor matters for "has this
 * number been re-verified since balance last changed?".
 *
 * Used by overrides.json and haste-sources.json - anything hand-verified
 * carries a verifiedPatch and is shown as possibly stale once the live patch
 * moves past it.
 */

export function parsePatch(v) {
  const [major, minor] = String(v || '').split('.').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(major)) return null;
  return { major, minor: Number.isFinite(minor) ? minor : 0 };
}

/** "16.19.1" -> "16.19" */
export function shortPatch(v) {
  const p = parsePatch(v);
  return p ? `${p.major}.${p.minor}` : String(v || '');
}

/** Negative if a is older than b, 0 if the same balance patch, positive if newer. */
export function comparePatch(a, b) {
  const pa = parsePatch(a);
  const pb = parsePatch(b);
  if (!pa || !pb) return 0;
  return pa.major - pb.major || pa.minor - pb.minor;
}

/**
 * Staleness of a hand-verified value against the live patch.
 * A missing verifiedPatch counts as stale: unverified is not trusted.
 * @returns {{stale: boolean, verifiedPatch: string|null, livePatch: string}}
 */
export function staleness(verifiedPatch, livePatch) {
  if (!verifiedPatch) return { stale: true, verifiedPatch: null, livePatch: shortPatch(livePatch) };
  return {
    stale: comparePatch(livePatch, verifiedPatch) > 0,
    verifiedPatch: shortPatch(verifiedPatch),
    livePatch: shortPatch(livePatch),
  };
}
