/**
 * Lane filtering, shared by the Champion search, the Sort view and the
 * Matchup enemy picker. A champion who plays several lanes appears under each.
 * Lanes come from data/lanes.json (generated, wiki-verified) unless
 * overrides.json sets "lanes" on the champion.
 */

import { el } from './ui.js';
import { LANES } from './model.js';

export const inLane = (champ, lane) => !lane || lane === 'all' || (champ.lanes || []).includes(lane);

/** Every champion in a lane, alphabetical - for browsing with an empty search. */
export function laneRoster(champions, lane) {
  return Object.values(champions)
    .filter((c) => inLane(c, lane))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * "All · Top · Jungle · Mid · Bot · Support" chips. The chips swallow
 * mousedown so tapping one doesn't blur an open search box.
 */
export function laneChips(current, onPick, { label = 'Lane' } = {}) {
  const value = current || 'all';
  return el(
    'div',
    { class: 'quick-row lane-row', role: 'group', 'aria-label': `${label} filter` },
    [{ id: 'all', label: 'All' }, ...LANES].map((l) =>
      el('button', {
        type: 'button',
        class: `chip chip-lane${value === l.id ? ' on' : ''}`,
        'aria-pressed': String(value === l.id),
        text: l.label,
        onmousedown: (e) => e.preventDefault(),
        onclick: () => onPick(l.id),
      }))
  );
}
