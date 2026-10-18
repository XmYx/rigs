---
title: Add or change a JARVIS UI theme
match: \b(?:(?:add|new|create|change|switch|make|design|restyle)\b[^.\n]{0,40}\b(?:themes?|colou?r ?schemes?|skins?)|dark mode|light mode|colou?r ?schemes?|skins?|palette)\b
size: S
---
# Playbook: add a JARVIS UI theme

One agent does this end to end — no audit or separate test task. Typical cost: 3 files, ~60 lines.

## Where themes live
- `ui/src/themes.js` — the registry: `id → { name, fonts?, graph: { background, stars }, orb?: { state: [r,g,b] }, terminal: {xterm palette} }`.
  The left panel’s Display → theme picker lists every entry; the choice persists in `localStorage['rigs.theme']`.
- `ui/src/styles.css` — one `:root[data-theme="<id>"] { … }` block that sets every color variable
  (`--bg --panel --panel-solid --accent-rgb --accent-2-rgb --line --line-strong --text --muted --accent --accent-2
  --warn --danger`, optionally `--mono --sans`), followed by any shape/texture overrides scoped to the same selector.
  Copy the `atari` block at the end of the file as the template.
- Accent colors are only ever spelled in `:root`; elsewhere use `var(--accent)` / `rgba(var(--accent-rgb), a)`.
  `test/themes.test.js` enforces that and checks every registered theme has a complete CSS block.

## Steps
1. Add the entry to `THEMES` in `ui/src/themes.js` (graph background + star color, xterm palette, optional
   Google Fonts URL — it must degrade to system fonts offline).
2. Add the `:root[data-theme="<id>"]` block to `ui/src/styles.css`.
3. `npm run build && npm test`.
4. Screenshot it: run the dev UI against a scratch home and pick the theme
   (`RIGS_HOME=$(mktemp -d) RIGS_NO_MIGRATIONS=1 RIGS_NO_AUTOUPDATE=1 RIGS_PORT=4799 node bin/rigs.js serve`, open
   `http://127.0.0.1:4799`, then `localStorage.setItem('rigs.theme', '<id>')` and reload). Check one window and a
   terminal at desktop and 390x844.
5. Commit once in the dev worktree. RIGS proposes the branch to the merge steward.

## Also
- A theme can set `--ex-pixel: N` (2–8) to make the Exhibit window's p5 sketches render at 1/N resolution, pixelated (see `:root[data-theme="atari"]`); the sketches take every color from the theme variables, so nothing else is needed.

## Don't
- Don't restyle components for one theme by editing the shared rules. Scope everything to the theme selector.
- Don't add a new theme mechanism, build step or dependency.
