/** Second view: every ability in the game, grouped by cooldown, shortest first. */

import { el, clear, icon, flagBadge, verifiedPill } from '../ui.js';
import { fmt, flattenAbilities } from '../model.js';
import { abilityCooldown } from '../haste.js';
import { staticTag, mechanicsBadge } from '../ability-ui.js';
import { settings, set } from '../store.js';

const ROLES = ['All', 'Fighter', 'Tank', 'Mage', 'Assassin', 'Marksman', 'Support'];
const KEYS = ['Q', 'W', 'E', 'R'];
const RANKS = ['1', '2', '3', '4', '5', 'max'];

export function createSortView(ctx) {
  const root = el('section', { id: 'view-sort', class: 'view', hidden: true });
  const rows = flattenAbilities(ctx.champions).filter((r) => r.slot !== 'P');

  const list = el('div', { class: 'cd-groups' });
  const count = el('p', { class: 'hint result-count' });

  /* -------------------------------------------------------------- filters */

  function chipGroup(label, values, isOn, onPick, cls = '') {
    return el(
      'div',
      { class: 'filter' },
      el('span', { class: 'filter-label', text: label }),
      el(
        'div',
        { class: 'quick-row', role: 'group', 'aria-label': label },
        values.map((v) =>
          el('button', {
            type: 'button',
            class: `chip ${cls}${isOn(v) ? ' on' : ''}`,
            text: String(v),
            'aria-pressed': String(isOn(v)),
            onclick: () => { onPick(v); renderFilters(); render(); },
          })
        )
      )
    );
  }

  const filterBar = el('section', { class: 'panel filters', 'aria-label': 'Filters' });

  function renderFilters() {
    clear(filterBar);
    const s = settings.sort;
    filterBar.append(
      chipGroup('Rank', RANKS, (v) => s.rank === v, (v) => set({ sort: { ...s, rank: v } })),
      chipGroup(
        'Key',
        KEYS,
        (v) => s.keys.includes(v),
        (v) => {
          const keys = s.keys.includes(v) ? s.keys.filter((k) => k !== v) : [...s.keys, v];
          set({ sort: { ...s, keys: keys.length ? keys : KEYS.slice() } });
        }
      ),
      chipGroup(
        'Role',
        ROLES,
        (v) => (s.role === 'all' ? v === 'All' : s.role === v),
        (v) => set({ sort: { ...s, role: v === 'All' ? 'all' : v } })
      )
    );
  }

  /* ---------------------------------------------------------------- render */

  function rankIndex(ability) {
    const n = ability.cooldown.length;
    if (settings.sort.rank === 'max') return n - 1;
    return Math.min(Number(settings.sort.rank) - 1, n - 1);
  }

  function render() {
    const s = settings.sort;
    const { totals } = ctx.tabHaste();
    const ah = totals.ability;
    const uh = totals.ultimate;

    const picked = [];
    for (const row of rows) {
      if (!s.keys.includes(row.slot)) continue;
      if (s.role !== 'all' && !row.champ.tags.includes(s.role)) continue;
      const i = rankIndex(row.ability);
      const { base, final } = abilityCooldown(row.ability, i, totals);
      if (!base) continue;
      picked.push({ ...row, rank: i + 1, base, eff: final });
    }

    picked.sort((a, b) =>
      a.eff - b.eff ||
      a.champ.name.localeCompare(b.champ.name) ||
      KEYS.indexOf(a.slot) - KEYS.indexOf(b.slot)
    );

    clear(list);
    count.textContent = `${picked.length} abilities${ah || uh ? ` at ${ah} ability haste${uh ? ` / +${uh} ultimate haste` : ''}` : ''}`;

    let currentKey = null;
    let group = null;
    for (const p of picked) {
      const key = fmt(p.eff);
      if (key !== currentKey) {
        currentKey = key;
        group = el('div', { class: 'cd-group' });
        group.append(
          el(
            'div',
            { class: 'cd-group-head' },
            el('span', { class: 'cd-group-cd', text: `${key}s` })
          )
        );
        list.append(group);
      }
      group.append(abilityChip(p));
    }

    if (!picked.length) {
      list.append(el('p', { class: 'empty', text: 'Nothing matches those filters.' }));
    }
  }

  function abilityChip(p) {
    // A div with button semantics: it contains its own badge buttons, and
    // buttons may not nest.
    const open = () => ctx.onPickChampion?.(p.champ.id);
    const changed = Math.abs(p.eff - p.base) > 1e-9;
    return el(
      'div',
      {
        class: 'cd-row',
        role: 'button',
        tabindex: '0',
        title: `${p.champ.name} ${p.slot} — rank ${p.rank}`,
        onclick: open,
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        },
      },
      icon(p.ability.icon, '', 'icon icon-sm'),
      el('span', { class: 'cd-row-champ', text: p.champ.name }),
      p.form.short ? el('span', { class: 'cd-row-form', text: p.form.short }) : null,
      el('span', { class: 'slot-key slot-key-sm', text: p.slot }),
      el('span', { class: 'cd-row-name', text: p.ability.name }),
      staticTag(p.ability),
      verifiedPill(p.ability.verified),
      mechanicsBadge(p.ability),
      el('span', { class: 'cd-row-rank', text: changed ? `r${p.rank} · base ${fmt(p.base)}` : `r${p.rank}` }),
      flagBadge(p.ability.flags.filter((f) => f.code !== 'passive'))
    );
  }

  root.append(
    el('div', { class: 'sort-head' },
      el('h2', { text: 'Sort by cooldown' }),
      el('p', { class: 'hint', text: 'Every ability in the game, shortest cooldown first. Uses the haste set on the Champion tab.' })),
    filterBar,
    count,
    list
  );

  renderFilters();

  return {
    el: root,
    render,
    refresh() { renderFilters(); render(); },
  };
}
