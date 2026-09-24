/** Main view: search a champion, read every cooldown at every rank. */

import { el, clear, icon, flagBadge, toast } from '../ui.js';
import { SLOTS, fmt } from '../model.js';
import {
  QUICK_HASTE, MAX_HASTE, SUMMONER_HASTE_SOURCES,
  applyHaste, hasteForSlot, summonerHaste,
} from '../haste.js';
import { settings, set } from '../store.js';
import { searchChampions } from '../search.js';

export function createChampionView(ctx) {
  const root = el('section', { id: 'view-champion', class: 'view' });

  /* --------------------------------------------------------------- search */

  const input = el('input', {
    id: 'search',
    type: 'search',
    class: 'search-input',
    placeholder: 'Search a champion…  (try "tk", "mf", "ww")',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    'aria-label': 'Search champions',
    'aria-autocomplete': 'list',
    'aria-controls': 'search-results',
  });
  const results = el('ul', {
    id: 'search-results',
    class: 'results',
    role: 'listbox',
    hidden: true,
  });
  const searchWrap = el('div', { class: 'search-wrap' }, input, results);

  let matches = [];
  let active = -1;

  function closeResults() {
    results.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
  }

  function renderResults() {
    clear(results);
    if (!matches.length) {
      closeResults();
      return;
    }
    matches.forEach((champ, i) => {
      results.append(
        el(
          'li',
          {
            class: `result${i === active ? ' active' : ''}`,
            role: 'option',
            'aria-selected': String(i === active),
            // mousedown fires before the input's blur, so the pick survives.
            onmousedown: (e) => {
              e.preventDefault();
              pick(champ.id);
            },
          },
          icon(champ.icon, '', 'icon icon-sm'),
          el('span', { class: 'result-name', text: champ.name }),
          el('span', { class: 'result-title', text: champ.title })
        )
      );
    });
    results.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function moveActive(delta) {
    if (results.hidden || !matches.length) return;
    active = (active + delta + matches.length) % matches.length;
    renderResults();
    results.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    matches = q ? searchChampions(ctx.index, q, 8) : [];
    active = matches.length ? 0 : -1;
    renderResults();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Enter') {
      const champ = matches[active >= 0 ? active : 0];
      if (champ) { e.preventDefault(); pick(champ.id); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!results.hidden) closeResults();
      else { input.value = ''; matches = []; closeResults(); }
    }
  });

  input.addEventListener('blur', () => setTimeout(closeResults, 100));

  function pick(id) {
    input.value = '';
    matches = [];
    closeResults();
    show(id);
    input.blur();
  }

  /* ---------------------------------------------------------------- haste */

  const hasteValue = el('output', { class: 'haste-value', for: 'haste-slider' });
  const slider = el('input', {
    id: 'haste-slider',
    type: 'range',
    class: 'slider',
    min: '0',
    max: String(MAX_HASTE),
    step: '1',
    'aria-label': 'Ability haste',
  });
  const ultInput = el('input', {
    id: 'ult-haste',
    type: 'number',
    class: 'num',
    min: '0',
    max: '200',
    step: '1',
    'aria-label': 'Ultimate haste',
  });

  const quickRow = el(
    'div',
    { class: 'quick-row', role: 'group', 'aria-label': 'Ability haste presets' },
    QUICK_HASTE.map((h) =>
      el('button', {
        type: 'button',
        class: 'chip chip-quick',
        dataset: { haste: String(h) },
        text: String(h),
        onclick: () => { set({ abilityHaste: h }); syncHaste(); render(); },
      })
    )
  );

  slider.addEventListener('input', () => {
    set({ abilityHaste: Number(slider.value) });
    syncHaste();
    render();
  });
  ultInput.addEventListener('input', () => {
    set({ ultimateHaste: Math.max(0, Number(ultInput.value) || 0) });
    syncHaste();
    render();
  });

  function syncHaste() {
    slider.value = String(settings.abilityHaste);
    ultInput.value = String(settings.ultimateHaste);
    hasteValue.textContent = String(settings.abilityHaste);
    quickRow.querySelectorAll('.chip-quick').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.haste) === settings.abilityHaste);
    });
    const total = settings.abilityHaste + settings.ultimateHaste;
    ultTotal.textContent = settings.ultimateHaste
      ? `R uses ${total} haste`
      : 'R uses ability haste';
  }

  const ultTotal = el('span', { class: 'hint' });

  const hastePanel = el(
    'section',
    { class: 'panel haste-panel', 'aria-label': 'Haste' },
    el(
      'div',
      { class: 'haste-main' },
      el('label', { class: 'field-label', for: 'haste-slider' }, 'Ability haste ', hasteValue),
      slider,
      quickRow
    ),
    el(
      'div',
      { class: 'haste-ult' },
      el('label', { class: 'field-label', for: 'ult-haste' }, 'Ultimate haste'),
      ultInput,
      ultTotal
    )
  );

  /* ------------------------------------------------------------- abilities */

  function rankChips(ability, ah, uh) {
    const h = hasteForSlot(ability.slot, ah, uh);
    const noCd = !ability.cooldown.length || ability.cooldown.every((c) => c === 0);
    if (noCd) {
      return [el('span', { class: 'chip chip-none', text: 'no cooldown' })];
    }
    const isLevel = ability.scaling === 'level';
    return ability.cooldown.map((base, i) => {
      const eff = applyHaste(base, h);
      const label = isLevel && ability.levelBreaks
        ? `L${ability.levelBreaks[i]}${ability.levelBreaks[i + 1] ? '–' + (ability.levelBreaks[i + 1] - 1) : '+'}`
        : String(i + 1);
      return el(
        'div',
        { class: `rank${h > 0 ? ' hasted' : ''}` },
        el('span', { class: 'rank-n', text: label }),
        el('span', { class: 'rank-cd', text: fmt(eff) }),
        h > 0 ? el('span', { class: 'rank-base', text: fmt(base) }) : null
      );
    });
  }

  function abilityRow(ability, ah, uh) {
    const badge = flagBadge(ability.flags);
    const details = el('div', { class: 'ability-details', hidden: true });

    const row = el(
      'div',
      { class: 'ability', dataset: { slot: ability.slot } },
      el(
        'div',
        {
          class: 'ability-head',
          role: 'button',
          tabindex: '0',
          'aria-expanded': 'false',
          onclick: () => toggle(),
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
          },
        },
        icon(ability.icon, ability.name),
        el('span', { class: 'slot-key', text: ability.slot }),
        el('span', { class: 'ability-name', text: ability.name }),
        badge,
        el('span', { class: 'expand-caret', 'aria-hidden': 'true', text: '›' })
      ),
      el('div', { class: 'ranks' }, rankChips(ability, ah, uh)),
      ability.ammo ? ammoLine(ability, ah, uh) : null,
      details
    );

    let built = false;
    function toggle() {
      const head = row.querySelector('.ability-head');
      const open = details.hidden;
      if (open && !built) {
        built = true;
        details.append(
          el('p', { class: 'desc', text: ability.description || 'No description published.' }),
          el(
            'dl',
            { class: 'facts' },
            fact('Cost', ability.cost ? `${ability.cost} ${ability.costType}`.trim() : null),
            fact('Range', ability.range && ability.range !== 'self' ? ability.range : null),
            fact('Max rank', ability.maxrank > 1 ? String(ability.maxrank) : null)
          ),
          ability.note ? el('p', { class: 'note', text: ability.note }) : null,
          ...ability.flags.map((f) =>
            el('p', { class: 'note note-flag' }, el('strong', { text: `${f.label}: ` }), f.text)
          )
        );
      }
      details.hidden = !open;
      row.classList.toggle('expanded', open);
      head.setAttribute('aria-expanded', String(open));
    }

    return row;
  }

  function fact(label, value) {
    if (!value) return null;
    return el('div', { class: 'fact' },
      el('dt', { text: label }), el('dd', { text: value }));
  }

  function ammoLine(ability, ah, uh) {
    const { max, recharge } = ability.ammo;
    const h = hasteForSlot(ability.slot, ah, uh);
    const chips = recharge.map((r, i) =>
      el(
        'div',
        { class: `rank rank-ammo${h > 0 ? ' hasted' : ''}` },
        el('span', { class: 'rank-n', text: String(i + 1) }),
        el('span', { class: 'rank-cd', text: fmt(applyHaste(r, h)) }),
        h > 0 ? el('span', { class: 'rank-base', text: fmt(r) }) : null
      )
    );
    const maxes = Array.isArray(max) ? max : [max];
    return el(
      'div',
      { class: 'ranks ranks-ammo' },
      el('span', { class: 'ammo-label', text: `recharge (max ${[...new Set(maxes)].join('/')})` }),
      chips
    );
  }

  /* ------------------------------------------------------------ champ card */

  const card = el('div', { id: 'champ-card', class: 'panel card' });
  let current = null;
  let formIndex = 0;

  function renderCard() {
    clear(card);
    if (!current) return;
    const ah = settings.abilityHaste;
    const uh = settings.ultimateHaste;
    const form = current.forms[Math.min(formIndex, current.forms.length - 1)];

    card.append(
      el(
        'header',
        { class: 'card-head' },
        icon(current.icon, current.name, 'portrait'),
        el(
          'div',
          { class: 'card-title' },
          el('h2', { text: current.name }),
          el('p', { class: 'card-sub', text: current.title }),
          el('div', { class: 'tags' }, current.tags.map((t) => el('span', { class: 'tag', text: t })))
        )
      )
    );

    if (current.forms.length > 1) {
      card.append(
        el(
          'div',
          { class: 'form-tabs', role: 'tablist', 'aria-label': 'Champion form' },
          current.forms.map((f, i) =>
            el('button', {
              type: 'button',
              role: 'tab',
              class: `chip chip-form${i === formIndex ? ' on' : ''}`,
              'aria-selected': String(i === formIndex),
              text: f.short || f.name || `Form ${i + 1}`,
              onclick: () => { formIndex = i; renderCard(); },
            })
          )
        )
      );
    }

    if (current.note) card.append(el('p', { class: 'champ-note', text: current.note }));

    const list = el('div', { class: 'abilities' });
    for (const slot of SLOTS) {
      const a = form.abilities[slot];
      if (a) list.append(abilityRow(a, ah, uh));
    }
    card.append(list);
  }

  /* ------------------------------------------------------------- summoners */

  const summonerPanel = el('section', { class: 'panel summoner-panel', 'aria-label': 'Summoner spells' });

  function renderSummoners() {
    clear(summonerPanel);
    const h = summonerHaste({
      cosmic: settings.cosmicInsight,
      ionian: settings.ionianBoots,
    });

    summonerPanel.append(
      el(
        'div',
        { class: 'panel-head' },
        el('h3', { text: 'Summoner spells' }),
        el(
          'div',
          { class: 'quick-row' },
          SUMMONER_HASTE_SOURCES.map((src) =>
            el('button', {
              type: 'button',
              class: `chip${settingFor(src.id) ? ' on' : ''}`,
              text: `${src.short} +${src.haste}`,
              title: src.name,
              'aria-pressed': String(settingFor(src.id)),
              onclick: () => {
                set(src.id === 'cosmic'
                  ? { cosmicInsight: !settings.cosmicInsight }
                  : { ionianBoots: !settings.ionianBoots });
                renderSummoners();
              },
            })
          ),
          el('span', { class: 'hint', text: `${h} summoner haste` })
        )
      )
    );

    const grid = el('div', { class: 'summoner-grid' });
    for (const s of ctx.summoners) {
      const eff = applyHaste(s.cooldown, h);
      grid.append(
        el(
          'div',
          { class: 'summoner', title: s.note || s.description.replace(/<[^>]*>/g, '') },
          icon(s.icon, s.name, 'icon'),
          el('span', { class: 'summoner-name', text: s.name }),
          el('span', { class: 'summoner-cd', text: fmt(eff) }),
          h > 0 ? el('span', { class: 'summoner-base', text: fmt(s.cooldown) }) : null,
          s.unreliable
            ? flagBadge([{ code: 'override', label: 'Caveat', text: s.note }])
            : null
        )
      );
    }
    summonerPanel.append(grid);
  }

  const settingFor = (id) => (id === 'cosmic' ? settings.cosmicInsight : settings.ionianBoots);

  /* ------------------------------------------------------------------ wire */

  function render() {
    renderCard();
  }

  function show(id) {
    const champ = ctx.champions[id];
    if (!champ) return;
    current = champ;
    formIndex = 0;
    set({ lastChampion: id });
    renderCard();
    ctx.onShow?.(champ);
  }

  root.append(searchWrap, hastePanel, card, summonerPanel);

  syncHaste();
  renderSummoners();
  show(ctx.champions[settings.lastChampion] ? settings.lastChampion : 'Renekton');

  return {
    el: root,
    show,
    focusSearch() { input.focus(); input.select(); },
    clearSearch() {
      if (input.value) { input.value = ''; matches = []; closeResults(); return true; }
      return false;
    },
    refresh() { syncHaste(); renderCard(); renderSummoners(); },
  };
}
