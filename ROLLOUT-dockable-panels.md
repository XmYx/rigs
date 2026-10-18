# Rollout: dockable panels (work/magix-system/dockable-panel-layout-engine-b47c)

Checked 2026-10-18 by team-test-sonnet (QA).

## Steward
- Entry f94b3d25 on steward magix-system: status `merged`. Merge commit on main: `932c5b034b3f218602936e0dcbf55eccf0791690`.
- A newer conflict waiting: not checked in detail (steward output was a 229k-char dump with a JSON parse error; matched the entry by grep).
- Another unrelated queue entry shows `checks-failed`; not investigated.

## Nodes
| Node | HEAD | Contains merge | Panel code | Daemon evidence |
|---|---|---|---|---|
| macbookpro | 932c5b0 | yes (merge-base exit 0) | ui/src/dock-layout.js, docking.js present | `rigs status` reports 932c5b0. The process start time I read (Oct 17 21:18) came from a loose pgrep, so it is not reliable proof of a restart. |
| magix-system | 932c5b0 | yes (exit 0) | present | `rigs status` reports 932c5b0; `bin/rigs.js serve` started Oct 18 21:42 (a start command from Oct 17 is also running) |

mesh_update was not needed: neither node was behind.

## Not checked
- iphone172: no RIGS agent (iOS).
- mikloss-macbook-pro: mesh_status said offline; `rigs status` lists it online with no rigs. Either way no RIGS daemon to check.

## Tests
- `node --test test/dock-layout.test.js`: 18/18 pass.
- `npm test`: 659 tests, 657 pass, 0 fail, 2 skipped.
- Not checked: the UI in a browser.
