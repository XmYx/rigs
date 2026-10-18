# Rollout: dockable panels (work/magix-system/dockable-panel-layout-engine-b47c)

Checked 2026-10-18 by team-test-sonnet (QA); re-checked live ~20:50Z by team-review-opus (t2), corrections inline.

## Steward
- Entry f94b3d25 on steward magix-system: status `merged`. Merge commit on main: `932c5b034b3f218602936e0dcbf55eccf0791690`.
- No newer conflict: the entry's log ends `merged to main as 932c5b0` (20:41:48Z) after two resolver rounds and one test failure sent back to the author. `origin/main` = 932c5b0.
- Another unrelated queue entry shows `checks-failed`; not investigated.

## Nodes
| Node | HEAD | Contains merge | Panel code | Daemon evidence |
|---|---|---|---|---|
| macbookpro | 932c5b0 | yes (merge-base exit 0) | ui/src/dock-layout.js, docking.js present | The :4719 listener is pid 57192 `~/.rigs/app/bin/rigs.js serve`, started 20:41:51Z, 3 s after the merge: restarted on 932c5b0. |
| magix-system | 932c5b0 | yes (exit 0) | present | The :4719 listener is pid 1194690 `~/.rigs/app/bin/rigs.js serve`, started 20:41:52Z: restarted on 932c5b0. (The 21:42 `serve` is a different process, not the daemon.) The checkout is on branch `work/magix-system/thread-choices`, not `main`. |

mesh_update was not needed for these two: neither was behind.

**Served UI:** on both nodes `GET /dist/app.js` from the live daemon is byte-identical to `~/.rigs/app/ui/dist/app.js` (built 20:41), its lazy chunk contains the dock engine (`"rigs.dock"`, `"rigs.docking"`, zones `left/right/top/bottom/center`), and `/dist/app.css` has the `.dock-*` rules (`.dock-split`, `.dock-tabs`, `.dock-compass`, ...).

## Not checked
- iphone172: no RIGS agent (iOS).
- **mikloss-macbook-pro is the mesh node `mac` and does run RIGS. It has NOT landed:** its last reported version is 5e15f69, the commit before the merge. At the check it was offline (tailscale: last seen 1-3 min earlier; `mesh_exec` and ssh time out). When it is back, let it self-update (or `mesh_update mac`), then confirm `merge-base --is-ancestor 932c5b0 HEAD`.

## Tests
- `node --test test/dock-layout.test.js`: 18/18 pass.
- `npm test`: 659 tests, 657 pass, 0 fail, 2 skipped. An earlier run in the same worktree had 1 fail: the `drift` test in `test/live-video.test.js:326`, which is flaky under load. It reads `mock.prompts.length` after `/api/live/update` returns, so a clip queued with the old prompt can land after it. It passes 5/5 alone and has nothing to do with this merge.
- Not opened in a browser; the served bundle check above stands in for it.
