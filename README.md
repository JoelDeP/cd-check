# CD Check

Fast League of Legends ability cooldown lookup. Search a champion, read every
cooldown at every rank, drag the ability haste slider, done. Works on a phone,
installs as an app, and keeps working offline after the first visit.

No backend, no accounts, no API keys. Cooldowns come straight from Riot's
**Data Dragon** and are cached on your device until the patch changes.

---

## For friends: using the site

Open the link, type a champion name, read the numbers. That's it.

- **Search is fuzzy.** `tk` finds Tahm Kench, `mf` finds Miss Fortune, `ww`
  finds Warwick, `j4` finds Jarvan IV, `trynd` finds Tryndamere.
- **Lane filter** (All · Top · Jungle · Mid · Bot · Support) under the search
  box narrows results to a lane; tap a lane with an empty box to browse its
  whole roster. Champions who play several lanes appear under each. The same
  filter applies in *Sort by cooldown* and the Matchup enemy picker, and your
  last choice is remembered.
- **Ability haste slider** updates every number live. The quick buttons
  (0 / 10 / 20 / 30 / 45 / 60) are the common breakpoints. **Ultimate haste** is
  a separate box and stacks on top of ability haste, for R only.
- **Summoner spells** have their own haste pool. Toggle **Cosmic Insight**
  (+18) and **Ionian Boots** (+10) to see real Flash and TP timers.
- **Tap an ability** to expand its description, cost and range.
- **Sort by cooldown** lists every ability in the game shortest-first, filtered
  by rank, key, role and lane — handy for "what else is up right now?".
- **Charge abilities** (Teemo R, Vi E, Caitlyn W, Gangplank E…) show the
  **recharge time per charge** as the main number — that's the wait once
  they're out — e.g. *2 charges · 12s recharge (1s between casts)*, with the
  between-casts delay small. Haste shortens the recharge.
- **⚠ means don't fully trust that number.** Tap it to read why. See
  [Where the data is wrong](#where-the-data-is-wrong).
- **↻ means the cooldown has a refund, reset or reduction** (Darius R resets
  on a kill, Fiora Q refunds half on hit, Master Yi Q drops 1s per auto…). Tap
  it for the details. The number shown is the plain, un-refunded cooldown.
- **`STATIC`** means ability haste does not affect that cooldown at all
  (Yasuo and Yone Q, Camille's passive…), so it never changes with haste.
- **Install it**: Chrome/Edge show an install button in the address bar;
  on iOS use Share → Add to Home Screen. After that it opens offline.

### Matchup tab

Pick **your** champion and the **enemy** side by side:

- **Quick picks** (Renekton, Camille, Jax by default) sit under each search
  box. Tap ☆ next to a champion's name to pin or unpin it — your own list.
- **Level** (1–18) sets both sides; untick *same level* to set them
  separately. Ability ranks follow a standard skill order (the strip of
  `Q E W Q Q R…` shows it). Change it per champion from the *Skill order* menu.
- **Enemy loadout bar**, above the enemy's cooldowns, is built for entering
  what they have mid-game, one-handed: a live total (*35 AH · 0 ult · 18
  summ*), a big **level** stepper, a big **Hextech** counter, toggles for
  **Blue buff, Cosmic, AH shard, Transcendence, Ult Hunter** (the last two
  only appear once the level makes them matter), and a **grid of every item
  that grants haste** — tap to add, tap the item up top to remove; a second
  copy of a legendary or a second pair of boots can't be added. Items you've
  entered for that champion before come first, then items that suit the
  champion. **Reset** clears it. Everything applies instantly. Your own bar is
  the same, collapsed by default. Rarer inputs (Jack of All Trades, Legend:
  Haste, cinders, manual haste) sit under *More*.
- **Every cooldown shows base → with haste**, e.g. `26 → 18.3s`.
- **Trade windows** at the top: the enemy's key abilities and how long you
  have when they use them — *"Fiora W on cooldown → 24s → their defence is
  down: all-in window"*. Tap ☆ on any enemy ability to add or remove it.
- **★ Save** keeps a matchup in your favourites; **Copy link** gives a URL
  that opens that exact matchup — champions, level, skill orders, items, runes,
  everything — e.g. `?me=renekton&vs=darius&lvl=6`.

Keyboard: <kbd>/</kbd> focus search · <kbd>Esc</kbd> clear · <kbd>1</kbd>
<kbd>2</kbd> <kbd>3</kbd> switch tabs · <kbd>↑</kbd><kbd>↓</kbd><kbd>Enter</kbd>
pick a result.

Your settings, pinned champions, skill orders, favourites and last matchup are
saved in your own browser's localStorage. Nothing is stored on a server, and
there is no server.

---

## Running it locally

It's plain HTML, CSS and ES modules — no build step, no dependencies. But it
does use ES modules and `fetch`, so it needs a real HTTP server; opening
`index.html` from the filesystem will not work.

Any static server will do:

```bash
# Python (already on most machines)
python -m http.server 8731

# or Node
npx serve -l 8731
```

Then open <http://127.0.0.1:8731/>.

**The service worker is disabled on localhost** so your edits show up on
reload instead of being served from a stale cache. To test the real PWA
behaviour locally, add `?sw=1` to the URL. (Python's server sends no cache
headers, so Chrome may still reuse an old copy of a JS file; if a change
doesn't show up, hard-reload with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>.)

### Tests

```bash
node tests/run.mjs
```

No dependencies. Covers the haste calculator (every source, static
cooldowns, slot rules), item-haste parsing against real Data Dragon 16.19 text
in `tests/fixtures/`, skill orders (including Jayce's and Nidalee's odd
ultimates), and matchup-link encoding, including hostile input.

### Regenerating the icons

The PNG icons are committed, so you only need this if you change the design:

```bash
node tools/make-icons.mjs
```

---

## How the data works

On load, the app:

1. Fetches `https://ddragon.leagueoflegends.com/api/versions.json` and takes
   the newest patch.
2. Compares it to the patch already in IndexedDB.
   - **Same patch** → loads from IndexedDB, no network.
   - **New patch** → downloads `championFull.json` (every champion and spell in
     one request) plus `summoner.json`, trims out skins/lore/build
     recommendations, stores it under the new patch key, and deletes the old
     patch's entries.
3. Applies `data/overrides.json` on top.

So it refreshes itself the day a patch drops, with no work from you. The patch
in use is shown in the header; it turns amber when you're offline and reading
cached data.

Champion and spell art is loaded straight from Data Dragon and cached by the
service worker. Those URLs contain the patch, so they never change; when a new
patch arrives, the previous patch's art is deleted.

After the first load, once the browser is idle, the service worker also
**caches every champion's square icon in the background** (~170 images, about
4 MB), so search results and cards show art even offline. It skips anything
already cached, so later visits cost nothing, and it doesn't run when the
device has Data Saver on. Ability icons are cached as you view them.

Art is fetched in CORS mode rather than as the `<img>` tag's own opaque
request: opaque responses can't be checked for success, and Chrome bills each
one as ~7 MB of storage quota.

**First load** is roughly 2 MB (mostly `championFull.json`, which gzips to a
few hundred KB) plus the background icon download. Every load after that, on
the same patch, is free.

---

## Where the data is wrong

Data Dragon is Riot's own export, but it is a *display* format, not a
simulation format. It gets some cooldowns wrong or can't express them at all.
CD Check flags these two ways.

### Detected automatically

No curation needed — these keep working for champions released after this was
written:

| What | How it's detected | Badge |
|---|---|---|
| Two forms merged into one entry | spell name contains `" / "` | **Form swap** |
| A recast sharing one cooldown | same, for a known list of recasts | **Recast** |
| Charge/ammo abilities | `maxammo` is set, then checked (see below) | **Charges** |
| No cooldown published | every rank is `0` | **No cooldown** |
| Passives | Data Dragon publishes no passive cooldowns at all | muted `·` |

Data Dragon's cooldown on a charge ability is only the delay *between casts*;
the recharge per charge — the number that matters — isn't published.
`data/charges.json` supplies it (see [Lanes and charges](#lanes-and-charges)),
so the app shows the recharge as the main number. It also found that
Data Dragon's `maxammo` flag is wrong for several abilities: **Rengar Q/W/E**
(published as 0.25s; really 6→4 / 16→10 / 10s) and **Karthus Q** (0s; really
1s) are corrected; Kled Q, LeBlanc R and Warwick W are plain cooldowns.

### Corrected by hand in `overrides.json`

Verified against the LoL Wiki on patch 16.19 (each entry records its own
`verifiedPatch`; see [Keeping overrides current](#keeping-overrides-current)):

- **Jayce, Nidalee, Elise, Rek'Sai** — Data Dragon publishes only one form's
  cooldowns. Both forms are now listed separately, with their own numbers.
- **Gnar** — both forms share cooldowns (so the numbers were right) but only
  the Mini names were published. Mega names added.
- **Camille P** — 14/11/8 by champion level; no passive cooldowns exist in
  Data Dragon at all.
- **Akali Q / R** — numbers are right but misleading (energy-gated; the R
  recast uses a separate 2.5s timer). Flagged with a caveat, not changed.
- **Teleport** — 300s is correct, but it becomes Unleashed Teleport at 10:00
  with a 330→240 (by level) cooldown.

### Editing `overrides.json`

Anything you put in `data/overrides.json` replaces or annotates Data Dragon and
gets a ⚠ badge automatically. It's plain JSON — no rebuild, just reload.

Every champion and summoner entry needs a **`verifiedPatch`** (`"16.19"` —
major.minor only): the patch on which you last checked it by hand. An entry
without one shows as *unverified*.

**Correct one ability** (applies to every form):

```jsonc
"champions": {
  "Darius": {
    "verifiedPatch": "16.19",
    "abilities": {
      "W": {
        "cooldown": [9, 8, 7, 6, 5],
        "note": "Why you changed it — this text shows in the UI."
      }
    }
  }
}
```

**Add a passive cooldown that scales with level:**

```jsonc
"Camille": {
  "verifiedPatch": "16.19",
  "abilities": {
    "P": {
      "name": "Adaptive Defenses",
      "cooldown": [14, 11, 8],
      "scaling": "level",
      "levelBreaks": [1, 7, 13]
    }
  }
}
```

**Split a champion into forms.** `from` is the index of the Data Dragon spell
to borrow the icon and description from (0 = Q, 1 = W, 2 = E, 3 = R). Any slot
you leave out falls back to the Data Dragon value:

```jsonc
"Jayce": {
  "verifiedPatch": "16.19",
  "note": "Shown as a banner on the champion card.",
  "forms": [
    {
      "name": "Mercury Hammer",
      "short": "Hammer",
      "abilities": {
        "Q": { "name": "To the Skies!", "from": 0, "cooldown": [16, 14, 12, 10, 8, 6] }
      }
    },
    { "name": "Mercury Cannon", "short": "Cannon", "abilities": { /* ... */ } }
  ]
}
```

**Charge-based ability:**

```jsonc
"Teemo": {
  "verifiedPatch": "16.19",
  "abilities": {
    "R": {
      "cooldown": [0.25, 0.25, 0.25],
      "ammo": { "max": [3, 4, 5], "recharge": [35, 30, 25] }
    }
  }
}
```

**Cooldown mechanics and static cooldowns** (shown as ↻ and `STATIC`):

```jsonc
"Yasuo": {
  "verifiedPatch": "16.19",
  "abilities": {
    "Q": {
      "static": true,
      "mechanics": ["4s down to 1.33s with bonus attack speed - shown value is the maximum."]
    }
  }
},
"Aatrox": {
  "verifiedPatch": "16.19",
  "abilities": {
    "P": { "levelRange": [22, 10], "static": true, "mechanics": ["..."] }
  }
}
```

`static: true` makes the calculator ignore haste for that ability.
`levelRange: [atLevel1, atLevel18]` is a cooldown that shrinks linearly with
champion level (the wiki's "22 – 10 (based on level)"). `scaling: "flat"`
is one value regardless of rank or level. Keep `mechanics` notes short and say
what the shown number represents ("shown value is the maximum").

Other fields: `maxrank`, `unreliable: true` (flag it without changing the
number), `verifiedPatch` on a single ability (wins over its champion's — use
it when you re-check one slot but not the rest), and under `summoners`, the
same `cooldown` / `note` / `unreliable` / `verifiedPatch`.

### Keeping overrides current

Hand-verified numbers go stale when Riot patches a champion. Once the live
patch is newer than an entry's `verifiedPatch`, the app stops trusting it
silently: the ability shows an amber **verified on 16.19** pill (and the ⚠
tooltip explains). Nothing is hidden; you just know to double-check.

After each patch, list what needs re-checking:

```bash
node tools/stale-overrides.mjs          # against the live patch
node tools/stale-overrides.mjs 16.21    # simulate a future patch
```

It prints every stale entry with our value next to what Data Dragon publishes
today, and exits 1 if anything is stale. Re-verify each against the LoL Wiki,
then bump its `verifiedPatch`. Values that come straight from Data Dragon are
never flagged — they're always current by definition.

Search aliases live in `data/nicknames.json`. Prefix matches (`trynd`) and
initials (`mf`) are automatic, so only add genuinely irregular nicknames.

---

## Lanes and charges

Two generated files, rebuilt after each patch with:

```bash
node tools/sync-lanes-charges.mjs
```

The script pulls three sources and matches champions by numeric id:

- **Meraki Analytics** (`cdn.merakianalytics.com`) — champion positions and
  ability `rechargeRate`. It is the first source, but its data was last
  updated in August 2025 (patch 15.x; it lacks the two newest champions), and
  its CDN sends no CORS header, so the site could not load it from a browser
  anyway.
- **LoL Wiki** — `Module:ChampionData/data` (`client_positions` +
  `external_positions`, updated for V26.19) and each ability's
  `Template:Data_<Champion>/<Ability>` (`recharge`, `static`, maximum
  charges). Every Meraki value is checked against it; where they disagree, or
  Meraki has nothing, the wiki wins.
- **Data Dragon** — which abilities are flagged `maxammo`, ranks, names.

Output, committed and precached like the rest of the app:

- `data/lanes.json` — lanes per champion (union of the wiki's client and
  external positions). On 16.19: Meraki agreed on 164 of 173; the 9
  differences (e.g. Corki now bot, Talon jungle, Locke and Zaahen missing from
  Meraki) are listed in its `notes`.
- `data/charges.json` — `charges` (19 real charge abilities with recharge per
  rank, between-casts delay, max charges per rank), `notCharges` (flagged by
  Data Dragon but ordinary cooldowns, with corrections), and `unverified`.

Both carry `verifiedPatch`; `tools/stale-overrides.mjs` says when to rerun
the script. **Don't hand-edit them** — corrections go in `overrides.json`: a
champion's `"lanes": ["top", "jungle"]`, or an ability's `ammo`.

### Full audit against the wiki

```bash
node tools/wiki-audit.mjs                 # fetch + compare (about 25 requests)
node tools/wiki-audit.mjs --cache a.json  # keep the fetched pages to re-run offline
```

Checks every current ability the wiki lists (about 930, forms included)
against what the app actually shows (Data Dragon + overrides + generated
data): missed charge abilities, recharge/charge mismatches, per-rank cooldown
differences, static cooldowns the app would haste, level-scaled cooldowns, and
passive cooldowns the app lacks. It reads through the MediaWiki API in batches
of 50 pages, at least 1.5s apart, with a descriptive User-Agent, and changes
nothing: it prints a report to act on. Worth running after big patches.

The first run (16.19) found and fixed, all now in `overrides.json`:

- **Missed charge ability:** Kled's dismounted Q, *Pocket Pistol* (2
  charges, 18→10s recharge, 3s between casts) — Data Dragon only describes
  mounted Kled. Kled now has Mounted / Dismounted tabs.
- **Data Dragon publishes 0 for real cooldowns:** Tahm Kench R (120/100/80),
  Kalista E (10→8), Rakan E (20→12), Talon E (2s between walls; the same
  wall locks for 160/135/110/85/60s), Veigar W (8s).
- **Static cooldowns the app was reducing with haste:** Amumu W, Aphelios W,
  Jinx Q, Karthus E, Rek'Sai W (burrowed), Samira R, Singed Q, Yuumi W
  (10/5/0 by level), K'Sante Q.
- **Passive cooldowns added** (18): Alistar, Anivia, Azir, Blitzcrank, Galio,
  Gragas, LeBlanc, Malphite, Malzahar, Maokai, Naafiri, Nocturne, Shen, Vex,
  Xerath, Zac, Ziggs, Zilean — with their reductions as ↻ notes.
- **Mechanics notes:** Hecarim Q (Rampage stacks), Veigar W (Phenomenal
  Evil), K'Sante Q (bonus resistances), Zeri Q (1 / attack speed), Syndra Q
  (2 charges only with her Transcendent bonus).

Left as they are, on purpose: **Mel W** (Data Dragon 38/35/33/29/26, wiki
38→26 i.e. 32 at rank 3 — can't tell which is right, so it keeps Data
Dragon's value with a ⚠ saying the sources disagree at rank 3);
passives whose wiki timer isn't a real cooldown or is ambiguous (Sion's Death
Surge, Taliyah, Yuumi); cooldowns that are formulas of stacks, attack speed or
resistances (Hecarim, Veigar, K'Sante, Zeri, Yasuo, Yone, Quinn…), which get a
note rather than a number.

## Haste: how every cooldown is calculated

All cooldowns in the app — Champion tab, Sort view, Matchup — go through one
module, `js/haste.js`:

```
final = base × 100 / (100 + haste)
```

Haste comes in kinds that apply to different things, and stack additively:

| Kind | Applies to | Examples |
|---|---|---|
| ability | Q, W, E, R (passives only if not static) | most items, Hextech, blue buff, AH shard |
| basic | Q, W, E only | Spear of Shojin, Legend: Haste |
| ultimate | R only | Malignance, Hexplate, Ultimate Hunter |
| summoner | summoner spells | Ionian Boots, Crimson Lucidity, Cosmic Insight |
| item | item actives (tracked, not shown) | Cosmic Insight |

Where the numbers come from:

- **Items** — parsed from Data Dragon `item.json` at runtime, so they follow
  every patch with no edits: the stats block ("15 Ability Haste") plus
  unconditional passive lines ("Gain 20 Ultimate Ability Haste."). Conditional
  effects (Imperial Mandate's +20 on immobilizing abilities, Staff of Flowing
  Water's temporary +15) are deliberately **not** counted.
- **Everything else** — `data/haste-sources.json`, hand-verified per patch.

### Editing `haste-sources.json`

Three sections, each entry with its own `verifiedPatch` (they go stale and get
the same *verified on 16.19* badge as overrides, and `tools/stale-overrides.mjs`
lists them too):

```jsonc
"buffs": [{
  "id": "blue", "name": "Blue buff (Crest of Insight)", "verifiedPatch": "16.19",
  "grants": [{ "kind": "ability", "byLevel": { "levels": [1, 6, 11], "values": [10, 15, 20] } }]
}],
"runes": [{
  "id": "ultimateHunter", "runeId": 8106, "verifiedPatch": "16.19",
  "grants": [{ "kind": "ultimate", "amount": 6 }, { "kind": "ultimate", "perStack": 5, "maxStacks": 5 }]
}],
"itemExceptions": {
  "2517": { "name": "Endless Hunger", "verifiedPatch": "16.19",
            "formula": { "kind": "ability", "base": 5, "perBonusAD": { "melee": 0.13, "ranged": 0.10 } } }
}
```

A grant is `amount` (flat, optionally `fromLevel`), `perStack` + `maxStacks`,
or `byLevel`. Verified on 16.19: Hextech 5 AH/stack (max 4; no other drake,
soul, Elder, Baron or Atakhan grants haste), blue buff 10/15/20 at levels
1/6/11, Infernal cinders 1 AH each, AH shard 8 (offense row only), Cosmic
Insight 18 summoner + 10 item, Transcendence +5 at 5 and +5 at 8, Ultimate
Hunter 6 + 5 per stack (31 max), Jack of All Trades 1 per stack, Legend: Haste
1.5 basic per stack (max 10).

### Editing `matchup.json`

Gameplay defaults, not patch data — edit freely: `pinnedDefault` (everyone's
starting quick picks), `skillOrders` (`"max": "QEW"`, optional `"start"`),
`keys` (each champion's trade-window abilities with a `role`: defensive,
escape, engage, cc, trade or execute) and `roleText` (the callout wording).
Champions without an entry use max Q > E > W and no keys.

### Designed for Phase 3 (in-game timers)

- A side's haste inputs are a plain JSON *loadout* (`items`, `buffs`,
  `runes`, `extra`, `level`), so the Live Client bridge can fill it field by
  field through `matchupView.setSide('vs', {...})`.
- Each source in `haste-sources.json` has a `live` field saying what the API
  can fill: a data path (Hextech stacks from dragon kills), `self-only` (the
  API gives your own full rune page but only the enemy's keystone) or `null`
  (never exposed: blue buff, cinders). When a live game is connected, fields
  the API can't fill are labelled **manual**.
- `rescaleRemaining(remaining, oldHaste, newHaste)` in `js/haste.js` keeps a
  running timer correct when the enemy's haste changes mid-countdown.

---

## Deployment

The site is served by GitHub Pages straight from the `main` branch — no
build step, no GitHub Actions. The repo *is* the site.

### Every push: stamp, then push

```bash
git commit -am "your change"
node tools/stamp-build.mjs     # validates data, stamps sw.js, commits the stamp
git push
```

`stamp-build`:

1. Checks that `overrides.json`, `nicknames.json` and the manifest parse, so
   a JSON typo can't ship as a broken site.
2. Refuses to run with uncommitted changes, so the stamp matches exactly what
   you're pushing.
3. Writes the current commit SHA into `const BUILD` in `sw.js` and commits it
   as `Stamp service worker build <sha>`. Running it twice is a no-op.

**Why it matters:** browsers only install a new service worker when `sw.js`
changes byte-for-byte. The stamp guarantees it does, so friends get a one-tap
**Reload** banner instead of a stale app. If you forget, the deploy still goes
live for new visitors, but anyone who already installed it keeps the old app
shell until the next stamped push. Use `--no-commit` if you'd rather commit
the stamp yourself.

**The pre-push hook stops you forgetting.** `tools/hooks/pre-push` refuses to
push `main` unless its tip is a fresh stamp — the tip's `sw.js` must carry the
hash of the tip's parent, which is exactly what `stamp-build` produces, so a
commit made after stamping is caught too. Other branches are not checked.
Git doesn't version hooks, so enable it once per clone:

```bash
git config core.hooksPath tools/hooks
```

In an emergency, `git push --no-verify` skips it.

Pages usually publishes within a minute of the push; check progress under the
repo's **Actions → pages-build-deployment** (that's GitHub's built-in Pages
job, not a workflow in this repo).

### First-time setup

1. `git config core.hooksPath tools/hooks`, then stamp and push `main`.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch →
   Branch: `main`, folder: `/ (root)`** → Save.
3. The site lands at `https://<user>.github.io/<repo>/`.

`.nojekyll` is committed so Pages serves the files as-is instead of running
them through Jekyll. Every path in the app is relative, so it works under a
`/<repo>/` subpath with no configuration.

---

## Project layout

```
index.html              app shell
manifest.webmanifest    PWA manifest
sw.js                   service worker (BUILD stamped by tools/stamp-build.mjs)
css/styles.css
js/
  app.js                bootstrap, tabs, keyboard, SW registration
  ddragon.js            Data Dragon fetch + IndexedDB cache
  model.js              normalisation, overrides, reliability flags
  patch.js              patch comparison / staleness
  haste.js              THE haste calculator - every cooldown goes through it
  items.js              item haste parsed from Data Dragon item.json
  skill-order.js        level -> ability ranks
  matchup-state.js      matchup state <-> shareable URL
  ability-ui.js         shared cooldown display bits
  lanes.js              lane filter chips + helpers
  search.js             fuzzy champion search
  store.js              localStorage settings
  ui.js                 DOM helpers
  views/champion.js     main view
  views/matchup.js      matchup view
  views/sort.js         sort-by-cooldown view
data/
  overrides.json        hand-verified corrections + cooldown mechanics
  haste-sources.json    runes, objectives, item exceptions (hand-verified)
  matchup.json          skill orders, key abilities, default pins
  lanes.json            generated: lanes per champion
  charges.json          generated: charge abilities, recharge times
  nicknames.json        search aliases
tests/run.mjs           unit tests (node tests/run.mjs)
tools/make-icons.mjs    regenerates the PNG icons
tools/stale-overrides.mjs  lists overrides + haste sources to re-verify after a patch
tools/stamp-build.mjs   validates data + stamps sw.js before a push
tools/sync-lanes-charges.mjs  regenerates data/lanes.json + data/charges.json
tools/wiki-audit.mjs    compares every ability the app shows with the LoL Wiki
tools/lib/wiki.mjs      polite MediaWiki API access + wiki value parsing
tools/hooks/pre-push    blocks pushing main without a fresh stamp
```

---

CD Check isn't endorsed by Riot Games and doesn't reflect the views or opinions
of Riot Games or anyone officially involved in producing or managing Riot Games
properties.
