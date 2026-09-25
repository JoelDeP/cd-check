/**
 * Matchup mode: my champion vs the enemy, side by side, at a chosen level.
 *
 * Each side is { champ, level, order, loadout, summoners }. The loadout is
 * what js/haste.js computes haste from, so everything shown here - every
 * cooldown, the totals, the trade windows - comes from the one calculator.
 *
 * Each side has a loadout bar built for fast, one-handed input mid-game: a
 * live total chip, a big level stepper, a tap-to-add grid of haste items,
 * a big Hextech counter, and toggles for the common haste runes. The enemy's
 * bar is open; yours is collapsed. Every tap applies instantly.
 *
 * Phase 3 slots in without restructuring: the Live Client bridge will call
 * view.setSide('vs', { level, loadout: { items, ... }, summoners }) and mark
 * loadout.live[field] = true for what it filled. Fields the API cannot see
 * (haste-sources.json `live: null` or 'self-only' on the enemy side) then get
 * a "manual" label - see manualTag().
 */

import { el, clear, icon, flagBadge, verifiedPill, toast } from '../ui.js';
import { SLOTS, fmt } from '../model.js';
import { computeHaste, abilityCooldown, summonerCooldown, cooldownIndex } from '../haste.js';
import { cdPair, cdLine, hasNoCooldown, staticTag, mechanicsBadge } from '../ability-ui.js';
import { describeGrants, rankItemsFor } from '../items.js';
import { ORDERS, resolveOrder, ranksAtLevel, skillSequence } from '../skill-order.js';
import { defaultMatchup, encodeMatchup } from '../matchup-state.js';
import { searchChampions } from '../search.js';
import { laneChips, inLane, laneRoster } from '../lanes.js';
import { staleness } from '../patch.js';
import { settings, set } from '../store.js';

const SIDES = [
  { key: 'me', label: 'You' },
  { key: 'vs', label: 'Enemy' },
];
const MAX_ITEMS = 6;
const KIND_SHORT = { ability: 'AH', basic: 'basic AH', ultimate: 'ult AH', summoner: 'summoner haste', item: 'item haste' };

export function createMatchupView(ctx) {
  const root = el('section', { id: 'view-matchup', class: 'view', hidden: true });
  const data = ctx.matchupData || {};
  const runeById = Object.fromEntries((ctx.hasteCtx.sources.runes || []).map((r) => [r.id, r]));
  const buffById = Object.fromEntries((ctx.hasteCtx.sources.buffs || []).map((b) => [b.id, b]));
  const formIndex = { me: 0, vs: 0 };
  const itemQuery = { me: '', vs: '' };
  // haste-sources.json entries go stale like overrides do.
  const srcPill = (src) => verifiedPill(staleness(src?.verifiedPatch, ctx.patch));

  let state = normalise(settings.matchup) || defaultMatchup(pinned());

  /* ------------------------------------------------------------- helpers */

  function pinned() {
    const p = settings.pinned || data.pinnedDefault || ['Renekton', 'Camille', 'Jax'];
    return p.filter((id) => ctx.champions[id]);
  }

  function normalise(m) {
    if (!m || !m.me || !m.vs) return null;
    for (const s of [m.me, m.vs]) {
      if (!ctx.champions[s.champ]) return null;
      s.level = Math.max(1, Math.min(18, Number(s.level) || 6));
      s.loadout = { items: [], buffs: {}, runes: {}, extra: [], bonusAD: 0, live: {}, ...(s.loadout || {}) };
      s.loadout.items = dedupeItems(s.loadout.items);
      if (!Array.isArray(s.summoners) || s.summoners.length !== 2) s.summoners = ['SummonerFlash', 'SummonerTeleport'];
    }
    m.linkLevels = m.linkLevels !== false;
    return m;
  }

  /** Shop rules on any incoming list (links, saved state): 6 max, one boots, no duplicate legendaries. */
  function dedupeItems(list) {
    const out = [];
    let boots = false;
    for (const id of list || []) {
      const it = ctx.hasteCtx.items[id];
      if (!it || out.length >= MAX_ITEMS) continue;
      if (it.group === 'Boots') { if (boots) continue; boots = true; }
      if (it.group === 'Legendary' && out.includes(id)) continue;
      out.push(id);
    }
    return out;
  }

  function save() {
    set({ matchup: state });
  }

  const champOf = (k) => ctx.champions[state[k].champ];
  const orderOf = (k) => resolveOrder(state[k].champ, settings.skillOrders, data.skillOrders);

  function hasteOf(k) {
    const s = state[k];
    const ranged = s.loadout.rangedOverride ?? champOf(k)?.ranged ?? false;
    return computeHaste({ ...s.loadout, level: s.level, ranged }, ctx.hasteCtx);
  }

  /** Phase 3: label a control "manual" when live data is connected but can't fill it. */
  function manualTag(k, liveKey) {
    if (!ctx.live?.connected) return null;
    const fillable = liveKey && !(k === 'vs' && liveKey === 'self-only');
    if (fillable && state[k].loadout.live?.[liveKey]) return null;
    return el('span', { class: 'tag-manual', text: 'manual' });
  }

  function keysFor(champId) {
    const base = (data.keys?.[champId] || []).map((k) => ({ ...k }));
    const over = settings.keyOverrides?.[champId] || {};
    const out = base.filter((k) => over[k.slot] !== false);
    for (const [slot, on] of Object.entries(over)) {
      if (on && !out.some((k) => k.slot === slot)) out.push({ slot, role: 'trade', user: true });
    }
    return out.sort((a, b) => 'PQWER'.indexOf(a.slot) - 'PQWER'.indexOf(b.slot));
  }

  function toggleKey(champId, slot) {
    const isKey = keysFor(champId).some((k) => k.slot === slot);
    const over = { ...(settings.keyOverrides || {}) };
    over[champId] = { ...(over[champId] || {}), [slot]: !isKey };
    set({ keyOverrides: over });
    renderDerived();
  }

  /** Change one side's level (both when linked) and redraw what depends on it. */
  function setLevel(k, v) {
    const lvl = Math.max(1, Math.min(18, v));
    if (state.linkLevels) {
      state.me.level = lvl;
      state.vs.level = lvl;
    } else {
      state[k].level = lvl;
    }
    save();
    renderLevelBar();
    for (const { key } of SIDES) if (state.linkLevels || key === k) renderSideParts(key);
    renderWindows();
  }

  /* ------------------------------------------------------ small controls */

  function stepper({ value, min = 0, max = 99, onChange, label, big = false }) {
    const bump = (d) => onChange(Math.max(min, Math.min(max, value + d)));
    return el(
      'span',
      { class: `stepper${big ? ' stepper-big' : ''}`, role: 'group', 'aria-label': label },
      el('button', { type: 'button', class: 'step', 'aria-label': `${label} down`, disabled: value <= min, onclick: () => bump(-1) }, '−'),
      el('span', { class: 'step-val', text: String(value) }),
      el('button', { type: 'button', class: 'step', 'aria-label': `${label} up`, disabled: value >= max, onclick: () => bump(1) }, '+')
    );
  }

  function toggleChip({ on, text, title, onClick, extra }) {
    return el(
      'span',
      { class: `toggle-wrap${on ? ' on' : ''}` },
      el('button', { type: 'button', class: `chip chip-big${on ? ' on' : ''}`, 'aria-pressed': String(on), title, onclick: onClick, text }),
      extra || null
    );
  }

  /* ------------------------------------------------------------ top bar */

  const bar = el('div', { class: 'mu-bar' });

  function renderTopBar() {
    clear(bar);
    const favs = settings.favorites || [];
    bar.append(
      el(
        'div',
        { class: 'mu-favs', role: 'group', 'aria-label': 'Favourite matchups' },
        favs.length
          ? favs.map((f, i) =>
            el(
              'span',
              { class: 'fav' },
              el('button', { type: 'button', class: 'chip', text: f.label, onclick: () => loadQuery(f.query) }),
              el('button', {
                type: 'button',
                class: 'fav-x',
                'aria-label': `Remove ${f.label}`,
                onclick: () => { set({ favorites: favs.filter((_, j) => j !== i) }); renderTopBar(); },
              }, '×')
            ))
          : el('span', { class: 'hint', text: 'No favourites yet.' })
      ),
      el(
        'div',
        { class: 'mu-actions' },
        el('button', { type: 'button', class: 'chip', onclick: saveFavorite }, '★ Save'),
        el('button', { type: 'button', class: 'chip on', onclick: copyLink }, 'Copy link')
      )
    );
  }

  function saveFavorite() {
    const label = `${champOf('me').name} vs ${champOf('vs').name} L${state.me.level}`;
    const query = encodeMatchup(state);
    const favs = (settings.favorites || []).filter((f) => f.label !== label);
    set({ favorites: [{ label, query }, ...favs].slice(0, 20) });
    renderTopBar();
    toast(`Saved “${label}”`, 2500);
  }

  function shareUrl() {
    return `${location.origin}${location.pathname}?${encodeMatchup(state)}#matchup`;
  }

  async function copyLink() {
    const url = shareUrl();
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied — it opens this exact matchup, loadouts included.', 2500);
    } catch {
      toast(`Copy this link:\n${url}`, 12000);
    }
  }

  function loadQuery(query) {
    const m = ctx.decodeQuery?.(query);
    if (m) setState(m);
  }

  /* ---------------------------------------------------------- level bar */

  const levelBar = el('section', { class: 'panel mu-level', 'aria-label': 'Champion level' });

  function renderLevelBar() {
    clear(levelBar);
    const slider = el('input', {
      type: 'range', class: 'slider', min: '1', max: '18', step: '1',
      value: String(state.me.level), 'aria-label': 'Level',
      oninput: (e) => setLevel('me', Number(e.target.value)),
    });
    levelBar.append(
      el(
        'div',
        { class: 'mu-level-row' },
        el('span', { class: 'field-label', text: state.linkLevels ? 'Level' : 'Your level' }),
        stepper({ value: state.me.level, min: 1, max: 18, onChange: (v) => setLevel('me', v), label: 'Level' }),
        slider,
        el(
          'label',
          { class: 'mu-link' },
          el('input', {
            type: 'checkbox',
            checked: state.linkLevels,
            onchange: (e) => {
              state.linkLevels = e.target.checked;
              if (state.linkLevels) state.vs.level = state.me.level;
              save();
              renderAll();
            },
          }),
          ' same level'
        )
      )
    );
  }

  /* ------------------------------------------------------- trade windows */

  const windowsEl = el('section', { class: 'panel mu-windows', 'aria-label': 'Trade windows' });

  function renderWindows() {
    clear(windowsEl);
    const enemy = champOf('vs');
    const { totals } = hasteOf('vs');
    const ranks = ranksAtLevel(enemy, orderOf('vs'), state.vs.level);
    const form = enemy.forms[Math.min(formIndex.vs, enemy.forms.length - 1)];
    const keys = keysFor(enemy.id);

    windowsEl.append(el('h3', {}, 'Trade windows ', el('span', { class: 'hint', text: `when ${enemy.name} uses…` })));
    if (!keys.length) {
      windowsEl.append(el('p', { class: 'hint', text: `No key abilities set for ${enemy.name}. Tap ☆ on the enemy's abilities below to add some.` }));
      return;
    }
    const list = el('ul', { class: 'window-list' });
    for (const k of keys) {
      const a = form.abilities[k.slot];
      if (!a) continue;
      const idx = cooldownIndex(a, state.vs.level, ranks[k.slot]);
      const roleText = data.roleText?.[k.role] || 'trade window';
      if (idx < 0) {
        list.append(el('li', { class: 'window muted' },
          el('span', { class: 'slot-key', text: k.slot }),
          el('span', { class: 'window-name', text: a.name }),
          el('span', { class: 'hint', text: 'not learned yet at this level' })));
        continue;
      }
      const cd = abilityCooldown(a, idx, totals);
      if (!cd.base) continue;
      list.append(el(
        'li',
        { class: `window role-${k.role}` },
        icon(a.icon, '', 'icon icon-sm'),
        el('span', { class: 'slot-key', text: k.slot }),
        el('span', { class: 'window-name', text: `${enemy.name} ${k.slot} ${a.name}` }),
        el('span', { class: 'window-arrow', text: cd.recharge ? 'out of charges →' : 'on cooldown →' }),
        // Charge abilities: the window is the recharge of one charge.
        el('span', { class: 'window-cd', text: `${fmt(cd.final)}s` }),
        cd.recharge
          ? el('span', { class: 'window-charges', text: `per charge (${cd.charges} charges${cd.between?.base ? `, ${fmt(cd.between.final)}s between casts` : ''})` })
          : null,
        el('span', { class: 'window-role', text: `→ ${roleText}` }),
        a.mechanics?.length ? mechanicsBadge(a) : null
      ));
    }
    windowsEl.append(list);
  }

  /* ---------------------------------------------------------------- sides */

  const sidesEl = el('div', { class: 'mu-sides' });
  const parts = {};

  function buildSide(k, label) {
    const p = {
      root: el('section', { class: `panel mu-side mu-${k}`, 'aria-label': label }),
      head: el('div', { class: 'mu-head' }),
      loadout: el('div', { class: 'mu-loadout-slot' }),
      order: el('div', { class: 'mu-order' }),
      cds: el('div', { class: 'mu-cds' }),
      sums: el('div', { class: 'mu-sums' }),
    };
    p.root.append(el('div', { class: 'mu-side-label', text: label }), p.head, p.loadout, p.order, p.cds, p.sums);
    parts[k] = p;
    return p.root;
  }

  /* --- head: champion + picker (+ lane filter for the enemy) + pinned */

  function renderHead(k) {
    const p = parts[k];
    clear(p.head);
    const champ = champOf(k);
    const isPinned = pinned().includes(champ.id);
    const withLanes = k === 'vs';

    const input = el('input', {
      type: 'search', class: 'search-input mu-search',
      placeholder: withLanes ? 'Enemy champion…' : 'Change champion…',
      autocomplete: 'off', spellcheck: 'false',
      'aria-label': `${k === 'me' ? 'Your' : 'Enemy'} champion`,
    });
    const results = el('ul', { class: 'results', role: 'listbox', hidden: true });
    let matches = [];
    let active = 0;
    const renderResults = () => {
      clear(results);
      results.hidden = !matches.length;
      matches.forEach((c, i) => results.append(el('li', {
        class: `result${i === active ? ' active' : ''}`,
        role: 'option',
        onmousedown: (e) => { e.preventDefault(); pick(c.id); },
      }, icon(c.icon, '', 'icon icon-sm'), el('span', { class: 'result-name', text: c.name }))));
    };
    const lane = () => (withLanes ? settings.lane || 'all' : 'all');
    const runSearch = (browse = false) => {
      const q = input.value.trim();
      if (q) matches = searchChampions(ctx.index, q, 80).filter((c) => inLane(c, lane())).slice(0, 8);
      else matches = browse && lane() !== 'all' ? laneRoster(ctx.champions, lane()) : [];
      active = 0;
      renderResults();
    };
    const pick = (id) => {
      state[k].champ = id;
      state[k].order = null;
      formIndex[k] = 0;
      save();
      renderSide(k);
      renderWindows();
    };
    input.addEventListener('input', () => runSearch());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, matches.length - 1); renderResults(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); renderResults(); }
      else if (e.key === 'Enter' && matches[active]) { e.preventDefault(); pick(matches[active].id); }
      else if (e.key === 'Escape') { input.value = ''; matches = []; renderResults(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { matches = []; renderResults(); }, 120));

    const laneRow = withLanes
      ? laneChips(settings.lane, (l) => {
        set({ lane: l });
        renderHead(k);
        const fresh = parts[k].head.querySelector('.mu-search');
        fresh.focus();
        fresh.dispatchEvent(new CustomEvent('browse'));
      })
      : null;
    input.addEventListener('browse', () => runSearch(true));

    const pinBtn = el('button', {
      type: 'button',
      class: `pin${isPinned ? ' on' : ''}`,
      title: isPinned ? 'Unpin from quick picks' : 'Pin to quick picks',
      'aria-pressed': String(isPinned),
      onclick: () => {
        const cur = pinned();
        set({ pinned: isPinned ? cur.filter((id) => id !== champ.id) : [...cur, champ.id].slice(0, 8) });
        renderHead('me');
        renderHead('vs');
      },
    }, isPinned ? '★' : '☆');

    p.head.append(...[
      el(
        'div',
        { class: 'mu-champ' },
        icon(champ.icon, champ.name, 'portrait portrait-sm'),
        el('div', { class: 'mu-champ-text' },
          el('h2', { text: champ.name }),
          el('p', { class: 'card-sub', text: [champ.tags.join(' · '), champ.lanes?.length ? champ.lanes.join(' / ') : ''].filter(Boolean).join(' — ') })),
        pinBtn
      ),
      laneRow,
      el('div', { class: 'search-wrap mu-search-wrap' }, input, results),
      el(
        'div',
        { class: 'quick-row mu-pins', role: 'group', 'aria-label': 'Pinned champions' },
        pinned().map((id) => el('button', {
          type: 'button',
          class: `chip chip-pin${id === champ.id ? ' on' : ''}`,
          onclick: () => pick(id),
        }, icon(ctx.champions[id].icon, '', 'icon icon-xs'), ctx.champions[id].name))
      ),
      champ.forms.length > 1
        ? el('div', { class: 'form-tabs' }, champ.forms.map((f, i) => el('button', {
          type: 'button',
          class: `chip chip-form${i === formIndex[k] ? ' on' : ''}`,
          text: f.short || f.name,
          onclick: () => { formIndex[k] = i; renderHead(k); renderDerived(); },
        })))
        : null,
    ].filter(Boolean));
  }

  /* --- the loadout bar */

  /** "35 AH · 0 ult · 18 summ" */
  function totalsChip(totals) {
    const part = (v, label, cls) => el('span', { class: `lt-part ${cls}${v ? '' : ' zero'}` },
      el('b', { text: fmt(v) }), ` ${label}`);
    return el('span', { class: 'loadout-total' },
      part(totals.ability, 'AH', 'ah'),
      totals.basic ? [' · ', part(totals.basic, 'basic', 'basic')] : null,
      ' · ', part(totals.ultimate, 'ult', 'ult'),
      ' · ', part(totals.summoner, 'summ', 'summ'));
  }

  function renderLoadout(k) {
    const p = parts[k];
    const wasOpen = p.loadout.querySelector('details.loadout')?.open;
    clear(p.loadout);
    const s = state[k];
    const L = s.loadout;
    const champ = champOf(k);
    const { totals, lines, notes } = hasteOf(k);
    const changed = () => { save(); renderLoadout(k); renderSideParts(k, { loadout: false }); renderWindows(); };

    // Items: owned chips (tap to remove), search, tap-to-add icon grid.
    const owned = L.items.map((id) => ctx.hasteCtx.items[id]).filter(Boolean);
    const hasBoots = owned.some((it) => it.group === 'Boots');
    const full = L.items.length >= MAX_ITEMS;
    const blocked = (it) => full || (it.group === 'Boots' && hasBoots) || (it.group === 'Legendary' && L.items.includes(it.id));
    const ownedRow = el('div', { class: 'owned-items' },
      owned.length
        ? owned.map((it, i) => el('button', {
          type: 'button', class: 'owned-item', title: `Remove ${it.name}`, 'aria-label': `Remove ${it.name}`,
          onclick: () => { L.items.splice(i, 1); changed(); },
        }, icon(it.icon, '', 'icon'), el('span', { class: 'owned-x', text: '×' })))
        : el('span', { class: 'hint', text: 'No items — tap one below.' }));

    const history = settings.itemHistory?.[champ.id] || [];
    const q = itemQuery[k].trim().toLowerCase();
    const ranked = rankItemsFor(ctx.hasteCtx.items, champ, history)
      .filter((it) => !q || it.name.toLowerCase().includes(q));
    const grid = el('div', { class: 'item-grid', role: 'group', 'aria-label': 'Haste items' },
      ranked.map((it) => el('button', {
        type: 'button',
        class: `grid-item${blocked(it) ? ' blocked' : ''}`,
        disabled: blocked(it),
        title: `${it.name}: ${describeGrants(it.grants) || it.note}`,
        'aria-label': `Add ${it.name} (${describeGrants(it.grants) || 'see note'})`,
        onclick: () => {
          if (blocked(it)) return;
          L.items.push(it.id);
          const hist = { ...(settings.itemHistory || {}) };
          hist[champ.id] = [it.id, ...(hist[champ.id] || []).filter((x) => x !== it.id)].slice(0, 12);
          set({ itemHistory: hist });
          changed();
        },
      }, icon(it.icon, '', 'icon'), el('span', { class: 'grid-cap', text: gridCaption(it) }))));
    const search = el('input', {
      type: 'search', class: 'search-input item-search', placeholder: 'Filter items…',
      value: itemQuery[k], 'aria-label': 'Filter items',
      oninput: (e) => {
        itemQuery[k] = e.target.value;
        const pos = e.target.selectionStart;
        renderLoadout(k);
        const again = parts[k].loadout.querySelector('.item-search');
        again.focus();
        again.setSelectionRange(pos, pos);
      },
    });

    // Drakes, level, rune toggles - irrelevant ones hidden.
    const hx = buffById.hextech;
    const blue = buffById.blue;
    const lvl = s.level;
    const rune = (id) => runeById[id];
    const runeOn = (id) => L.runes[id] !== undefined && L.runes[id] !== false && L.runes[id] !== null;
    const flip = (id, stacked) => () => { if (runeOn(id)) delete L.runes[id]; else L.runes[id] = stacked ? 0 : true; changed(); };
    // Transcendence does nothing before level 5, Ultimate Hunter nothing before R (6).
    const showTransc = lvl >= 5 || runeOn('transcendence');
    const showUH = lvl >= 6 || runeOn('ultimateHunter');

    const toggles = el('div', { class: 'loadout-toggles' },
      blue ? toggleChip({ on: Boolean(L.buffs.blue), text: 'Blue buff', title: blue.note, onClick: () => { L.buffs.blue = !L.buffs.blue; changed(); }, extra: [manualTag(k, blue.live), srcPill(blue)] }) : null,
      rune('cosmic') ? toggleChip({ on: runeOn('cosmic'), text: 'Cosmic', title: rune('cosmic').name, onClick: flip('cosmic'), extra: [manualTag(k, rune('cosmic').live), srcPill(rune('cosmic'))] }) : null,
      rune('shardAH') ? toggleChip({ on: runeOn('shardAH'), text: 'AH shard', title: rune('shardAH').name, onClick: flip('shardAH'), extra: srcPill(rune('shardAH')) }) : null,
      showTransc && rune('transcendence') ? toggleChip({ on: runeOn('transcendence'), text: 'Transcendence', title: rune('transcendence').note, onClick: flip('transcendence'), extra: srcPill(rune('transcendence')) }) : null,
      showUH && rune('ultimateHunter') ? toggleChip({
        on: runeOn('ultimateHunter'), text: 'Ult Hunter', title: rune('ultimateHunter').note, onClick: flip('ultimateHunter', true),
        extra: runeOn('ultimateHunter')
          ? stepper({ value: Number(L.runes.ultimateHunter) || 0, max: 5, label: 'Bounty Hunter stacks', onChange: (n) => { L.runes.ultimateHunter = n; changed(); } })
          : srcPill(rune('ultimateHunter')),
      }) : null);

    // Less common inputs, tucked away.
    const extraVal = (kind) => L.extra.find((e) => e.kind === kind)?.amount || 0;
    const setExtra = (kind, amount) => {
      L.extra = L.extra.filter((e) => e.kind !== kind);
      if (amount) L.extra.push({ kind, amount, label: kind === 'ability' ? 'Manual ability haste' : 'Manual ultimate haste' });
      save();
      renderSideParts(k, { loadout: false });
      renderWindows();
      const chip = parts[k].loadout.querySelector('.loadout-total');
      if (chip) chip.replaceWith(totalsChip(hasteOf(k).totals));
    };
    const numBox = (label, value, onInput, max = 300) => el('label', { class: 'ctrl' }, label, ' ',
      el('input', {
        type: 'number', class: 'num num-sm', min: '0', max: String(max), step: '1', value: String(value || 0),
        inputmode: 'numeric', oninput: (e) => onInput(Math.max(0, Math.min(max, Number(e.target.value) || 0))),
      }));
    const hasFormula = L.items.some((id) => ctx.hasteCtx.items[id]?.formula);
    const ranged = L.rangedOverride ?? champ.ranged;
    const stackRune = (id) => {
      const r = rune(id);
      if (!r) return null;
      return toggleChip({
        on: runeOn(id), text: r.short || r.name, title: r.note || r.name, onClick: flip(id, true),
        extra: runeOn(id)
          ? stepper({ value: Number(L.runes[id]) || 0, max: Math.max(...r.grants.map((g) => g.maxStacks || 0), 0) || 20, label: r.stacksLabel || 'stacks', onChange: (n) => { L.runes[id] = n; changed(); } })
          : srcPill(r),
      });
    };
    const cin = buffById.cinders;
    const more = el('details', { class: 'loadout-more' },
      el('summary', { text: 'More: other runes, cinders, manual haste' }),
      el('div', { class: 'loadout-toggles' },
        stackRune('jack'),
        stackRune('legendHaste'),
        rune('axiomArcanist') ? toggleChip({ on: runeOn('axiomArcanist'), text: 'Axiom', title: rune('axiomArcanist').note, onClick: flip('axiomArcanist') }) : null,
        cin ? el('span', { class: 'ctrl', title: cin.note }, 'Cinders ', stepper({ value: Number(L.buffs.cinders) || 0, max: 20, label: 'Infernal cinders', onChange: (v) => { L.buffs.cinders = v; changed(); } })) : null),
      el('div', { class: 'loadout-toggles' },
        numBox('+AH', extraVal('ability'), (v) => setExtra('ability', v)),
        numBox('+Ult', extraVal('ultimate'), (v) => setExtra('ultimate', v)),
        hasFormula ? numBox('Bonus AD', L.bonusAD, (v) => { L.bonusAD = v; save(); renderSideParts(k, { loadout: false }); renderWindows(); }, 1000) : null,
        hasFormula ? toggleChip({ on: ranged, text: ranged ? 'Ranged' : 'Melee', title: 'Endless Hunger: 13% (melee) / 10% (ranged) of bonus AD', onClick: () => { L.rangedOverride = !ranged; changed(); } }) : null));

    const breakdown = el('details', { class: 'breakdown' },
      el('summary', {}, 'Where the haste comes from'),
      lines.length
        ? el('ul', { class: 'breakdown-list' }, lines.map((l) => el('li', {},
          el('span', { class: 'b-amt', text: `+${fmt(l.amount)}` }),
          el('span', { class: 'b-kind', text: KIND_SHORT[l.kind] }),
          el('span', { class: 'b-src', text: l.label }),
          l.hint ? el('span', { class: 'hint', text: `(${l.hint})` }) : null,
          el('span', { class: `b-group g-${l.group}`, text: l.group }))))
        : el('p', { class: 'hint', text: 'Nothing yet.' }),
      notes.map((n) => el('p', { class: 'note note-flag' }, el('strong', { text: `${n.label}: ` }), n.note)));

    const body = el('div', { class: 'loadout-body' },
      el('div', { class: 'loadout-row' },
        // Each label stays with its control when the row wraps on a phone.
        el('span', { class: 'loadout-pair' },
          el('span', { class: 'loadout-label', text: state.linkLevels ? 'Level (both)' : 'Level' }),
          stepper({ value: lvl, min: 1, max: 18, big: true, label: 'Level', onChange: (v) => setLevel(k, v) })),
        hx ? el('span', { class: 'loadout-pair' },
          el('span', { class: 'loadout-label', text: 'Hextech' }),
          stepper({ value: Number(L.buffs.hextech) || 0, max: hx.grants[0].maxStacks || 4, big: true, label: 'Hextech Drake stacks', onChange: (v) => { L.buffs.hextech = v; changed(); } }),
          manualTag(k, hx.live),
          srcPill(hx)) : null),
      toggles,
      el('div', { class: 'loadout-row loadout-items-head' },
        el('span', { class: 'loadout-label', text: `Items ${owned.length}/${MAX_ITEMS}` }),
        ownedRow),
      search,
      grid,
      more,
      breakdown);

    const reset = el('button', {
      type: 'button', class: 'chip reset-btn', title: 'Clear items, drakes and runes (keeps champion and level)',
      onclick: (e) => {
        e.preventDefault();
        s.loadout = { items: [], buffs: {}, runes: {}, extra: [], bonusAD: 0, live: {} };
        itemQuery[k] = '';
        changed();
      },
    }, 'Reset');

    const head = el('div', { class: 'loadout-head' },
      el('span', { class: 'loadout-title', text: k === 'vs' ? 'Enemy loadout' : 'Your loadout' }),
      totalsChip(totals),
      reset);

    // The enemy's bar is open; yours starts collapsed (<details>, remembered while open).
    const box = el('details', { class: `loadout loadout-${k}` }, el('summary', {}, head), body);
    box.open = wasOpen ?? (k === 'vs');
    p.loadout.append(box);
  }

  function gridCaption(it) {
    const g = Object.fromEntries(it.grants.map((x) => [x.kind, x.amount]));
    const bits = [];
    if (g.ability) bits.push(`${g.ability}`);
    if (g.basic) bits.push(`${g.basic}b`);
    if (g.ultimate) bits.push(`${g.ultimate}u`);
    if (g.summoner) bits.push(`${g.summoner}s`);
    return bits.join('·') || (it.formula ? 'AD%' : '?');
  }

  /* --- skill order */

  function renderOrder(k) {
    const p = parts[k];
    clear(p.order);
    const champ = champOf(k);
    const order = orderOf(k);
    const seq = skillSequence(champ, order);
    const lvl = state[k].level;
    const pretty = (o) => o.split('').join(' > ');

    const select = el(
      'select',
      {
        class: 'select',
        'aria-label': 'Skill max order',
        onchange: (e) => {
          const v = e.target.value;
          const overrides = { ...(settings.skillOrders || {}) };
          if (v === 'default') delete overrides[champ.id];
          else overrides[champ.id] = v;
          set({ skillOrders: overrides });
          renderOrder(k);
          renderDerived();
        },
      },
      el('option', { value: 'default', selected: order.source !== 'user' },
        `${order.source === 'generic' ? 'Generic' : 'Standard'}: ${pretty(resolveOrder(champ.id, {}, data.skillOrders).max)}`),
      ORDERS.map((o) => el('option', { value: o, selected: order.source === 'user' && order.max === o }, `Max ${pretty(o)}`))
    );

    p.order.append(
      el('div', { class: 'mu-order-row' },
        el('span', { class: 'field-label', text: 'Skill order' }),
        select),
      el('div', { class: 'seq', 'aria-label': 'Skill sequence' },
        seq.map((sl, i) => el('span', {
          class: `seq-cell${i < lvl ? ' done' : ''}${i === lvl - 1 ? ' now' : ''}${sl === 'R' ? ' r' : ''}`,
          title: `Level ${i + 1}: ${sl || '-'}`,
          text: sl || '·',
        })))
    );
  }

  /* --- cooldown table */

  function renderCds(k) {
    const p = parts[k];
    clear(p.cds);
    const champ = champOf(k);
    const form = champ.forms[Math.min(formIndex[k], champ.forms.length - 1)];
    const { totals } = hasteOf(k);
    const lvl = state[k].level;
    const ranks = ranksAtLevel(champ, orderOf(k), lvl);
    const keys = k === 'vs' ? keysFor(champ.id) : [];

    const rows = SLOTS.map((slot) => {
      const a = form.abilities[slot];
      if (!a) return null;
      const noCd = hasNoCooldown(a);
      const rank = slot === 'P' ? null : ranks[slot];
      const idx = cooldownIndex(a, lvl, rank);
      let value;
      if (noCd) value = el('span', { class: 'cd-pair cd-none', text: 'no cooldown' });
      else if (idx < 0) value = el('span', { class: 'cd-pair cd-none', text: 'not learned' });
      else value = cdLine(abilityCooldown(a, idx, totals));
      const rankText = slot === 'P' ? (a.scaling === 'level' ? `L${lvl}` : '') : `${rank}/${a.maxrank}`;
      const isKey = keys.some((x) => x.slot === slot);
      return el(
        'div',
        { class: `mu-cd${idx < 0 && !noCd ? ' unlearned' : ''}${isKey ? ' is-key' : ''}${a.ammo?.recharge ? ' has-charges' : ''}`, dataset: { slot } },
        el('span', { class: 'slot-key', text: slot }),
        icon(a.icon, '', 'icon icon-sm'),
        el('span', { class: 'mu-cd-name' }, el('span', { text: a.name }), staticTag(a), verifiedPill(a.verified)),
        el('span', { class: 'mu-cd-rank', text: rankText }),
        value,
        mechanicsBadge(a),
        flagBadge(a.flags.filter((f) => f.code !== 'passive' && f.code !== 'none')),
        k === 'vs' && slot !== 'P'
          ? el('button', {
            type: 'button',
            class: `star${isKey ? ' on' : ''}`,
            title: isKey ? 'Remove from trade windows' : 'Add to trade windows',
            'aria-pressed': String(isKey),
            onclick: () => toggleKey(champ.id, slot),
          }, isKey ? '★' : '☆')
          : null
      );
    });
    p.cds.append(el('div', { class: 'mu-cd-head' },
      el('span', { text: `Cooldowns at level ${lvl}` }),
      el('span', { class: 'hint', text: 'base → with haste' })), ...rows.filter(Boolean));
  }

  /* --- summoners */

  function renderSums(k) {
    const p = parts[k];
    clear(p.sums);
    const { totals } = hasteOf(k);
    const byId = Object.fromEntries(ctx.summoners.map((x) => [x.id, x]));
    const rows = state[k].summoners.map((id, i) => {
      const s = byId[id] || ctx.summoners[0];
      const cd = summonerCooldown(s.cooldown, totals);
      const select = el('select', {
        class: 'select select-sm',
        'aria-label': `Summoner spell ${i + 1}`,
        onchange: (e) => { state[k].summoners[i] = e.target.value; save(); renderSums(k); },
      }, ctx.summoners.map((o) => el('option', { value: o.id, selected: o.id === s.id }, o.name)));
      return el('div', { class: 'mu-sum' },
        icon(s.icon, '', 'icon icon-sm'),
        select,
        cdPair(cd.base, cd.final),
        s.unreliable ? flagBadge([{ code: 'override', label: 'Caveat', text: s.note }]) : null);
    });
    p.sums.append(el('div', { class: 'mu-cd-head' }, el('span', { text: 'Summoner spells' })), ...rows);
  }

  /* ---------------------------------------------------------- rendering */

  function renderSideParts(k, { loadout = true } = {}) {
    if (loadout) renderLoadout(k);
    else {
      const chip = parts[k].loadout.querySelector('.loadout-total');
      if (chip) chip.replaceWith(totalsChip(hasteOf(k).totals));
    }
    renderOrder(k);
    renderCds(k);
    renderSums(k);
  }

  function renderSide(k) {
    renderHead(k);
    renderSideParts(k);
  }

  function renderDerived() {
    for (const { key } of SIDES) {
      renderSideParts(key, { loadout: false });
    }
    renderWindows();
  }

  function renderAll() {
    renderTopBar();
    renderLevelBar();
    for (const { key } of SIDES) renderSide(key);
    renderWindows();
  }

  function setState(m) {
    const n = normalise(m);
    if (!n) return;
    state = n;
    formIndex.me = 0;
    formIndex.vs = 0;
    save();
    renderAll();
  }

  root.append(
    el('div', { class: 'sort-head' },
      el('h2', { text: 'Matchup' }),
      el('p', { class: 'hint', text: 'Both champions at the same level, ranks from their skill order, cooldowns with each side’s haste.' })),
    bar,
    levelBar,
    windowsEl,
    sidesEl
  );
  sidesEl.append(...SIDES.map((s) => buildSide(s.key, s.label)));
  renderAll();

  return {
    el: root,
    refresh: renderAll,
    setState,
    /** Phase 3 entry point: merge live data into one side. */
    setSide(k, patch) {
      state[k] = { ...state[k], ...patch, loadout: { ...state[k].loadout, ...(patch.loadout || {}) } };
      state[k].loadout.items = dedupeItems(state[k].loadout.items);
      save();
      renderSide(k);
      renderWindows();
    },
    getState: () => state,
  };
}
