/** Small DOM helpers. No framework, no build step. */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Warning badge for an ability whose published cooldown cannot be trusted.
 * 'passive' and 'none' are missing data rather than wrong data, so they get a
 * muted info dot instead of a loud warning triangle.
 */
const INFO_CODES = new Set(['passive', 'none', 'charges']);

export function flagBadge(flags) {
  if (!flags || !flags.length) return null;
  const info = flags.every((f) => INFO_CODES.has(f.code));
  const title = flags.map((f) => `${f.label}: ${f.text}`).join('\n\n');
  return el(
    'button',
    {
      class: `flag ${info ? 'flag-info' : 'flag-warn'}`,
      type: 'button',
      title,
      'aria-label': title,
      onclick: (e) => {
        e.stopPropagation();
        toast(flags.map((f) => `${f.label} — ${f.text}`).join('\n\n'));
      },
    },
    info ? '·' : '⚠'
  );
}

/**
 * "verified on 16.19" pill for a hand-verified value the live patch has moved
 * past. Returns null when the value is current (or was never hand-verified).
 */
export function verifiedPill(v) {
  if (!v || !v.stale) return null;
  const label = v.verifiedPatch ? `verified on ${v.verifiedPatch}` : 'unverified';
  const title = v.verifiedPatch
    ? `Last checked on patch ${v.verifiedPatch}; live patch is ${v.livePatch}. May be out of date.`
    : 'Never verified against a patch.';
  return el('span', { class: 'verified-pill', title, text: label });
}

let toastTimer = null;
export function toast(message, ms = 6000) {
  let host = $('#toast');
  if (!host) {
    host = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  host.textContent = message;
  host.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('show'), ms);
}

/** Lazily-loaded square icon that degrades to a blank tile if the CDN 404s. */
export function icon(src, alt, cls = 'icon') {
  return el('img', {
    class: cls,
    src,
    alt,
    loading: 'lazy',
    decoding: 'async',
    onerror: (e) => e.target.classList.add('icon-missing'),
  });
}
