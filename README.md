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
- **Ability haste slider** updates every number live. The quick buttons
  (0 / 10 / 20 / 30 / 45 / 60) are the common breakpoints. **Ultimate haste** is
  a separate box and stacks on top of ability haste, for R only.
- **Summoner spells** have their own haste pool. Toggle **Cosmic Insight**
  (+18) and **Ionian Boots** (+10) to see real Flash and TP timers.
- **Tap an ability** to expand its description, cost and range.
- **Sort by cooldown** lists every ability in the game shortest-first, filtered
  by rank, key and role — handy for "what else is up right now?".
- **⚠ means don't fully trust that number.** Tap it to read why. See
  [Where the data is wrong](#where-the-data-is-wrong).
- **Install it**: Chrome/Edge show an install button in the address bar;
  on iOS use Share → Add to Home Screen. After that it opens offline.

Keyboard: <kbd>/</kbd> focus search · <kbd>Esc</kbd> clear · <kbd>1</kbd> /
<kbd>2</kbd> switch tabs · <kbd>↑</kbd><kbd>↓</kbd><kbd>Enter</kbd> pick a result.

Your haste settings and last champion are saved in your own browser's
localStorage. Nothing is stored on a server, and there is no server.

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
behaviour locally, add `?sw=1` to the URL.

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
service worker. Those URLs contain the patch, so they're immutable and cached
forever.

**First load** is roughly 2 MB (mostly `championFull.json`, which gzips to a
few hundred KB). Every load after that, on the same patch, is free.

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
| Charge/ammo abilities | `maxammo` is set | **Charges** |
| No cooldown published | every rank is `0` | **No cooldown** |
| Passives | Data Dragon publishes no passive cooldowns at all | muted `·` |

The listed cooldown on a charge ability is only the delay *between casts* — the
charges themselves refill on a separate, much longer timer, which Data Dragon
does not publish.

### Corrected by hand in `overrides.json`

Verified against the LoL Wiki on patch 16.19.1:

- **Jayce, Nidalee, Elise, Rek'Sai** — Data Dragon publishes only one form's
  cooldowns. Both forms are now listed separately, with their own numbers.
- **Gnar** — both forms share cooldowns (so the numbers were right) but only
  the Mini names were published. Mega names added.
- **Corki R / Teemo R** — real ammo maximums and recharge times added.
- **Camille P** — 14/11/8 by champion level; no passive cooldowns exist in
  Data Dragon at all.
- **Akali Q / R** — numbers are right but misleading (energy-gated; the R
  recast uses a separate 2.5s timer). Flagged with a caveat, not changed.
- **Teleport** — 300s is correct, but it becomes Unleashed Teleport at 10:00
  with a 330→240 (by level) cooldown.

### Editing `overrides.json`

Anything you put in `data/overrides.json` replaces or annotates Data Dragon and
gets a ⚠ badge automatically. It's plain JSON — no rebuild, just reload.

**Correct one ability** (applies to every form):

```jsonc
"champions": {
  "Darius": {
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
  "abilities": {
    "R": {
      "cooldown": [0.25, 0.25, 0.25],
      "ammo": { "max": [3, 4, 5], "recharge": [35, 30, 25] }
    }
  }
}
```

Other fields: `maxrank`, `unreliable: true` (flag it without changing the
number), and under `summoners`, the same `cooldown` / `note` / `unreliable`.

Search aliases live in `data/nicknames.json`. Prefix matches (`trynd`) and
initials (`mf`) are automatic, so only add genuinely irregular nicknames.

---

## Deployment

Pushing to `main` deploys to GitHub Pages via
`.github/workflows/deploy.yml`. No build step — the repo is the site.

The workflow:

1. Rewrites `__BUILD_ID__` in `sw.js` with the commit SHA. This is what makes
   the service worker byte-different on every deploy, so browsers notice the
   update and the app offers a one-tap **Reload** instead of making people
   hard-refresh.
2. Validates the JSON data files (a typo in `overrides.json` fails the deploy
   rather than shipping a broken site).
3. Uploads the repo as the Pages artifact and deploys it.

### First-time setup

1. Push the repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main`. The site lands at
   `https://<user>.github.io/<repo>/`.

Every path in the app is relative, so it works under a `/<repo>/` subpath with
no configuration.

---

## Project layout

```
index.html              app shell
manifest.webmanifest    PWA manifest
sw.js                   service worker (BUILD stamped by CI)
css/styles.css
js/
  app.js                bootstrap, tabs, keyboard, SW registration
  ddragon.js            Data Dragon fetch + IndexedDB cache
  model.js              normalisation, overrides, reliability flags
  haste.js              cooldown maths
  search.js             fuzzy champion search
  store.js              localStorage settings
  ui.js                 DOM helpers
  views/champion.js     main view
  views/sort.js         sort-by-cooldown view
data/
  overrides.json        hand-verified corrections
  nicknames.json        search aliases
tools/make-icons.mjs    regenerates the PNG icons
```

---

CD Check isn't endorsed by Riot Games and doesn't reflect the views or opinions
of Riot Games or anyone officially involved in producing or managing Riot Games
properties.
