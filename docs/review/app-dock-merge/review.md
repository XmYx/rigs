# Review: macOS-style grouped app dock, merged onto main (project 88535b2a48, task t2)

Branch `work/macbookpro/merge-and-roll-out-macos-docki-4d53`, reviewed at 40ef437 on top of main f8f84bf (still
`origin/main`). Reviewer: team.review-opus (Claude Opus 5.5), 2026-10-20.

## Verdict

**Ready to propose.** There are no blockers. During the review I fixed one check-script timing problem and one gap in
the docs (both committed with this file). The open items below are LOW and none of them comes from the merge.

## What was checked

### Nothing from the magix-system source was dropped

Source: `/home/magix/rigs-dev/grouped-app-dock` on magix-system, HEAD c067db5, read-only (`git diff c067db5` plus a tar of
the untracked files). Its status is the same 15 entries t1 reported.

- **9 new files.** All 9 are on the branch. Seven are byte-identical: `app-dock-state.js`, `app-dock-model.js`,
  `open-events.js`, `app-dock-auto-check.js` and the three `test/app-dock-*.test.js`. Two have small intentional
  edits:
  - `app-dock.js`: re-lays out when the menu bar changes and heads its menus "App dock".
  - `app-dock-check.js`: presses the Menu key on macOS.
- **6 modified files.** I checked that every line the source adds is on the branch. The lines that differ are all intentional:
  - `styles.css` and `terminal-lazy.js`: complete.
  - `main.js`: the popup `openTerminal({… auto, tab})` call is kept, with `const t = await` from main.
  - `wm.js`: the `emitTitle` in `setTitle` is kept (re-wrapped).
  - `terminal.js`: the `live` map became `ptyId → [toFront…]`, so a PTY open twice keeps its item (40ef437). The
    import became `import { CAPS, createDisposer }`, which keeps main's `CAPS`. A tab returns main's cleanup API
    (`onCleanup`/`interval`/`listen`).
  - `AGENTS.md`: both source rows are present.

### The new features are off by default

- `DEFAULT_SETTINGS.autoDock` and `autoTabTerminals` are `false` (`ui/src/app-dock-state.js:26-27`).
- `onOpened` returns the state unchanged unless one of them is on.
- `mergeSources` only adds applets and rigs; it never adds panels or windows on its own.
- `reconcileOnLoad` only refreshes panel items that already exist.
- The background-session popup still opens its own window unless `autoTabTerminals` is on.
- The browser check confirms all of this: "defaults: autoDock and autoTabTerminals are off", "off: a newly opened panel
  is NOT docked", and "off: the auto-opened session has its OWN terminal window".

The dock itself is on (it is the feature). The docking layout (`rigs.docking`) stays off by default as on main.

### Regressions: Ask JARVIS panel, menu-bar docking, terminals

- **Ask JARVIS.** `ask-check` passes 47/47. `app-dock-merge-check` passes 27/27 with Ask in the top bar, floating, and
  docked beside the galaxy, against left, right and bottom docks, with auto-hide and with the menu bar hidden. The
  `#ask-panel` narrowing rule only applies under `html.adock-rl/rr`. An inline width (from resizing or docking) still
  wins, and phones keep `display: none`.
- **Docking layout and menu bar.**
  - `dockArea()` and `hitTest` now start inside `--ad-l/r/b`, the same way they start below `--mb-h`.
  - The inset observer in `docking.js` re-renders only when the inset key changes.
  - The dock's own observer acts only when `--mb-h` changes, so their two style writes cannot feed each other in a loop.
  - `scripts/dock-check.js` gives the same 10 PASS lines and then the same crash (`dock-check.js:146`, `drag()` on a
    missing `#legend .sec-h`) on main f8f84bf and on this branch. I ran both. That crash already exists on main and is
    not a regression. The only difference is that the chat panel starts 64px higher on the branch, which is the bottom
    dock's reserved edge, as designed.
- **Terminals.**
  - A hand-opened terminal is still its own `term-win` window.
  - The tab path (only with `autoTabTerminals`) gives each tab main's cleanup API. Its `el` is the pane, so the
    `CAPS.popupWindows` cap and "typing in it" stay per tab.
  - Closing the Terminals window closes every tab once: `tabsHost` is cleared first and `wm.close` is guarded.
  - `app-dock-auto-check` passes 28/28, using real tmux sessions, tab switching, closing tabs, reloads and the phone
    layout.

## Verification (re-run by the reviewer on macbookpro)

| Command | Result |
| --- | --- |
| `npm run build` | OK (`ui/dist` built) |
| `npm test` | 946 tests, 945 pass, 0 fail, 1 skipped |
| `node scripts/app-dock-check.js` | 44/44 after the fix below (43/44 before, 4 of 4 runs) |
| `node scripts/app-dock-auto-check.js` | 28/28 |
| `node scripts/app-dock-merge-check.js` | 27/27 |
| `node scripts/ask-check.js` | 47/47 |
| `node scripts/dock-check.js` | crashes at line 146 on both main and branch (already broken on main) |
| `git diff --check origin/main...HEAD`, conflict-marker grep | clean |

I looked at t1's screenshots in this folder and at my own runs: desktop at 1440×900 with left, right and bottom docks
and Ask in each placement, the tabbed Terminals window, and the phone at 390×844. The side panels, the toolbar and the
Ask panel stay clear of the dock, the magnified tile and its label sit over the panels as intended, and the phone bar
sits under the toolbar's Ask field.

## Fixed during the review

1. **`scripts/app-dock-check.js`, "it hides again when the pointer leaves", failed every time.**
   - The dock does hide. A per-100 ms trace showed `shown` dropped after about 200 ms and the list at y=906 by 500 ms.
     But idle headless Chromium did not start the slide-out transition until something read layout, so the fixed
     `sleep(1000)` read the dock still in place.
   - The failure depends on the check's own path, not on the dock code. It appears only once the Menu-key step
     (40ef437) really opens the menu. With `Shift+F10` forced, the current code passes the hide step. I could not
     reproduce t1's 44/44 on the final commit (0 of 4 runs).
   - The step now waits on animation frames (`waitForFunction`, `polling: 'raf'`, 2 s timeout). It passes in about
     850–900 ms, which matches the 450 ms hide delay plus the 260 ms transition.
2. **`AGENTS.md`**: the app-dock row now names `scripts/app-dock-merge-check.js` and its output folder.

## Open items (LOW, not blockers)

- A bottom dock with 13 or more tiles on a 1280px screen can overlap the bottom edges of the side panels. t1 reported
  this, and I agree.
- With docking on and Ask docked in a right column, the floating Filters and Active projects panels (z above docked
  ones) cover the top of that column. Floating panels have always drawn over docked ones, so this is not from the dock,
  but a right dock makes the overlap more likely because those panels shift inward by `--ad-r`.
- On a phone, a "session … started" toast covers the Terminals tab strip while it is shown (seen in
  `auto-phone-390x844-terminals-window`). This is general toast placement and goes away when the toast does.
- A dock terminal item for a PTY that is open in another browser tab does nothing when clicked (`focusTerminal` returns
  `false`). Items don't survive a reload, so this only happens with two JARVIS tabs open.
- `scripts/dock-check.js` has been broken on main since before this branch. It should be fixed separately.
