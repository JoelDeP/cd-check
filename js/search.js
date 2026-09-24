/**
 * Fuzzy champion search.
 *
 * Ranked, not filtered - every strategy contributes a score and the best wins,
 * so "tk" finds Tahm Kench (initials), "trynd" finds Tryndamere (prefix),
 * "ww" finds Warwick (alias) and "sorka" still finds Soraka (subsequence).
 */

/** Lowercase, strip apostrophes/spaces/punctuation: "Kai'Sa" -> "kaisa". */
function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** First letter of each word: "Miss Fortune" -> "mf", "Jarvan IV" -> "ji". */
function initials(name) {
  return name
    .split(/[\s'.]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toLowerCase();
}

/**
 * Position-aware subsequence match. Returns a 0-1 quality score, or -1 if the
 * query letters do not appear in order.
 */
function subsequenceScore(needle, haystack) {
  let hi = 0;
  let gaps = 0;
  let firstAt = -1;
  for (let ni = 0; ni < needle.length; ni += 1) {
    const found = haystack.indexOf(needle[ni], hi);
    if (found === -1) return -1;
    if (firstAt === -1) firstAt = found;
    if (ni > 0) gaps += found - hi;
    hi = found + 1;
  }
  const density = needle.length / (hi - firstAt);
  const lead = 1 - firstAt / (haystack.length + 1);
  const spread = 1 / (1 + gaps);
  return density * 0.5 + lead * 0.25 + spread * 0.25;
}

export function buildSearchIndex(champions, aliasMap = {}) {
  const aliasesById = {};
  for (const [alias, id] of Object.entries(aliasMap)) {
    (aliasesById[id] = aliasesById[id] || []).push(norm(alias));
  }
  return Object.values(champions).map((champ) => ({
    champ,
    id: champ.id,
    nName: norm(champ.name),
    nId: norm(champ.id),
    nTitle: norm(champ.title || ''),
    inits: initials(champ.name),
    aliases: aliasesById[champ.id] || [],
  }));
}

function scoreEntry(entry, q) {
  if (entry.nName === q || entry.nId === q) return 1000;
  if (entry.aliases.includes(q)) return 900;
  if (entry.inits === q && q.length >= 2) return 850;
  if (entry.nName.startsWith(q)) return 800 - entry.nName.length;
  if (entry.aliases.some((a) => a.startsWith(q))) return 700;
  if (entry.inits.startsWith(q) && q.length >= 2) return 650;

  const word = entry.champ.name
    .split(/[\s']+/)
    .some((w) => norm(w).startsWith(q));
  if (word) return 600 - entry.nName.length;

  if (entry.nName.includes(q)) return 500 - entry.nName.indexOf(q);

  const sub = subsequenceScore(q, entry.nName);
  if (sub >= 0) return 200 + sub * 100;

  if (entry.nTitle.includes(q) && q.length >= 3) return 100;
  return -1;
}

export function searchChampions(index, query, limit = 40) {
  const q = norm(query);
  if (!q) {
    return index
      .slice()
      .sort((a, b) => a.champ.name.localeCompare(b.champ.name))
      .map((e) => e.champ);
  }
  const scored = [];
  for (const entry of index) {
    const score = scoreEntry(entry, q);
    if (score > 0) scored.push({ score, entry });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.champ.name.localeCompare(b.entry.champ.name));
  return scored.slice(0, limit).map((s) => s.entry.champ);
}
