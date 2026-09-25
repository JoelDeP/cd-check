/** Small pieces shared by every view that shows a cooldown. */

import { el, toast } from './ui.js';
import { fmt } from './model.js';

/** "9 → 6.9" (base struck, final bright), or just "9" when nothing changed it. */
export function cdPair(base, final, { static: isStatic = false } = {}) {
  if (!Number.isFinite(base)) return el('span', { class: 'cd-pair cd-none', text: '–' });
  const changed = !isStatic && Math.abs(final - base) > 1e-9;
  return el(
    'span',
    { class: `cd-pair${changed ? ' changed' : ''}` },
    changed ? el('span', { class: 'cd-base', text: fmt(base) }) : null,
    changed ? el('span', { class: 'cd-arrow', 'aria-hidden': 'true', text: '→' }) : null,
    el('span', { class: 'cd-final', text: fmt(changed ? final : base) }),
    el('span', { class: 'cd-unit', text: 's' })
  );
}

/** Tag for cooldowns that ability haste does not touch. */
export function staticTag(ability) {
  if (!ability.static) return null;
  return el('span', {
    class: 'tag-static',
    title: 'Static cooldown: ability haste does not reduce it.',
    text: 'static',
  });
}

/** ↻ badge listing refunds / resets / reductions for this ability. */
export function mechanicsBadge(ability) {
  if (!ability.mechanics?.length) return null;
  const text = ability.mechanics.join('\n\n');
  return el(
    'button',
    {
      class: 'mech-badge',
      type: 'button',
      title: text,
      'aria-label': `Cooldown mechanics: ${text}`,
      onclick: (e) => {
        e.stopPropagation();
        toast(`${ability.name}\n\n${text}`);
      },
    },
    '↻'
  );
}

/** Mechanics as paragraphs, for expanded ability details. */
export function mechanicsNotes(ability) {
  return (ability.mechanics || []).map((m) =>
    el('p', { class: 'note note-mech' }, el('strong', { text: '↻ ' }), m)
  );
}

/**
 * Which cooldown-array entries to show as chips. 18-entry level-scaled arrays
 * (from levelRange) collapse to a few readable breakpoints.
 */
export function chipIndices(ability) {
  const n = ability.cooldown.length;
  if (ability.scaling === 'level' && n > 6) return [0, 5, 10, 15, 17].filter((i) => i < n);
  return Array.from({ length: n }, (_, i) => i);
}

export function chipLabel(ability, i) {
  if (ability.scaling === 'flat') return 'all';
  if (ability.scaling !== 'level' || !ability.levelBreaks) return String(i + 1);
  const b = ability.levelBreaks;
  if (b.length > 6) return `L${b[i]}`;
  return `L${b[i]}${b[i + 1] ? `–${b[i + 1] - 1}` : '+'}`;
}
