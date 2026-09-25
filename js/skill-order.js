/**
 * Skill orders: which ability ranks a champion has at a given level.
 *
 * An order is a max priority for Q/W/E ("QEW" = max Q, then E, then W) plus
 * the first three points ("start", defaults to the max order). R is taken at
 * 6 / 11 / 16 whenever possible. League's rank rule is respected: a basic
 * ability can reach rank n only from champion level 2n - 1.
 *
 * Special ultimates, read from the ability data rather than a champion list:
 *   R with 1 rank (Jayce)                 - learned free at level 1
 *   R with 4 ranks (Elise, Nidalee, Karma) - rank 1 free at level 1, then 6/11/16
 * Udyr (four 6-rank abilities, no real ultimate) is approximated.
 */

export const ORDERS = ['QEW', 'QWE', 'WQE', 'WEQ', 'EQW', 'EWQ'];
const BASICS = ['Q', 'W', 'E'];
const R_LEVELS = [6, 11, 16];

function isOrder(s) {
  return typeof s === 'string' && s.length === 3 && [...s].sort().join('') === 'EQW';
}

/**
 * The order to use for a champion: a user override, else the matchup.json
 * default, else Q > E > W.
 * @returns {{ max: string, start: string, source: 'user'|'default'|'generic' }}
 */
export function resolveOrder(champId, userOrders = {}, defaults = {}) {
  const user = userOrders[champId];
  if (isOrder(user)) return { max: user, start: user, source: 'user' };
  const d = defaults[champId];
  if (d && isOrder(d.max)) {
    return { max: d.max, start: isOrder(d.start) ? d.start : d.max, source: 'default' };
  }
  return { max: 'QEW', start: 'QEW', source: 'generic' };
}

/** @returns {{Q:number,W:number,E:number,R:number}} ranks at `level` */
export function ranksAtLevel(champ, order, level) {
  const abilities = champ.forms[0].abilities;
  const maxRank = (s) => abilities[s]?.maxrank ?? (s === 'R' ? 3 : 5);
  const rMax = maxRank('R');
  const ranks = { Q: 0, W: 0, E: 0, R: 0 };

  const rFree = rMax === 1 || rMax === 4;
  if (rFree) ranks.R = 1;
  const rTakesPoints = rMax !== 1;

  const lvl = Math.max(1, Math.min(18, Math.floor(level) || 1));
  for (let L = 1; L <= lvl; L += 1) {
    if (rTakesPoints && R_LEVELS.includes(L) && ranks.R < rMax) {
      ranks.R += 1;
      continue;
    }
    const canTake = (s) => ranks[s] < maxRank(s) && 2 * (ranks[s] + 1) - 1 <= L;
    let pick = null;
    if (L <= 3 && canTake(order.start[L - 1])) pick = order.start[L - 1];
    if (!pick) pick = [...order.max].find(canTake);
    if (!pick) pick = BASICS.find(canTake);
    if (pick) ranks[pick] += 1;
  }
  return ranks;
}

/** The slot levelled at each of levels 1..18 - for a compact "Q E W Q Q R..." strip. */
export function skillSequence(champ, order) {
  const seq = [];
  let prev = { Q: 0, W: 0, E: 0, R: 0 };
  for (let L = 1; L <= 18; L += 1) {
    const now = ranksAtLevel(champ, order, L);
    seq.push(['Q', 'W', 'E', 'R'].find((s) => now[s] > prev[s]) || null);
    prev = now;
  }
  return seq;
}
