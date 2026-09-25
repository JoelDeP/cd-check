/**
 * LoL Wiki access for the dev scripts (never loaded by the site).
 *
 * Polite by construction: every request carries a descriptive User-Agent,
 * page content is fetched through the MediaWiki API in batches of 50 titles
 * (the anonymous limit), and requests are spaced at least 1.5s apart.
 */

export const WIKI = 'https://wiki.leagueoflegends.com/en-us';
export const API = `${WIKI}/api.php`;
export const UA = {
  'User-Agent': 'cd-check-dev/1.0 (https://github.com/JoelDeP/cd-check; League cooldown PWA data audit; contact via GitHub issues)',
};
const GAP_MS = 1500;

let last = 0;
async function politeFetch(url) {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

/** Raw wikitext of many pages: Map(title -> content | null when missing). */
export async function fetchPages(titles, { onBatch } = {}) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    // MediaWiki caps the response size; when 50 pages of content don't fit it
    // returns part of them plus a `continue` token. Follow it until done.
    let cont = {};
    // Several requested titles can resolve to one page ("X 2" and "X 3" both
    // redirect to "X"), so each resolved title maps to all the titles that
    // asked for it, including itself.
    const askers = new Map();
    const addAsker = (to, from) => askers.set(to, [...new Set([...(askers.get(to) || [to]), ...(askers.get(from) || [from])])]);
    for (;;) {
      const params = new URLSearchParams({
        action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
        titles: batch.join('|'), redirects: '1', format: 'json', formatversion: '2', ...cont,
      });
      const j = await (await politeFetch(`${API}?${params}`)).json();
      for (const n of j.query?.normalized || []) addAsker(n.to, n.from);
      for (const r of j.query?.redirects || []) addAsker(r.to, r.from);
      for (const p of j.query?.pages || []) {
        const content = p.revisions?.[0]?.slots?.main?.content;
        for (const asked of askers.get(p.title) || [p.title]) {
          if (p.missing) out.set(asked, null);
          else if (content !== undefined) out.set(asked, content);
        }
      }
      if (!j.continue) break;
      cont = j.continue;
    }
    for (const t of batch) if (!out.has(t)) out.set(t, null);
    onBatch?.(Math.min(i + 50, titles.length), titles.length);
  }
  return out;
}

export async function fetchRaw(title) {
  const res = await politeFetch(`${WIKI}/${encodeURIComponent(title.replace(/ /g, '_'))}?action=raw`);
  return res.text();
}

/* ------------------------------------------------------------ Lua tables */

/** Minimal parser for the wiki's Lua data modules: tables, strings, numbers (incl. arithmetic), booleans. */
export function parseLua(src) {
  let i = src.indexOf('return');
  i = src.indexOf('{', i);
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i += 1;
      if (src.startsWith('--', i)) { while (i < src.length && src[i] !== '\n') i += 1; continue; }
      break;
    }
  };
  const str = () => {
    const q = src[i]; i += 1;
    let out = '';
    while (src[i] !== q) {
      if (src[i] === '\\') { out += src[i + 1]; i += 2; } else { out += src[i]; i += 1; }
    }
    i += 1;
    return out;
  };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '{') return table();
    if (c === '"' || c === "'") return str();
    const kw = /^(true|false|nil)\b/.exec(src.slice(i, i + 6));
    if (kw) {
      i += kw[0].length;
      return kw[0] === 'true' ? true : kw[0] === 'false' ? false : null;
    }
    const m = /^-?[\d.(][\d.+\-*/() eE]*/.exec(src.slice(i, i + 80));
    if (!m) throw new Error(`lua parse error at ${i}: ${src.slice(i, i + 30)}`);
    const expr = m[0].trim();
    i += m[0].length;
    if (!/^[\d.+\-*/() eE]+$/.test(expr)) throw new Error(`unsafe expression ${expr}`);
    return Number(Function(`"use strict"; return (${expr});`)());
  };
  const table = () => {
    i += 1;
    const obj = {};
    const arr = [];
    let keyed = false;
    for (;;) {
      ws();
      if (src[i] === '}') { i += 1; break; }
      if (src[i] === '[') {
        i += 1; ws();
        const k = src[i] === '"' || src[i] === "'" ? str() : value();
        ws(); i += 1; ws(); i += 1;
        obj[k] = value();
        keyed = true;
      } else if (/^[A-Za-z_]\w*\s*=/.test(src.slice(i, i + 60))) {
        const m = /^([A-Za-z_]\w*)\s*=/.exec(src.slice(i, i + 60));
        i += m[0].length;
        obj[m[1]] = value();
        keyed = true;
      } else {
        arr.push(value());
      }
      ws();
      if (src[i] === ',' || src[i] === ';') i += 1;
    }
    if (!keyed) return arr;
    arr.forEach((v, idx) => { obj[idx + 1] = v; });
    return obj;
  };
  return table();
}

export const listOf = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

export async function loadChampionModule() {
  return parseLua(await fetchRaw('Module:ChampionData/data'));
}

/* ------------------------------------------------ template value parsing */

const round2 = (n) => Math.round(n * 100) / 100;
const linear = (a, b, count) => (count === 1 ? [a] : Array.from({ length: count }, (_, k) => round2(a + ((b - a) * k) / (count - 1))));

/**
 * Split a whole-string template call "{{name|a|b}}" into { name, args },
 * respecting nested {{ }} and [[ ]]. Returns null if s isn't one template.
 */
export function splitTemplate(s) {
  const str = String(s ?? '').trim();
  if (!str.startsWith('{{') || !str.endsWith('}}')) return null;
  const body = str.slice(2, -2);
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i += 1) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth += 1; cur += two; i += 1; continue; }
    if (two === '}}' || two === ']]') {
      depth -= 1;
      if (depth < 0) return null; // "{{a}} {{b}}" - not a single template
      cur += two; i += 1; continue;
    }
    if (body[i] === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += body[i];
  }
  if (depth !== 0) return null;
  parts.push(cur);
  return { name: parts[0].trim().toLowerCase(), args: parts.slice(1).map((a) => a.trim()) };
}

/** Strip display-only wrappers: {{tt|{{ap|9 to 5}}|note}} -> {{ap|9 to 5}}, {{fd|0.5}} -> 0.5. */
function unwrap(s) {
  let out = String(s ?? '').trim();
  for (let n = 0; n < 5; n += 1) {
    const t = splitTemplate(out);
    if (!t) break;
    if (['tt', 'tip', 'sti', 'as', 'fd', 'nie'].includes(t.name) && t.args.length) out = t.args[0];
    else break;
  }
  return out.trim();
}

/**
 * A per-rank value -> array of n numbers, or null if it isn't one.
 *   "30", "{{fd|0.5}}", "{{ap|35 to 25}}", "{{ap|3|3|4|4|5}}", "12 / 11 / 10"
 */
export function parseRankValue(raw, n) {
  const s = unwrap(raw);
  if (!s) return null;
  if (/^[\d.]+$/.test(s)) return Array(n).fill(Number(s));
  if (/^[\d.]+(\s*\/\s*[\d.]+)+$/.test(s)) return s.split('/').map((x) => Number(x.trim()));
  const t = splitTemplate(s);
  if (!t || t.name !== 'ap' || !t.args.length) return null;
  const inner = t.args[0];
  // "16 to 6", "16 to 6 for 6", and the shorthand "16 to 6 6" (count after a space)
  const to = /^([\d.]+)\s+to\s+([\d.]+)(?:\s+(?:for\s+)?(\d+))?$/.exec(inner);
  if (to && t.args.length === 1) return linear(Number(to[1]), Number(to[2]), to[3] ? Number(to[3]) : n);
  if (t.args.every((p) => /^[\d.]+$/.test(p))) {
    const nums = t.args.map(Number);
    return nums.length === 1 ? Array(n).fill(nums[0]) : nums;
  }
  return null;
}

/**
 * A per-level value ({{pp|...}}) -> { values, levels } or null.
 *   "{{pp|10;15;20|1;6;11}}", "{{pp|14 to 8 for 3|1 to 13}}", "{{pp|22 to 10}}"
 */
export function parseLevelValue(raw) {
  const s = unwrap(raw);
  const t = splitTemplate(s);
  if (!t || !['pp', 'pplevel'].includes(t.name)) return null;
  // Named args (formula=, type=, key1=...) mean "scales with something other
  // than level" or a custom formula: not parsed, reported instead.
  const positional = t.args.filter((a) => !/^\w+\s*=/.test(a));
  if (t.args.some((a) => /^type\s*=/.test(a))) return null;
  const [vRaw = '', lRaw = ''] = positional;
  // Explicit levels first, so "12 to 6" can be spread across them.
  // A formula with no explicit levels ("capped at level 9") can't be spread
  // safely across 1-18 - report it rather than guess.
  if (!lRaw && t.args.some((a) => /^formula\s*=/.test(a))) return null;
  let levels = null;
  const lto = /^(\d+)\s+to\s+(\d+)$/.exec(lRaw);
  if (/^\d+(;\d+)*$/.test(lRaw)) levels = lRaw.split(';').map(Number);
  else if (lRaw && !lto) return null;

  let values;
  const to = /^([\d.]+)\s+to\s+([\d.]+)(?:\s+for\s+(\d+))?$/.exec(vRaw);
  if (to) values = linear(Number(to[1]), Number(to[2]), to[3] ? Number(to[3]) : levels ? levels.length : 18);
  else if (/^[\d.]+(;[\d.]+)*$/.test(vRaw)) values = vRaw.split(';').map(Number);
  else return null;

  if (!levels) {
    if (lto) levels = linear(Number(lto[1]), Number(lto[2]), values.length).map(Math.round);
    else levels = values.length === 18 ? Array.from({ length: 18 }, (_, k) => k + 1) : linear(1, 18, values.length).map(Math.round);
  }
  if (levels.length !== values.length) return null;
  return { values, levels };
}

/** |field = value lines of a Data template. */
export function templateFields(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\|(\w+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Maximum charges: "{{st|Maximum Charges|{{ap|3 to 5}}}}" or prose "up to a maximum of 2". */
export function findMaxCharges(text, n) {
  const re = /\{\{st\|([^|{}]*(?:[Cc]harge|[Tt]raps|[Ss]tored|[Kk]egs|[Ss]entinels|[Aa]mmo)[^|{}]*)\|(\{\{ap\|[^}]+\}\}|[\d.]+)\}\}/g;
  for (const m of String(text).matchAll(re)) {
    if (!/max/i.test(m[1])) continue;
    const v = parseRankValue(m[2], n);
    if (v) return { label: m[1], values: v };
  }
  const prose = /up to a maximum of (\d+)(?!\s*(?:seconds|%|stacks? of))/i.exec(String(text));
  if (prose) return { label: 'prose', values: Array(n).fill(Number(prose[1])) };
  return null;
}
