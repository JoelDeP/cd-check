/**
 * Matchup state and its URL form.
 *
 *   ?me=renekton&vs=darius&lvl=6
 *   &vlvl=9                  enemy level, when the two differ
 *   &mo=QEW&vo=QWE           skill-order overrides
 *   &mh=i3071.3158,hx2,bl,uh3,sh    my haste (tokens below)
 *   &vh=...                  enemy haste
 *   &ms=F.T&vsm=F.I          summoner spells
 *
 * Haste tokens (comma-separated, order irrelevant):
 *   i<id>.<id>  items          hx<n> Hextech stacks   bl  blue buff
 *   ci<n> cinders              co  Cosmic Insight     tr  Transcendence
 *   uh<n> Ultimate Hunter      jk<n> Jack of All Trades
 *   lh<n> Legend: Haste        sh  AH shard           ax  Axiom Arcanist
 *   ah<n> ul<n> bh<n> su<n>    manual ability / ultimate / basic / summoner haste
 *   ad<n> bonus AD             rg / ml  force ranged / melee (Endless Hunger)
 */

import { emptyLoadout } from './haste.js';

export const SUMMONER_CODES = {
  SummonerFlash: 'F', SummonerTeleport: 'T', SummonerDot: 'I', SummonerHaste: 'G',
  SummonerExhaust: 'E', SummonerHeal: 'H', SummonerBarrier: 'B', SummonerBoost: 'C', SummonerSmite: 'S',
};
const CODE_TO_SUMMONER = Object.fromEntries(Object.entries(SUMMONER_CODES).map(([k, v]) => [v, k]));

const EXTRA_TOKENS = { ah: 'ability', ul: 'ultimate', bh: 'basic', su: 'summoner' };
const RUNE_FLAGS = { co: 'cosmic', tr: 'transcendence', sh: 'shardAH', ax: 'axiomArcanist' };
const RUNE_STACKS = { uh: 'ultimateHunter', jk: 'jack', lh: 'legendHaste' };

export function defaultSide(champ, level = 6) {
  return {
    champ,
    level,
    order: null,
    loadout: { ...emptyLoadout(), level },
    summoners: ['SummonerFlash', 'SummonerTeleport'],
  };
}

export function defaultMatchup(pinned = ['Renekton']) {
  return { me: defaultSide(pinned[0] || 'Renekton'), vs: defaultSide('Darius'), linkLevels: true };
}

/* ------------------------------------------------------------------ encode */

function encodeHaste(l) {
  const t = [];
  if (l.items?.length) t.push(`i${l.items.join('.')}`);
  const b = l.buffs || {};
  if (b.hextech) t.push(`hx${b.hextech}`);
  if (b.blue) t.push('bl');
  if (b.cinders) t.push(`ci${b.cinders}`);
  const r = l.runes || {};
  for (const [tok, id] of Object.entries(RUNE_FLAGS)) if (r[id]) t.push(tok);
  for (const [tok, id] of Object.entries(RUNE_STACKS)) {
    if (r[id] !== undefined && r[id] !== false && r[id] !== null) t.push(`${tok}${Number(r[id]) || 0}`);
  }
  for (const e of l.extra || []) {
    const tok = Object.keys(EXTRA_TOKENS).find((k) => EXTRA_TOKENS[k] === e.kind);
    if (tok && e.amount) t.push(`${tok}${e.amount}`);
  }
  if (l.bonusAD) t.push(`ad${l.bonusAD}`);
  if (l.rangedOverride === true) t.push('rg');
  if (l.rangedOverride === false) t.push('ml');
  return t.join(',');
}

export function encodeMatchup(m) {
  const p = new URLSearchParams();
  p.set('me', m.me.champ.toLowerCase());
  p.set('vs', m.vs.champ.toLowerCase());
  p.set('lvl', String(m.me.level));
  if (!m.linkLevels && m.vs.level !== m.me.level) p.set('vlvl', String(m.vs.level));
  if (m.me.order) p.set('mo', m.me.order);
  if (m.vs.order) p.set('vo', m.vs.order);
  const mh = encodeHaste(m.me.loadout);
  const vh = encodeHaste(m.vs.loadout);
  if (mh) p.set('mh', mh);
  if (vh) p.set('vh', vh);
  const sums = (s) => s.summoners.map((id) => SUMMONER_CODES[id]).filter(Boolean).join('.');
  if (sums(m.me) !== 'F.T') p.set('ms', sums(m.me));
  if (sums(m.vs) !== 'F.T') p.set('vsm', sums(m.vs));
  return p.toString();
}

/* ------------------------------------------------------------------ decode */

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

function decodeHaste(str, level) {
  const l = { ...emptyLoadout(), level };
  if (!str) return l;
  for (const tok of str.split(',').map((s) => s.trim()).filter(Boolean)) {
    const head = tok.slice(0, 2);
    const num = tok.slice(2);
    if (tok[0] === 'i' && /^\d/.test(tok.slice(1))) {
      l.items = tok.slice(1).split('.').filter((x) => /^\d+$/.test(x)).slice(0, 6);
    } else if (head === 'hx') l.buffs.hextech = clampInt(num, 0, 4, 0);
    else if (tok === 'bl') l.buffs.blue = true;
    else if (head === 'ci') l.buffs.cinders = clampInt(num, 0, 20, 0);
    else if (RUNE_FLAGS[tok]) l.runes[RUNE_FLAGS[tok]] = true;
    else if (RUNE_STACKS[head]) l.runes[RUNE_STACKS[head]] = clampInt(num, 0, 20, 0);
    else if (EXTRA_TOKENS[head]) l.extra.push({ kind: EXTRA_TOKENS[head], amount: clampInt(num, 0, 500, 0), label: 'Manual' });
    else if (head === 'ad') l.bonusAD = clampInt(num, 0, 1000, 0);
    else if (tok === 'rg') l.rangedOverride = true;
    else if (tok === 'ml') l.rangedOverride = false;
  }
  return l;
}

/**
 * @param {URLSearchParams} params
 * @param {(name: string) => string|null} resolveChamp  lowercase/nickname -> champion id
 * @returns {object|null} a matchup, or null when the URL has no matchup in it
 */
export function decodeMatchup(params, resolveChamp) {
  if (!params.has('me') && !params.has('vs')) return null;
  const me = resolveChamp(params.get('me') || '') || 'Renekton';
  const vs = resolveChamp(params.get('vs') || '') || 'Darius';
  const lvl = clampInt(params.get('lvl'), 1, 18, 6);
  const vlvl = params.has('vlvl') ? clampInt(params.get('vlvl'), 1, 18, lvl) : lvl;
  const order = (s) => (s && /^[QWE]{3}$/i.test(s) && new Set(s.toUpperCase()).size === 3 ? s.toUpperCase() : null);
  const sums = (s) => {
    const ids = (s || '').split('.').map((c) => CODE_TO_SUMMONER[c]).filter(Boolean);
    return ids.length === 2 ? ids : ['SummonerFlash', 'SummonerTeleport'];
  };
  return {
    me: { champ: me, level: lvl, order: order(params.get('mo')), loadout: decodeHaste(params.get('mh'), lvl), summoners: sums(params.get('ms')) },
    vs: { champ: vs, level: vlvl, order: order(params.get('vo')), loadout: decodeHaste(params.get('vh'), vlvl), summoners: sums(params.get('vsm')) },
    linkLevels: vlvl === lvl,
  };
}
