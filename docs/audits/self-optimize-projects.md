# Audit: why RIGS projects stall short of 100%

Read-only investigation (project `4429a5fbc0`, task t1). Sources: `src/planner.js`, `src/work.js`, `src/hubs.js`,
`src/merge.js`, `src/server.js`, `src/mcp.js`, and the stored project records in `~/.rigs/projects/*.json` on
macbookpro (9 projects) and magix-system (25 projects), plus both `~/.rigs/merge/queue.json` files. Snapshot taken
2026-10-17 20:36 CEST. Facts come from stored state; inferences are marked *(inferred)*.

## Summary

34 projects exist. 17 are `done`. The other 17 split into: 4 `blocked`, 6 `paused`, 7 `running` (5 on macbookpro, 2 on
magix-system). Of the running ones, 3 cannot make progress.
Nothing in `planner.js` is *wrong* in the common path; projects stall at the **edges of the state machine**,
where a task or project lands in a state that no tick loop looks at again:

* `tick()` only visits `running | planning | merging` projects (and `blocked` ones with a *stalled* task), `planner.js:775`.
  A `blocked` project is terminal until a human or agent moves a task (`planner.js:677`, `791`).
* `ready()` needs `t.assign`, `planner.js:481`. A `todo` task without a machine is neither "moving" nor "stuck"
  in `settle()` (`planner.js:641-642`), so the project stays `running` forever and nobody is told.
* `retryOrFail()` allows one immediate retry, with no delay and no change of approach, `planner.js:576-591`.
* The agent's brief says "never ask, report blocked/failed" (`planner.js:464`, `426`), but a `blocked` report has
  no consumer except Sir.

## Causes, ranked

Ranking = number of projects hurt now, then number of events across all 34 projects. Frequencies from the project
logs: seat-down revives 6, merge-check bounces 5, retries 4, agent-reported blocked 6 (3 classifier/permission,
3 other), planning lost on restart 3, dispatch failures 6, propose failures 2.

### 1. Task that no machine can run is silently stranded in `todo` (3 live projects, one idle for 10 h)

`routeProject()` filters machines by `needs.platform` (`planner.js:358`) **and** pins every code-ish task to the
repo's machine when the folder has no git URL (`codeLocal`, `planner.js:331`, applied at `360`). A task that needs
a different OS than the repo's machine matches no node, so `t.assign = null` and `t.reason = 'no online machine…'`
(`planner.js:379-383`). Nothing retries it, logs it, or fails it.

Evidence:

| Project | Task | Needs | Repo machine | State |
| --- | --- | --- | --- | --- |
| `2ed3c75b03` (magix-system) | t6 test | mac | magix-system (linux) | `todo`, unassigned; log's last line is 11:34; t8, t9 wait on it. 9 h of nothing |
| `d902921162` (magix-system) | t2 test | mac | magix-system (linux) | `todo`, unassigned since t1 finished 17:02; t3 waits |
| `8eb2687046` (macbookpro) | t2 code | linux | macbookpro (mac) | `todo`, unassigned; t3, t4 wait |

All three show `reason: "no online machine can run this task (needs claude + mac|linux)"` and status `running`.
`settle()` sees `moving=false`, `stuck=[]` (todo is not failed) so it never escalates (`planner.js:641-648`).
`tickProject` returns `'dispatch'` every tick because `todo && !assign` (`planner.js:819`), and `dispatchReady`
re-routes and fails again, rewriting the file (`planner.js:522`, `saveProject` bumps `updatedAt`) — which is why
`updatedAt` is 20:35 on a project whose log ends at 11:34: *the staleness is masked*.

Fix: 
* `planner.js routeProject()`: when `codeLocal(t)` and the machine fails `needs.platform`, relax `codeLocal` for
  `test`/`review` kinds (the agent can reach the folder with `mesh_*`), or fall back to a fresh clone. At minimum, do not
  apply `codeLocal` when it contradicts an explicit `needs.platform`.
* `planner.js settle()`: count `todo && !assign` tasks as stuck (add them to `stuck`), event once, and `tell()` Sir.
  Better: after N ticks unassigned, drop the platform need (re-route with `needs.platform='any'`) and note it in the brief.
* `planner.js normalizeTasks()` / `planningPrompt` (`planner.js:138`): tell the planner that platform needs on a
  folder-bound project are only valid for the machine holding the folder.
* `planner.js saveProject()` callers in `tickProject`/`dispatchReady`: only save when something changed so
  `updatedAt` stays honest.

### 2. Agent reports `blocked` and the project parks forever (4d3a213760 live; 6 events, 3 recovered only by Sir)

`applyUpdate` sets the task `blocked` (`planner.js:669`) and the project moves to `blocked` through `settle()`
(`planner.js:643-646`). `tickProject` returns early for a `blocked` project (`planner.js:791`), so only a human can
continue.

Evidence:

* `4d3a213760` (retire finished projects): t1 blocked at 16:30, "one live stop needs the user's OK". The code was
  committed and tested (commit 85f2451); the only open step was a live `project_stop`/archive that needs the
  change rolled out first. The agent was told to report blocked for anything "destructive" (`planner.js:426`),
  so a *reversible* pause counted as blocked. t2 (review) still `todo`, project `blocked` 4 h later.
* Claude Code auto-mode classifier denials turned into `blocked` three times: `81de454745` t1 (Discord send,
  recovered itself in 2 min via osascript), `2ed3c75b03` t3 (safety classifier stopped output writing control code,
  Sir re-dispatched to Codex), `d902921162` t1 ("needs Sir's explicit go-ahead", Sir answered 12 min later).
  Each time progress depended on a human noticing.
* `needsInput` waits are ignored: `watchTask` returns `false` while a permission/question wait is showing
  (`planner.js:713`) — no timeout, no nudge, no escalation. The comment says "the attention feed already asks Sir".

Fix:
* `planner.js watchTask()` line 713: put a ceiling on `needsInput` (e.g. 10 min). Then send the agent the standing
  answer ("Sir pre-approved non-destructive work; choose the safe path and report") and after a second ceiling mark
  the task `failed` (retryable) instead of waiting.
* `planner.js applyUpdate()`: on `blocked`, auto-triage once: dispatch a small "unblocker" turn to the *same seat*
  (`work.nudgeTask`) asking it to split the blocked step from the finished work and report the finished work as `done`
  with the blocked step listed as follow-up. Only the second `blocked` escalates.
* `planner.js autonomyBrief()` (`planner.js:418-431`): define "destructive" narrowly (deleting data not created,
  force-push, spend). Say that reversible changes to RIGS state (pause, archive) are fine, and that a classifier
  denial means "choose another route (different tool, smaller step)", not "report blocked".
* `planner.js tickProject()` line 791: for `blocked` projects, retry `blocked` tasks whose summary matches a
  classifier/permission pattern after a delay.

### 3. End-of-project hand-off to the merge steward fails or is never reconciled (81de454745, e43412ceae; 5 check bounces; 2 parked conflicts)

After the last task is done, `settle()` proposes the branch (`planner.js:620-631`). Any propose error flips the
project to `blocked` with no retry (`planner.js:628`).

* **81de454745** — "nothing to propose: no commits ahead of origin/main" (`merge.js:113`). The task was an
  action (send a Discord message), not a code change, yet the project is `selfDev` because it was filed under
  RIGS. All tasks `done`, review passed, project `blocked`.
* **e43412ceae** — "commit your changes first (git status is not clean)" (`merge.js:111`). The agents had
  *already* proposed the branch themselves (`mcp.js:247` exposes `rigs_propose` to every agent); the steward's queue
  shows two merged requests for that branch, `a7c6ddf4` → `1869b44` and `e231759d` → `94174b6`. The final automatic
  propose then hit a dirty tracked tree *(inferred: OpenRig-managed block in CLAUDE.md/AGENTS.md or leftover edit, before
  `stripManaged` was passed from `server.js:366`)*. The project never looks at the steward's queue, so it stays blocked
  although the work is on main.
* **Check bounces** — 5 `merge checks failed` events; `followMerge` handles them with one `fixN` task
  (`planner.js:836-846`, `MAX_ATTEMPTS`), then blocks (`planner.js:847-852`). `a0c34f169f` and `b7a0a00273` are paused
  with merge requests parked in `conflict` (`eb55e88f` split-questions, `70d6df0d` cut-token) — they have been in
  `conflict` since ~16:00.
* A `conflict` request waits **6 h** before the project is even marked blocked (`planner.js:847`).

Fix:
* `merge.js describe()` (`merge.js:103-119`): return `{ empty: true }` instead of throwing for "no commits";
  `server.js proposeBranch()` passes it through and `planner.js settle()` (`620-631`) treats it as `done` (no merge).
* `server.js proposeBranch()` (`server.js:203-206`): run `stripManagedBlocks` always for `selfDev` and treat
  tracked changes limited to the guide files as clean; auto-commit remaining tracked changes made by the task's own
  seat or return a precise list so the agent can fix it.
* `planner.js settle()`: before proposing, ask the steward whether the branch is already merged/queued
  (`ctx.call(steward,'merge')`, as `followMerge` does at `planner.js:828`) and adopt that request.
* `planner.js followMerge()`: retry `propose` with backoff for transient errors; shorten the 6 h conflict wait;
  when a conflict resolver project is paused/failed (cause 5) re-dispatch it.
* Remove `rigs_propose` / `rigs_dev_start` from agents of RIGS-managed projects (`mcp.js:242-249`), or make
  `proposeBranch` idempotent per branch so a second propose is a no-op.

### 4. Dispatch fails on a deterministic or transient error and the single retry repeats it (8ef0d6fed0, 1cb81e0446, 64df77d72b)

`retryOrFail` retries once right away (`planner.js:583-586`) and sets `t.assign=null` for routing
(`planner.js:558`), but re-routing picks the same machine.

* **`1cb81e0446`, `64df77d72b`** (resolver projects created by `server.js:183-186`): `dispatch to magix-system failed:
  duplicate session: merge-conflict-wor-t1[-r1]`. Cause: `createProject` makes `slug(name, 18)`
  (`planner.js:51`), and every `Merge conflict: <branch>` project truncates to `merge-conflict-wor`; direct mode names
  the tmux session `${project.slug}-${task.id}[-rN]` (`work.js:144`). A leftover session from the first resolver
  collides with the second project's. Both retries collide, so the project is `failed` after 2 min; the merge request
  stays in `conflict`.
* **`8ef0d6fed0`** (ACE-Step packaging): `worker team-code-opus@hub-mad-max-5e3b did not come back`. `ensureWorker`
  relaunches a stopped idle worker (`hubs.js:229-232`, `relaunch` at `hubs.js:158-162`) and `waitFor` gives it 30×2 s
  = 60 s (`hubs.js:149-155`). The retry two minutes later hit the same condition (`18:50`, `18:52`) and the project
  went `blocked` with t2 `todo`. Nothing tried a fresh seat (`rig seat clean` + new member id) or another machine.
* `b516d66d28`: `rig up failed` on dispatch (recovered by retry).

Fix:
* `work.js startDirect()` line 144: include the project id (`${project.slug}-${project.id.slice(0,4)}-${task.id}`);
  and in `server.js resolve()` (line 184) give the project a unique slug.
* `work.js startDirect()`: if the session name exists and `findTask` shows it is dead, kill it; if alive, adopt.
* `hubs.js waitFor()`/`ensureWorker()`: raise the wait to ≥3 min for relaunch, and on failure create a sibling
  seat (`-2`) instead of throwing.
* `planner.js retryOrFail()`: back off (store `t.retryAt`, skip in `ready()`), allow 3 attempts for
  infrastructure errors (dispatch failures) while keeping 2 for agent-reported failures, and clear `lastSeat`.

### 5. `project_stop` pauses the remedy as well as the problem (51c3923280, 0335bc0f31, a0c34f169f, b7a0a00273)

Sir said "retire finished projects, keep OS control and video generation" at 16:30; JARVIS called `project_stop` on
every other project at once (all `paused` records read `by: JARVIS for Sir`, reason `Sir: retire…`). That included
the two *resolver* projects (`51c3923280`, `0335bc0f31`), whose `t1` was running and went back to `todo`
(`stopProject`, `planner.js:866-868`), and the two original projects whose branches are parked in `conflict`. After
that nothing owns the parked merge requests, and `resume` is manual (`planner.js:881`). Four hours later their
branches (cut-token, split-questions) are neither merged nor dropped.

Fix:
* `planner.js stopProject()`: refuse or warn when a project owns an unmerged merge request (`selfDev.request` or a
  steward `conflict`); offer `archive` (a stop that also `drop`s the request via `merge.drop`, `merge.js:312`).
* `merge.js`: when a resolver project is paused/failed, mark the request `conflict-orphaned` and surface it in
  `GET merge` so `kickMerge` can retry (`retry`, `merge.js:311`).
* The retire branch already adds `archiveProject` (4d3a213760, commit 85f2451) — merge it; it is the right
  vocabulary for "done, ignore".

### 6. Work lost on a daemon restart and recovered only once (`0335bc0f31`, `51c3923280`, `4429a5fbc0`)

Planning is a single in-memory LLM call. `tickProject` resets `planning` older than `BOOT` to `draft` and replans
once (`planner.js:792-801`, guarded by `p.replanned`). Both resolver projects and this one hit it at 16:25/16:26 and
20:3x. Works, but a second restart during the replan leaves the project `draft` and silent.

Fix: `planner.js tickProject()` — keep a counter instead of a flag (3 tries), and `tell()` when it gives up.

### 7. Smaller, seen in logs

* `reviveTask()` (`planner.js:740-767`) restored a dead seat 6 times (`2ed3c75b03`, `cb22eb14a6`, `e525365a44`,
  `f8894c2e99`): working as designed, but after `MAX_REVIVES` (3) it fails the task with no change of strategy.
* `stalled` is only set for tasks that are idle with no `needsInput`; a seat that sits on a hidden prompt (the
  `needsInput` regex covers tmux only, `work.js:248`) can look busy until the watchdog's `STALL_MS` (15 min) fires.
* Final review tasks fail when the whole review needs a platform the repo machine lacks (cause 1 applies to
  `review` as well).

## Every path where an agent (or RIGS) can commit, push or switch branches outside a RIGS dev worktree

Agents are LLM sessions with a shell. Nothing in code *enforces* the rule: it is prompt text plus permission
policy (`builtin:auto`/`builtin:standard`). The list below is every place that either tells an agent to run a git
write, lets one reach one, or runs one in RIGS code.

**Prompt/brief paths (agent runs git itself)**

| # | Where | What |
| --- | --- | --- |
| A1 | `planner.js:428` | `agents.commitOtherProjects === 'branch'`: tells agents of **non-RIGS projects** to commit on "a work branch of your own" in the user's folder, i.e. `git checkout -b` + `git commit` outside any dev worktree (never push). Default is `'ask'` (`config.js:44-46`) which only *instructs* not to commit (`planner.js:429`); there is no technical block. |
| A2 | `work.js:61-63`, `hubs.js:275-289` | Non-selfDev tasks run with `cwd` = the user's real folder (`workdir = p0.repo.path`, `planner.js:531`), under `claude --permission-mode auto`/`builtin:auto`. A `git commit/push/checkout` from the agent is allowed by the harness. |
| A3 | `server.js:190` | Merge-resolver brief: "`git add` … `git commit --no-edit`" in the steward scratch worktree `~/.rigs/merge/wt-<id>` (not a dev worktree), on a project that is **not** `selfDev`, so `autonomyBrief` (`planner.js:429`) simultaneously says "do not commit, push, merge, rebase". Contradictory brief. Resolver runs `policy: 'builtin:standard'`, `dispatch: 'direct'` (`server.js:184`). |
| A4 | `planner.js:838-841` | `fixN` task brief: "Rebase or merge origin/main into the worktree … commit". Inside the dev worktree (OK) but the task's node is forced to `p.repo.node` and the check is by prompt only. |
| A5 | `mcp.js:242-249`, `server.js:707-708` | `rigs_dev_start`/`rigs_propose` are available to every agent. `dev/start` takes `repo` from the caller (`server.js:707`) so an agent can create a worktree + branch in any repo. `proposeBranch` takes any `dir` (`server.js:204`) and `describe()` only rejects `main` (`merge.js:109-110`): any other branch in any directory is accepted, committed to (`stripManagedBlocks`, `merge.js:70`) and bundled. `e43412ceae` shows agents using this on their own. |
| A6 | `mcp.js:257` + `server.js:183-186` | `rigs_merge_resolved` lets any agent flip a conflict request to `resolved` (`merge.js:296-309`, which itself runs `git commit --no-edit`) provided a worktree path exists. |
| A7 | `hubs.js:262`, `409` | Lead and overseer seats have `cwd` = the pinned project folder / `$HOME` with a free brief; no git restriction. |

**RIGS code that writes git state**

| # | Where | What |
| --- | --- | --- |
| C1 | `merge.js:231`, `267` | Trial `git merge --no-ff` in the steward scratch worktree (`wt-<id>`), intended. |
| C2 | `merge.js:263` | `git push origin HEAD:main`, intended, steward only. The one sanctioned push. |
| C3 | `merge.js:70` | `stripManagedBlocks`: `git add` + `git commit` in whatever `dir` the caller passes (see A5). |
| C4 | `merge.js:94` | `startWork`: `git worktree add -b` in `repo` (default the installed checkout `APP_DIR`; caller-overridable, A5). Also `git fetch` in `APP_DIR`. |
| C5 | `merge.js:145-147` | `cleanupWork`: `git worktree remove` + `git branch -D` in the repo derived from `dir`'s `--git-common-dir`; guarded by clean/merged checks, but `dir`/`branch` come from the request body (`server.js:709`). |
| C6 | `work.js:34`, `37` | `prepareWorkdir`: `git clone` and **`git pull --ff-only`** run in the user's project folder (`workdir`) whenever `project.gitUrl` is set, on every dispatch — moves the user's checked-out branch tip. |
| C7 | `updater.js:95`, `100`; `bin/rigs.js:53` | `git merge --ff-only` and `git reset --hard` in the installed checkout (self-update/rollback), intended; skipped when the tree is dirty (`updater.js`). |
| C8 | `appstore.js:884`, `894` | `git checkout -q FETCH_HEAD` in an app's own cloned root under `~/.rigs`, not a project repo. |

Guard that *does* exist: `work.js startTask` refuses to run an agent in the installed checkout (`isInstall`,
`work.js:46`). There is no equivalent for "not in a dev worktree" for selfDev, nor for "not main" in user projects.

Fixes (code-level enforcement rather than prompt text):
* `server.js proposeBranch()` and `merge.js describe()`: require `dir` to be under `devRoot()` (or the steward
  scratch dir) and the branch to match `work/<machine>/…`.
* `server.js dev/start` (`707`): ignore the `repo` argument unless the caller is local operator, not agent.
* `work.js startTask()`: for `selfDev`, assert `dir` is under `devRoot()`. For non-selfDev, start Claude with a
  deny list for `git commit|push|checkout|switch|reset|stash|rebase|merge` when `commitOtherProjects !== 'branch'`,
  via the harness permission rules (`agentmodes.js`/`models.js` `claudeFlags`) and the Codex profile.
* `work.js prepareWorkdir()`: skip `git pull` when `dir` is the user's own folder (`dir === project.repo.path`);
  only pull in `~/rigs-work/<slug>` clones.
* `server.js:190`: give the resolver project a `selfDev`-like brief (commit allowed in `req.worktree` only),
  remove the contradictory `autonomyBrief` text for `kind: 'merge'` tasks.

## Suggested implementation order (smallest change that moves the most projects to 100%)

1. Cause 1 (`settle` counts unassigned `todo` as stuck; relax `codeLocal` for platform conflicts) — unblocks 3 live projects.
2. Cause 3 (empty-propose = done; adopt already-merged branch) — removes two pure bookkeeping blocks.
3. Cause 4 (unique tmux names; backoff + sibling seat) — removes the deterministic resolver failure.
4. Cause 2 (needsInput timeout, narrower "destructive", auto-triage of `blocked`).
5. Cause 5 / 6, then git enforcement list.

## Method notes

* Project logs capture only transitions the planner writes. Task-level causes inside an agent's own session
  (for example *why* a classifier denied something) come from the `summary` the agent sent, not from transcripts;
  I did not open seat transcripts. The `e43412ceae` dirty-tree reason is therefore *(inferred)*.
* "Running for a long time" on macbookpro: the four `running` projects there started at 20:29-20:33 (minutes
  old) and are healthy at the snapshot (t1 `running`, seats live). The only long-stranded `running` projects are on
  magix-system plus `8eb2687046`'s unassigned t2 (cause 1).
